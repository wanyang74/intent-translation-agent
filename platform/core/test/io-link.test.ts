// L3 for Intake, Brain link and Respond together, with a scripted brain: tool calls start the moment they arrive,
// parallel calls run together, render: direct shows a result early, the answer is filled and checked, each turn gets
// a fresh task budget, and every way the protocol can break stops the turn with a plain message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMessage, ClientResults } from '../../contract/generated/types.ts';
import { FakeSurface } from '../../testkit/src/fake-surface.ts';
import { amendTurn, runTurn } from '../src/index.ts';
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
  const scriptedBrain = scripted(step);
  const shop = await exampleSession({ ...options, host: { ...options.host, brain: scriptedBrain.brain } });
  const surface = new FakeSurface();
  const outcome = await runTurn(shop.session, message, surface);
  return { ...shop, ...scriptedBrain, surface, outcome };
}

test('a tool call starts the moment it arrives, before the brain finishes its step (eager dispatch)', async () => {
  let reached!: () => void;
  const atSite = new Promise<void>((resolve) => { reached = resolve; });
  const network: typeof shopNetwork = (req) => { reached(); return shopNetwork(req); };
  const { outcome, surface, received } = await turnWith(async function* (message, round) {
    if (round === 0) {
      yield call(message.traceId, 'call_1', 'search_products', { query: 'shoe' });
      const eager = await Promise.race([atSite.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 2000))]);
      if (!eager) throw new Error('the call had not reached the site before the brain finished its step');
      yield { type: 'await_results', traceId: message.traceId, callIds: ['call_1'] };
    } else {
      yield answer(message.traceId, 'Two shoes.', [items([1, 2])]);
    }
  }, 'shoes please', { network });
  assert.deepEqual(outcome, { ok: true });
  assert.equal(surface.answers[0]!.text, 'Two shoes.');
  const resultsMessage = received[1] as ClientResults;
  assert.equal(resultsMessage.type, 'results');
  assert.equal(resultsMessage.traceId, received[0]!.traceId);
  assert.equal(resultsMessage.sessionId, received[0]!.sessionId);
  assert.ok(resultsMessage.results[0]!.ok);
});

test('parallel calls run together, and results go back in the order the brain awaits them', async () => {
  const { received, requests } = await turnWith(async function* (message, round) {
    if (round === 0) {
      yield call(message.traceId, 'call_1', 'search_products', { query: 'a' });
      yield call(message.traceId, 'call_2', 'search_products', { query: 'b' });
      yield { type: 'await_results', traceId: message.traceId, callIds: ['call_2', 'call_1'] };
    } else {
      yield answer(message.traceId, 'Done.');
    }
  });
  assert.deepEqual((received[1] as ClientResults).results.map((result) => result.id), ['call_2', 'call_1']);
  assert.equal(requests.length, 2);
});

test('a call marked render: direct is shown as soon as its result is ready, before the answer', async () => {
  const { surface } = await turnWith(async function* (message, round) {
    if (round === 0) {
      yield call(message.traceId, 'call_1', 'search_products', { query: 'shoe' }, 'direct');
      yield { type: 'await_results', traceId: message.traceId, callIds: ['call_1'] };
    } else {
      yield answer(message.traceId, 'Here they are.');
    }
  });
  assert.deepEqual(surface.events.map((event) => event.type), ['early', 'answer']);
  const early = surface.events[0]!;
  assert.deepEqual(early.type === 'early' && early.components.map((component) => component.type), ['items', 'notice']);
});

test('the answer is filled from tool results, checked, and given its required notices', async () => {
  const { surface } = await turnWith(async function* (message, round) {
    if (round === 0) {
      yield { type: 'progress', traceId: message.traceId, text: 'Looking…' };
      yield call(message.traceId, 'call_1', 'search_products', { query: 'shoe' });
      yield { type: 'await_results', traceId: message.traceId, callIds: ['call_1'] };
    } else {
      yield answer(message.traceId, 'One good one, one made up.', [items([1]), items([999])]);
    }
  });
  assert.deepEqual(surface.events.map((event) => event.type), ['progress', 'answer']);
  const reply = surface.answers[0]!;
  assert.deepEqual(reply.components.map((component) => component.type), ['items', 'notice'], 'the made-up item is left out; the notice is added');
});

test('each turn gets a fresh task budget; the session budget carries on', async () => {
  const scriptedBrain = scripted(async function* (message, round) {
    const turn = Math.floor(round / 2);
    if (round % 2 === 0) {
      const calls = turn === 0 ? 5 : 4;
      for (let i = 0; i < calls; i++) yield call(message.traceId, `call_${turn}_${i}`, 'search_products', { query: `t${turn}q${i}` });
      yield { type: 'await_results', traceId: message.traceId, callIds: Array.from({ length: calls }, (_, i) => `call_${turn}_${i}`) };
    } else {
      yield answer(message.traceId, 'ok');
    }
  });
  const shop = await exampleSession({ host: { brain: scriptedBrain.brain } });
  const surface = new FakeSurface();
  await runTurn(shop.session, 'first', surface);
  await runTurn(shop.session, 'second', surface);
  const okIn = (i: number) => (scriptedBrain.received[i] as ClientResults).results.map((result) => result.ok);
  assert.deepEqual(okIn(1), [true, true, true, true, true], 'five calls fit the task budget of five');
  assert.deepEqual(okIn(3), [true, true, true, false], 'a new task, but the session budget of eight runs out');
});

const failures: [string, Step, RegExp][] = [
  ['an event that breaks the protocol', async function* (message) { yield { type: 'tool_call', traceId: message.traceId, call: { id: 'not a call id', name: 'x', args: {} } }; }, /invalid event/],
  ['an event for another turn', async function* () { yield answer('trace_someone_else', 'hi'); }, /another turn/],
  ['awaiting a call it never sent', async function* (message) { yield { type: 'await_results', traceId: message.traceId, callIds: ['call_9'] }; }, /never sent/],
  ['the same call twice', async function* (message) {
    yield call(message.traceId, 'call_1', 'search_products', {});
    yield call(message.traceId, 'call_1', 'search_products', {});
  }, /arrived twice/],
  ['stopping with neither an answer nor a wait', async function* (message) { yield { type: 'progress', traceId: message.traceId, text: 'thinking' }; }, /without an answer/],
  ['dropping the connection', async function* (message) {
    yield { type: 'progress', traceId: message.traceId, text: 'thinking' };
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
  const { outcome, surface } = await turnWith(async function* (message) {
    yield { type: 'error', traceId: message.traceId, code: 'budget_reached', message: "You've reached today's limit. Try again tomorrow." };
  });
  assert.deepEqual(outcome, { ok: false, reason: 'brain error: budget_reached' });
  assert.deepEqual(surface.errors.map((error) => error.message), ["You've reached today's limit. Try again tomorrow."]);
});

test('a turn needs a page context, a brain, and a message of at most 2,000 characters', async () => {
  const long = await turnWith(async function* (message) { yield answer(message.traceId, 'ok'); }, 'x'.repeat(2001));
  assert.match(long.surface.errors[0]!.message, /too long/);
  const noBrain = await exampleSession();
  const s1 = new FakeSurface();
  assert.equal((await runTurn(noBrain.session, 'hi', s1)).ok, false);
  const noPage = await exampleSession({ host: { brain: scripted(async function* (message) { yield answer(message.traceId, 'ok'); }).brain } });
  noPage.session.setPage(undefined);
  const s2 = new FakeSurface();
  assert.equal((await runTurn(noPage.session, 'hi', s2)).ok, false);
  assert.equal(s2.errors.length, 1);
});

test('a brain that never stops calling tools is cut off', async () => {
  let count = 0;
  const { outcome } = await turnWith(async function* (message) {
    const id = `call_${count++}`;
    yield call(message.traceId, id, 'search_products', { query: 'same' });
    yield { type: 'await_results', traceId: message.traceId, callIds: [id] };
  });
  assert.deepEqual(outcome, { ok: false, reason: 'too many round trips' });
});

test('a message typed while a turn runs goes to that turn; with no turn running it is too late, and nothing is sent', async () => {
  let amended: Promise<string> | undefined;
  const holder: { session?: Parameters<typeof amendTurn>[0] } = {};
  const network: typeof shopNetwork = (req) => {
    amended ??= amendTurn(holder.session!, 'only red ones');
    return shopNetwork(req);
  };
  const scriptedBrain = scripted(async function* (message) {
    if (message.type === 'amend') yield { type: 'amended', traceId: message.traceId, status: 'queued' };
    else if (message.type === 'turn') {
      yield call(message.traceId, 'call_1', 'search_products', { query: 'shoe' });
      yield { type: 'await_results', traceId: message.traceId, callIds: ['call_1'] };
    } else yield answer(message.traceId, 'Red ones.');
  });
  const shop = await exampleSession({ network, host: { brain: scriptedBrain.brain } });
  holder.session = shop.session;
  const surface = new FakeSurface();
  assert.deepEqual(await runTurn(shop.session, 'shoes', surface), { ok: true });
  assert.equal(await amended, 'queued');
  const [turnMessage, amendMessage] = scriptedBrain.received;
  assert.deepEqual(amendMessage, { type: 'amend', sessionId: shop.session.id, traceId: turnMessage!.traceId, message: 'only red ones' });
  const idle = scripted(async function* () { yield answer('trace_unused', 'never'); });
  const quiet = await exampleSession({ host: { brain: idle.brain } });
  assert.equal(await amendTurn(quiet.session, 'hello?'), 'too_late');
  assert.equal(idle.received.length, 0);
});

test("messages that missed a turn's last step come back as follow-ups and run as the next turn", async () => {
  const scriptedBrain = scripted(async function* (message) {
    if (message.type !== 'turn') return;
    if (message.message === 'shoes') yield { ...answer(message.traceId, 'Two shoes.'), followUps: ['and boots'] };
    else yield answer(message.traceId, `Boots, for: ${message.message}`);
  });
  const shop = await exampleSession({ host: { brain: scriptedBrain.brain } });
  const surface = new FakeSurface();
  assert.deepEqual(await runTurn(shop.session, 'shoes', surface), { ok: true });
  assert.deepEqual(surface.answers.map((shown) => shown.text), ['Two shoes.', 'Boots, for: and boots']);
  assert.equal(shop.session.activeTurn, undefined, 'no turn is running afterwards');
});
