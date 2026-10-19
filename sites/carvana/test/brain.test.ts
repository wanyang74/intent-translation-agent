// The brain serving Carvana: what the model is told about Carvana, the vehicle research skill loading before the first
// model call on a car's page, and the brain's own checks with Carvana's schemas and IDs, before anything reaches the
// client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatorFor } from '../../../platform/core/src/shared/validate.ts';
import { Brain } from '../../../platform/brain/src/agent/brain.ts';
import { globalSegment } from '../../../platform/brain/src/prompt/prompt.ts';
import { loadSite } from '../../../platform/brain/src/prompt/site.ts';
import { loadConversations } from '../../../platform/testkit/src/conversations.ts';
import { FakeClient, inProcess, replayConversation } from '../../../platform/testkit/src/fake-client.ts';
import { FakeModel, fakeModelFor } from '../../../platform/testkit/src/fake-model.ts';

const bundle = await loadSite('carvana');
const validate = validatorFor(bundle.validators.platform, 'messages.json');
const HOME = { url: 'https://www.carvana.com/', pageType: 'other', location: { postalCode: '94402' }, locale: 'en-US' };

test("the model is told Carvana's rules: hidden payment figures, the zip code, the estimated-total notice, and the four skills", () => {
  const { system, tools } = globalSegment(bundle);
  for (const line of [
    "You're the assistant inside Carvana's website and apps.",
    '- Carvana sells used cars online.',
    '- Never show, filter by, rank by or mention these, even when a result has them: price.monthlyPayment, price.apr, price.term, price.downPayment.',
    "- Searches need the user's postal code: use the one in the context block, or ask for it. Never guess it.",
    '- estimated_total: "Estimated total adds Carvana\'s estimated taxes and fees to the price. Final amounts are set at checkout." It\'s added automatically when estimatedTotal is shown.',
    '- Never shown: route. Tools pass these IDs between them; never show or mention them.',
    '- Each request can make at most 60 calls to the site, 1 per second.',
  ]) assert.ok(system.includes(line), `missing: ${line}`);
  assert.ok(!system.includes('<!--'), 'authoring notes stay out');
  assert.deepEqual(tools.map((tool) => tool.name).slice(0, 7), ['search_vehicles', 'get_delivery_dates', 'suggest_refinements', 'get_vehicle_quote', 'compare_vehicles', 'get_owner_reviews', 'vehicle_details']);
  const loadSkill = tools.find((tool) => tool.name === 'load_skill')!;
  assert.deepEqual((loadSkill.inputSchema as { properties: { name: { enum: string[] } } }).properties.name.enum, ['vehicle_research', 'batch_search', 'delivery_and_pickup', 'financing_questions']);
  assert.match(tools.find((tool) => tool.name === 'search_vehicles')!.description, /Show its results with present_items\.$/);
});

test("on a car's page, vehicle research loads before the first model call, and the conversation replays exactly", async () => {
  const conversation = loadConversations('carvana').find((candidate) => candidate.id === 'car-on-screen')!;
  const model = fakeModelFor(conversation);
  const brain = new Brain({ site: bundle, model, now: () => Date.parse(conversation.now!) });
  const { differences } = await replayConversation(inProcess(brain), conversation);
  assert.deepEqual(differences, []);
  const [, preload, skill] = model.requests[0]!.messages;
  assert.deepEqual(preload, { role: 'assistant', content: [{ type: 'tool-call', id: 'preload_vehicle_research', name: 'load_skill', input: { name: 'vehicle_research' } }] });
  assert.ok(skill?.role === 'tool' && String(skill.content[0]!.output).startsWith('# Vehicle research\n'));
});

test("the brain refuses what Carvana's schemas and the session's IDs don't allow, without a round trip", async () => {
  const model = new FakeModel([
    {
      calls: [
        { name: 'search_vehicles', input: { zip5: '9440', make: 'Tesla' } },
        { name: 'get_vehicle_quote', input: { vehicleId: 4812031, zip5: '94402' } },
        { name: 'get_delivery_dates', input: { vehicleIds: Array.from({ length: 25 }, (_, i) => 4812000 + i), zip5: '94402' } },
      ],
    },
    { text: 'Which car?', calls: [{ name: 'present_items', input: { entity: 'vehicle', ids: ['4812031'] } }] },
    { text: 'Which car do you mean?' },
  ]);
  const brain = new Brain({ site: bundle, model, now: () => Date.parse('2026-10-08T19:15:00Z') });
  const client = new FakeClient(inProcess(brain), { site: 'carvana', validate });
  const turn = await client.turn('quote car 4812031', HOME);
  assert.deepEqual(turn.calls, []);
  const reasons = (i: number) => (model.requests[i]!.messages.at(-1)!.content as { output: { reason: string } }[]).map((part) => part.output.reason);
  assert.deepEqual(reasons(1), ['bad_arguments', 'unknown_id', 'bad_arguments'], 'a 4-digit zip, a car never returned, more than 24 cars');
  assert.deepEqual(reasons(2), ['bad_id'], 'vehicle IDs are numbers');
  assert.equal(turn.answer?.text, 'Which car do you mean?');
});
