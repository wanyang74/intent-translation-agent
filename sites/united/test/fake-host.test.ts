// Tests: FakeHost on United's fixtures, which stand in for united.com in every other test.
// How: sends recorded requests with and without United's token, and reads a search back as the stream it was.
// Passes when: a call without the token is refused with 405, as United refused it live (2026-11-06); the token call
// needs none; and a search answers as a stream of events, one flight option each, framed by its meta event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupEvents, parseEventStream } from '../../../platform/contract/src/events.ts';
import { FakeHost } from '../../../platform/testkit/src/fake-host.ts';
import { loadFixtures, toHostRequest } from '../../../platform/testkit/src/fixtures.ts';

const fixtures = loadFixtures('united');
const byId = (id: string) => structuredClone(fixtures.find((fixture) => fixture.id === id)!);

test("token: a call without United's token is refused with 405, as United refuses it; the token call needs none", async () => {
  const host = new FakeHost('united', fixtures);
  const lookup = toHostRequest(byId('airports-01'));
  assert.equal((await host.request({ ...lookup, headers: { accept: 'application/json' } })).status, 405);
  assert.equal((await host.request(lookup)).status, 200, "the fixture's own request carries the fixture token");
  const token = JSON.parse((await host.request(toHostRequest(byId('token-01')))).body);
  assert.equal(token.data.token.hash, 'fixture-token-0001');
});

test('search: answers as a stream of events, grouped by their type into the search and its flight options', async () => {
  const host = new FakeHost('united', fixtures);
  const res = await host.request(toHostRequest(byId('flights-01')));
  assert.match(res.body, /^data: \{"type":"meta"/);
  const grouped = groupEvents(parseEventStream(res.body), 'type') as Record<string, { flight?: { hash: string } }[]>;
  assert.equal(grouped.meta!.length, 1);
  assert.equal(grouped.flightOption!.length, 10, 'the fixture keeps the first 10 of the 47 recorded');
  assert.equal(grouped.flightOption![0]!.flight!.hash, '356-857-UA');
});
