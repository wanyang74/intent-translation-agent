// FakeHost: replays recorded traffic, enforces the contract like Carvana does, and injects faults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeHost } from '../src/fake-host.ts';
import { loadFixtures, type Fixture, type HostRequest } from '../src/fixtures.ts';

const fixtures = loadFixtures();
const byId = (id: string) => {
  const f = fixtures.find((x) => x.id === id);
  if (!f) throw new Error(`no fixture ${id}`);
  return structuredClone(f);
};
const asRequest = (f: Fixture, body: unknown = f.request.body): HostRequest => ({
  method: f.request.method, url: f.request.url, headers: f.request.headers,
  body: body === null ? null : JSON.stringify(body),
});
const json = (s: string) => JSON.parse(s);

test('replays every recorded fixture exactly', async () => {
  const host = new FakeHost(fixtures);
  for (const f of fixtures.filter((x) => x.kind === 'recorded')) {
    const res = await host.request(asRequest(f));
    assert.equal(res.status, 200, f.id);
    assert.deepEqual(json(res.body), f.response.body, f.id);
  }
});

test('a request with fresh tracking IDs still gets the recorded response', async () => {
  const host = new FakeHost(fixtures);
  const f = byId('search-03');
  const body = f.request.body as Record<string, any>;
  body.browserCookieId = 'ffffffff-0000-4000-8000-000000000001';
  body.analyticsData = { clientId: 'srp_ui', searchSessionId: 'ffffffff-0000-4000-8000-000000000002' };
  const res = await host.request(asRequest(f, body));
  assert.deepEqual(json(res.body), byId('search-03').response.body);
  assert.equal(host.calls.at(-1)?.fixtureId, 'search-03');
});

test('a quote without a client ID gets the error Carvana returned live', async () => {
  const host = new FakeHost(fixtures);
  const f = byId('pricing-01');
  const noBlock = { ...(f.request.body as object), analyticsData: undefined };
  const emptyBlock = { ...(f.request.body as object), analyticsData: {} };
  for (const body of [noBlock, emptyBlock]) {
    const res = await host.request(asRequest(f, JSON.parse(JSON.stringify(body))));
    assert.equal(res.status, 400);
    assert.equal(res.body, 'ClientId cannot be null');
  }
});

test('suggestions without a visitor ID get "Invalid Request"; a GAP check with no amount gets a validation problem', async () => {
  const host = new FakeHost(fixtures);
  const s = byId('suggest-02');
  const { browserCookieId, ...noVisitor } = s.request.body as Record<string, unknown>;
  assert.ok(browserCookieId);
  const res = await host.request(asRequest(s, noVisitor));
  assert.deepEqual([res.status, res.body], [400, 'Invalid Request']);

  const g = byId('gap-01');
  const url = new URL(g.request.url);
  url.searchParams.set('amountFinanced', 'null');
  const gapRes = await host.request({ method: 'GET', url: url.toString() });
  assert.equal(gapRes.status, 400);
  assert.match(json(gapRes.body).errors.AmountFinanced[0], /not valid/);
});

test('any other contract break gets a generic 400 that names the problem, not a recorded error', async () => {
  const host = new FakeHost(fixtures);
  const f = byId('pricing-01');
  const res = await host.request(asRequest(f, { ...(f.request.body as object), zip5: '9440' }));
  assert.equal(res.status, 400);
  assert.match(json(res.body).details, /zip5/);
});

test('a request with no matching fixture fails loudly and lists what was recorded', async () => {
  const host = new FakeHost(fixtures);
  const f = byId('search-01');
  const body = { ...(f.request.body as object), filters: { makes: [{ name: 'Toyota' }] } };
  await assert.rejects(host.request(asRequest(f, body)), (err: Error) => {
    assert.match(err.message, /no search fixture matches/);
    assert.match(err.message, /Tesla/);
    return true;
  });
});

test('injected faults apply to the next matching calls only', async () => {
  const host = new FakeHost(fixtures);
  const search = byId('search-01');
  const reviews = byId('reviews-01');

  host.inject({ endpoint: 'search', status: 429, headers: { 'retry-after': '30' } });
  assert.equal((await host.request(asRequest(reviews))).status, 200, 'a search fault must not hit other endpoints');
  assert.equal((await host.request(asRequest(search))).status, 429);
  assert.equal((await host.request(asRequest(search))).status, 200, 'the fault applies once by default');

  host.inject({ endpoint: 'search', networkError: 'socket hang up', times: 2 });
  await assert.rejects(host.request(asRequest(search)), /socket hang up/);
  await assert.rejects(host.request(asRequest(search)), /socket hang up/);
  assert.equal((await host.request(asRequest(search))).status, 200);

  host.inject({ delayMs: 120 });
  const t0 = Date.now();
  await host.request(asRequest(search));
  assert.ok(Date.now() - t0 >= 110, 'delay applies');
});

test('the call log records each call and which fixture answered it', async () => {
  const host = new FakeHost(fixtures);
  await host.request(asRequest(byId('search-02')));
  await host.request(asRequest(byId('availability-02')));
  assert.deepEqual(host.calls.map((c) => [c.endpoint, c.fixtureId, c.status]), [['search', 'search-02', 200], ['availability', 'availability-02', 200]]);
});

test('the vehicle-page availability shape is accepted and replayed', async () => {
  const host = new FakeHost(fixtures);
  const f = byId('availability-09');
  assert.ok(!('userId' in (f.request.body as object)));
  const res = await host.request(asRequest(f));
  assert.equal(res.status, 200);
  assert.equal(json(res.body).content.length, 50);
});
