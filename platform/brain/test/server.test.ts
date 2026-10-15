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
import { Brain, type BrainLogEntry } from '../src/loop.ts';
import { createBrainServer } from '../src/server.ts';
import { HOME, NOW, shopResults, shopSite, validateMessage } from './example-brain.ts';

const SITE_ORIGIN = 'https://www.example.com';

async function serve(script: FakeScript[], o: { maxBodyBytes?: number } = {}) {
  const log: BrainLogEntry[] = [];
  const model = new FakeModel(script);
  const brain = new Brain({ sites: [shopSite()], model, now: () => NOW, log: (e) => log.push(e) });
  const server = createBrainServer({ brain, allowedOrigins: [SITE_ORIGIN], ...(o.maxBodyBytes ? { maxBodyBytes: o.maxBodyBytes } : {}) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = webHost({ brainUrl: base }).brain!.bind(null) as (m: ClientMessage) => AsyncIterable<unknown>;
  return { base, brain, model, log, send, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("a turn over HTTP, with core.js's web host as the client: each tool call streams out before the model's step ends", async () => {
  let arrived!: () => void;
  const firstCall = new Promise<void>((r) => { arrived = r; });
  const s = await serve([
    {
      text: 'Searching…', calls: [{ name: 'search_products', input: { query: 'red' } }, { name: 'search_products', input: { query: 'blue' } }],
      beforeCall: (i) => (i === 1 ? Promise.race([firstCall, new Promise<void>((_, no) => setTimeout(() => no(new Error('call_1 was held back by the server')), 2000))]) : undefined),
    },
    { text: 'Two shoes.', calls: [{ name: 'present_items', input: { entity: 'product', ids: [1, 2] } }] },
  ]);
  try {
    const client = new FakeClient(s.send, { site: 'example-shop', validate: validateMessage, results: (call) => { arrived(); return shopResults(call); } });
    const t = await client.turn('red or blue shoes', HOME);
    assert.deepEqual(t.problems, []);
    assert.deepEqual(t.events.map((e) => e.type), ['tool_call', 'tool_call', 'progress', 'await_results', 'answer']);
    assert.equal(t.answer?.text, 'Two shoes.');
  } finally {
    await s.close();
  }
});

test("CORS answers the sites' own origins and no others", async () => {
  const s = await serve([]);
  try {
    const preflight = (origin: string) => fetch(`${s.base}/v1/turn`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    const ok = await preflight(SITE_ORIGIN);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), SITE_ORIGIN);
    assert.match(ok.headers.get('access-control-allow-headers') ?? '', /content-type/);
    const other = await preflight('https://evil.example.net');
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.close();
  }
});

test('bad requests get plain refusals: wrong method or path, a body that is not JSON or too large, a broken message', async () => {
  const s = await serve([], { maxBodyBytes: 10_000 });
  try {
    const post = (path: string, body: string) => fetch(`${s.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
    assert.equal((await fetch(`${s.base}/v1/turn`)).status, 405);
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
    await s.close();
  }
});

test('a client that hangs up mid-turn: the brain stops the model call and ends the turn', async () => {
  let aborted!: () => void;
  const wasAborted = new Promise<void>((r) => { aborted = r; });
  const s = await serve([
    (request) => {
      request.signal.addEventListener('abort', () => aborted());
      return { calls: [{ name: 'search_products', input: { query: 'red' } }], hang: 'abortable' };
    },
  ]);
  try {
    const controller = new AbortController();
    const res = await fetch(`${s.base}/v1/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ type: 'turn', site: 'example-shop', sessionId: 'sess_http_hangup', traceId: 'trace_http_hangup', message: 'shoes', pageContext: HOME }),
    });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"type":"tool_call"/);
    controller.abort();
    await Promise.race([wasAborted, new Promise((_, no) => setTimeout(() => no(new Error('the model call was not aborted')), 2000))]);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(s.log.some((e) => e.kind === 'turn_end' && (e.detail as { why: string }).why === 'the client went away'));
  } finally {
    await s.close();
  }
});
