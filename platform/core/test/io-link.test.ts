// L3 for Intake, Brain link and Respond together, with a scripted brain: tool calls start the moment they arrive,
// parallel calls run together, render: direct shows a result early, the answer is filled and checked, each turn gets
// a fresh task budget, and every way the protocol can break stops the turn with a plain message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMessage, ClientResults } from '../../contract/generated/types.ts';
import { FakeSurface } from '../../testkit/src/fake-surface.ts';
import { runTurn } from '../src/index.ts';
import { exampleSession, shopNetwork } from './example-site.ts';

type Step = (message: ClientMessage, round: number) => AsyncGenerator<unknown>;

/** A brain that runs `step` for each message the client sends, and keeps what it received. */
function scripted(step: Step) {
  const received: ClientMessage[] = [];
  return {
    received,
    brain: (message: ClientMessage) => {
      received.push(message);
      return step(message, received.length - 1);
    },
  };
}

const call = (traceId: string, id: string, name: string, args: unknown, render?: 'direct') =>
  ({ type: 'tool_call', traceId, call: { id, name, args, ...(render ? { render } : {}) } });
const answer = (traceId: string, text: string, present: unknown[] = []) => ({ type: 'answer', traceId, text, present });
const items = (ids: number[]) => ({ name: 'present_items', args: { entity: 'product', ids } });

async function turnWith(step: Step, message = 'shoes please', options: Parameters<typeof exampleSession>[0] = {}) {
  const b = scripted(step);
  const s = await exampleSession({ ...options, host: { ...options.host, brain: b.brain } });
  const surface = new FakeSurface();
  const outcome = await runTurn(s.session, message, surface);
  return { ...s, ...b, surface, outcome };
}

test('a tool call starts the moment it arrives, before the brain finishes its step (eager dispatch)', async () => {
  let reached!: () => void;
  const atSite = new Promise<void>((r) => { reached = r; });
  const network: typeof shopNetwork = (req) => { reached(); return shopNetwork(req); };
  const { outcome, surface, received } = await turnWith(async function* (m, round) {
    if (round === 0) {
      yield call(m.traceId, 'call_1', 'search_products', { query: 'shoe' });
      const eager = await Promise.race([atSite.then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))]);
      if (!eager) throw new Error('the call had not reached the site before the brain finished its step');
      yield { type: 'await_results', traceId: m.traceId, callIds: ['call_1'] };
    } else {
      yield answer(m.traceId, 'Two shoes.', [items([1, 2])]);
    }
  }, 'shoes please', { network });
  assert.deepEqual(outcome, { ok: true });
  assert.equal(surface.answers[0]!.text, 'Two shoes.');
  const results = received[1] as ClientResults;
  assert.equal(results.type, 'results');
  assert.equal(results.traceId, received[0]!.traceId);
  assert.equal(results.sessionId, received[0]!.sessionId);
  assert.ok(results.results[0]!.ok);
});

test('parallel calls run together, and results go back in the order the brain awaits them', async () => {
  const { received, requests } = await turnWith(async function* (m, round) {
    if (round === 0) {
      yield call(m.traceId, 'call_1', 'search_products', { query: 'a' });
      yield call(m.traceId, 'call_2', 'search_products', { query: 'b' });
      yield { type: 'await_results', traceId: m.traceId, callIds: ['call_2', 'call_1'] };
    } else {
      yield answer(m.traceId, 'Done.');
    }
  });
  assert.deepEqual((received[1] as ClientResults).results.map((r) => r.id), ['call_2', 'call_1']);
  assert.equal(requests.length, 2);
});

test('a call marked render: direct is shown as soon as its result is ready, before the answer', async () => {
  const { surface } = await turnWith(async function* (m, round) {
    if (round === 0) {
      yield call(m.traceId, 'call_1', 'search_products', { query: 'shoe' }, 'direct');
      yield { type: 'await_results', traceId: m.traceId, callIds: ['call_1'] };
    } else {
      yield answer(m.traceId, 'Here they are.');
    }
  });
  assert.deepEqual(surface.events.map((e) => e.type), ['early', 'answer']);
  const early = surface.events[0]!;
  assert.deepEqual(early.type === 'early' && early.components.map((c) => c.type), ['items', 'notice']);
});

test('the answer is filled from tool results, checked, and given its required notices', async () => {
  const { surface } = await turnWith(async function* (m, round) {
    if (round === 0) {
      yield { type: 'progress', traceId: m.traceId, text: 'Looking…' };
      yield call(m.traceId, 'call_1', 'search_products', { query: 'shoe' });
      yield { type: 'await_results', traceId: m.traceId, callIds: ['call_1'] };
    } else {
      yield answer(m.traceId, 'One good one, one made up.', [items([1]), items([999])]);
    }
  });
  assert.deepEqual(surface.events.map((e) => e.type), ['progress', 'answer']);
  const a = surface.answers[0]!;
  assert.deepEqual(a.components.map((c) => c.type), ['items', 'notice'], 'the made-up item is left out; the notice is added');
});

test('each turn gets a fresh task budget; the session budget carries on', async () => {
  const b = scripted(async function* (m, round) {
    const turn = Math.floor(round / 2);
    if (round % 2 === 0) {
      const n = turn === 0 ? 5 : 4;
      for (let i = 0; i < n; i++) yield call(m.traceId, `call_${turn}_${i}`, 'search_products', { query: `t${turn}q${i}` });
      yield { type: 'await_results', traceId: m.traceId, callIds: Array.from({ length: n }, (_, i) => `call_${turn}_${i}`) };
    } else {
      yield answer(m.traceId, 'ok');
    }
  });
  const s = await exampleSession({ host: { brain: b.brain } });
  const surface = new FakeSurface();
  await runTurn(s.session, 'first', surface);
  await runTurn(s.session, 'second', surface);
  const okIn = (i: number) => (b.received[i] as ClientResults).results.map((r) => r.ok);
  assert.deepEqual(okIn(1), [true, true, true, true, true], 'five calls fit the task budget of five');
  assert.deepEqual(okIn(3), [true, true, true, false], 'a new task, but the session budget of eight runs out');
});

const failures: [string, Step, RegExp][] = [
  ['an event that breaks the protocol', async function* (m) { yield { type: 'tool_call', traceId: m.traceId, call: { id: 'not a call id', name: 'x', args: {} } }; }, /invalid event/],
  ['an event for another turn', async function* () { yield answer('trace_someone_else', 'hi'); }, /another turn/],
  ['awaiting a call it never sent', async function* (m) { yield { type: 'await_results', traceId: m.traceId, callIds: ['call_9'] }; }, /never sent/],
  ['the same call twice', async function* (m) {
    yield call(m.traceId, 'call_1', 'search_products', {});
    yield call(m.traceId, 'call_1', 'search_products', {});
  }, /arrived twice/],
  ['stopping with neither an answer nor a wait', async function* (m) { yield { type: 'progress', traceId: m.traceId, text: 'thinking' }; }, /without an answer/],
  ['dropping the connection', async function* (m) {
    yield { type: 'progress', traceId: m.traceId, text: 'thinking' };
    throw new Error('socket hang up');
  }, /lost the brain link/],
];
for (const [what, step, reasonPattern] of failures) {
  test(`the turn stops with one plain message on ${what}`, async () => {
    const { outcome, surface } = await turnWith(step);
    assert.equal(outcome.ok, false);
    assert.match(!outcome.ok ? outcome.reason : '', reasonPattern);
    assert.equal(surface.errors.length, 1);
    assert.doesNotMatch(surface.errors[0]!.message, /trace|call_|protocol/i, 'no internals in what the user sees');
  });
}

test("the brain's own error reaches the user as the brain worded it", async () => {
  const { outcome, surface } = await turnWith(async function* (m) {
    yield { type: 'error', traceId: m.traceId, code: 'budget_reached', message: "You've reached today's limit. Try again tomorrow." };
  });
  assert.deepEqual(outcome, { ok: false, reason: 'brain error: budget_reached' });
  assert.deepEqual(surface.errors.map((e) => e.message), ["You've reached today's limit. Try again tomorrow."]);
});

test('a turn needs a page context, a brain, and a message of at most 2,000 characters', async () => {
  const long = await turnWith(async function* (m) { yield answer(m.traceId, 'ok'); }, 'x'.repeat(2001));
  assert.match(long.surface.errors[0]!.message, /too long/);
  const noBrain = await exampleSession();
  const s1 = new FakeSurface();
  assert.equal((await runTurn(noBrain.session, 'hi', s1)).ok, false);
  const noPage = await exampleSession({ host: { brain: scripted(async function* (m) { yield answer(m.traceId, 'ok'); }).brain } });
  noPage.session.setPage(undefined);
  const s2 = new FakeSurface();
  assert.equal((await runTurn(noPage.session, 'hi', s2)).ok, false);
  assert.equal(s2.errors.length, 1);
});

test('a brain that never stops calling tools is cut off', async () => {
  let n = 0;
  const { outcome } = await turnWith(async function* (m) {
    const id = `call_${n++}`;
    yield call(m.traceId, id, 'search_products', { query: 'same' });
    yield { type: 'await_results', traceId: m.traceId, callIds: [id] };
  });
  assert.deepEqual(outcome, { ok: false, reason: 'too many round trips' });
});
