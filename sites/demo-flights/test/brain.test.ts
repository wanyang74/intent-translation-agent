// The brain serving Demo Flights: tools and items that need sign-in, the flight search form and what it can be
// prefilled with, and offers that expire while the conversation goes on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PageContext } from '../../../platform/contract/generated/types.ts';
import { validatorFor } from '../../../platform/core/src/shared/validate.ts';
import { Brain } from '../../../platform/brain/src/agent/loop.ts';
import { loadSite } from '../../../platform/brain/src/prompt/site.ts';
import { loadConversations } from '../../../platform/testkit/src/conversations.ts';
import { FakeClient, inProcess, type ResultFor } from '../../../platform/testkit/src/fake-client.ts';
import { FakeModel, type FakeScript } from '../../../platform/testkit/src/fake-model.ts';

const bundle = await loadSite('demo-flights');
const validate = validatorFor(bundle.validators.platform, 'messages.json');
const conversation = loadConversations('demo-flights').find((example) => example.id === 'one-way-search')!;
const searchOutput = (conversation.messages.find((message) => message.type === 'results') as { results: { output: Record<string, unknown> }[] }).results[0]!.output;
const TRIPS = { trips: [{ recordLocator: 'Q7K2LM', route: 'SFO to SEA', departs: '2026-12-03T16:00:00Z', status: 'confirmed' }] };
const HOME: PageContext = { url: 'https://www.demo-flights.example/', pageType: 'home', locale: 'en-US' };
const results: ResultFor = (call) => ({ ok: true, output: call.name === 'get_trips' ? TRIPS : searchOutput });
const search = { name: 'search_flights', input: { origin: 'SFO', destination: 'JFK', departDate: '2026-11-20', adults: 1, cabin: 'economy' } };

function setup(script: FakeScript[], now: () => number = () => Date.parse('2026-10-12T18:05:00Z')) {
  const model = new FakeModel(script);
  const brain = new Brain({ sites: [bundle], model, now });
  return { model, client: new FakeClient(inProcess(brain), { site: 'demo-flights', validate, results }) };
}
const reasons = (model: FakeModel, i: number) => (model.requests[i]!.messages.at(-1)!.content as { isError: boolean; output: { reason: string } }[])
  .map((part) => (part.isError ? part.output.reason : 'ok'));

test("trips need sign-in: refused by the brain with the airline's own wording when signed out, sent when signed in", async () => {
  const out = setup([{ calls: [{ name: 'get_trips', input: { status: 'upcoming' } }] }, { text: 'Please sign in.' }]);
  const turn = await out.client.turn('my trips', HOME);
  assert.deepEqual(turn.calls, []);
  assert.deepEqual(reasons(out.model, 1), ['signed_out']);
  const signedIn = setup([{ calls: [{ name: 'get_trips', input: { status: 'upcoming' } }] }, { text: 'One trip.', calls: [{ name: 'present_items', input: { entity: 'trip', ids: ['Q7K2LM'] } }] }]);
  const t2 = await signedIn.client.turn('my trips', { ...HOME, url: 'https://www.demo-flights.example/trips', pageType: 'trips', signedIn: true });
  assert.deepEqual(t2.calls.map((call) => call.name), ['get_trips']);
  assert.deepEqual(t2.answer?.present, [{ name: 'present_items', args: { entity: 'trip', ids: ['Q7K2LM'] } }]);
});

test('the flight search form: prefilled with what fits it, refused with what does not', async () => {
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

test('offers expire: once the time passes, the brain refuses to show them and the model is told to search again', async () => {
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
