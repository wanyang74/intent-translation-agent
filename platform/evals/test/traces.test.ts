// Tests: reading real-session traces back (evals/src/traces.ts): the report's numbers and promotion into test drafts.
// How: each site's example conversations written out as traces, the way the brain's HTTP server writes them, then
// moved to another zip with a URL query added, as a real user's session would be; plus small made-up traces.
// Passes when: promoting gives back the example conversation (the standard zip, no query, the exact fixtures, no
// checker problems); the summary counts steps, calls, failures, unavailable tools, refusals, times and tokens;
// IP addresses are blanked and an encoded value still holding the user's zip is reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { listSites } from '../../contract/src/site-pack.ts';
import type { Message } from '../../contract/generated/types.ts';
import type { TraceLine } from '../../brain/src/server/traces.ts';
import { loadConversations, type Conversation } from '../../testkit/src/conversations.ts';
import { hasFixtures } from '../../testkit/src/fixtures.ts';
import { costOf, describeTraces, promoteTrace, standardZip, summarizeTrace, type Trace } from '../src/traces.ts';

const USER_ZIP = '00501';
const isClient = (message: Message) => message.type === 'turn' || message.type === 'results' || message.type === 'amend';

/** A conversation as the brain's server would trace it: one line per message, a second apart, with a model step logged before each event. */
function traceOf(conversation: Conversation, edit: (text: string) => string = (text) => text): Trace {
  const start = Date.parse(conversation.now ?? '2026-11-05T20:00:00Z');
  const lines: TraceLine[] = [];
  const at = () => new Date(start + lines.length * 1000).toISOString();
  for (const original of conversation.messages) {
    const message = JSON.parse(edit(JSON.stringify(original))) as Message;
    if (isClient(message)) {
      lines.push({ at: at(), in: message });
      continue;
    }
    if (message.type === 'tool_call' || message.type === 'answer') {
      lines.push({ at: at(), log: { sessionId: 'sess_real', traceId: message.traceId, kind: 'model_step', detail: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 } } });
    }
    lines.push({ at: at(), out: message });
  }
  return { file: `/traces/${conversation.site}/2026-11-05/sess_real.jsonl`, site: conversation.site, sessionId: 'sess_real', lines };
}

/** The same conversation as a real user's session: at another zip, on a page URL with a query. */
function asRealUser(conversation: Conversation, zip: string | null): Trace {
  return traceOf(conversation, (text) => {
    const moved = zip ? text.replace(new RegExp(`\\b${zip}\\b`, 'g'), USER_ZIP) : text;
    return moved.replace(/"url":"([^"?]*)"/g, '"url":"$1?utm_source=newsletter&visitor=abc"');
  });
}

const withoutRunIds = (messages: readonly Message[]) => messages.map((message) => {
  const { sessionId: _sessionId, traceId: _traceId, ...rest } = message as Message & { sessionId?: string };
  return rest;
});

for (const site of listSites().filter(hasFixtures)) {
  for (const conversation of loadConversations(site).filter((candidate) => candidate.pageData === undefined)) {
    test(`${site}/${conversation.id}: promoting a real user's trace gives back the conversation, at the standard zip, with its exact fixtures`, async () => {
      const zip = standardZip(site);
      const promoted = await promoteTrace(asRealUser(conversation, zip), { id: 'draft' });
      assert.deepEqual(withoutRunIds(promoted.conversation.messages), withoutRunIds(conversation.messages));
      assert.deepEqual(promoted.conversation.fixtures, [...conversation.fixtures].sort());
      assert.deepEqual(promoted.problems, []);
      assert.ok(!JSON.stringify(promoted).includes('utm_source'), 'page URLs lose their query');
      if (zip && JSON.stringify(conversation.messages).includes(zip)) assert.ok(!JSON.stringify(promoted.conversation).includes(USER_ZIP), "the user's zip is gone");
      assert.ok(promoted.notes.every((note) => !/no recording yet|differ/.test(note)), promoted.notes.join('\n'));
      assert.equal(promoted.caseDrafts.length, conversation.messages.filter((message) => message.type === 'turn').length);
    });
  }
}

test("summary: each turn's steps, calls, failures, unavailable tools, refusals, times and tokens", () => {
  const page = { url: 'https://www.example.com/', pageType: 'other' };
  const lines: TraceLine[] = [
    { at: '2026-11-05T20:00:00.000Z', in: { type: 'turn', site: 'example', sessionId: 'sess_a', traceId: 'trace_1', message: 'VINs for these cars?', pageContext: page } },
    { at: '2026-11-05T20:00:01.000Z', log: { sessionId: 'sess_a', traceId: 'trace_1', kind: 'model_step', detail: { inputTokens: 8000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 8000 } } },
    { at: '2026-11-05T20:00:01.500Z', out: { type: 'tool_call', traceId: 'trace_1', call: { id: 'call_1', name: 'item_details', args: {} } } },
    { at: '2026-11-05T20:00:01.600Z', out: { type: 'await_results', traceId: 'trace_1', callIds: ['call_1'] } },
    { at: '2026-11-05T20:00:02.000Z', in: { type: 'results', sessionId: 'sess_a', traceId: 'trace_1', results: [{ id: 'call_1', ok: false, error: { code: 'tool_disabled', message: "item_details isn't available yet." } }] } },
    { at: '2026-11-05T20:00:04.000Z', log: { sessionId: 'sess_a', traceId: 'trace_1', kind: 'model_step', detail: { inputTokens: 9000, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 1000 } } },
    { at: '2026-11-05T20:00:04.500Z', out: { type: 'answer', traceId: 'trace_1', text: "I can't get those yet." } },
    { at: '2026-11-05T20:00:04.600Z', log: { sessionId: 'sess_a', traceId: 'trace_1', kind: 'turn_end', detail: { why: 'answered', steps: 2 } } },
    { at: '2026-11-05T20:01:00.000Z', in: { type: 'turn', site: 'example', sessionId: 'sess_a', traceId: 'trace_2', message: '', pageContext: page } },
    { at: '2026-11-05T20:01:00.000Z', refused: { status: 400, error: 'the message breaks the protocol', traceId: 'trace_2' } },
  ];
  const summary = summarizeTrace({ file: '/traces/example/2026-11-05/sess_a.jsonl', site: 'example', sessionId: 'sess_a', lines });
  assert.equal(summary.turns.length, 1, 'a refused turn is not a turn');
  const [turn] = summary.turns;
  assert.deepEqual(
    { steps: turn!.steps, calls: turn!.calls, failures: turn!.failures, unavailable: turn!.unavailable, firstEventMs: turn!.firstEventMs, answerMs: turn!.answerMs, ended: turn!.ended, tokens: turn!.tokens },
    { steps: 2, calls: { item_details: 1 }, failures: ['item_details: tool_disabled'], unavailable: ['item_details'], firstEventMs: 1500, answerMs: 4500, ended: 'answered', tokens: { input: 17000, output: 300, cacheRead: 8000, cacheWrite: 9000 } },
  );
  const prices = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  // 0 fresh input tokens; 8,000 read at $0.30, 9,000 written at $3.75 and 300 out at $15, per million.
  assert.equal(costOf(turn!.tokens, prices).toFixed(6), ((8000 * 0.3 + 9000 * 3.75 + 300 * 15) / 1e6).toFixed(6));
  const report = describeTraces([summary], prices);
  assert.match(report, /asked for but not available yet: item_details ×1/);
  assert.match(report, /cache hit rate 47%/);
  assert.match(describeTraces([summary]), /set TRACE_PRICES/);
});

for (const site of listSites().filter(hasFixtures)) {
  const [conversation] = loadConversations(site).filter((candidate) => candidate.pageData === undefined);
  const zip = standardZip(site);
  if (!conversation) continue;
  test(`${site}: promotion blanks IP addresses${zip ? " and reports encoded values that still hold the user's zip" : ''}`, async () => {
    const token = gzipSync(Buffer.from(JSON.stringify({ zip: USER_ZIP }))).toString('base64url');
    const trace = asRealUser({
      ...conversation,
      messages: conversation.messages.map((message, i) => (i === 0 && message.type === 'turn' ? { ...message, message: `${message.message} (from 203.0.113.9, ${token})` } : message)),
    }, zip);
    const promoted = await promoteTrace(trace, { id: 'draft', ...(zip ? {} : { zip: '94000' }) });
    const firstTurn = promoted.conversation.messages[0];
    assert.ok(firstTurn?.type === 'turn' && firstTurn.message.includes('0.0.0.0') && !firstTurn.message.includes('203.0.113.9'));
    assert.ok(promoted.notes.some((note) => /1 IP addresses were blanked/.test(note)));
    if (zip) assert.ok(promoted.notes.some((note) => /1 encoded values still hold the user's zip/.test(note)), promoted.notes.join('\n'));
  });
}
