// Tests: what the brain keeps of a signed-in account (sign-in mode): session memory and real-session traces replace a
// tool's personal fields, a script result that read any, and the answer of a turn that read them.
// How: every site pack with a tool that has personal fields; its output schema's example as the result; a history in
// the brain's own shapes for memory, and the trace writer fed the link's messages directly, into a temporary folder.
// Passes when: no personal value from the result is in the memory or the trace, the turn's answer is a placeholder in
// both, the IDs are still kept, and a turn that read nothing personal keeps its answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { valuesAt } from '../../contract/src/paths.ts';
import { PERSONAL_PLACEHOLDER } from '../../contract/src/privacy.ts';
import { entriesOf, listSites, readSite } from '../../contract/src/site-pack.ts';
import { condense } from '../src/memory/condense.ts';
import type { ChatMessage } from '../src/model/model.ts';
import { contextBlock, SCRIPT_TOOL } from '../src/prompt/prompt.ts';
import { loadSite } from '../src/prompt/site.ts';
import { TraceWriter } from '../src/server/traces.ts';

const NOW = Date.parse('2026-11-15T10:00:00Z');
const ANSWER = 'You have one upcoming trip, from SFO to SEA on December 3.';

/** Every tool with personal fields, on every site pack. */
const personalTools = listSites().flatMap((site) => entriesOf(readSite(site).pack.tools).filter(([, tool]) => tool.privacy?.personal?.length).map(([name]) => ({ site, name })));

test('there is a site pack with personal fields, so these rules run on at least one', () => {
  assert.ok(personalTools.length > 0);
});

for (const { site, name } of personalTools) {
  test(`${site}/${name}: session memory keeps the IDs but none of the personal values, and no answer for the turn`, async () => {
    const bundle = await loadSite(site);
    const tool = bundle.pack.tools[name]!;
    const output = exampleOutput(site, tool.output);
    const personal = personalValues(output, tool.privacy!.personal!);
    assert.ok(personal.length, 'the example has personal values to look for');
    const page = { url: bundle.pack.site.origins[0]!, pageType: bundle.pack.site.pageTypes?.[0] ?? 'home', signedIn: true };
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'my account' }, { type: 'text', text: contextBlock(page, NOW) }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm1', name, input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'm1', name, output, isError: false }] },
      { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
      { role: 'user', content: [{ type: 'text', text: 'and a script?' }, { type: 'text', text: contextBlock(page, NOW) }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm2', name: SCRIPT_TOOL, input: { source: '…' } }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'm2', name: SCRIPT_TOOL, output: { result: { found: personal }, knownIds: {}, personal: true }, isError: false }] },
      { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }, { type: 'text', text: contextBlock(page, NOW) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'You are welcome.' }] },
    ];
    const memory = condense({ sessionId: 'sess_1', bundle, history, knownIds: [], usage: { turns: 3, modelCalls: 3, tokens: 0 }, previous: null, lastSeen: NOW, now: NOW });
    const kept = JSON.stringify(memory);
    for (const value of personal) assert.ok(!kept.includes(value), `"${value}" is in the memory`);
    assert.deepEqual(memory.turns.map((turn) => turn.answer), [PERSONAL_PLACEHOLDER, PERSONAL_PLACEHOLDER, 'You are welcome.']);
    const idPaths = tool.ids?.output ?? [];
    for (const idPath of idPaths) for (const id of valuesAt(output, idPath.path)) assert.ok(memory.turns[0]!.calls[0]!.ids.some((entry) => entry.id === id), `ID ${String(id)} is kept`);
  });

  test(`${site}/${name}: a real-session trace keeps none of the personal values, and no answer for the turn`, async () => {
    const { pack } = readSite(site);
    const output = exampleOutput(site, pack.tools[name]!.output);
    const personal = personalValues(output, pack.tools[name]!.privacy!.personal!);
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
    traces.sent({ type: 'answer', traceId: 'trace_3', text: 'You are welcome.', present: [] });
    const [day] = readdirSync(path.join(dir, site));
    const text = readFileSync(path.join(dir, site, day!, 'sess_1.jsonl'), 'utf8');
    for (const value of personal) assert.ok(!text.includes(value), `"${value}" is in the trace`);
    const answers = text.trim().split('\n').map((line) => JSON.parse(line) as { out?: { type: string; text: string } }).filter((line) => line.out?.type === 'answer').map((line) => line.out!.text);
    assert.deepEqual(answers, [PERSONAL_PLACEHOLDER, PERSONAL_PLACEHOLDER, 'You are welcome.']);
  });
}

/** The first example of a tool's output schema. */
function exampleOutput(site: string, rel: string): Record<string, unknown> {
  const schema = JSON.parse(readFileSync(path.join(readSite(site).schemasDir, rel), 'utf8')) as { examples?: Record<string, unknown>[] };
  return schema.examples![0]!;
}

/** The text of every value at the personal paths, long enough to look for. */
function personalValues(output: unknown, paths: readonly string[]): string[] {
  return paths.flatMap((personalPath) => valuesAt(output, personalPath)).map(String).filter((value) => value.length >= 4);
}
