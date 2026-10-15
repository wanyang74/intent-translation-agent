// L3 for calling the site and running tools, on the made-up shop with a scripted network: how requests are built,
// the cache, the shared budget, the rate limit, every status, changed responses, the page reader, the boundary checks
// before a tool runs, and our own failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runToolCall, type SiteCode } from '../src/index.ts';
import { exampleCode, exampleSession, exampleValidators, json, SEARCH_RESPONSE, shopNetwork, START } from './example-site.ts';

const reason = (r: { ok: boolean; error?: { reason?: string } }) => (r.ok ? 'ok' : r.error!.reason);
const signedIn = { url: 'https://www.example.com/account', pageType: 'account', signedIn: true };

test("a request is built from the site pack: method, URL, fixed headers, and tracking IDs that stay the same for the session", async () => {
  const { session, requests } = await exampleSession();
  assert.equal(reason(await runToolCall(session, 'search_products', { query: 'shoe' })), 'ok');
  assert.equal(reason(await runToolCall(session, 'search_products', { query: 'boot' })), 'ok');
  const [a, b] = requests.map((r) => ({ ...r, json: JSON.parse(r.body!) }));
  assert.equal(a!.method, 'POST');
  assert.equal(a!.url, 'https://api.example.com/search');
  assert.equal(a!.headers['x-shop-client'], 'web');
  assert.equal(a!.headers['content-type'], 'application/json');
  assert.equal(a!.headers.accept, 'application/json, text/plain, */*');
  assert.match(a!.json.visitorId, /^00000000-0000-4000-9000-\d{12}$/);
  assert.equal(a!.headers.visitorid, a!.json.visitorId, 'a body field and a header with the same name share one ID');
  assert.notEqual(a!.json.analytics.clientRef, a!.json.visitorId);
  assert.equal(b!.json.visitorId, a!.json.visitorId, 'the same for the whole session');
  assert.deepEqual([a!.json.query, a!.json.colors], ['shoe', []]);
});

test('a tracking field the site code sets itself is kept', async () => {
  const code: SiteCode = { ...exampleCode, tools: { ...exampleCode.tools, async search_products(ctx) {
    await ctx.call('search', { body: { query: 'x', visitorId: 'fixed' } });
    return { products: [] };
  } } };
  const { session, requests } = await exampleSession({ code });
  await runToolCall(session, 'search_products', { query: 'x' });
  assert.equal(JSON.parse(requests[0]!.body!).visitorId, 'fixed');
});

test('GET: path parameters and the query are URL-encoded, and pages ask for HTML', async () => {
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
  assert.equal(requests.find((r) => r.url.includes('/filters'))!.url, 'https://api.example.com/filters?query=a%20b%26c');
});

test("a request that breaks the endpoint's schema is our bug, reported as such, and never sent", async () => {
  const validators = exampleValidators({ 'endpoints/search.request.json': (d) => typeof d.query === 'string' && d.query.length > 0 });
  const { session, requests } = await exampleSession({ validators });
  const r = await runToolCall(session, 'search_products', { query: '' });
  assert.equal(reason(r), 'site_code_error');
  assert.match(!r.ok ? r.error.message : '', /search request is invalid/);
  assert.equal(requests.length, 0);
});

test('the same request is answered from the cache: no second call, and no budget used', async () => {
  const { session, requests } = await exampleSession();
  await runToolCall(session, 'search_products', { query: 'shoe' });
  await runToolCall(session, 'search_products', { query: 'shoe' });
  assert.equal(requests.length, 1);
  assert.equal(session.budget.used().task, 1);
});

test('the shared budget stops calls at the task limit, then at the session limit', async () => {
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

test('the rate limit spaces calls on the clock, and parallel calls queue instead of bursting', async () => {
  const times: number[] = [];
  const s = await exampleSession({ network: (req) => { times.push(s.clock.now()); return shopNetwork(req); } });
  await Promise.all(['a', 'b', 'c'].map((q) => runToolCall(s.session, 'search_products', { query: q })));
  assert.deepEqual(times.map((t) => t - START), [0, 500, 1000], 'two calls per second');
});

test('statuses become errors the model can act on, in the tool\'s own words where it has them', async () => {
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
    const r = await runToolCall(session, 'my_orders', {});
    assert.equal(reason(r), expected, String(status));
    assert.equal(!r.ok && r.error.retryable, retryable, String(status));
  }
});

test("an answer that isn't JSON, or that breaks the response schema, is reported as a changed format and logged", async () => {
  const notJson = await exampleSession({ network: () => ({ status: 200, headers: {}, body: '<html>maintenance</html>' }) });
  assert.equal(reason(await runToolCall(notJson.session, 'search_products', { query: 'x' })), 'response_changed');
  assert.ok(notJson.log.some((e) => e.kind === 'response_check'));
  const validators = exampleValidators({ 'endpoints/search.response.json': (d) => Array.isArray(d.items) });
  const changed = await exampleSession({ validators, network: () => json({ results: [] }) });
  const r = await runToolCall(changed.session, 'search_products', { query: 'x' });
  assert.deepEqual([r.ok, !r.ok && r.error.code], [false, 'format_changed']);
  assert.ok(changed.log.some((e) => e.kind === 'response_check' && JSON.stringify(e.detail).includes('search')));
});

test("a page is read by the site's page reader; without a reader it's our bug", async () => {
  const { session } = await exampleSession({ code: { ...exampleCode, parsers: {} } });
  session.ids.learn('product', 7);
  assert.equal(reason(await runToolCall(session, 'read_product_page', { productId: 7 })), 'site_code_error');
});

test("a tool can only call endpoints it declares", async () => {
  const code: SiteCode = { ...exampleCode, tools: { ...exampleCode.tools, async get_offer(ctx) {
    await ctx.call('orders', { query: {} });
    return {};
  } } };
  const { session } = await exampleSession({ code });
  session.ids.learn('offer', 'of_ab12', { expiresAt: START + 60_000 });
  const r = await runToolCall(session, 'get_offer', { offerId: 'of_ab12' });
  assert.equal(reason(r), 'site_code_error');
  assert.match(!r.ok ? r.error.message : '', /orders, which it doesn't declare/);
});

test('boundary checks run before the site\'s code: unknown tools, writes, unknown IDs and bad arguments', async () => {
  const validators = exampleValidators({ 'tools/search_products.input.json': (d) => d.query === undefined || typeof d.query === 'string' });
  const { session, requests } = await exampleSession({ validators });
  assert.equal(reason(await runToolCall(session, 'buy_everything', {})), 'unknown_tool');
  assert.equal(reason(await runToolCall(session, 'place_order', { offerId: 'of_ab12' })), 'writes_off');
  assert.equal(reason(await runToolCall(session, 'compare_products', { productIds: [1, 2] })), 'unknown_id');
  assert.equal(reason(await runToolCall(session, 'search_products', { query: 42 })), 'bad_arguments');
  assert.equal(requests.length, 0);
});

test('allowed values: the source is fetched the way the site says, once, and values are checked against it', async () => {
  const { session, requests } = await exampleSession();
  const bad = await runToolCall(session, 'search_products', { query: 'shoe', colors: ['Green'] });
  assert.deepEqual(!bad.ok && [bad.error.reason, bad.error.message], ['bad_color', "'Green' isn't one of the colors we sell. Try one of: Red, Blue."]);
  assert.equal(reason(await runToolCall(session, 'search_products', { query: 'shoe', colors: ['Red'] })), 'ok');
  assert.equal(requests.filter((r) => r.url.includes('/filters')).length, 1);
});

test("a tool the site hasn't built is unavailable; a crash is our bug, and is logged", async () => {
  const { compare_products: _omit, ...rest } = exampleCode.tools;
  const crash: SiteCode = { ...exampleCode, tools: { ...rest, async search_products() { throw new TypeError('x is undefined'); } } };
  const { session, log } = await exampleSession({ code: crash });
  session.ids.learn('product', 1);
  session.ids.learn('product', 2);
  assert.deepEqual(await runToolCall(session, 'compare_products', { productIds: [1, 2] }).then((r) => !r.ok && [r.error.code, r.error.reason]), ['tool_disabled', 'not_built']);
  const r = await runToolCall(session, 'search_products', { query: 'x' });
  assert.equal(reason(r), 'site_code_error');
  assert.doesNotMatch(!r.ok ? r.error.message : '', /x is undefined/, "the crash's details stay out of the model's view");
  assert.ok(log.some((e) => e.kind === 'tool_crashed' && JSON.stringify(e.detail).includes('x is undefined')));
});

test("ctx.fail raises one of the tool's own errors; an error it doesn't declare is our bug", async () => {
  const failing = (why: string): SiteCode => ({ ...exampleCode, tools: { ...exampleCode.tools, async get_offer(ctx) { return ctx.fail(why); } } });
  for (const [why, code, r] of [['offer_gone', 'expired', 'offer_gone'], ['nope', 'upstream_error', 'site_code_error']] as const) {
    const { session } = await exampleSession({ code: failing(why) });
    session.ids.learn('offer', 'of_ab12', { expiresAt: START + 60_000 });
    const out = await runToolCall(session, 'get_offer', { offerId: 'of_ab12' });
    assert.deepEqual(!out.ok && [out.error.code, out.error.reason], [code, r]);
  }
});

test("an output that breaks the tool's schema is never shown to the model", async () => {
  const validators = exampleValidators({ 'tools/search_products.output.json': (d) => !('secret' in d) });
  const leaky: SiteCode = { ...exampleCode, tools: { ...exampleCode.tools, async search_products() { return { products: [], secret: 'internal' }; } } };
  const { session, log } = await exampleSession({ code: leaky, validators });
  const r = await runToolCall(session, 'search_products', { query: 'x' });
  assert.equal(reason(r), 'response_changed');
  assert.ok(!JSON.stringify(r).includes('internal'));
  assert.ok(log.some((e) => e.kind === 'output_check'));
});

test("outputs get the site pack's next step; their IDs join the known IDs, with expiry; records are kept for Respond", async () => {
  const { session, clock } = await exampleSession();
  const r = await runToolCall(session, 'search_products', { query: 'shoe' });
  assert.ok(r.ok);
  assert.equal(r.output.nextStep, 'To see an offer, call get_offer with its ID.');
  assert.deepEqual(r.output.products, [
    { id: 1, name: 'Red Shoe', price: 40, total: 45.5, rating: 4.5 },
    { id: 2, name: 'Blue Shoe', price: 1250, total: 1250, rating: 3.9 },
  ]);
  const now = clock.now();
  assert.deepEqual(['product:1', 'product:2', 'offer:of_ab12', 'coupon:SAVEX', 'token:tok_1'].map((k) => {
    const [kind, id] = k.split(':');
    return session.ids.status(kind!, kind === 'product' ? Number(id) : id, now);
  }), ['known', 'known', 'known', 'known', 'known']);
  assert.equal(session.ids.status('offer', 'of_ab12', Date.parse(SEARCH_RESPONSE.offers[0]!.expiresAt)), 'expired');
  assert.equal(session.ids.status('coupon', 'SAVEX', now + 600_000), 'expired', 'coupons last ten minutes once shown');
  assert.deepEqual(Object.fromEntries(session.recordsFor('product', 1)!), { search_products: { id: 1, name: 'Red Shoe', price: 40, total: 45.5, rating: 4.5 } });
  session.ids.learn('product', 7);
  await runToolCall(session, 'read_product_page', { productId: 7 });
  assert.deepEqual(Object.fromEntries(session.recordsFor('product', 7)!), { read_product_page: { name: 'Product 7' } }, 'kept for the input ID when the output has none');
});

test('ctx.keep adds details for display', async () => {
  const code: SiteCode = { ...exampleCode, tools: { ...exampleCode.tools, async get_offer(ctx) {
    ctx.keep('offer', ctx.args.offerId, { amount: 30 });
    return {};
  } } };
  const { session } = await exampleSession({ code });
  session.ids.learn('offer', 'of_ab12', { expiresAt: START + 60_000 });
  await runToolCall(session, 'get_offer', { offerId: 'of_ab12' });
  assert.deepEqual(Object.fromEntries(session.recordsFor('offer', 'of_ab12')!), { 'get_offer:kept': { amount: 30 }, get_offer: {} }, 'kept details, then the output for the input ID');
});
