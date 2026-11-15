// Tests: Demo Flights' tools run by core.js, end to end on the client: a trips list behind sign-in and the user's
// permission, with its record locators kept on the device, offers that expire while the session goes on, and
// arguments the airline's form rules don't allow.
// How: core.js's Execute and Respond with FakeHost answering from Demo Flights' fixtures.
// Passes when: refused calls send no request, allowed ones come back and show as the site pack says, and the model's
// copy of the trips holds a stand-in for each record locator, which shows the same card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PresentationCall } from '../../../platform/contract/generated/types.ts';
import { present, runToolCall, startSession } from '../../../platform/core/src/index.ts';
import { modelCopy } from '../../../platform/core/src/execute/execute.ts';
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

test("sign-in: the trips list is refused when signed out, and when signed in until the user allows it, with no request; then it's shown", async () => {
  const out = await session(false);
  const refused = await runToolCall(out.coreSession, 'get_trips', { status: 'upcoming' });
  assert.deepEqual(!refused.ok && [refused.error.code, refused.error.reason], ['auth_required', 'signed_out']);
  assert.equal(out.fake.calls.length, 0);
  const signed = await session(true);
  const notAllowed = await runToolCall(signed.coreSession, 'get_trips', { status: 'upcoming' });
  assert.deepEqual(!notAllowed.ok && [notAllowed.error.code, notAllowed.error.reason], ['auth_required', 'needs_consent']);
  assert.match(!notAllowed.ok ? notAllowed.error.message : '', /reads the user's Demo Flights account/);
  assert.equal(signed.fake.calls.length, 0, 'nothing is read before the user allows it');
  signed.coreSession.accountAllowed = true;
  const trips = await runToolCall(signed.coreSession, 'get_trips', { status: 'upcoming' });
  assert.deepEqual(trips.ok && trips.output, { trips: [{ recordLocator: 'Q7K2LM', route: 'SFO to SEA', departs: '2026-12-03T16:00:00Z', status: 'confirmed', traveler: 'Alex Rivera' }] });
  const [list] = present(signed.coreSession, [{ name: 'present_items', args: { entity: 'trip', ids: ['Q7K2LM'] } }]).components;
  assert.deepEqual(list?.type === 'items' && [list.items[0]!.title, list.items[0]!.subtitle], ['SFO to SEA', '2026-12-03T16:00:00Z']);
});

test("private IDs: the model's copy of the trips has a stand-in for each record locator, and the stand-in shows the same card", async () => {
  const signed = await session(true);
  signed.coreSession.accountAllowed = true;
  const trips = await runToolCall(signed.coreSession, 'get_trips', { status: 'upcoming' });
  assert.ok(trips.ok);
  const forModel = modelCopy(signed.coreSession, 'get_trips', trips.output);
  assert.deepEqual(forModel, { trips: [{ recordLocator: 'withheld:1', route: 'SFO to SEA', departs: '2026-12-03T16:00:00Z', status: 'confirmed', traveler: 'Alex Rivera' }] });
  assert.ok(!JSON.stringify(forModel).includes('Q7K2LM'));
  assert.equal(modelCopy(signed.coreSession, 'get_trips', trips.output).trips && signed.coreSession.withheld.size, 1, 'the same value keeps its stand-in');
  const shown = present(signed.coreSession, [{ name: 'present_items', args: { entity: 'trip', ids: ['withheld:1'] } }]);
  assert.deepEqual(shown.refused, []);
  const [list] = shown.components;
  assert.deepEqual(list?.type === 'items' && [list.items[0]!.title, list.items[0]!.id], ['SFO to SEA', 'Q7K2LM'], 'the card is filled on the device, with the real value');
  assert.equal(present(signed.coreSession, [{ name: 'present_items', args: { entity: 'trip', ids: ['withheld:9'] } }]).refused.length, 1, 'a stand-in the session never issued is unknown');
  // The stand-ins go with the session to the next page.
  const restored = await startSession({ pack: rt.pack, site: rt.code, validators: rt.validators, host: signed.host, restore: signed.coreSession.snapshot() });
  assert.deepEqual(restored.session.withheld.resolve('withheld:1'), 'Q7K2LM');
  assert.equal(restored.session.accountAllowed, true);
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
