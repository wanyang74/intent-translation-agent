// FakeHost on Carvana's fixtures: the behavior specific to Carvana. The errors it returned live in phase 0
// when tracking fields were missing (decision D4), and its two availability request shapes. Generic FakeHost
// behavior is tested for every site in platform/testkit/test/fake-host.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeHost } from '../../../platform/testkit/src/fake-host.ts';
import { loadFixtures, toHostRequest } from '../../../platform/testkit/src/fixtures.ts';

const fixtures = loadFixtures('carvana');
const byId = (id: string) => {
  const fixture = fixtures.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`no fixture ${id}`);
  return structuredClone(fixture);
};
const json = (text: string) => JSON.parse(text);

test('a search with fresh tracking IDs still gets the recorded response', async () => {
  const host = new FakeHost('carvana', fixtures);
  const fixture = byId('search-03');
  const body = fixture.request.body as Record<string, any>;
  body.browserCookieId = 'ffffffff-0000-4000-8000-000000000001';
  body.analyticsData = { clientId: 'srp_ui', searchSessionId: 'ffffffff-0000-4000-8000-000000000002' };
  const res = await host.request(toHostRequest(fixture, body));
  assert.deepEqual(json(res.body), byId('search-03').response.body);
  assert.equal(host.calls.at(-1)?.fixtureId, 'search-03');
});

test('a quote without a client ID gets the error Carvana returned live', async () => {
  const host = new FakeHost('carvana', fixtures);
  const fixture = byId('pricing-01');
  const noBlock = { ...(fixture.request.body as object), analyticsData: undefined };
  const emptyBlock = { ...(fixture.request.body as object), analyticsData: {} };
  for (const body of [noBlock, emptyBlock]) {
    const res = await host.request(toHostRequest(fixture, JSON.parse(JSON.stringify(body))));
    assert.equal(res.status, 400);
    assert.equal(res.body, 'ClientId cannot be null');
  }
});

test('suggestions without a visitor ID get "Invalid Request"; a GAP check with no amount gets a validation problem', async () => {
  const host = new FakeHost('carvana', fixtures);
  const recorded = byId('suggest-02');
  const { browserCookieId, ...noVisitor } = recorded.request.body as Record<string, unknown>;
  assert.ok(browserCookieId);
  const res = await host.request(toHostRequest(recorded, noVisitor));
  assert.deepEqual([res.status, res.body], [400, 'Invalid Request']);

  const fixture = byId('gap-01');
  const url = new URL(fixture.request.url);
  url.searchParams.set('amountFinanced', 'null');
  const gapRes = await host.request({ method: 'GET', url: url.toString() });
  assert.equal(gapRes.status, 400);
  assert.match(json(gapRes.body).errors.AmountFinanced[0], /not valid/);
});

test('any other contract break gets a generic 400 that names the problem, not a recorded error', async () => {
  const host = new FakeHost('carvana', fixtures);
  const fixture = byId('pricing-01');
  const res = await host.request(toHostRequest(fixture, { ...(fixture.request.body as object), zip5: '9440' }));
  assert.equal(res.status, 400);
  assert.match(json(res.body).details, /zip5/);
});

test('a search with no matching fixture lists the recorded searches', async () => {
  const host = new FakeHost('carvana', fixtures);
  const fixture = byId('search-01');
  const body = { ...(fixture.request.body as object), filters: { makes: [{ name: 'Toyota' }] } };
  await assert.rejects(host.request(toHostRequest(fixture, body)), (err: Error) => {
    assert.match(err.message, /no search fixture matches/);
    assert.match(err.message, /Tesla/);
    return true;
  });
});

test('the vehicle-page availability shape is accepted and replayed', async () => {
  const host = new FakeHost('carvana', fixtures);
  const fixture = byId('availability-09');
  assert.ok(!('userId' in (fixture.request.body as object)));
  const res = await host.request(toHostRequest(fixture));
  assert.equal(res.status, 200);
  assert.equal(json(res.body).content.length, 50);
});
