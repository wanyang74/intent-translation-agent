// Tests: FakeHost on Demo Flights' hand-written fixtures.
// How: sends search and trips requests with different fields, with and without the site's token.
// Passes when: the search form's fields decide the response, which arrives as a stream; a request with an invalid
// airport code never reaches a fixture; a call without a token the site issued is refused, as the site refuses it; and
// the trips list, which needs sign-in, takes only the page's signed-in token (D7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupEvents, parseEventStream } from '../../../platform/contract/src/events.ts';
import { FAKE_PAGE_TOKEN, FakeHost } from '../../../platform/testkit/src/fake-host.ts';
import { loadFixtures, toHostRequest } from '../../../platform/testkit/src/fixtures.ts';

const fixtures = loadFixtures('demo-flights');
const byId = (id: string) => structuredClone(fixtures.find((fixture) => fixture.id === id)!);
const json = (text: string) => JSON.parse(text);
const streamed = (text: string) => groupEvents(parseEventStream(text)) as { offer?: { offerId: string }[]; done: { count: number }[] };

test('search: streams the offers for that route, date, travelers and cabin', async () => {
  const host = new FakeHost('demo-flights', fixtures);
  const res = await host.request(toHostRequest(byId('offers-01')));
  assert.match(res.body, /^event: search\ndata: /);
  assert.deepEqual(streamed(res.body).offer!.map((offer) => offer.offerId), ['off_7GQ2', 'off_9KD1', 'off_3MZ8']);

  const none = streamed((await host.request(toHostRequest(byId('offers-no-results')))).body);
  assert.equal(none.offer, undefined);
  assert.deepEqual(none.done, [{ count: 0 }]);
});

test('token: a call without a token the site issued is refused with the site\'s status, and the token call needs none', async () => {
  const host = new FakeHost('demo-flights', fixtures);
  const request = toHostRequest(byId('offers-01'));
  assert.equal((await host.request({ ...request, headers: { accept: 'text/event-stream' } })).status, 403);
  assert.equal((await host.request({ ...request, headers: { 'X-Demo-Token': 'Bearer someone-elses' } })).status, 403);
  assert.equal((await host.request({ ...request, headers: { 'X-Demo-Token': 'Bearer fixture-token-0001' } })).status, 200, 'header names are case-insensitive');
  const token = await host.request(toHostRequest(byId('session_token-01')));
  assert.equal(json(token.body).token, 'fixture-token-0001');
});

test('contract: a lowercase airport code gets a 400 naming the field', async () => {
  const host = new FakeHost('demo-flights', fixtures);
  const fixture = byId('offers-01');
  const res = await host.request(toHostRequest(fixture, { ...(fixture.request.body as object), origin: 'sfo' }));
  assert.equal(res.status, 400);
  assert.match(json(res.body).details, /origin/);
});

test("trips: a GET whose status filter decides the response, signed with the page's token, not the anonymous one", async () => {
  const host = new FakeHost('demo-flights', fixtures);
  const url = 'https://api.demo-flights.example/v1/trips?status=upcoming';
  assert.equal((await host.request({ method: 'GET', url, headers: { 'x-demo-token': 'Bearer fixture-token-0001' } })).status, 403, 'the anonymous token reads no account');
  const headers = { 'x-demo-token': `Bearer ${FAKE_PAGE_TOKEN}` };
  const res = await host.request({ method: 'GET', url: 'https://api.demo-flights.example/v1/trips?status=upcoming', headers });
  assert.equal(json(res.body).trips[0].recordLocator, 'Q7K2LM');
  await assert.rejects(host.request({ method: 'GET', url: 'https://api.demo-flights.example/v1/trips?status=past', headers }), /no trips fixture matches/);
});
