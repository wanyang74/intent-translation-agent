// The brain over HTTP, called the way core.js's web host calls it: newline-delimited JSON that streams each event as
// it happens (a tool call reaches the client while the model is still writing), CORS for the sites' origins, plain
// refusals for bad requests, and a client that hangs up mid-turn ends the turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { ClientMessage } from '../../contract/generated/types.ts';
import { webHost } from '../../core/hosts/web.ts';
import { FakeClient } from '../../testkit/src/fake-client.ts';
import { FakeModel, type FakeScript } from '../../testkit/src/fake-model.ts';
import { Brain, type BrainLogEntry } from '../src/agent/loop.ts';
import { createBrainServer } from '../src/server/server.ts';
import { HOME, NOW, shopResults, shopSite, validateMessage } from './example-brain.ts';

const SITE_ORIGIN = 'https://www.example.com';

async function serve(script: FakeScript[], options: { maxBodyBytes?: number } = {}) {
  const log: BrainLogEntry[] = [];
  const model = new FakeModel(script);
  const brain = new Brain({ sites: [shopSite()], model, now: () => NOW, log: (entry) => log.push(entry) });
  const server = createBrainServer({ brain, allowedOrigins: [SITE_ORIGIN], ...(options.maxBodyBytes ? { maxBodyBytes: options.maxBodyBytes } : {}) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = webHost({ brainUrl: base }).brain!.bind(null) as (message: ClientMessage) => AsyncIterable<unknown>;
  return { base, brain, model, log, send, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("a turn over HTTP, with core.js's web host as the client: each tool call streams out before the model's step ends", async () => {
  let arrived!: () => void;
  const firstCall = new Promise<void>((resolve) => { arrived = resolve; });
  const server = await serve([
    {
      text: 'Searching…', calls: [{ name: 'search_products', input: { query: 'red' } }, { name: 'search_products', input: { query: 'blue' } }],
      beforeCall: (i) => (i === 1 ? Promise.race([firstCall, new Promise<void>((_, no) => setTimeout(() => no(new Error('call_1 was held back by the server')), 2000))]) : undefined),
    },
    { text: 'Two shoes.', calls: [{ name: 'present_items', input: { entity: 'product', ids: [1, 2] } }] },
  ]);
  try {
    const client = new FakeClient(server.send, { site: 'example-shop', validate: validateMessage, results: (call) => { arrived(); return shopResults(call); } });
    const turn = await client.turn('red or blue shoes', HOME);
    assert.deepEqual(turn.problems, []);
    assert.deepEqual(turn.events.map((event) => event.type), ['tool_call', 'tool_call', 'progress', 'await_results', 'answer']);
    assert.equal(turn.answer?.text, 'Two shoes.');
  } finally {
    await server.close();
  }
});

test("CORS answers the sites' own origins and no others", async () => {
  const server = await serve([]);
  try {
    const preflight = (origin: string) => fetch(`${server.base}/v1/turn`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    const ok = await preflight(SITE_ORIGIN);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), SITE_ORIGIN);
    assert.match(ok.headers.get('access-control-allow-headers') ?? '', /content-type/);
    const other = await preflight('https://evil.example.net');
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  } finally {
    await server.close();
  }
});

test('bad requests get plain refusals: wrong method or path, a body that is not JSON or too large, a broken message', async () => {
  const server = await serve([], { maxBodyBytes: 10_000 });
  try {
    const post = (path: string, body: string) => fetch(`${server.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await fetch(`${server.base}/healthz`)).status, 200);
    assert.equal((await fetch(`${server.base}/v1/turn`)).status, 405);
    assert.equal((await post('/v1/answer', '{}')).status, 404);
    const notJson = await post('/v1/turn', '{oops');
    assert.equal(notJson.status, 400);
    assert.deepEqual(await notJson.json(), { error: 'the body is not JSON' });
    assert.equal((await post('/v1/turn', JSON.stringify({ blob: 'x'.repeat(20_000) }))).status, 413);
    const broken = await post('/v1/turn', JSON.stringify({ type: 'turn', site: 'example-shop' }));
    assert.equal(broken.status, 400);
    assert.match((await broken.json() as { error: string }).error, /breaks the protocol/);
    const misrouted = await post('/v1/results', JSON.stringify({ type: 'turn', site: 'example-shop', sessionId: 'sess_http_1', traceId: 'trace_http_1', message: 'hi', pageContext: HOME }));
    assert.equal(misrouted.status, 400);
  } finally {
    await server.close();
  }
});

test('a client that hangs up mid-turn: the brain stops the model call and ends the turn', async () => {
  let aborted!: () => void;
  const wasAborted = new Promise<void>((resolve) => { aborted = resolve; });
  const server = await serve([
    (request) => {
      request.signal.addEventListener('abort', () => aborted());
      return { calls: [{ name: 'search_products', input: { query: 'red' } }], hang: 'abortable' };
    },
  ]);
  try {
    const controller = new AbortController();
    const res = await fetch(`${server.base}/v1/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ type: 'turn', site: 'example-shop', sessionId: 'sess_http_hangup', traceId: 'trace_http_hangup', message: 'shoes', pageContext: HOME }),
    });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"type":"tool_call"/);
    controller.abort();
    await Promise.race([wasAborted, new Promise((_, no) => setTimeout(() => no(new Error('the model call was not aborted')), 2000))]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(server.log.some((entry) => entry.kind === 'turn_end' && (entry.detail as { why: string }).why === 'the client went away'));
  } finally {
    await server.close();
  }
});

test('POST /v1/amend queues a message on the running turn, over HTTP', async () => {
  const holder: { client?: FakeClient; reply?: unknown[] } = {};
  const served = await serve([
    { calls: [{ name: 'search_products', input: { query: 'shoes' } }] },
    { text: 'Red ones.', calls: [{ name: 'present_items', input: { entity: 'product', ids: [1] } }] },
  ]);
  try {
    holder.client = new FakeClient(served.send, {
      site: 'example-shop', validate: validateMessage,
      results: async (toolCall) => { holder.reply = await holder.client!.amend('only red'); return shopResults(toolCall); },
    });
    const turn = await holder.client.turn('shoes', HOME);
    assert.deepEqual(holder.reply, [{ type: 'amended', traceId: turn.traceId, status: 'queued' }]);
    assert.match(JSON.stringify(served.model.requests[1]!.messages.at(-1)), /only red/);
  } finally {
    await served.close();
  }
});
