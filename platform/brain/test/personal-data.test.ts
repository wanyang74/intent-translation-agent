// Tests: what the brain keeps of a signed-in account (sign-in mode): session memory replaces a tool's personal fields,
// a script result that read any, and the answer of a turn that read them, but keeps account data (a miles balance, a
// trip's dates) so a reopened conversation still knows it; real-session traces replace both levels.
// How: every site pack with a tool that has personal or account fields; its output schema's example as the result; a
// history in the brain's own shapes for memory, and the trace writer fed the link's messages directly, into a temporary
// folder. A script that read only account data is the third turn.
// Passes when: no personal value is in the memory and no personal or account value is in the trace; account values are
// in the memory; answers are placeholders exactly where the turn read a level that record replaces; the IDs are kept;
// and a turn that read nothing private keeps its answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { valuesAt } from '../../contract/src/paths.ts';
import { PERSONAL_PLACEHOLDER, readsLevel, REDACTED_IN } from '../../contract/src/privacy.ts';
import { entriesOf, listSites, readSite } from '../../contract/src/site-pack.ts';
import { condense } from '../src/memory/condense.ts';
import type { ChatMessage } from '../src/model/model.ts';
import { contextBlock, SCRIPT_TOOL } from '../src/prompt/prompt.ts';
import { loadSite } from '../src/prompt/site.ts';
import { TraceWriter } from '../src/server/traces.ts';

const NOW = Date.parse('2026-11-15T10:00:00Z');
const ANSWER = 'You have one upcoming trip, from SFO to SEA on December 3.';

/** Every tool with personal or account fields, on every site pack. */
const privateTools = listSites().flatMap((site) => entriesOf(readSite(site).pack.tools).filter(([, tool]) => tool.privacy?.personal?.length || tool.privacy?.account?.length).map(([name]) => ({ site, name })));

test('there are site packs with personal and with account fields, so these rules run on both', () => {
  const packs = listSites().map((site) => readSite(site).pack);
  for (const level of ['personal', 'account'] as const) assert.ok(packs.some((pack) => entriesOf(pack.tools).some(([, tool]) => tool.privacy?.[level]?.length)), level);
});

for (const { site, name } of privateTools) {
  test(`${site}/${name}: session memory keeps the IDs and the account values, but none of the personal ones`, async () => {
    const bundle = await loadSite(site);
    const tool = bundle.pack.tools[name]!;
    const output = exampleOutput(site, tool.output);
    const personal = valuesOf(output, tool.privacy!.personal ?? []);
    const account = valuesOf(output, tool.privacy!.account ?? []);
    const page = { url: bundle.pack.site.origins[0]!, pageType: bundle.pack.site.pageTypes?.[0] ?? 'home', signedIn: true };
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'my account' }, { type: 'text', text: contextBlock(page, NOW) }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm1', name, input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'm1', name, output, isError: false }] },
      { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
      { role: 'user', content: [{ type: 'text', text: 'and a script?' }, { type: 'text', text: contextBlock(page, NOW) }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm2', name: SCRIPT_TOOL, input: { source: '…' } }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'm2', name: SCRIPT_TOOL, output: { result: { found: personal }, knownIds: {}, personal: true, account: true }, isError: false }] },
      { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
      { role: 'user', content: [{ type: 'text', text: 'and my account only?' }, { type: 'text', text: contextBlock(page, NOW) }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm3', name: SCRIPT_TOOL, input: { source: '…' } }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'm3', name: SCRIPT_TOOL, output: { result: { found: account }, knownIds: {}, account: true }, isError: false }] },
      { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }, { type: 'text', text: contextBlock(page, NOW) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'You are welcome.' }] },
    ];
    const memory = condense({ sessionId: 'sess_1', bundle, history, knownIds: [], usage: { turns: 4, modelCalls: 4, tokens: 0 }, previous: null, lastSeen: NOW, now: NOW });
    const kept = JSON.stringify(memory);
    for (const value of personal) assert.ok(!kept.includes(value), `"${value}" is in the memory`);
    for (const value of account) assert.ok(kept.includes(value), `"${value}" is kept, so the user needn't say it again`);
    const toolTurn = readsLevel(bundle.pack, name, REDACTED_IN.memory) ? PERSONAL_PLACEHOLDER : ANSWER;
    assert.deepEqual(memory.turns.map((turn) => turn.answer), [toolTurn, PERSONAL_PLACEHOLDER, ANSWER, 'You are welcome.']);
    const idPaths = tool.ids?.output ?? [];
    for (const idPath of idPaths) for (const id of valuesAt(output, idPath.path)) assert.ok(memory.turns[0]!.calls[0]!.ids.some((entry) => entry.id === id), `ID ${String(id)} is kept`);
  });

  test(`${site}/${name}: a real-session trace keeps none of the personal or account values, and no answer for the turn`, async () => {
    const { pack } = readSite(site);
    const privacy = pack.tools[name]!.privacy!;
    const output = exampleOutput(site, pack.tools[name]!.output);
    const personal = valuesOf(output, [...(privacy.personal ?? []), ...(privacy.account ?? [])]);
    assert.ok(personal.length, 'the example has values to look for');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'personal-trace-'));
    const traces = new TraceWriter({ dir, site, pack, keepDays: 30, now: () => new Date(NOW) });
    const turn = (traceId: string) => ({ type: 'turn', sessionId: 'sess_1', traceId, message: 'my account' });
    traces.received(turn('trace_1'));
    traces.sent({ type: 'tool_call', traceId: 'trace_1', call: { id: 'call_1', name, args: {} } });
    traces.received({ type: 'results', sessionId: 'sess_1', traceId: 'trace_1', results: [{ id: 'call_1', ok: true, output }] });
    traces.sent({ type: 'answer', traceId: 'trace_1', text: ANSWER, present: [] });
    traces.received(turn('trace_2'));
    traces.sent({ type: 'tool_call', traceId: 'trace_2', call: { id: 'call_2', name: SCRIPT_TOOL, args: {} } });
    traces.received({ type: 'results', sessionId: 'sess_1', traceId: 'trace_2', results: [{ id: 'call_2', ok: true, output: { result: { found: personal }, knownIds: {}, personal: true } }] });
    traces.sent({ type: 'answer', traceId: 'trace_2', text: ANSWER, present: [] });
    traces.received(turn('trace_3'));
    traces.sent({ type: 'tool_call', traceId: 'trace_3', call: { id: 'call_3', name: SCRIPT_TOOL, args: {} } });
    traces.received({ type: 'results', sessionId: 'sess_1', traceId: 'trace_3', results: [{ id: 'call_3', ok: true, output: { result: { found: personal }, knownIds: {}, account: true } }] });
    traces.sent({ type: 'answer', traceId: 'trace_3', text: ANSWER, present: [] });
    traces.received(turn('trace_4'));
    traces.sent({ type: 'answer', traceId: 'trace_4', text: 'You are welcome.', present: [] });
    const [day] = readdirSync(path.join(dir, site));
    const text = readFileSync(path.join(dir, site, day!, 'sess_1.jsonl'), 'utf8');
    for (const value of personal) assert.ok(!text.includes(value), `"${value}" is in the trace`);
    const answers = text.trim().split('\n').map((line) => JSON.parse(line) as { out?: { type: string; text: string } }).filter((line) => line.out?.type === 'answer').map((line) => line.out!.text);
    assert.deepEqual(answers, [PERSONAL_PLACEHOLDER, PERSONAL_PLACEHOLDER, PERSONAL_PLACEHOLDER, 'You are welcome.']);
  });
}

/** The first example of a tool's output schema. */
function exampleOutput(site: string, rel: string): Record<string, unknown> {
  const schema = JSON.parse(readFileSync(path.join(readSite(site).schemasDir, rel), 'utf8')) as { examples?: Record<string, unknown>[] };
  return schema.examples![0]!;
}

/** The text of every value at these paths, long enough to look for. */
function valuesOf(output: unknown, paths: readonly string[]): string[] {
  return paths.flatMap((personalPath) => valuesAt(output, personalPath)).map(String).filter((value) => value.length >= 4);
}
