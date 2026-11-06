// Real-session traces, read back: the files the local brain writes as people use the agent in a real browser
// (brain/src/server/traces.ts), summarized for benchmarks and turned into test drafts for quality evaluation.
// summarizeTrace measures each turn (steps, tool calls, failures, refusals, time to the first event and to the answer,
// tokens and cache use); describeTraces prints them as a report. promoteTrace makes a conversation draft from a trace
// for a person to review before it becomes a test: personal details are removed (the user's zip becomes the site's
// standard test zip, page URLs lose their query, IP addresses are blanked), and core.js replays it against the
// site's fixtures to show which requests still need a recording.
// Rules: a trace is read, never changed; drafts go to traces/<site>/drafts/, which retention leaves alone.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { ClientTurn, Message, ToolCall, ToolResult } from '../../contract/generated/types.ts';
import { loadContract } from '../../contract/src/load.ts';
import { repoRoot } from '../../contract/src/site-pack.ts';
import { runTurn, startSession } from '../../core/src/index.ts';
import type { BrainLogEntry } from '../../brain/src/agent/types.ts';
import type { TraceLine } from '../../brain/src/server/traces.ts';
import { checkConversation, type Conversation } from '../../testkit/src/conversations.ts';
import { FakeBrain } from '../../testkit/src/fake-brain.ts';
import { FakeSurface } from '../../testkit/src/fake-surface.ts';
import { loadFixtures } from '../../testkit/src/fixtures.ts';
import { loadSiteRuntime } from '../../testkit/src/site-runtime.ts';
import { testHost } from '../../testkit/src/test-host.ts';
import { loadCases } from './cases.ts';

export const defaultTraceDir = path.join(repoRoot, 'traces');

export interface Trace {
  file: string;
  site: string;
  sessionId: string;
  lines: TraceLine[];
}

/** Dollars per million tokens, for the cost column. There's no default: prices change, so the caller supplies them. */
export interface Prices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Tokens {
  /** All input tokens, cached or not. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TurnSummary {
  traceId: string;
  at: string;
  message: string;
  pageType: string;
  steps: number;
  /** Client tool calls, by tool name. */
  calls: Record<string, number>;
  /** Failed tool results, as "tool: code". */
  failures: string[];
  /** Tools the device said aren't available (tool_disabled): what users asked for that the agent can't do yet. */
  unavailable: string[];
  /** Messages the brain refused, results it turned away, quota stops and error events. */
  refusals: string[];
  /** From the user's message to the first thing the brain sent back (a progress line or a tool call), in ms. */
  firstEventMs: number | null;
  /** From the user's message to the answer, in ms; null when no answer came. */
  answerMs: number | null;
  /** Why the turn ended, from the brain's log. */
  ended: string | null;
  tokens: Tokens;
}

export interface SessionSummary {
  file: string;
  site: string;
  sessionId: string;
  started: string;
  turns: TurnSummary[];
}

/** Trace files under the traces folder, oldest first, optionally for some sites and from a date (YYYY-MM-DD) on. */
export function listTraces(dir: string, options: { sites?: string[]; since?: string } = {}): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const site of readdirSync(dir).sort()) {
    if (options.sites && !options.sites.includes(site)) continue;
    const siteDir = path.join(dir, site);
    for (const day of readdirSync(siteDir).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort()) {
      if (options.since && day < options.since) continue;
      for (const name of readdirSync(path.join(siteDir, day)).filter((file) => file.endsWith('.jsonl')).sort()) files.push(path.join(siteDir, day, name));
    }
  }
  return files;
}

export function readTrace(file: string): Trace {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as TraceLine);
  const site = path.basename(path.dirname(path.dirname(file)));
  return { file, site, sessionId: path.basename(file, '.jsonl'), lines };
}

const typeOf = (message: unknown) => (message as { type?: string } | null)?.type;
const traceOf = (message: unknown) => (message as { traceId?: string } | null)?.traceId;
const msBetween = (from: string, to: string | undefined) => (to ? Date.parse(to) - Date.parse(from) : null);

/**
 * Each turn of a session, measured.
 *   1. Find the turns: each turn message the brain took (a refused one is counted as a refusal, not a turn).
 *   2. For each, walk the lines with its trace ID: events and results for calls, failures and times; log entries for
 *      steps, tokens and how it ended.
 */
export function summarizeTrace(trace: Trace): SessionSummary {
  const { lines } = trace;
  // 1. The turns. A refusal line follows the message it refuses.
  const refusedAt = new Set(lines.flatMap((line, i) => ('refused' in line ? [i - 1] : [])));
  const turnLines = lines.flatMap((line, i) => ('in' in line && typeOf(line.in) === 'turn' && !refusedAt.has(i) ? [{ at: line.at, turn: line.in as ClientTurn }] : []));
  const turns = turnLines.map(({ at, turn }): TurnSummary => {
    const summary: TurnSummary = {
      traceId: turn.traceId, at, message: turn.message, pageType: turn.pageContext.pageType, steps: 0, calls: {}, failures: [],
      unavailable: [], refusals: [], firstEventMs: null, answerMs: null, ended: null, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const toolOfCall = new Map<string, string>();
    // 2. The turn's lines.
    for (const line of lines) {
      if ('out' in line && traceOf(line.out) === turn.traceId) {
        const event = line.out as { type: string; call?: ToolCall; code?: string };
        if (summary.firstEventMs === null) summary.firstEventMs = msBetween(at, line.at);
        if (event.type === 'tool_call' && event.call) {
          toolOfCall.set(event.call.id, event.call.name);
          summary.calls[event.call.name] = (summary.calls[event.call.name] ?? 0) + 1;
        }
        if (event.type === 'answer' && summary.answerMs === null) summary.answerMs = msBetween(at, line.at);
        if (event.type === 'error') summary.refusals.push(`error: ${event.code ?? 'unknown'}`);
      } else if ('in' in line && typeOf(line.in) === 'results' && traceOf(line.in) === turn.traceId) {
        for (const result of (line.in as { results: ToolResult[] }).results) {
          if (result.ok) continue;
          const tool = toolOfCall.get(result.id) ?? result.id;
          summary.failures.push(`${tool}: ${result.error.code}`);
          if (result.error.code === 'tool_disabled') summary.unavailable.push(tool);
        }
      } else if ('refused' in line && line.refused.traceId === turn.traceId) {
        summary.refusals.push(`refused ${line.refused.status}: ${line.refused.error}`);
      } else if ('log' in line && line.log.traceId === turn.traceId) {
        addLog(summary, line.log);
      }
    }
    return summary;
  });
  return { file: trace.file, site: trace.site, sessionId: trace.sessionId, started: lines[0]?.at ?? '', turns };
}

function addLog(summary: TurnSummary, entry: BrainLogEntry): void {
  const detail = (entry.detail ?? {}) as Record<string, unknown>;
  const count = (key: string) => (typeof detail[key] === 'number' ? (detail[key] as number) : 0);
  if (entry.kind === 'model_step') {
    summary.steps++;
    summary.tokens.input += count('inputTokens');
    summary.tokens.output += count('outputTokens');
    summary.tokens.cacheRead += count('cacheReadTokens');
    summary.tokens.cacheWrite += count('cacheWriteTokens');
  }
  if (entry.kind === 'turn_end') summary.ended = typeof detail.why === 'string' ? detail.why : null;
  if (entry.kind === 'results_refused' || entry.kind === 'result_refused' || entry.kind === 'quota') summary.refusals.push(entry.kind);
}

/** Cost in dollars: fresh input, cache reads and cache writes at their own prices, and output. */
export function costOf(tokens: Tokens, prices: Prices): number {
  const fresh = Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite);
  return (fresh * prices.input + tokens.cacheRead * prices.cacheRead + tokens.cacheWrite * prices.cacheWrite + tokens.output * prices.output) / 1e6;
}

const percentile = (values: number[], share: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)]!;
};
/** A path as people read it: relative inside the repo, absolute outside it. */
export const shownPath = (file: string) => (path.relative(repoRoot, file).startsWith('..') ? file : path.relative(repoRoot, file));
const seconds = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)}s`);
const tally = (names: string[]) => Object.entries(names.reduce<Record<string, number>>((counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }), {}))
  .sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ×${count}`).join(', ');

/** The report `npm run traces` prints: each session's turns, then totals. */
export function describeTraces(sessions: readonly SessionSummary[], prices?: Prices): string {
  const out: string[] = [];
  const turns = sessions.flatMap((session) => session.turns);
  for (const session of sessions) {
    out.push(`${session.site} ${session.started.replace('T', ' ').slice(0, 19)} ${session.sessionId} (${shownPath(session.file)})`);
    for (const turn of session.turns) {
      const hitRate = turn.tokens.input ? `${Math.round((turn.tokens.cacheRead / turn.tokens.input) * 100)}%` : '–';
      const calls = Object.entries(turn.calls).map(([tool, count]) => (count > 1 ? `${tool}×${count}` : tool)).join(' ') || 'no calls';
      const cost = prices ? ` $${costOf(turn.tokens, prices).toFixed(4)}` : '';
      out.push(`  "${turn.message.length > 60 ? `${turn.message.slice(0, 57)}…` : turn.message}" on ${turn.pageType}`);
      out.push(`    ${turn.steps} steps · ${calls} · first event ${seconds(turn.firstEventMs)} · answer ${seconds(turn.answerMs)} · ${turn.ended ?? 'no end logged'} · ${turn.tokens.input} in / ${turn.tokens.output} out, cache ${hitRate}${cost}`);
      if (turn.failures.length) out.push(`    failed: ${tally(turn.failures)}`);
      if (turn.refusals.length) out.push(`    refused: ${tally(turn.refusals)}`);
    }
  }
  const total = turns.reduce((sum, turn) => ({
    input: sum.input + turn.tokens.input, output: sum.output + turn.tokens.output, cacheRead: sum.cacheRead + turn.tokens.cacheRead, cacheWrite: sum.cacheWrite + turn.tokens.cacheWrite,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const answerTimes = turns.flatMap((turn) => (turn.answerMs === null ? [] : [turn.answerMs]));
  const firstTimes = turns.flatMap((turn) => (turn.firstEventMs === null ? [] : [turn.firstEventMs]));
  out.push('', `${sessions.length} sessions, ${turns.length} turns, ${turns.filter((turn) => turn.answerMs !== null).length} answered`);
  out.push(`  steps per turn: median ${percentile(turns.map((turn) => turn.steps), 0.5) ?? '–'}, p90 ${percentile(turns.map((turn) => turn.steps), 0.9) ?? '–'}`);
  out.push(`  first event: median ${seconds(percentile(firstTimes, 0.5))}, p90 ${seconds(percentile(firstTimes, 0.9))}; answer: median ${seconds(percentile(answerTimes, 0.5))}, p90 ${seconds(percentile(answerTimes, 0.9))}`);
  out.push(`  tokens: ${total.input} in, ${total.output} out; cache hit rate ${total.input ? Math.round((total.cacheRead / total.input) * 100) : 0}%`);
  out.push(`  cost: ${prices ? `$${costOf(total, prices).toFixed(4)}, $${turns.length ? (costOf(total, prices) / turns.length).toFixed(4) : '0'} per turn` : 'set TRACE_PRICES (dollars per million tokens: input,output,cacheRead,cacheWrite) to see it'}`);
  const unavailable = turns.flatMap((turn) => turn.unavailable);
  if (unavailable.length) out.push(`  asked for but not available yet: ${tally(unavailable)}`);
  const failures = turns.flatMap((turn) => turn.failures);
  if (failures.length) out.push(`  failed tool results: ${tally(failures)}`);
  const refusals = turns.flatMap((turn) => turn.refusals);
  if (refusals.length) out.push(`  refusals: ${tally(refusals)}`);
  return out.join('\n');
}

export interface Promoted {
  conversation: Conversation;
  /** An eval case stub per turn: the message and the page, with the expectations left for a person to write. */
  caseDrafts: { id: string; description: string; message: string; page: unknown; expect: Record<string, never> }[];
  /** What a person should know before the draft becomes a test. */
  notes: string[];
  /** Problems the conversation checker finds in the draft. */
  problems: string[];
}

/** The zip most of a site's eval cases use: the stand-in for a real user's zip. */
export function standardZip(site: string): string | null {
  const counts = new Map<string, number>();
  for (const evalCase of loadCases(site)) {
    const zip = (evalCase.page as { location?: { postalCode?: string } } | undefined)?.location?.postalCode;
    if (zip) counts.set(zip, (counts.get(zip) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** Whether an encoded run in the string (base64 or base64url, possibly gzip inside) hides the text; such values can't be rewritten in place. */
function hidesText(value: string, text: string): boolean {
  return (value.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? []).some((run) => {
    try {
      let bytes = Buffer.from(run.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
      return bytes.toString('utf8').includes(text);
    } catch {
      return false;
    }
  });
}

/**
 * A trace as a conversation draft, with personal details removed and its fixtures found.
 *   1. Keep the link's messages in order, leaving out refused ones.
 *   2. Remove personal details: the user's zip becomes the standard zip everywhere it appears as text, page URLs
 *      lose their query and fragment, IP addresses become 0.0.0.0, and session and trace IDs are renamed. Encoded
 *      values that still hide the zip are listed, since they can't be rewritten.
 *   3. Replay core.js's side against the site's fixtures, to list the fixtures that answer and the requests none do.
 *   4. Check the draft as the tests would, and stub an eval case per turn.
 */
export async function promoteTrace(trace: Trace, options: { id: string; zip?: string }): Promise<Promoted> {
  const notes: string[] = [];
  // 1. The link's messages.
  const refusedAt = new Set(trace.lines.flatMap((line, i) => ('refused' in line ? [i - 1] : [])));
  const linkLines = trace.lines.flatMap((line, i) => ('in' in line && !refusedAt.has(i) ? [{ at: line.at, message: line.in }] : 'out' in line ? [{ at: line.at, message: line.out }] : []));
  const firstTurn = linkLines.find((line) => typeOf(line.message) === 'turn');
  if (!firstTurn) throw new Error(`${trace.file}: no turn the brain took`);

  // 2. Personal details.
  const zip = options.zip ?? standardZip(trace.site);
  const userZips = new Set(linkLines.flatMap((line) => {
    const found = typeOf(line.message) === 'turn' ? (line.message as ClientTurn).pageContext.location?.postalCode : undefined;
    return found && found !== zip ? [found] : [];
  }));
  if (!zip && userZips.size) notes.push('The site has no standard test zip, so the user\'s zip was left in; pass --zip.');
  const traceIds = new Map<string, string>();
  let ipsBlanked = 0;
  let hiddenZips = 0;
  const scrubText = (text: string) => {
    let scrubbed = text.replace(IPV4, () => { ipsBlanked++; return '0.0.0.0'; });
    for (const userZip of userZips) {
      if (zip) scrubbed = scrubbed.replace(new RegExp(`\\b${userZip}\\b`, 'g'), zip);
      if (hidesText(scrubbed, userZip)) hiddenZips++;
    }
    return scrubbed;
  };
  const scrub = (node: unknown, key?: string): unknown => {
    if (typeof node === 'string') {
      if (key === 'sessionId') return `sess_${options.id}`;
      if (key === 'traceId') {
        if (!traceIds.has(node)) traceIds.set(node, `trace_${options.id}_${traceIds.size + 1}`);
        return traceIds.get(node);
      }
      return scrubText(node);
    }
    if (Array.isArray(node)) return node.map((item) => scrub(item));
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([childKey, child]) => [childKey, scrub(child, childKey)]));
    return node;
  };
  const messages = linkLines.map((line) => {
    const message = scrub(line.message) as Message;
    if (message.type === 'turn') message.pageContext.url = message.pageContext.url.replace(/[?#].*$/, '');
    return message;
  });
  if (userZips.size && zip) notes.push(`The user's zip was replaced with ${zip}. Tool results came from the live site at the user's zip, so prices and dates may not match ${zip}'s fixtures.`);
  if (ipsBlanked) notes.push(`${ipsBlanked} IP addresses were blanked.`);
  if (hiddenZips) notes.push(`${hiddenZips} encoded values still hold the user's zip (such as route tokens). Replace them with a fixture's values before committing.`);
  const conversation: Conversation = {
    id: options.id, site: trace.site, description: 'TODO: what this conversation shows', now: firstTurn.at, fixtures: [],
    notes: [`Promoted from a real session (${path.basename(trace.file)}). Review before committing.`], messages,
  };
  if (messages.some((message) => message.type === 'turn' && message.pageContext.entity)) {
    notes.push('A turn started on an item\'s page. The trace doesn\'t carry the page\'s own data, so add pageData if the tools need it.');
  }

  // 3. Replay against the fixtures.
  const runtime = await loadSiteRuntime(trace.site);
  const fakeBrain = new FakeBrain(conversation);
  const harness = testHost({ site: trace.site, fixtures: loadFixtures(trace.site), start: conversation.now!, brain: fakeBrain.brain });
  const misses: string[] = [];
  const request = harness.host.request;
  harness.host.request = async (req) => {
    try {
      return await request(req);
    } catch (error) {
      const message = String((error as Error).message ?? error);
      if (message.startsWith('FakeHost: no ')) misses.push(message.split('\n').slice(0, 2).join(' ').replace(/\s+/g, ' '));
      throw error;
    }
  };
  const { session } = await startSession({ pack: runtime.pack, site: runtime.code, validators: runtime.validators, host: harness.host });
  const surface = new FakeSurface();
  for (const turn of messages.filter((message): message is ClientTurn => message.type === 'turn')) {
    session.setPage(turn.pageContext);
    await runTurn(session, turn.message, surface);
  }
  conversation.fixtures = [...new Set(harness.fake.calls.flatMap((call) => (call.fixtureId ? [call.fixtureId] : [])))].sort();
  if (misses.length) notes.push(`${misses.length} requests have no recording yet: ${[...new Set(misses)].join('; ')}`);
  if (fakeBrain.differences.length) notes.push(`${fakeBrain.differences.length} results differ from what the fixtures give (live data changes); replace them with the fixtures' before committing.`);

  // 4. Check and stub.
  const problems = checkConversation(loadContract({ sites: [trace.site] }), conversation);
  const caseDrafts = messages.filter((message): message is ClientTurn => message.type === 'turn').map((turn, i) => ({
    id: `${options.id}-${i + 1}`, description: 'TODO: what a good answer does', message: turn.message, page: turn.pageContext, expect: {},
  }));
  return { conversation, caseDrafts, notes, problems };
}
