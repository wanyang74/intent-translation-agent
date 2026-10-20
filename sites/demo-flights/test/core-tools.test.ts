// Tests: Demo Flights' tools run by core.js, end to end on the client: a trips list behind sign-in, offers that expire
// while the session goes on, and arguments the airline's form rules don't allow.
// How: core.js's Execute and Respond with FakeHost answering from Demo Flights' fixtures.
// Passes when: refused calls send no request, and allowed ones come back and show as the site pack says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PresentationCall } from '../../../platform/contract/generated/types.ts';
import { present, runToolCall, startSession } from '../../../platform/core/src/index.ts';
import { loadFixtures } from '../../../platform/testkit/src/fixtures.ts';
import { loadSiteRuntime } from '../../../platform/testkit/src/site-runtime.ts';
import { testHost } from '../../../platform/testkit/src/test-host.ts';

const rt = await loadSiteRuntime('demo-flights');
const START = '2026-10-12T18:05:00Z';
const search = { origin: 'SFO', destination: 'JFK', departDate: '2026-11-20', adults: 1, cabin: 'economy' };

async function session(signedIn = false) {
  const harness = testHost({ site: 'demo-flights', fixtures: loadFixtures('demo-flights'), start: START });
  const { session: coreSession } = await startSession({ pack: rt.pack, site: rt.code, validators: rt.validators, host: harness.host });
  coreSession.setPage({ url: 'https://www.demo-flights.example/trips', pageType: 'trips', ...(signedIn ? { signedIn: true } : {}) });
  return { ...harness, coreSession };
}

test('sign-in: the trips list is refused when signed out, with no request, and shown when signed in', async () => {
  const out = await session(false);
  const refused = await runToolCall(out.coreSession, 'get_trips', { status: 'upcoming' });
  assert.deepEqual(!refused.ok && [refused.error.code, refused.error.reason], ['auth_required', 'signed_out']);
  assert.equal(out.fake.calls.length, 0);
  const signed = await session(true);
  const trips = await runToolCall(signed.coreSession, 'get_trips', { status: 'upcoming' });
  assert.deepEqual(trips.ok && trips.output, { trips: [{ recordLocator: 'Q7K2LM', route: 'SFO to SEA', departs: '2026-12-03T16:00:00Z', status: 'confirmed' }] });
  const [list] = present(signed.coreSession, [{ name: 'present_items', args: { entity: 'trip', ids: ['Q7K2LM'] } }]).components;
  assert.deepEqual(list?.type === 'items' && [list.items[0]!.title, list.items[0]!.subtitle], ['SFO to SEA', '2026-12-03T16:00:00Z']);
});

test('offer expiry: offers can be shown while current; after they expire, the card is refused', async () => {
  const { coreSession, clock } = await session();
  const outcome = await runToolCall(coreSession, 'search_flights', search);
  assert.ok(outcome.ok);
  assert.deepEqual((outcome.output.offers as { offerId: string }[]).map((offer) => offer.offerId), ['off_7GQ2', 'off_9KD1', 'off_3MZ8']);
  const call: PresentationCall = { name: 'present_items', args: { entity: 'flight_offer', ids: ['off_3MZ8'] } };
  const now = present(coreSession, [call]);
  assert.deepEqual(now.components.map((component) => component.type), ['items', 'notice'], 'with the full-fare notice');
  assert.equal(now.components[0]!.type === 'items' && now.components[0]!.items[0]!.fields[0]!.text, '$301.20');
  clock.advance(30 * 60_000);
  assert.deepEqual(present(coreSession, [call]).refused.map((refusal) => refusal.error.code), ['expired']);
});

test("form rules: arguments the airline's rules don't allow are refused before any request", async () => {
  const { coreSession, fake } = await session();
  for (const args of [{ ...search, origin: 'sfo' }, { ...search, adults: 0 }, { ...search, cabin: 'luxury' }]) {
    const outcome = await runToolCall(coreSession, 'search_flights', args);
    assert.equal(!outcome.ok && outcome.error.reason, 'bad_arguments', JSON.stringify(args));
  }
  assert.equal(fake.calls.length, 0);
});
