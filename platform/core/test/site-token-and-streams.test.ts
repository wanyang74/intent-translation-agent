// Tests: the site token and streamed answers in Execute (core/src/execute/endpoints.ts), for sites whose frontend
// sends an anonymous token with every call, and whose answers arrive as a stream of events (L3).
// How: the made-up shop with a token endpoint added and its search turned into a stream, a scripted network that
// issues tokens and refuses calls without a current one, and a virtual clock.
// Passes when: the token is fetched once, shared by calls side by side, sent in the site's own format, renewed before it
// expires and after a refusal (with one retry only), carried to the next page, and never written to the log; a broken
// token answer is a changed format; a tool that needs sign-in, where the page keeps the token, sends the page's (read
// each time, never kept or logged) and treats none or a refusal as signed out; a stream is read whole and grouped by kind before the site's code and the schema
// see it; and an endpoint's own time limit reaches the host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SitePack } from '../../contract/generated/types.ts';
import type { HostRequest, HostResponse } from '../src/runtime/host.ts';
import { runToolCall, startSession, type SiteCode } from '../src/index.ts';
import { examplePack } from './example-pack.ts';
import { exampleCode, exampleSession, exampleValidators, json, SEARCH_RESPONSE, START } from './example-site.ts';

const reason = (outcome: { ok: boolean; error?: { reason?: string } }) => (outcome.ok ? 'ok' : outcome.error!.reason);
const HOUR = 60 * 60 * 1000;

const tokenPack: SitePack = {
  ...examplePack,
  endpoints: {
    ...examplePack.endpoints,
    session: { method: 'GET', url: 'https://api.example.com/session', request: 'endpoints/session.request.json', response: 'endpoints/session.response.json', matchKey: [] },
  },
  token: { endpoint: 'session', value: 'data.token', expiresAt: 'data.expiresAt', header: 'X-Shop-Token', format: 'bearer {token}', refusedStatuses: [405] },
};

/** A site that issues numbered tokens lasting an hour and refuses any call without the newest one, as a real one does. */
function tokenSite(options: { refuse?: (req: HostRequest) => boolean; tokenAnswer?: () => HostResponse } = {}) {
  let issued = 0;
  const valid = new Set<string>();
  const network = (now: () => number) => (req: HostRequest): HostResponse => {
    const url = new URL(req.url);
    if (url.pathname === '/session') {
      if (options.tokenAnswer) return options.tokenAnswer();
      const token = `sess-${++issued}`;
      valid.add(`bearer ${token}`);
      return json({ data: { token, expiresAt: new Date(now() + HOUR).toISOString() } });
    }
    if (!valid.has(req.headers['X-Shop-Token'] ?? '') || options.refuse?.(req)) return json('', 405);
    return json(SEARCH_RESPONSE);
  };
  return { network, valid, issuedCount: () => issued };
}

async function tokenSession(site = tokenSite()) {
  let clockNow = () => START;
  const shop = await exampleSession({ pack: tokenPack, validators: exampleValidators({}, tokenPack), network: (req) => site.network(clockNow)(req) });
  clockNow = () => shop.clock.now();
  return { ...shop, site };
}

const tokenRequests = (requests: HostRequest[]) => requests.filter((request) => request.url.endsWith('/session'));

test("site token: fetched once, sent on every call in the site's format, never sent to its own endpoint and never logged", async () => {
  const { session, requests, log } = await tokenSession();
  assert.equal(reason(await runToolCall(session, 'search_products', { query: 'shoe' })), 'ok');
  assert.equal(reason(await runToolCall(session, 'search_products', { query: 'boot' })), 'ok');
  assert.equal(tokenRequests(requests).length, 1);
  assert.equal(tokenRequests(requests)[0]!.headers['X-Shop-Token'], undefined);
  const searches = requests.filter((request) => request.url.endsWith('/search'));
  assert.deepEqual(searches.map((request) => request.headers['X-Shop-Token']), ['bearer sess-1', 'bearer sess-1']);
  assert.ok(!JSON.stringify(log).includes('sess-1'), 'the token never reaches the log');
  assert.deepEqual(log.find((entry) => entry.kind === 'token')!.detail, { endpoint: 'session', lastsSeconds: 3600 });
});

test('site token: tool calls side by side share one token request', async () => {
  const { session, requests } = await tokenSession();
  const outcomes = await Promise.all(['shoe', 'boot', 'sock'].map((query) => runToolCall(session, 'search_products', { query })));
  assert.deepEqual(outcomes.map(reason), ['ok', 'ok', 'ok']);
  assert.equal(tokenRequests(requests).length, 1);
});

test('site token: a new one is fetched a few minutes before the old one expires', async () => {
  const { session, requests, clock } = await tokenSession();
  await runToolCall(session, 'search_products', { query: 'shoe' });
  clock.advance(HOUR - 6 * 60_000);
  await runToolCall(session, 'search_products', { query: 'boot' });
  assert.equal(tokenRequests(requests).length, 1, 'six minutes left: still good');
  clock.advance(2 * 60_000);
  await runToolCall(session, 'search_products', { query: 'sock' });
  assert.equal(tokenRequests(requests).length, 2, 'four minutes left: inside the five-minute margin');
  assert.equal(requests.at(-1)!.headers['X-Shop-Token'], 'bearer sess-2');
});

test('site token: a refusal gets a new token and one retry; a second refusal is an error, not a loop', async () => {
  // The site drops sess-1 on its side, as when it expires early: the retry with sess-2 goes through.
  const revoked = tokenSite({ refuse: (req) => req.headers['X-Shop-Token'] === 'bearer sess-1' });
  const once = await tokenSession(revoked);
  assert.equal(reason(await runToolCall(once.session, 'search_products', { query: 'shoe' })), 'ok');
  assert.deepEqual(once.requests.map((request) => new URL(request.url).pathname), ['/session', '/search', '/session', '/search']);
  assert.ok(once.log.some((entry) => entry.kind === 'token_refused'));

  const always = await tokenSession(tokenSite({ refuse: () => true }));
  const outcome = await runToolCall(always.session, 'search_products', { query: 'shoe' });
  assert.equal(reason(outcome), 'site_refused');
  assert.equal(always.requests.filter((request) => request.url.endsWith('/search')).length, 2);
});

test('site token: an answer without a token is a changed format, and the call it was for is never sent', async () => {
  const { session, requests, log } = await tokenSession(tokenSite({ tokenAnswer: () => json({ data: { expiresAt: '2026-10-14T13:00:00Z' } }) }));
  assert.equal(reason(await runToolCall(session, 'search_products', { query: 'shoe' })), 'response_changed');
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), ['/session']);
  assert.ok(log.some((entry) => entry.kind === 'response_check' && JSON.stringify(entry.detail).includes('no token')));
});

test("site token: the next page's session carries on with the same token instead of fetching another", async () => {
  const first = await tokenSession();
  await runToolCall(first.session, 'search_products', { query: 'shoe' });
  const snapshot = first.session.snapshot();
  const { session: next } = await startSession({ pack: tokenPack, site: exampleCode, validators: exampleValidators({}, tokenPack), host: first.host, restore: snapshot });
  next.setPage({ url: 'https://www.example.com/p/1', pageType: 'home' });
  await runToolCall(next, 'search_products', { query: 'boot' });
  assert.equal(tokenRequests(first.requests).length, 1);
  assert.equal(first.requests.at(-2)!.headers['X-Shop-Token'], 'bearer sess-1');
});

test('site token: a site without one sends no token header and makes no token call', async () => {
  const { session, requests } = await exampleSession();
  await runToolCall(session, 'search_products', { query: 'shoe' });
  assert.ok(requests.every((request) => !Object.keys(request.headers).some((header) => /token/i.test(header))));
});

// ---------------------------------------------------------------- the page's signed-in token (D7)

const pageSignedPack: SitePack = { ...tokenPack, token: { ...tokenPack.token!, signedIn: { from: 'page' } } };

/** The shop signed with the page's token for its orders: the anonymous token reads products, only the page's reads orders. */
async function pageSignedSession(pageToken: () => Promise<string | null>, options: { refuseOrders?: boolean } = {}) {
  const site = tokenSite();
  let clockNow = () => START;
  const network = (req: HostRequest): HostResponse => {
    if (new URL(req.url).pathname !== '/orders') return site.network(clockNow)(req);
    return req.headers['X-Shop-Token'] === 'bearer page-token-1' && !options.refuseOrders ? json({ orders: [{ id: 'ABC123', status: 'open' }] }) : json('', 405);
  };
  const shop = await exampleSession({ pack: pageSignedPack, validators: exampleValidators({}, pageSignedPack), network, host: { pageToken } });
  clockNow = () => shop.clock.now();
  shop.session.setPage({ url: 'https://www.example.com/account', pageType: 'account', signedIn: true });
  shop.session.accountAllowed = true;
  return shop;
}

test("page token: a tool that needs sign-in sends the page's token, read for each call and never kept or logged; other tools keep the anonymous one", async () => {
  let reads = 0;
  const { session, requests, log } = await pageSignedSession(async () => { reads++; return 'page-token-1'; });
  assert.equal(reason(await runToolCall(session, 'my_orders', {})), 'ok');
  assert.equal(reason(await runToolCall(session, 'search_products', { query: 'shoe' })), 'ok');
  const orders = requests.find((request) => request.url.includes('/orders'))!;
  const search = requests.find((request) => request.url.includes('/search'))!;
  assert.equal(orders.headers['X-Shop-Token'], 'bearer page-token-1');
  assert.equal(search.headers['X-Shop-Token'], 'bearer sess-1');
  assert.equal(reads, 1, 'read only for the tool that needs sign-in');
  assert.equal(session.siteToken?.value, 'sess-1', 'the session keeps only the anonymous token');
  assert.ok(!JSON.stringify(log).includes('page-token-1'), 'the log never has it');
});

test("page token: none on the page, or one the site refuses, means signed out: no anonymous token instead, and no retry", async () => {
  const signedOut = await pageSignedSession(async () => null);
  const missing = await runToolCall(signedOut.session, 'my_orders', {});
  assert.equal(missing.ok ? 'ok' : missing.error.code, 'auth_required');
  assert.equal(signedOut.requests.length, 0, 'nothing was sent');
  const refused = await pageSignedSession(async () => 'page-token-1', { refuseOrders: true });
  const outcome = await runToolCall(refused.session, 'my_orders', {});
  assert.equal(outcome.ok ? 'ok' : outcome.error.code, 'auth_required');
  assert.equal(refused.requests.filter((request) => request.url.includes('/orders')).length, 1, 'one try');
  assert.equal(tokenRequests(refused.requests).length, 0, 'no anonymous token was fetched for it');
});

// ---------------------------------------------------------------- streams

const streamPack: SitePack = {
  ...examplePack,
  endpoints: { ...examplePack.endpoints, search: { ...examplePack.endpoints.search!, responseFormat: 'sse', eventKind: 'type', timeoutSeconds: 40, ids: [{ kind: 'product', path: 'item[].id' }] } },
};

const STREAM = [
  ': connected',
  '',
  'data: {"type":"meta","total":2}',
  '',
  'data: {"type":"item","id":1,"name":"Red Shoe","price":40,"shipping":{"cost":5.5},"rating":4.5}',
  '',
  'data: {"type":"item",',
  'data: "id":2,"name":"Blue Shoe","price":1250,"shipping":{"cost":0},"rating":3.9}',
  '',
  'event: done',
  'data: finished',
  '',
].join('\r\n');

const streamCode: SiteCode = {
  ...exampleCode,
  tools: {
    ...exampleCode.tools,
    async search_products(ctx) {
      const res = await ctx.call('search', { body: { query: ctx.args.query ?? '', colors: [] } });
      // Only the first item, so the second one's ID can only have been learned from the stream itself.
      const [first] = res.item as { id: number; name: string; price: number }[];
      return { products: [{ id: first!.id, name: first!.name, price: first!.price }], offers: [], coupons: [], token: res.done[0] };
    },
  },
};

test('streams: the site is asked for an event stream, read whole, and grouped by kind for the schema and the site code', async () => {
  const checked: unknown[] = [];
  const validators = exampleValidators({ 'endpoints/search.response.json': (data) => { checked.push(data); return true; } }, streamPack);
  const network = (req: HostRequest): HostResponse => req.url.endsWith('/search')
    ? { status: 200, headers: { 'content-type': 'text/event-stream' }, body: STREAM }
    : json({ colors: [] });
  const { session, requests } = await exampleSession({ pack: streamPack, code: streamCode, validators, network });
  const outcome = await runToolCall(session, 'search_products', { query: 'shoe' });
  assert.equal(reason(outcome), 'ok');
  assert.equal(requests[0]!.headers.accept, 'text/event-stream');
  const grouped = checked[0] as Record<string, unknown[]>;
  assert.deepEqual(Object.keys(grouped), ['meta', 'item', 'done']);
  assert.equal(grouped.item!.length, 2, 'data split over two lines is one event');
  assert.deepEqual(grouped.done, ['finished'], "an event named by the stream, with data that isn't JSON");
  assert.deepEqual(outcome.ok && (outcome.output as { products: { id: number }[] }).products.map((product) => product.id), [1]);
  assert.equal(session.ids.status('product', 2, START), 'known', "the endpoint's ID paths point into the grouped events");
});

test("timeouts: an endpoint's own time limit reaches the host; other endpoints leave the host's default", async () => {
  const network = (req: HostRequest): HostResponse => req.url.endsWith('/search')
    ? { status: 200, headers: {}, body: 'data: {"type":"item","id":1,"name":"Red Shoe","price":40}\n\ndata: {"type":"done"}\n\n' }
    : json({ colors: [] });
  const code: SiteCode = { ...streamCode, tools: { ...streamCode.tools, async search_products(ctx) {
    await ctx.call('search', { body: { query: 'x', colors: [] } });
    await ctx.call('filters', { query: { query: 'x' } });
    return { products: [], offers: [], coupons: [], token: 't' };
  } } };
  const { session, requests } = await exampleSession({ pack: streamPack, code, validators: exampleValidators({}, streamPack), network });
  await runToolCall(session, 'search_products', { query: 'x' });
  assert.deepEqual(requests.map((request) => request.timeoutMs), [40_000, undefined]);
});
