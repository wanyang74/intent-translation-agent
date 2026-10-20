// Tests: Execute (core/src/execute/), the layer that runs a tool: it checks the call, runs the site's tool code, and
// sends its requests to the site (L3).
// How: the made-up shop (example-site.ts) with a scripted network function and a virtual clock, so every status,
// changed response and timing can be produced on purpose.
// Passes when: requests are built from the site pack exactly; the cache, the shared budget and the rate limit hold;
// every status and bad response becomes an error the model can act on; the boundary checks run before the site's
// code; and outputs are checked, their IDs learned and their records kept for display.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runToolCall, type SiteCode } from '../src/index.ts';
import { exampleCode, exampleSession, exampleValidators, json, SEARCH_RESPONSE, shopNetwork, START } from './example-site.ts';

const reason = (outcome: { ok: boolean; error?: { reason?: string } }) => (outcome.ok ? 'ok' : outcome.error!.reason);
const signedIn = { url: 'https://www.example.com/account', pageType: 'account', signedIn: true };

test('request building: method, URL, fixed headers, and tracking IDs that stay the same for the session', async () => {
  const { session, requests } = await exampleSession();
  assert.equal(reason(await runToolCall(session, 'search_products', { query: 'shoe' })), 'ok');
  assert.equal(reason(await runToolCall(session, 'search_products', { query: 'boot' })), 'ok');
  const [firstRequest, secondRequest] = requests.map((request) => ({ ...request, json: JSON.parse(request.body!) }));
  assert.equal(firstRequest!.method, 'POST');
  assert.equal(firstRequest!.url, 'https://api.example.com/search');
  assert.equal(firstRequest!.headers['x-shop-client'], 'web');
  assert.equal(firstRequest!.headers['content-type'], 'application/json');
  assert.equal(firstRequest!.headers.accept, 'application/json, text/plain, */*');
  assert.match(firstRequest!.json.visitorId, /^00000000-0000-4000-9000-\d{12}$/);
  assert.equal(firstRequest!.headers.visitorid, firstRequest!.json.visitorId, 'a body field and a header with the same name share one ID');
  assert.notEqual(firstRequest!.json.analytics.clientRef, firstRequest!.json.visitorId);
  assert.equal(secondRequest!.json.visitorId, firstRequest!.json.visitorId, 'the same for the whole session');
  assert.deepEqual([firstRequest!.json.query, firstRequest!.json.colors], ['shoe', []]);
});

test('request building: a tracking field the site code sets itself is kept', async () => {
  const code: SiteCode = { ...exampleCode, tools: { ...exampleCode.tools, async search_products(ctx) {
    await ctx.call('search', { body: { query: 'x', visitorId: 'fixed' } });
    return { products: [] };
  } } };
  const { session, requests } = await exampleSession({ code });
  await runToolCall(session, 'search_products', { query: 'x' });
  assert.equal(JSON.parse(requests[0]!.body!).visitorId, 'fixed');
});

test('request building: GET path parameters and the query are URL-encoded; pages ask for HTML', async () => {
  const { session, requests } = await exampleSession();
  session.setPage(signedIn);
  assert.equal(reason(await runToolCall(session, 'read_product_page', { productId: 7 })), 'unknown_id', 'product 7 is not known yet');
  session.ids.learn('product', 7);
  const page = await runToolCall(session, 'read_product_page', { productId: 7 });
  assert.deepEqual(page, { ok: true, output: { name: 'Product 7' } });
  assert.equal(requests.at(-1)!.url, 'https://www.example.com/p/7');
  assert.equal(requests.at(-1)!.headers.accept, 'text/html');
  assert.equal(requests.at(-1)!.body, null);
  await runToolCall(session, 'search_products', { query: 'a b&c', colors: ['Red'] });
  assert.equal(requests.find((request) => request.url.includes('/filters'))!.url, 'https://api.example.com/filters?query=a%20b%26c');
});

test("request schema: a request that breaks the endpoint's schema is our bug, and never sent", async () => {
  const validators = exampleValidators({ 'endpoints/search.request.json': (data) => typeof data.query === 'string' && data.query.length > 0 });
  const { session, requests } = await exampleSession({ validators });
  const outcome = await runToolCall(session, 'search_products', { query: '' });
  assert.equal(reason(outcome), 'site_code_error');
  assert.match(!outcome.ok ? outcome.error.message : '', /search request is invalid/);
  assert.equal(requests.length, 0);
});

test('cache: the same request is answered from the cache, with no second call and no budget used', async () => {
  const { session, requests } = await exampleSession();
  await runToolCall(session, 'search_products', { query: 'shoe' });
  await runToolCall(session, 'search_products', { query: 'shoe' });
  assert.equal(requests.length, 1);
  assert.equal(session.budget.used().task, 1);
});

test('call budget: stops calls at the task limit, then at the session limit', async () => {
  const { session } = await exampleSession();
  const results = [];
  for (let i = 0; i < 6; i++) results.push(reason(await runToolCall(session, 'search_products', { query: `q${i}` })));
  assert.deepEqual(results, ['ok', 'ok', 'ok', 'ok', 'ok', 'budget_reached']);
  session.budget.startTask();
  const more = [];
  for (let i = 6; i < 10; i++) more.push(await runToolCall(session, 'search_products', { query: `q${i}` }));
  assert.deepEqual(more.map(reason), ['ok', 'ok', 'ok', 'budget_reached']);
  assert.match(!more[3]!.ok ? more[3]!.error.message : '', /This session reached its limit of 8 calls/);
});

test('rate limit: calls are spaced on the clock; parallel calls queue instead of bursting', async () => {
  const times: number[] = [];
  const shop = await exampleSession({ network: (req) => { times.push(shop.clock.now()); return shopNetwork(req); } });
  await Promise.all(['a', 'b', 'c'].map((query) => runToolCall(shop.session, 'search_products', { query: query })));
  assert.deepEqual(times.map((time) => time - START), [0, 500, 1000], 'two calls per second');
});

test('statuses: become errors the model can act on, in the tool\'s own words where it has them', async () => {
  const cases: [number | 'network', string, boolean][] = [
    [401, 'signed_out', true], [404, 'site_not_found', false], [429, 'site_rate_limited', true],
    [500, 'site_unavailable', true], [503, 'site_unavailable', true], [400, 'site_refused', false], [403, 'site_refused', false],
    ['network', 'network_error', true],
  ];
  for (const [status, expected, retryable] of cases) {
    const { session } = await exampleSession({
      network: () => { if (status === 'network') throw new Error('socket hang up'); return json({}, status); },
    });
    session.setPage(signedIn);
    const outcome = await runToolCall(session, 'my_orders', {});
    assert.equal(reason(outcome), expected, String(status));
    assert.equal(!outcome.ok && outcome.error.retryable, retryable, String(status));
  }
});

test("changed format: a response that isn't JSON or breaks its schema is reported and logged", async () => {
  const notJson = await exampleSession({ network: () => ({ status: 200, headers: {}, body: '<html>maintenance</html>' }) });
  assert.equal(reason(await runToolCall(notJson.session, 'search_products', { query: 'x' })), 'response_changed');
  assert.ok(notJson.log.some((entry) => entry.kind === 'response_check'));
  const validators = exampleValidators({ 'endpoints/search.response.json': (data) => Array.isArray(data.items) });
  const changed = await exampleSession({ validators, network: () => json({ results: [] }) });
  const outcome = await runToolCall(changed.session, 'search_products', { query: 'x' });
  assert.deepEqual([outcome.ok, !outcome.ok && outcome.error.code], [false, 'format_changed']);
  assert.ok(changed.log.some((entry) => entry.kind === 'response_check' && JSON.stringify(entry.detail).includes('search')));
});

test("page reader: a page is read by the site's reader; without one it's our bug", async () => {
  const { session } = await exampleSession({ code: { ...exampleCode, parsers: {} } });
  session.ids.learn('product', 7);
  assert.equal(reason(await runToolCall(session, 'read_product_page', { productId: 7 })), 'site_code_error');
});

test('endpoints: a tool can only call the endpoints it declares', async () => {
  const code: SiteCode = { ...exampleCode, tools: { ...exampleCode.tools, async get_offer(ctx) {
    await ctx.call('orders', { query: {} });
    return {};
  } } };
  const { session } = await exampleSession({ code });
  session.ids.learn('offer', 'of_ab12', { expiresAt: START + 60_000 });
  const outcome = await runToolCall(session, 'get_offer', { offerId: 'of_ab12' });
  assert.equal(reason(outcome), 'site_code_error');
  assert.match(!outcome.ok ? outcome.error.message : '', /orders, which it doesn't declare/);
});

test('boundary checks: run before the site\'s code: unknown tools, writes, unknown IDs and bad arguments', async () => {
  const validators = exampleValidators({ 'tools/search_products.input.json': (data) => data.query === undefined || typeof data.query === 'string' });
  const { session, requests } = await exampleSession({ validators });
  assert.equal(reason(await runToolCall(session, 'buy_everything', {})), 'unknown_tool');
  assert.equal(reason(await runToolCall(session, 'place_order', { offerId: 'of_ab12' })), 'writes_off');
  assert.equal(reason(await runToolCall(session, 'compare_products', { productIds: [1, 2] })), 'unknown_id');
  assert.equal(reason(await runToolCall(session, 'search_products', { query: 42 })), 'bad_arguments');
  assert.equal(requests.length, 0);
});

test('allowed values: the source is fetched once, the way the site says, and values are checked against it', async () => {
  const { session, requests } = await exampleSession();
  const bad = await runToolCall(session, 'search_products', { query: 'shoe', colors: ['Green'] });
  assert.deepEqual(!bad.ok && [bad.error.reason, bad.error.message], ['bad_color', "'Green' isn't one of the colors we sell. Try one of: Red, Blue."]);
  assert.equal(reason(await runToolCall(session, 'search_products', { query: 'shoe', colors: ['Red'] })), 'ok');
  assert.equal(requests.filter((request) => request.url.includes('/filters')).length, 1);
});

test("tool code: a tool the site hasn't built is unavailable; a crash is our bug, and is logged", async () => {
  const { compare_products: _omit, ...rest } = exampleCode.tools;
  const crash: SiteCode = { ...exampleCode, tools: { ...rest, async search_products() { throw new TypeError('x is undefined'); } } };
  const { session, log } = await exampleSession({ code: crash });
  session.ids.learn('product', 1);
  session.ids.learn('product', 2);
  assert.deepEqual(await runToolCall(session, 'compare_products', { productIds: [1, 2] }).then((callOutcome) => !callOutcome.ok && [callOutcome.error.code, callOutcome.error.reason]), ['tool_disabled', 'not_built']);
  const outcome = await runToolCall(session, 'search_products', { query: 'x' });
  assert.equal(reason(outcome), 'site_code_error');
  assert.doesNotMatch(!outcome.ok ? outcome.error.message : '', /x is undefined/, "the crash's details stay out of the model's view");
  assert.ok(log.some((entry) => entry.kind === 'tool_crashed' && JSON.stringify(entry.detail).includes('x is undefined')));
});

test("ctx.fail: raises one of the tool's own errors; an error it doesn't declare is our bug", async () => {
  const failing = (why: string): SiteCode => ({ ...exampleCode, tools: { ...exampleCode.tools, async get_offer(ctx) { return ctx.fail(why); } } });
  for (const [why, code, expectedReason] of [['offer_gone', 'expired', 'offer_gone'], ['nope', 'upstream_error', 'site_code_error']] as const) {
    const { session } = await exampleSession({ code: failing(why) });
    session.ids.learn('offer', 'of_ab12', { expiresAt: START + 60_000 });
    const out = await runToolCall(session, 'get_offer', { offerId: 'of_ab12' });
    assert.deepEqual(!out.ok && [out.error.code, out.error.reason], [code, expectedReason]);
  }
});

test("output schema: an output that breaks the tool's schema never reaches the model", async () => {
  const validators = exampleValidators({ 'tools/search_products.output.json': (data) => !('secret' in data) });
  const leaky: SiteCode = { ...exampleCode, tools: { ...exampleCode.tools, async search_products() { return { products: [], secret: 'internal' }; } } };
  const { session, log } = await exampleSession({ code: leaky, validators });
  const outcome = await runToolCall(session, 'search_products', { query: 'x' });
  assert.equal(reason(outcome), 'response_changed');
  assert.ok(!JSON.stringify(outcome).includes('internal'));
  assert.ok(log.some((entry) => entry.kind === 'output_check'));
});

test("outputs: get the site pack's next step; their IDs are learned with expiry; records are kept for display", async () => {
  const { session, clock } = await exampleSession();
  const outcome = await runToolCall(session, 'search_products', { query: 'shoe' });
  assert.ok(outcome.ok);
  assert.equal(outcome.output.nextStep, 'To see an offer, call get_offer with its ID.');
  assert.deepEqual(outcome.output.products, [
    { id: 1, name: 'Red Shoe', price: 40, total: 45.5, rating: 4.5 },
    { id: 2, name: 'Blue Shoe', price: 1250, total: 1250, rating: 3.9 },
  ]);
  const now = clock.now();
  assert.deepEqual(['product:1', 'product:2', 'offer:of_ab12', 'coupon:SAVEX', 'token:tok_1'].map((key) => {
    const [kind, id] = key.split(':');
    return session.ids.status(kind!, kind === 'product' ? Number(id) : id, now);
  }), ['known', 'known', 'known', 'known', 'known']);
  assert.equal(session.ids.status('offer', 'of_ab12', Date.parse(SEARCH_RESPONSE.offers[0]!.expiresAt)), 'expired');
  assert.equal(session.ids.status('coupon', 'SAVEX', now + 600_000), 'expired', 'coupons last ten minutes once shown');
  assert.deepEqual(Object.fromEntries(session.recordsFor('product', 1)!), { search_products: { id: 1, name: 'Red Shoe', price: 40, total: 45.5, rating: 4.5 } });
  session.ids.learn('product', 7);
  await runToolCall(session, 'read_product_page', { productId: 7 });
  assert.deepEqual(Object.fromEntries(session.recordsFor('product', 7)!), { read_product_page: { name: 'Product 7' } }, 'kept for the input ID when the output has none');
});

test('ctx.keep: adds details for display', async () => {
  const code: SiteCode = { ...exampleCode, tools: { ...exampleCode.tools, async get_offer(ctx) {
    ctx.keep('offer', ctx.args.offerId, { amount: 30 });
    return {};
  } } };
  const { session } = await exampleSession({ code });
  session.ids.learn('offer', 'of_ab12', { expiresAt: START + 60_000 });
  await runToolCall(session, 'get_offer', { offerId: 'of_ab12' });
  assert.deepEqual(Object.fromEntries(session.recordsFor('offer', 'of_ab12')!), { 'get_offer:kept': { amount: 30 }, get_offer: {} }, 'kept details, then the output for the input ID');
});
