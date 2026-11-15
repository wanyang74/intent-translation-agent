// Tests: the brain serving Demo Flights, a made-up airline that checks the platform has no Carvana assumptions:
// tools and items that need sign-in and the user's permission, private record locators, the flight search form and its
// prefill, and offers that expire.
// How: the real brain with the Demo Flights site pack, FakeModel as the model and FakeClient as core.js.
// Passes when: each call or card is sent or refused as the site pack says, with the airline's own wording; an account
// tool waits for the user's yes, and the answer asks for it; and a result with a real record locator is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PageContext } from '../../../platform/contract/generated/types.ts';
import { validatorFor } from '../../../platform/core/src/shared/validate.ts';
import { Brain } from '../../../platform/brain/src/agent/brain.ts';
import { loadSite } from '../../../platform/brain/src/prompt/site.ts';
import { loadConversations } from '../../../platform/testkit/src/conversations.ts';
import { FakeClient, inProcess, type ResultFor } from '../../../platform/testkit/src/fake-client.ts';
import { FakeModel, type FakeScript } from '../../../platform/testkit/src/fake-model.ts';

const bundle = await loadSite('demo-flights');
const validate = validatorFor(bundle.validators.platform, 'messages.json');
const conversation = loadConversations('demo-flights').find((example) => example.id === 'one-way-search')!;
const searchOutput = (conversation.messages.find((message) => message.type === 'results') as { results: { output: Record<string, unknown> }[] }).results[0]!.output;
// What core.js sends the brain: the record locator is private, so the model's copy holds its stand-in.
const TRIPS = { trips: [{ recordLocator: 'withheld:1', route: 'SFO to SEA', departs: '2026-12-03T16:00:00Z', status: 'confirmed' }] };
const HOME: PageContext = { url: 'https://www.demo-flights.example/', pageType: 'home', locale: 'en-US' };
const results: ResultFor = (call) => ({ ok: true, output: call.name === 'get_trips' ? TRIPS : searchOutput });
const search = { name: 'search_flights', input: { origin: 'SFO', destination: 'JFK', departDate: '2026-11-20', adults: 1, cabin: 'economy' } };

function setup(script: FakeScript[], now: () => number = () => Date.parse('2026-10-12T18:05:00Z')) {
  const model = new FakeModel(script);
  const brain = new Brain({ site: bundle, model, now });
  return { model, client: new FakeClient(inProcess(brain), { site: 'demo-flights', validate, results }) };
}
const reasons = (model: FakeModel, i: number) => (model.requests[i]!.messages.at(-1)!.content as { isError: boolean; output: { reason: string } }[])
  .map((part) => (part.isError ? part.output.reason : 'ok'));

const TRIPS_PAGE: PageContext = { ...HOME, url: 'https://www.demo-flights.example/trips', pageType: 'trips', signedIn: true };

test("sign-in: trips are refused in the airline's wording when signed out, held back until the user allows it, then sent", async () => {
  const out = setup([{ calls: [{ name: 'get_trips', input: { status: 'upcoming' } }] }, { text: 'Please sign in.' }]);
  const turn = await out.client.turn('my trips', HOME);
  assert.deepEqual(turn.calls, []);
  assert.deepEqual(reasons(out.model, 1), ['signed_out']);
  assert.equal(turn.answer?.askConsent, undefined, 'signed out: sign in first, no permission button');
  const signedIn = setup([
    { calls: [{ name: 'get_trips', input: { status: 'upcoming' } }] }, { text: "I'd look up your upcoming trips." },
    { calls: [{ name: 'get_trips', input: { status: 'upcoming' } }] }, { text: 'One trip.', calls: [{ name: 'present_items', input: { entity: 'trip', ids: ['withheld:1'] } }] },
    { calls: [{ name: 'get_trips', input: { status: 'past' } }] }, { text: 'None.' },
  ]);
  // 1. Signed in, not yet allowed: nothing goes to the client, and the answer asks.
  const asked = await signedIn.client.turn('my trips', TRIPS_PAGE);
  assert.deepEqual(asked.calls, []);
  assert.deepEqual(reasons(signedIn.model, 1), ['needs_consent']);
  assert.equal(asked.answer?.askConsent, true);
  // 2. The user's yes comes with the next message; the model hears it in the context block.
  const allowed = await signedIn.client.turn('Use my Demo Flights account to answer.', { ...TRIPS_PAGE, granted: ['account'] });
  assert.deepEqual(allowed.calls.map((call) => call.name), ['get_trips']);
  assert.deepEqual(allowed.answer?.present, [{ name: 'present_items', args: { entity: 'trip', ids: ['withheld:1'] } }]);
  assert.equal(allowed.answer?.askConsent, undefined);
  assert.match(JSON.stringify(signedIn.model.requests[2]!.messages.at(-1)), /Allowed with this message: reading the user's account/);
  // 3. It holds for the rest of the conversation.
  const later = await signedIn.client.turn('and past ones?', TRIPS_PAGE);
  assert.deepEqual(later.calls.map((call) => call.name), ['get_trips']);
});

test('private IDs: the brain refuses a result that carries a real record locator, where the model must get a stand-in', async () => {
  const leaky: ResultFor = (call) => ({ ok: true, output: call.name === 'get_trips' ? { trips: [{ ...TRIPS.trips[0]!, recordLocator: 'Q7K2LM' }] } : searchOutput });
  const { client, model } = setup([{ calls: [{ name: 'get_trips', input: { status: 'upcoming' } }] }, { text: 'Hmm.' }]);
  await client.turn('Use my Demo Flights account to answer.', { ...TRIPS_PAGE, granted: ['account'] }, leaky);
  const [part] = model.requests[1]!.messages.at(-1)!.content as { isError: boolean; output: unknown }[];
  assert.equal(part?.isError, true);
  assert.ok(!JSON.stringify(model.requests[1]!.messages).includes('Q7K2LM'), 'the real value never reaches the model');
});

test('form prefill: the flight search form takes what fits it and refuses what does not', async () => {
  const { client, model } = setup([
    { text: 'When?', calls: [{ name: 'present_form', input: { form: 'flight_search', prefill: { origin: 'SFO', adults: 12 } } }] },
    { text: 'When?', calls: [{ name: 'present_form', input: { form: 'flight_search', prefill: { origin: 'SFO', seat: '1A' } } }] },
    { text: 'When would you like to fly?', calls: [{ name: 'present_form', input: { form: 'flight_search', prefill: { origin: 'SFO', adults: 2 } } }] },
  ]);
  const turn = await client.turn('two of us from SFO', HOME);
  assert.deepEqual(reasons(model, 1), ['bad_prefill']);
  assert.deepEqual(reasons(model, 2), ['bad_prefill']);
  assert.deepEqual(turn.answer?.present, [{ name: 'present_form', args: { form: 'flight_search', prefill: { origin: 'SFO', adults: 2 } } }]);
});

test('offer expiry: once the time passes, offers are refused and the model is told to search again', async () => {
  let now = Date.parse('2026-10-12T18:05:00Z');
  const { client, model } = setup([
    { calls: [search] },
    { text: 'Three options.', calls: [{ name: 'present_items', input: { entity: 'flight_offer', ids: ['off_7GQ2'] } }] },
    { text: 'Still this one.', calls: [{ name: 'present_items', input: { entity: 'flight_offer', ids: ['off_7GQ2'] } }] },
    { text: 'Prices may have changed; let me search again.' },
  ], () => now);
  const first = await client.turn('SFO to JFK on Nov 20', HOME);
  assert.deepEqual(first.answer?.present?.map((presentation) => presentation.name), ['present_items', 'present_notice']);
  now = Date.parse('2026-10-12T18:31:00Z');
  const later = await client.turn('show me that one again', HOME);
  assert.deepEqual(reasons(model, 3), ['expired_id']);
  assert.equal(later.answer?.text, 'Prices may have changed; let me search again.');
});
