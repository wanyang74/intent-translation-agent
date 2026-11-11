// Tests: the brain reopening a conversation it forgot (agent/brain.ts, agent/session.ts, memory/), with FakeModel and
// FakeClient on the example shop, a clock the test moves, and an in-memory or file memory store.
// Passes when: a session forgotten after 30 idle minutes comes back from its memory when its ID returns: the model reads
// the memory first in the new turn, the IDs from before pass the brain's checks without a new search, and usage keeps
// counting; a brain restarted on the same file store does the same; and without a store a forgotten session starts
// over, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeClient } from '../../testkit/src/fake-client.ts';
import { FakeModel, type FakeScript } from '../../testkit/src/fake-model.ts';
import { Brain } from '../src/agent/brain.ts';
import type { BrainLogEntry } from '../src/agent/types.ts';
import { FileMemoryStore, InMemoryMemoryStore, type MemoryStore } from '../src/memory/store.ts';
import { HOME, inProcess, NOW, shopResults, shopSite, textOf, validateMessage } from './example-brain.ts';

const SEARCH_AND_SHOW: FakeScript[] = [
  { text: 'Searching…', calls: [{ name: 'search_products', input: { query: 'shoes' } }] },
  { text: 'Two shoes: red and blue.', calls: [{ name: 'present_items', input: { entity: 'product', ids: [1, 2], heading: 'Two shoes' } }] },
];
/** The follow-up after the gap: compare the two shoes found before, by ID, with no new search. */
const COMPARE_EARLIER: FakeScript[] = [
  { text: 'Comparing…', calls: [{ name: 'compare_products', input: { productIds: [1, 2] } }] },
  { text: 'The red one is cheaper.' },
];

function brainWith(script: FakeScript[], clock: { now: number }, memory: MemoryStore | undefined) {
  const model = new FakeModel(script);
  const log: BrainLogEntry[] = [];
  const brain = new Brain({ site: shopSite(), model, now: () => clock.now, log: (entry) => log.push(entry), memory });
  return { brain, model, log };
}

const clientFor = (brain: Brain, sessionId = 'sess_memory') => new FakeClient(inProcess(brain), { site: 'example-shop', validate: validateMessage, results: shopResults, sessionId });

test('after 40 idle minutes the session comes back from its memory: the model reads it, and earlier IDs work without a new search', async () => {
  const clock = { now: NOW };
  const memory = new InMemoryMemoryStore({ site: 'example-shop', keepHours: 24 });
  const { brain, model, log } = brainWith([...SEARCH_AND_SHOW, ...COMPARE_EARLIER], clock, memory);
  const client = clientFor(brain);
  assert.equal((await client.turn('show me shoes', HOME)).answer?.text, 'Two shoes: red and blue.');

  clock.now += 40 * 60_000;
  const later = await client.turn('which of those two is cheaper?', HOME);
  assert.equal(later.answer?.text, 'The red one is cheaper.');
  // The brain forgot the session, then reopened it from memory rather than starting over.
  const kinds = log.filter((entry) => entry.sessionId === 'sess_memory').map((entry) => entry.kind);
  assert.ok(kinds.includes('session_forgotten') && kinds.includes('session_restored'), kinds.join(', '));
  assert.deepEqual(log.find((entry) => entry.kind === 'session_restored')!.detail, { turns: 1, ids: 5, idleMinutes: 40 });
  // The model's first request after the gap starts with the memory, then the new message.
  const firstUser = model.requests[2]!.messages[0]!;
  assert.equal(firstUser.role, 'user');
  const texts = firstUser.content.map((part) => (part as { text: string }).text);
  assert.match(texts[0]!, /^<earlier-conversation>/);
  assert.match(texts[0]!, /product 1: Red Shoe/);
  assert.match(texts[0]!, /Shown: present_items product 1, 2/);
  assert.equal(texts[1], 'which of those two is cheaper?');
  // The IDs from before passed the brain's checks: the compare call reached the client, and no search ran again.
  assert.deepEqual(later.calls.map((call) => [call.name, call.args]), [['compare_products', { productIds: [1, 2] }]]);
  assert.ok(!textOf(model.requests[3]!.messages).includes("wasn't returned in this session"), 'no refusal for unknown IDs');
  assert.deepEqual(model.problems, []);
});

test('without a memory store, a forgotten session starts over: the earlier IDs are refused', async () => {
  const clock = { now: NOW };
  const { brain, model } = brainWith([...SEARCH_AND_SHOW, COMPARE_EARLIER[0]!, { text: "I don't have those shoes any more." }], clock, undefined);
  const client = clientFor(brain);
  await client.turn('show me shoes', HOME);
  clock.now += 40 * 60_000;
  const later = await client.turn('which of those two is cheaper?', HOME);
  assert.deepEqual(later.calls, [], 'the compare call never reached the client');
  assert.ok(!textOf(model.requests[2]!.messages).includes('<earlier-conversation>'));
  assert.match(textOf(model.requests[3]!.messages), /product 1 wasn't returned in this session/);
});

test('a restarted brain on the same file store reopens the conversation, and its usage keeps counting', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  const clock = { now: NOW };
  const store = () => new FileMemoryStore({ dir, site: 'example-shop', keepHours: 24, now: () => clock.now });
  const first = brainWith(SEARCH_AND_SHOW, clock, store());
  await clientFor(first.brain).turn('show me shoes', HOME);

  clock.now += 5 * 60_000;
  const second = brainWith(COMPARE_EARLIER, clock, store());
  const later = await clientFor(second.brain).turn('which of those two is cheaper?', HOME);
  assert.equal(later.answer?.text, 'The red one is cheaper.');
  assert.deepEqual(later.calls.map((call) => call.name), ['compare_products']);
  assert.ok(second.log.some((entry) => entry.kind === 'session_restored'));
  // The memory saved after the second turn has both turns and counts both.
  const saved = store().load('sess_memory', clock.now)!;
  assert.deepEqual(saved.turns.map((turn) => turn.message), ['show me shoes', 'which of those two is cheaper?']);
  assert.equal(saved.usage.turns, 2);
});

test('a memory past its limit is not used: the session starts over', async () => {
  const clock = { now: NOW };
  const memory = new InMemoryMemoryStore({ site: 'example-shop', keepHours: 1 });
  const { brain, model, log } = brainWith([...SEARCH_AND_SHOW, { text: 'Which shoes do you mean?' }], clock, memory);
  const client = clientFor(brain);
  await client.turn('show me shoes', HOME);
  clock.now += 2 * 60 * 60_000;
  await client.turn('which of those two is cheaper?', HOME);
  assert.ok(!log.some((entry) => entry.kind === 'session_restored'));
  assert.ok(!textOf(model.requests[2]!.messages).includes('<earlier-conversation>'));
});
