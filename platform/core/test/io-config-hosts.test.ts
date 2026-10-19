// L3 for the remote config (off switches) and the web host: a config is used only when it is valid, for this site,
// and signed, and it can only tighten the site pack's limits; the web host sends requests with the page's session
// and reads the brain's newline-delimited events however the network splits them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ndjsonEvents, webHost } from '../hosts/web.ts';
import { acceptConfig, runToolCall } from '../src/index.ts';
import { examplePack } from './example-pack.ts';
import { exampleHost, exampleSession, exampleValidators, shopNetwork } from './example-site.ts';

const config = (over: Record<string, unknown> = {}) => ({
  site: 'example-shop', version: '3', issuedAt: '2026-10-14T00:00:00Z', disabledTools: ['search_products'], disabledSkills: [],
  budgets: { perTask: 2, perSession: null, perDay: null }, rateLimitPerSecond: 5, signature: 'sig', ...over,
});
const signedBy = (good: string) => ({ verifyConfig: async (remoteConfig: unknown) => (remoteConfig as { signature: string }).signature === good });

test('a remote config is ignored unless it is valid, for this site, and signed', async () => {
  const base = { pack: examplePack, validators: exampleValidators() };
  const cases: [unknown, Partial<ReturnType<typeof exampleHost>['host']>, RegExp | null][] = [
    [{ site: 'example-shop' }, signedBy('sig'), /remote config ignored/],
    [config({ site: 'other-shop' }), signedBy('sig'), /it is for other-shop/],
    [config(), {}, /can't check signatures/],
    [config({ signature: 'forged' }), signedBy('sig'), /signature check failed/],
    [config(), signedBy('sig'), null],
  ];
  for (const [raw, hostExtra, warning] of cases) {
    const { host } = exampleHost(shopNetwork, hostExtra);
    const accepted = await acceptConfig({ ...base, host, config: raw });
    if (warning) {
      assert.equal(accepted.config, null);
      assert.match(accepted.warnings[0]!, warning);
    } else {
      assert.deepEqual([accepted.config?.version, accepted.warnings], ['3', []]);
    }
  }
});

test("an accepted config switches tools off and tightens limits, but can't loosen them", async () => {
  const { session } = await exampleSession({ host: signedBy('sig'), config: config({ disabledTools: ['my_orders'], rateLimitPerSecond: 50 }) });
  assert.deepEqual(session.policy.budgets, { perTask: 2, perSession: 8, perDay: 10 });
  assert.equal(session.policy.rateLimitPerSecond, 2, "the site pack's 2 per second stays");
  session.setPage({ url: 'https://www.example.com/account', pageType: 'account', signedIn: true });
  const off = await runToolCall(session, 'my_orders', {});
  assert.deepEqual(!off.ok && [off.error.code, off.error.reason], ['tool_disabled', 'tool_disabled']);
  assert.equal((await runToolCall(session, 'search_products', { query: 'a' })).ok, true);
  assert.equal((await runToolCall(session, 'search_products', { query: 'b' })).ok, true);
  const third = await runToolCall(session, 'search_products', { query: 'c' });
  assert.equal(!third.ok && third.error.reason, 'budget_reached');
});

test("the web host sends requests with the page's session and maps the response", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json', 'x-trace': 'abc' } });
  }) as unknown as typeof fetch;
  const host = webHost({ brainUrl: 'https://agent.example.com/', fetch: fakeFetch, readPage: () => ({ vehicleId: 7 }) });
  const res = await host.request({ method: 'POST', url: 'https://api.example.com/search', headers: { 'content-type': 'application/json' }, body: '{"q":1}' });
  assert.deepEqual(res, { status: 201, headers: { 'content-type': 'application/json', 'x-trace': 'abc' }, body: '{"ok":true}' });
  assert.equal(seen[0]!.init.credentials, 'include');
  assert.equal(seen[0]!.init.method, 'POST');
  assert.equal(seen[0]!.init.body, '{"q":1}');
  assert.match(host.randomId(), /^[0-9a-f-]{36}$/);
  assert.deepEqual(host.pageData!(), { vehicleId: 7 });
});

function chunked(text: string, sizes: number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      const size = sizes[0] ? sizes.shift()! : bytes.length;
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

test("the brain's events are read one per line, however the network splits them", async () => {
  const lines = ['{"type":"progress","traceId":"trace_1","text":"Señor ✓"}', '', '{"type":"answer","traceId":"trace_1","text":"done"}'];
  const text = lines.join('\n');
  for (const sizes of [[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 50, 3], [7, 33, 2], [1000]]) {
    const events = [];
    for await (const event of ndjsonEvents(chunked(text, [...sizes]))) events.push(event);
    assert.deepEqual(events, [
      { type: 'progress', traceId: 'trace_1', text: 'Señor ✓' },
      { type: 'answer', traceId: 'trace_1', text: 'done' },
    ], `split ${sizes}`);
  }
});

test('the web host posts turns and results to the brain, and fails loudly on a bad status', async () => {
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    if (url.endsWith('/v1/results')) return new Response('busy', { status: 503 });
    return new Response(chunked('{"type":"answer","traceId":"trace_1","text":"hi"}\n', [5]), { status: 200 });
  }) as unknown as typeof fetch;
  const host = webHost({ brainUrl: 'https://agent.example.com/', fetch: fakeFetch });
  const events = [];
  const turn = { type: 'turn', site: 'example-shop', sessionId: 'sess_12345678', traceId: 'trace_1', message: 'hi', pageContext: { url: 'https://www.example.com/', pageType: 'home' } } as const;
  for await (const event of host.brain!(turn)) events.push(event);
  assert.deepEqual(events, [{ type: 'answer', traceId: 'trace_1', text: 'hi' }]);
  await assert.rejects(async () => {
    for await (const _ of host.brain!({ type: 'results', sessionId: 'sess_12345678', traceId: 'trace_1', results: [{ id: 'call_1', ok: true, output: {} }] })) { /* drain */ }
  }, /answered 503/);
  assert.deepEqual(urls, ['https://agent.example.com/v1/turn', 'https://agent.example.com/v1/results']);
});
