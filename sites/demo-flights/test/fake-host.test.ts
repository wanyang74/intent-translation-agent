// FakeHost on Demo Flights' hand-written fixtures: a search form's fields decide the response, and
// a request with an invalid airport code never reaches a fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeHost } from '../../../platform/testkit/src/fake-host.ts';
import { loadFixtures, toHostRequest } from '../../../platform/testkit/src/fixtures.ts';

const fixtures = loadFixtures('demo-flights');
const byId = (id: string) => structuredClone(fixtures.find((x) => x.id === id)!);
const json = (s: string) => JSON.parse(s);

test('a search returns the offers for that route, date, travelers and cabin', async () => {
  const host = new FakeHost('demo-flights', fixtures);
  const res = await host.request(toHostRequest(byId('offers-01')));
  assert.deepEqual(json(res.body).offers.map((o: { offerId: string }) => o.offerId), ['off_7GQ2', 'off_9KD1', 'off_3MZ8']);

  const none = await host.request(toHostRequest(byId('offers-no-results')));
  assert.deepEqual(json(none.body).offers, []);
});

test('a lowercase airport code breaks the contract and gets a 400 naming the field', async () => {
  const host = new FakeHost('demo-flights', fixtures);
  const f = byId('offers-01');
  const res = await host.request(toHostRequest(f, { ...(f.request.body as object), origin: 'sfo' }));
  assert.equal(res.status, 400);
  assert.match(json(res.body).details, /origin/);
});

test('the trips list is a GET whose status filter decides the response', async () => {
  const host = new FakeHost('demo-flights', fixtures);
  const res = await host.request({ method: 'GET', url: 'https://api.demo-flights.example/v1/trips?status=upcoming' });
  assert.equal(json(res.body).trips[0].recordLocator, 'Q7K2LM');
  await assert.rejects(host.request({ method: 'GET', url: 'https://api.demo-flights.example/v1/trips?status=past' }), /no trips fixture matches/);
});
