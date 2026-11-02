// Tests: the brain's agent loop (L3): Brain, AgentSession and Turn in brain/src/agent/, on the made-up shop.
// How: FakeModel plays the LLM from a script (including bad calls, failures and hangs) and FakeClient plays core.js.
// Each test is one story: eager dispatch, call IDs, progress lines, the brain's checks on tool calls and cards,
// skills, the step budget, results and timeouts, superseded and abandoned turns, amendments, quotas, and the loop's
// guards (card retries, cut-off replies).
// Passes when: the client sees the expected events, and after each story the session's history is still valid for
// a model API: every tool call answered exactly once, in order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientResults, ToolResult } from '../../contract/generated/types.ts';
import { DROP, FakeClient, type TurnRecord } from '../../testkit/src/fake-client.ts';
import { FakeModel, type FakeStep } from '../../testkit/src/fake-model.ts';
import { Brain } from '../src/agent/brain.ts';
import { progressLine } from '../src/agent/turn.ts';
import type { ToolResultPart } from '../src/model/model.ts';
import {
  HOME, historyProblems, inProcess, NOW, productPage, SEARCH_OUTPUT, setup, shopResults, shopSite, textOf, validateMessage,
} from './example-brain.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}
const search = (query: string) => ({ name: 'search_products', input: { query } });
const items = (ids: (number | string)[], entity = 'product') => ({ name: 'present_items', input: { entity, ids } });
const notice = { name: 'present_notice', args: { notice: 'total_estimate' } };
const types = (turn: TurnRecord) => turn.events.map((event) => event.type);
const callIds = (turn: TurnRecord) => turn.calls.map((call) => call.id);
/** The results the model was given in a request's last message. */
const lastResults = (model: FakeModel, request: number) => {
  const last = model.requests[request]!.messages.at(-1)!;
  assert.equal(last.role, 'tool');
  return last.content as ToolResultPart[];
};
const reasons = (parts: ToolResultPart[]) => parts.map((result) => (result.isError ? (result.output as { reason: string }).reason : 'ok'));

test('eager dispatch: each tool call reaches the client as soon as the model finishes writing it', async () => {
  let arrived!: () => void;
  const firstCallArrived = new Promise<void>((resolve) => { arrived = resolve; });
  const { client, model, brain } = setup([
    {
      text: 'Searching red and blue shoes…', calls: [search('red'), search('blue')],
      beforeCall: (i) => (i === 1 ? within(firstCallArrived, 2000, 'the first call had not reached the client when the model wrote the second') : undefined),
    },
    { text: 'Two shoes.', calls: [items([1, 2])] },
  ], { results: (call) => { arrived(); return shopResults(call); } });
  const turn = await client.turn('shoes in red or blue', HOME);
  assert.deepEqual(turn.problems, []);
  assert.deepEqual(types(turn), ['tool_call', 'tool_call', 'progress', 'await_results', 'answer']);
  assert.deepEqual(turn.events.slice(0, 4), [
    { type: 'tool_call', traceId: turn.traceId, call: { id: 'call_1', name: 'search_products', args: { query: 'red' } } },
    { type: 'tool_call', traceId: turn.traceId, call: { id: 'call_2', name: 'search_products', args: { query: 'blue' } } },
    { type: 'progress', traceId: turn.traceId, text: 'Searching red and blue shoes…' },
    { type: 'await_results', traceId: turn.traceId, callIds: ['call_1', 'call_2'] },
  ]);
  assert.deepEqual(turn.answer, {
    type: 'answer', traceId: turn.traceId, text: 'Two shoes.',
    present: [{ name: 'present_items', args: { entity: 'product', ids: [1, 2] } }, notice],
  }, 'the notice for the total on the cards is added');
  assert.deepEqual(lastResults(model, 1), [
    { type: 'tool-result', id: 'toolu_fake_1', name: 'search_products', output: SEARCH_OUTPUT, isError: false },
    { type: 'tool-result', id: 'toolu_fake_2', name: 'search_products', output: SEARCH_OUTPUT, isError: false },
  ], "results go back under the model's own call IDs");
  assert.deepEqual(historyProblems(brain.historyOf(client.sessionId)!), []);
});

test('call IDs: count up through the session from call_1; a step with no text sends no progress line', async () => {
  const { client, brain, send } = setup([
    { calls: [search('red')] }, { text: 'One.', calls: [items([1])] },
    { calls: [{ name: 'get_offer', input: { offerId: 'of_ab12' } }] }, { text: 'Thirty dollars.' },
    { calls: [search('blue')] }, { text: 'Blue.', calls: [items([2])] },
  ]);
  const first = await client.turn('red shoes', HOME);
  const second = await client.turn('and the offer?', HOME);
  assert.deepEqual(callIds(first), ['call_1']);
  assert.deepEqual(callIds(second), ['call_2']);
  assert.ok(!types(first).includes('progress'));
  const other = new FakeClient(send, { site: 'example-shop', validate: validateMessage, results: shopResults });
  assert.deepEqual(callIds(await other.turn('blue shoes', HOME)), ['call_1']);
  assert.deepEqual(historyProblems(brain.historyOf(client.sessionId)!), []);
});

test('prompt prefix: every request starts with it; the newest user turn ends with its context block', async () => {
  const { client, model } = setup([{ calls: [search('red')] }, { text: 'One.', calls: [items([1])] }, { text: 'Hello again.' }]);
  await client.turn('red shoes', HOME);
  await client.turn('thanks', { ...HOME, url: 'https://www.example.com/cart', pageType: 'home' });
  const [firstRequest, secondRequest, thirdRequest] = model.requests;
  assert.equal(firstRequest!.system, secondRequest!.system);
  assert.equal(firstRequest!.tools, secondRequest!.tools, 'the very same tools array, so the adapter converts it once');
  assert.equal(JSON.stringify(firstRequest!.tools), JSON.stringify(thirdRequest!.tools));
  const firstUser = firstRequest!.messages[0]!;
  assert.equal(firstUser.role, 'user');
  assert.equal(firstUser.content[0]!.type === 'text' && firstUser.content[0]!.text, 'red shoes');
  assert.match(firstUser.content[1]!.type === 'text' ? firstUser.content[1]!.text : '', /^<context>\n<untrusted source="page-context">Page: https:\/\/www\.example\.com\/ \(home page\)/);
  const newest = thirdRequest!.messages.at(-1)!;
  assert.equal(newest.role, 'user');
  assert.match(textOf([newest]), /www\.example\.com\/cart/);
  assert.ok(textOf(thirdRequest!.messages).includes('https://www.example.com/ (home page)'), 'earlier context blocks stay, so the cached prefix stays the same');
});

test('tool call checks: made-up tools, bad arguments, unknown IDs and writes never reach the client', async () => {
  const { client, model, brain } = setup([
    {
      calls: [
        { name: 'buy_now', input: {} },
        { name: 'search_products', input: { q: 'shoes' } },
        { name: 'get_offer', input: { offerId: 'of_zz99' } },
        { name: 'place_order', input: { offerId: 'of_ab12' } },
        { name: 'search_products', input: 'shoes' },
      ],
    },
    { text: 'Sorry, I made some mistakes.' },
  ]);
  const turn = await client.turn('buy shoes', HOME);
  assert.deepEqual(turn.calls, [], 'the client never sees them');
  assert.deepEqual(types(turn), ['answer'], 'the errors went straight back to the model, in the same stream');
  assert.deepEqual(reasons(lastResults(model, 1)), ['unknown_tool', 'bad_arguments', 'unknown_id', 'writes_off', 'bad_arguments']);
  assert.match((lastResults(model, 1)[1]!.output as { message: string }).message, /The arguments for search_products are invalid/);
  const history = brain.historyOf(client.sessionId)!;
  assert.deepEqual(historyProblems(history), []);
  const lastCall = history[1]!.content.at(-1)!;
  assert.deepEqual(lastCall.type === 'tool-call' && lastCall.input, {}, 'arguments that are not an object are kept as {} so the history stays valid');
});

test('card checks: cards are checked before sending; a refused one goes back to the model, nothing shown', async () => {
  const { client, model } = setup([
    { calls: [search('shoes')] },
    { text: 'Here.', calls: [items([1, 99]), { name: 'present_notice', input: { notice: 'total_estimate' } }] },
    { text: 'More.', calls: [items(['tok_1'], 'token'), { name: 'present_items', input: { entity: 'product' } }, { name: 'present_notice', input: { notice: 'no_such_notice' } }] },
    { text: 'Here is the one I found.', calls: [{ name: 'present_detail', input: { entity: 'product', id: 1, sections: ['reviews'] } }] },
  ]);
  const turn = await client.turn('shoes', HOME);
  assert.deepEqual(types(turn), ['tool_call', 'await_results', 'answer']);
  assert.deepEqual(reasons(lastResults(model, 2)), ['unknown_id', 'not_shown']);
  assert.deepEqual(reasons(lastResults(model, 3)), ['internal_kind', 'bad_arguments', 'unknown_notice']);
  assert.deepEqual(turn.answer!.present, [{ name: 'present_detail', args: { entity: 'product', id: 1, sections: ['reviews'] } }, notice], "the detail's card shows the total, so its notice is added");
  assert.equal(turn.answer!.text, 'Here is the one I found.');
});

test('cards without words: kept for the next step to write the answer; duplicates shown once; shown as-is on the last step', async () => {
  const { client, model } = setup([
    { calls: [search('shoes')] },
    { calls: [items([1])] },
    { text: 'The red one costs less and rates higher.', calls: [items([1])] },
  ]);
  const turn = await client.turn('which shoe?', HOME);
  assert.deepEqual(lastResults(model, 2).map((result) => result.output), ['Accepted: it will be shown with your answer. Now write the answer text; there is no need to call it again.']);
  assert.deepEqual(turn.answer, { type: 'answer', traceId: turn.traceId, text: 'The red one costs less and rates higher.', present: [{ name: 'present_items', args: { entity: 'product', ids: [1] } }, notice] });

  const wordsAfter = setup([{ calls: [search('shoes')] }, { calls: [items([1])] }, { text: 'The red one is the better buy.' }]);
  const t1 = await wordsAfter.client.turn('which shoe?', HOME);
  assert.deepEqual(t1.answer, { type: 'answer', traceId: t1.traceId, text: 'The red one is the better buy.', present: [{ name: 'present_items', args: { entity: 'product', ids: [1] } }, notice] });

  const last = setup([{ calls: [search('shoes')] }, { calls: [items([1])] }], { limits: { stepsPerTurn: 2 } });
  const t2 = await last.client.turn('which shoe?', HOME);
  assert.deepEqual(t2.answer, { type: 'answer', traceId: t2.traceId, text: '', present: [{ name: 'present_items', args: { entity: 'product', ids: [1] } }, notice] });
});

test('cards too early: cards in a step that also calls site tools are refused; only the site call is sent', async () => {
  const { client, model } = setup([
    { calls: [search('shoes'), items([1])] },
    { text: 'One.', calls: [items([1])] },
  ]);
  const turn = await client.turn('shoes', HOME);
  assert.deepEqual(turn.calls.map((call) => call.name), ['search_products']);
  assert.deepEqual(reasons(lastResults(model, 1)), ['ok', 'present_too_early']);
  assert.deepEqual(turn.answer!.present![0], { name: 'present_items', args: { entity: 'product', ids: [1] } });
});

test('skills: load without a round trip to the client, once each; unknown and switched-off ones are refused', async () => {
  const { client, model } = setup([
    { calls: [{ name: 'load_skill', input: { name: 'gift_ideas' } }] },
    { calls: [{ name: 'load_skill', input: { name: 'gift_ideas' } }, { name: 'load_skill', input: { name: 'astrology' } }, { name: 'load_skill', input: { name: 'product_research' } }] },
    { text: 'Who is the gift for?' },
  ], { config: { site: 'example-shop', version: '1', issuedAt: '2026-10-14T00:00:00Z', disabledTools: [], disabledSkills: ['product_research'], budgets: { perTask: 5, perSession: 8, perDay: 10 }, rateLimitPerSecond: 2, signature: 'test' } });
  const turn = await client.turn('a gift for my dad', HOME);
  assert.deepEqual(types(turn), ['answer']);
  assert.deepEqual(lastResults(model, 1), [{ type: 'tool-result', id: 'toolu_fake_1', name: 'load_skill', output: '# Gift ideas\nAsk who the gift is for before searching.', isError: false }]);
  const second = lastResults(model, 2);
  assert.match(String(second[0]!.output), /already loaded/);
  assert.deepEqual(reasons(second), ['ok', 'unknown_skill', 'skill_disabled']);
  assert.match((second[1]!.output as { message: string }).message, /Skills: product_research, gift_ideas\./);
});

test("skill preload: the page type's skill loads before the first model call; the item on screen is a known ID", async () => {
  const { client, model } = setup([
    { text: 'This one.', calls: [{ name: 'present_detail', input: { entity: 'product', id: 7 } }] },
    { text: 'Still this one.', calls: [{ name: 'present_detail', input: { entity: 'product', id: 7 } }] },
  ]);
  const turn = await client.turn('tell me about this', productPage(7));
  assert.deepEqual(turn.answer!.present, [{ name: 'present_detail', args: { entity: 'product', id: 7 } }, notice]);
  const [user, call, result] = model.requests[0]!.messages;
  assert.equal(user!.role, 'user');
  assert.deepEqual(call, { role: 'assistant', content: [{ type: 'tool-call', id: 'preload_product_research', name: 'load_skill', input: { name: 'product_research' } }] });
  assert.deepEqual(result, { role: 'tool', content: [{ type: 'tool-result', id: 'preload_product_research', name: 'load_skill', output: '# Product research\nCompare products by price and rating; read reviews for what owners say.', isError: false }] });
  await client.turn('and again', productPage(7));
  assert.equal(textOf(model.requests[1]!.messages).split('preload_product_research').length - 1, 2, 'one call and one result: not loaded twice');
});

test('step budget: a last step that still needs site tools ends the turn with an error, not a partial answer', async () => {
  const OUT_OF_STEPS = "I couldn't finish this within the steps I can take for one request, so I'm not showing a partial answer. Try asking for less at once.";
  const { client, model, brain } = setup([
    { calls: [search('a')] }, { calls: [search('b')] }, { text: 'Checking more…', calls: [search('c')] },
  ], { limits: { stepsPerTurn: 3 } });
  const turn = await client.turn('every shoe', HOME);
  assert.deepEqual(callIds(turn), ['call_1', 'call_2'], 'the last step\'s call is not sent');
  assert.equal(turn.answer, null);
  assert.deepEqual(turn.error, { type: 'error', traceId: turn.traceId, code: 'budget_reached', message: OUT_OF_STEPS });
  assert.ok(!textOf(model.requests[2]!.messages).includes('out of steps'), 'the last step is not told to rush');
  assert.deepEqual(historyProblems(brain.historyOf(client.sessionId)!), []);

  const refusedAtTheEnd = setup([{ calls: [search('a')] }, { text: 'Here.', calls: [items([1, 99])] }], { limits: { stepsPerTurn: 2 } });
  const refusedTurn = await refusedAtTheEnd.client.turn('every shoe', HOME);
  assert.equal(refusedTurn.error?.code, 'budget_reached', 'a card it can no longer fix: no answer rather than half of one');

  const finishedInTime = setup([{ calls: [search('a')] }, { text: 'Here is what I found.', calls: [items([1])] }], { limits: { stepsPerTurn: 2 } });
  const finishedTurn = await finishedInTime.client.turn('every shoe', HOME);
  assert.deepEqual(finishedTurn.answer, { type: 'answer', traceId: finishedTurn.traceId, text: 'Here is what I found.', present: [{ name: 'present_items', args: { entity: 'product', ids: [1] } }, notice] }, 'an answer on the last step is a normal answer');
});

test('results: accepted only for the calls the brain is waiting for, each exactly once', async () => {
  for (const tamper of [
    (results: ToolResult[]) => [{ ...results[0]!, id: 'call_99' }],
    (results: ToolResult[]) => [results[0]!, results[0]!],
    (results: ToolResult[]) => [results[0]!],
  ]) {
    const { brain, model } = setup([{ calls: [search('a'), search('b')] }, { text: 'Fresh start.' }]);
    const client = new FakeClient(inProcess(brain), { site: 'example-shop', validate: validateMessage, results: shopResults, tamper });
    const turn = await client.turn('shoes', HOME);
    assert.deepEqual(turn.error, { type: 'error', traceId: turn.traceId, code: 'internal', message: 'Something went wrong. Try again.' });
    const next = await client.turn('try again', HOME);
    assert.equal(next.answer?.text, 'Fresh start.');
    assert.deepEqual(historyProblems(model.requests[1]!.messages), [], 'the refused calls were closed with errors');
  }
});

test('results: expire when the turn is not waiting; malformed and oversized outputs reach the model as errors', async () => {
  const { brain, send, model } = setup([{ calls: [search('a'), search('b'), search('c')] }, { text: 'Done.' }]);
  const stale: ClientResults = { type: 'results', sessionId: 'sess_nobody_home', traceId: 'trace_nobody_home', results: [{ id: 'call_1', ok: true, output: {} }] };
  const events = [];
  for await (const event of send(stale)) events.push(event);
  assert.deepEqual(events, [{ type: 'error', traceId: 'trace_nobody_home', code: 'timeout', message: 'This request expired. Ask again.' }]);

  const client = new FakeClient(inProcess(brain), {
    site: 'example-shop', validate: validateMessage,
    results: (call) => {
      const query = (call.args as { query: string }).query;
      if (query === 'a') return { ok: true, output: { items: [] } };
      if (query === 'b') return { ok: true, output: { products: [{ id: 1, name: 'x'.repeat(200_000) }] } };
      return { ok: false, error: { code: 'upstream_error', reason: 'site_unavailable', message: 'The site had a problem.', retryable: true } };
    },
  });
  const turn = await client.turn('shoes', HOME);
  assert.equal(turn.answer?.text, 'Done.');
  assert.deepEqual(reasons(lastResults(model, 1)), ['response_changed', 'response_changed', 'site_unavailable']);
});

test('results timeout: a client that never answers ends the turn; the next turn still works', async () => {
  const { brain, client, model, send, log } = setup([{ calls: [search('a')] }, { text: 'Back again.' }], {
    limits: { resultsTimeoutMs: 30 }, results: () => DROP,
  });
  const turn = await client.turn('shoes', HOME);
  assert.deepEqual(types(turn), ['tool_call', 'await_results']);
  await sleep(80);
  assert.ok(log.some((entry) => entry.kind === 'turn_end' && (entry.detail as { why: string }).why === 'results timed out'));
  const late: ClientResults = { type: 'results', sessionId: client.sessionId, traceId: turn.traceId, results: [{ id: 'call_1', ok: true, output: SEARCH_OUTPUT }] };
  const events = [];
  for await (const event of send(late)) events.push(event);
  assert.equal((events[0] as { code: string }).code, 'timeout');
  const next = await client.turn('hello?', HOME, shopResults);
  assert.equal(next.answer?.text, 'Back again.');
  const closed = model.requests[1]!.messages.find((message) => message.role === 'tool')!.content[0] as ToolResultPart;
  assert.match((closed.output as { message: string }).message, /didn't return a result: the user's device didn't send it in time/);
  assert.deepEqual(historyProblems(brain.historyOf(client.sessionId)!), []);
});

test('model failures: an API error, a hang, and an ignored abort each end the turn with a plain message', async () => {
  const cases: [FakeStep, string, string][] = [
    [{ fail: 'overloaded' }, 'internal', "The assistant couldn't answer just now. Try again."],
    [{ hang: 'abortable' }, 'timeout', 'The assistant took too long to answer. Try again.'],
    [{ hang: 'deaf' }, 'timeout', 'The assistant took too long to answer. Try again.'],
    [{ calls: [search('a')], fail: 'connection reset' }, 'internal', "The assistant couldn't answer just now. Try again."],
  ];
  for (const [step, code, message] of cases) {
    const { client, brain } = setup([step, { text: 'Working now.' }], { limits: { modelTimeoutMs: 30 } });
    const turn = await client.turn('shoes', HOME);
    assert.deepEqual(turn.error, { type: 'error', traceId: turn.traceId, code, message });
    assert.equal((await client.turn('again', HOME)).answer?.text, 'Working now.');
    assert.deepEqual(historyProblems(brain.historyOf(client.sessionId)!), [], 'a failed step leaves nothing half-written');
  }
});

test('supersede while waiting: a new message closes the old calls; their results expire', async () => {
  const { brain, client, send, model } = setup([{ calls: [search('a')] }, { text: 'New answer.' }], { results: () => DROP });
  const old = await client.turn('shoes', HOME);
  const fresh = await client.turn('actually, boots', HOME, shopResults);
  assert.equal(fresh.answer?.text, 'New answer.');
  const late = [];
  for await (const event of send({ type: 'results', sessionId: client.sessionId, traceId: old.traceId, results: [{ id: 'call_1', ok: true, output: SEARCH_OUTPUT }] })) late.push(event);
  assert.equal((late[0] as { code: string }).code, 'timeout');
  assert.match(textOf(model.requests[1]!.messages), /the user sent a new message first/);
  assert.deepEqual(historyProblems(brain.historyOf(client.sessionId)!), []);
});

test('supersede while the model writes: the step is aborted; the new turn runs on a clean history', async () => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const { brain, client, model } = setup([
    { calls: [search('a'), search('b')], beforeCall: (i) => (i === 1 ? paused : undefined), hang: 'abortable' },
    { text: 'Boots it is.' },
  ]);
  let firstCall!: () => void;
  const sawCall = new Promise<void>((resolve) => { firstCall = resolve; });
  const old = client.turn('shoes', HOME, (call) => { firstCall(); return shopResults(call); });
  await within(sawCall, 2000, 'the first call never arrived');
  const fresh = await client.turn('boots instead', HOME);
  release();
  const oldTurn = await old;
  assert.equal(fresh.answer?.text, 'Boots it is.');
  assert.equal(oldTurn.answer, null);
  assert.deepEqual(historyProblems(model.requests[1]!.messages), []);
  assert.ok(!textOf(model.requests[1]!.messages).includes('toolu_fake_1'), 'the aborted step left nothing in the history');
  assert.deepEqual(historyProblems(brain.historyOf(client.sessionId)!), []);
});

test('client stops reading: the model call is aborted and the turn ends', async () => {
  let aborted = false;
  const { brain, send, client, log } = setup([
    (request) => {
      request.signal.addEventListener('abort', () => { aborted = true; });
      return { calls: [search('a')], hang: 'abortable' };
    },
    { text: 'Hi again.' },
  ]);
  const stream = send({ type: 'turn', site: 'example-shop', sessionId: client.sessionId, traceId: 'trace_walkaway_1', message: 'shoes', pageContext: HOME })[Symbol.asyncIterator]();
  const first = await stream.next();
  assert.equal((first.value as { type: string }).type, 'tool_call');
  await stream.return!(undefined);
  assert.ok(aborted, 'the model call was aborted');
  assert.ok(log.some((entry) => entry.kind === 'turn_end' && (entry.detail as { why: string }).why === 'the client went away'));
  assert.equal((await client.turn('hello', HOME)).answer?.text, 'Hi again.');
  assert.deepEqual(historyProblems(brain.historyOf(client.sessionId)!), []);
});

test('client already gone: the model is not called at all', async () => {
  const { brain, client, model } = setup([{ text: 'Hello again.' }]);
  const hungUp = new AbortController();
  hungUp.abort();
  const accepted = brain.accept({ type: 'turn', site: 'example-shop', sessionId: client.sessionId, traceId: 'trace_gone_1', message: 'shoes', pageContext: HOME }, { signal: hungUp.signal });
  assert.ok(accepted.ok);
  const events = [];
  for await (const event of accepted.events) events.push(event);
  assert.deepEqual(events, []);
  assert.equal(model.requests.length, 0, 'no model call for a client that is gone');
  assert.equal((await client.turn('hello', HOME)).answer?.text, 'Hello again.');
});

test('scripts: a bad source is refused; only the IDs a script returns can be shown', async () => {
  const { client, model } = setup([
    { calls: [{ name: 'run_script', input: { source: '' } }] },
    { calls: [{ name: 'run_script', input: { source: "const found = await tools.search_products({ query: 'x' }); return { ids: [found.products[0].id] };" } }] },
    { text: 'Two.', calls: [items([1, 2])] },
    { text: 'One.', calls: [items([1])] },
  ], { scripts: true });
  const turn = await client.turn('cheap shoes', HOME);
  assert.deepEqual(turn.calls.map((call) => [call.id, call.name]), [['call_1', 'run_script']], 'the empty script never reached the client');
  assert.deepEqual(reasons(lastResults(model, 1)), ['bad_arguments']);
  assert.deepEqual(reasons(lastResults(model, 3)), ['unknown_id'], 'product 2 was never returned');
  assert.equal(turn.answer?.text, 'One.');
});

test('scripts: offered only to a client that says it has a sandbox; without one a script is refused before it is sent', async () => {
  const script = { name: 'run_script', input: { source: 'return { ids: [] };' } };
  const without = setup([{ calls: [script] }, { text: 'One at a time, then.' }]);
  const turn = await without.client.turn('every shoe', HOME);
  assert.ok(!without.model.requests[0]!.tools.some((tool) => tool.name === 'run_script'), 'not offered');
  assert.deepEqual(turn.calls, [], 'never sent to the client');
  assert.deepEqual(reasons(lastResults(without.model, 1)), ['scripts_off']);
  assert.equal(turn.answer?.text, 'One at a time, then.');
  // The first turn decides: a later turn that claims a sandbox doesn't change the tools mid-conversation.
  const later = setup([{ text: 'Hi.' }, { text: 'Hi again.' }]);
  await later.client.turn('hi', HOME);
  for await (const event of later.send({ type: 'turn', site: 'example-shop', sessionId: later.client.sessionId, traceId: 'trace_claims_1', message: 'hi', pageContext: HOME, capabilities: { scripts: true } })) void event;
  assert.equal(later.model.requests.length, 2);
  assert.ok(!later.model.requests[1]!.tools.some((tool) => tool.name === 'run_script'), 'still not offered in the same conversation');
  const withSandbox = setup([{ text: 'Hi.' }], { scripts: true });
  await withSandbox.client.turn('hi', HOME);
  assert.ok(withSandbox.model.requests[0]!.tools.some((tool) => tool.name === 'run_script'), 'offered with a sandbox');
});

test('quotas: turns, model calls and tokens per session, and model calls per day for the site', async () => {
  const turns = setup([{ text: 'One.' }, { text: 'Two.' }], { quotas: { turnsPerSession: 1 } });
  await turns.client.turn('hi', HOME);
  const refused = await turns.client.turn('hi again', HOME);
  assert.deepEqual(refused.error, { type: 'error', traceId: refused.traceId, code: 'budget_reached', message: 'This conversation has reached its limit. Start a new one to keep going.' });

  const calls = setup([{ calls: [search('a')] }, { calls: [search('b')] }, { text: 'never' }], { quotas: { modelCallsPerSession: 2 } });
  const midTurn = await calls.client.turn('shoes', HOME);
  assert.equal(midTurn.error?.code, 'budget_reached');
  assert.deepEqual(callIds(midTurn), ['call_1', 'call_2']);
  assert.deepEqual(historyProblems(calls.brain.historyOf(calls.client.sessionId)!), []);

  const tokens = setup([{ calls: [search('a')], usage: { inputTokens: 1400 } }, { text: 'never' }], { quotas: { tokensPerSession: 1500 } });
  assert.equal((await tokens.client.turn('shoes', HOME)).error?.code, 'budget_reached');

  let now = NOW;
  const day = setup([{ text: 'a' }, { text: 'b' }, { text: 'c' }], { quotas: { modelCallsPerDay: 2 }, now: () => now });
  const other = new FakeClient(day.send, { site: 'example-shop', validate: validateMessage });
  assert.equal((await day.client.turn('1', HOME)).answer?.text, 'a');
  assert.equal((await other.turn('2', HOME)).answer?.text, 'b');
  assert.deepEqual((await day.client.turn('3', HOME)).error?.message, "The assistant has reached today's limit. Try again tomorrow.");
  now += 86_400_000;
  assert.equal((await other.turn('4', HOME)).answer?.text, 'c', 'a new day');
});

test('protocol: broken messages get 400 before anything runs; results for a running turn get 409', async () => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const model = new FakeModel([{ calls: [search('a')], beforeFinish: () => paused }, { text: 'ok' }]);
  const brain = new Brain({ site: shopSite(), model, now: () => NOW });
  const turn = { type: 'turn', site: 'example-shop', sessionId: 'sess_protocol_1', traceId: 'trace_protocol_1', message: 'shoes', pageContext: HOME };
  const status = (message: unknown, endpoint?: 'turn' | 'results') => {
    const result = brain.accept(message, endpoint ? { endpoint } : {});
    return result.ok ? 200 : result.status;
  };
  assert.equal(status('hello'), 400);
  assert.equal(status({ type: 'answer', traceId: 'trace_x1234', text: 'hi' }), 400);
  assert.equal(status({ ...turn, pageContext: undefined }), 400);
  assert.equal(status({ ...turn, message: '' }), 400);
  assert.equal(status(turn, 'results'), 400);
  assert.equal(status({ ...turn, site: 'nowhere-shop' }), 400, 'a brain serves one site');
  const accepted = brain.accept(turn, { endpoint: 'turn' });
  assert.ok(accepted.ok);
  const it = accepted.events[Symbol.asyncIterator]();
  assert.equal(((await it.next()).value as { type: string }).type, 'tool_call');
  const pending = it.next();
  assert.equal(status({ type: 'results', sessionId: 'sess_protocol_1', traceId: 'trace_protocol_1', results: [{ id: 'call_1', ok: true, output: SEARCH_OUTPUT }] }, 'results'), 409);
  assert.equal(status({ ...turn, site: 'other-shop', traceId: 'trace_protocol_2' }), 400, 'a turn for another site is refused, even for a session that exists');
  release();
  assert.equal(((await pending).value as { type: string }).type, 'await_results');
});

test('one site per brain: a remote config for another site is caught at start', () => {
  const config = { site: 'other-shop', version: '1', issuedAt: '2026-10-14T00:00:00Z', disabledTools: [], disabledSkills: [], budgets: { perTask: 5, perSession: 8, perDay: 10 }, rateLimitPerSecond: 2, signature: 'test' };
  assert.throws(() => new Brain({ site: shopSite(), model: new FakeModel([]), config }), /for other-shop, not example-shop/);
});

test('idle sessions: forgotten after a while; the oldest go first when there are too many', async () => {
  let now = NOW;
  const { brain, send } = setup([{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }], { now: () => now, limits: { sessionIdleMs: 1000, maxSessions: 2 } });
  const client = (id: string) => new FakeClient(send, { site: 'example-shop', validate: validateMessage, sessionId: id });
  await client('sess_evict_a').turn('hi', HOME);
  now += 2000;
  await client('sess_evict_b').turn('hi', HOME);
  assert.equal(brain.historyOf('sess_evict_a'), undefined, 'idle too long');
  await client('sess_evict_c').turn('hi', HOME);
  await client('sess_evict_d').turn('hi', HOME);
  assert.equal(brain.sessionCount, 2);
  assert.equal(brain.historyOf('sess_evict_b'), undefined, 'the oldest went first');
});

test('empty answer: no text and nothing to show gets a plain fallback', async () => {
  const { client } = setup([{}]);
  const turn = await client.turn('hmm', HOME);
  assert.deepEqual(turn.answer, { type: 'answer', traceId: turn.traceId, text: "I couldn't put together an answer. Try asking another way.", present: [] });
});

test('progress line: the text before the calls, cut to 200 characters at a sentence', () => {
  assert.equal(progressLine('  Checking\n delivery dates…  '), 'Checking delivery dates…');
  assert.equal(progressLine(''), null);
  const long = `Searching for shoes. ${'x'.repeat(300)}`;
  assert.equal(progressLine(long), 'Searching for shoes.');
  const noStop = 'y'.repeat(300);
  assert.equal(Array.from(progressLine(noStop)!).length, 200);
  assert.ok(progressLine(noStop)!.endsWith('…'));
});

test('amend while waiting: the message reaches the model with the results, as a reminder', async () => {
  let amendReply: unknown[] = [];
  const holder: { client?: FakeClient } = {};
  const { client, model, brain } = setup([
    { calls: [search('shoes')] },
    { text: 'Here are the red ones.', calls: [items([1])] },
  ], { results: async (call) => { amendReply = await holder.client!.amend('only red ones, please'); return shopResults(call); } });
  holder.client = client;
  const turn = await client.turn('shoes', HOME);
  assert.deepEqual(amendReply, [{ type: 'amended', traceId: turn.traceId, status: 'queued' }]);
  const messages = model.requests[1]!.messages;
  assert.equal(messages.at(-2)!.role, 'tool', 'the tool results come first');
  const reminder = messages.at(-1)!;
  assert.equal(reminder.role, 'user', 'then the reminder, in the same user turn once the adapter merges them');
  assert.match(textOf([reminder]), /<system-reminder>\\nThe user sent a new message while you were working:\\nonly red ones, please/);
  assert.equal(turn.answer?.text, 'Here are the red ones.');
  assert.equal(turn.answer?.followUps, undefined);
  assert.deepEqual(historyProblems(brain.historyOf(client.sessionId)!), []);
});

test('amend during the last step: the message comes back on the answer as a follow-up', async () => {
  const holder: { client?: FakeClient } = {};
  const { client, model } = setup([
    { calls: [search('shoes')] },
    { text: 'Two shoes.', calls: [items([1, 2])], beforeFinish: async () => { await holder.client!.amend('and boots too'); } },
  ]);
  holder.client = client;
  const turn = await client.turn('shoes', HOME);
  assert.deepEqual(turn.answer?.followUps, ['and boots too']);
  assert.equal(model.requests.length, 2, 'the answer is not held back for it');
});

test('amend while cards wait: the model is told what is held, and new cards replace them', async () => {
  const holder: { client?: FakeClient } = {};
  const { client, model } = setup([
    { calls: [search('shoes')] },
    { calls: [items([1, 2])], beforeFinish: async () => { await holder.client!.amend('just the cheaper one'); } },
    { text: 'The cheaper one.', calls: [items([1])] },
  ]);
  holder.client = client;
  const turn = await client.turn('shoes', HOME);
  assert.match(textOf([model.requests[2]!.messages.at(-1)!]), /just the cheaper one/);
  assert.deepEqual(turn.answer?.present, [{ name: 'present_items', args: { entity: 'product', ids: [1] } }, notice]);
});

test('amend while cards wait: a text-only reply keeps the held cards', async () => {
  const holder: { client?: FakeClient } = {};
  const { client, model } = setup([
    { calls: [search('shoes')] },
    { calls: [items([1, 2])], beforeFinish: async () => { await holder.client!.amend('which one rates higher?') } },
    { text: 'The red one rates higher: 4.5 against 3.9.' },
  ]);
  holder.client = client;
  const turn = await client.turn('shoes', HOME);
  assert.match(textOf([model.requests[2]!.messages.at(-1)!]), /You were about to show: present_items \(product 1, 2\)\. Handle the user's message however it needs, with more tools if useful\. When you answer, those cards are shown with it, unless you call presentation tools again; whatever you send then replaces them\./);
  assert.deepEqual(turn.answer, { type: 'answer', traceId: turn.traceId, text: 'The red one rates higher: 4.5 against 3.9.', present: [{ name: 'present_items', args: { entity: 'product', ids: [1, 2] } }, notice] });
});

test('amend too late: refused for an ended turn or no turn; an empty message is refused', async () => {
  const { client, brain } = setup([{ text: 'Hi.' }]);
  const turn = await client.turn('hello', HOME);
  assert.ok(turn.answer);
  assert.deepEqual(await client.amend('one more thing'), [{ type: 'amended', traceId: turn.traceId, status: 'too_late' }]);
  const stranger = brain.accept({ type: 'amend', sessionId: 'sess_never_seen', traceId: 'trace_never_seen', message: 'hi' });
  assert.ok(stranger.ok);
  const replies = [];
  for await (const reply of stranger.events) replies.push(reply);
  assert.deepEqual(replies, [{ type: 'amended', traceId: 'trace_never_seen', status: 'too_late' }]);
  const empty = brain.accept({ type: 'amend', sessionId: client.sessionId, traceId: turn.traceId, message: '' });
  assert.deepEqual(empty.ok ? 200 : empty.status, 400);
});

/** The reasons the loop went round again, in order, from the brain's log. */
const nextSteps = (log: { kind: string; detail: unknown }[]) => log.filter((entry) => entry.kind === 'next_step').map((entry) => (entry.detail as { reason: string }).reason);

test('next-step reasons: every loop that skips the client is logged with its reason', async () => {
  const { client, log, brain } = setup([
    { calls: [{ name: 'load_skill', input: { name: 'gift_ideas' } }] },
    { calls: [search('shoes')] },
    { text: 'Here.', calls: [items([99])] },
    { calls: [items([1])] },
    { text: 'Found one.' },
  ]);
  const turn = await client.turn('a gift for my dad', HOME);
  assert.equal(turn.answer?.text, 'Found one.');
  assert.deepEqual(nextSteps(log), ['server_calls', 'cards_refused', 'cards_kept'], 'waiting for the client is not a next step: the stream ends there');
  assert.deepEqual(historyProblems(brain.historyOf(client.sessionId)!), []);
});

test('card retries: a refused card is retried cardRetriesPerTurn times, then the cards that passed are shown', async () => {
  const { client, model, log, brain } = setup([
    { calls: [search('shoes')] },
    { text: 'Here.', calls: [items([99])] },
    { text: 'Here.', calls: [items([98])] },
    { text: 'Here is one.', calls: [items([97]), items([1])] },
  ]);
  const turn = await client.turn('shoes', HOME);
  assert.equal(model.requests.length, 4, 'two retries, then no more');
  assert.deepEqual(nextSteps(log), ['cards_refused', 'cards_refused']);
  assert.ok(log.some((entry) => entry.kind === 'card_retries_used_up'));
  assert.deepEqual(turn.answer, { type: 'answer', traceId: turn.traceId, text: 'Here is one.', present: [{ name: 'present_items', args: { entity: 'product', ids: [1] } }, notice] });
  const history = brain.historyOf(client.sessionId)!;
  assert.deepEqual(reasons(history.at(-1)!.content as ToolResultPart[]), ['unknown_id', 'ok'], 'the dropped card is closed with its reason');
  assert.deepEqual(historyProblems(history), []);
});

test('cut-off reply: dropped and asked for again once with a larger limit; a second cut-off ends the turn', async () => {
  const retried = setup([{ text: 'The first half of a long', finish: 'length' }, { text: 'The whole answer.' }]);
  const turn = await retried.client.turn('compare everything', HOME);
  assert.equal(turn.answer?.text, 'The whole answer.');
  assert.deepEqual(retried.model.requests.map((request) => request.maxOutputTokens), [4096, 16_384]);
  assert.deepEqual(retried.model.requests[1]!.messages, retried.model.requests[0]!.messages, 'the cut-off step never reached the history');
  assert.deepEqual(nextSteps(retried.log), ['cut_off_retry']);
  assert.deepEqual(historyProblems(retried.brain.historyOf(retried.client.sessionId)!), []);

  const twice = setup([{ text: 'Half', finish: 'length' }, { text: 'Still half', finish: 'length' }, { text: 'Fresh start.' }]);
  const failed = await twice.client.turn('compare everything', HOME);
  assert.deepEqual(failed.error, { type: 'error', traceId: failed.traceId, code: 'internal', message: 'The answer came out too long to finish. Try asking for less at once.' });
  assert.equal(failed.answer, null, 'no half-written answer is shown');
  assert.equal((await twice.client.turn('just the price', HOME)).answer?.text, 'Fresh start.');
  assert.deepEqual(historyProblems(twice.brain.historyOf(twice.client.sessionId)!), []);
});

test('cut-off reply after client calls: kept, and the model goes on after their results', async () => {
  const { client, model, log, brain } = setup([{ text: 'Searching…', calls: [search('a')], finish: 'length' }, { text: 'Done.' }]);
  const turn = await client.turn('shoes', HOME);
  assert.deepEqual(callIds(turn), ['call_1']);
  assert.equal(turn.answer?.text, 'Done.');
  assert.deepEqual(model.requests.map((request) => request.maxOutputTokens), [4096, 4096]);
  assert.ok(log.some((entry) => entry.kind === 'reply_cut_off' && (entry.detail as { outcome: string }).outcome === 'kept'));
  assert.deepEqual(historyProblems(brain.historyOf(client.sessionId)!), []);
});
