// Real-session traces, for a brain run locally: every protocol message that crosses the HTTP link, both ways, and
// the brain's log entries, one JSON line each, in one file per session: <dir>/<site>/<YYYY-MM-DD>/<sessionId>.jsonl.
// They record what a person did in a real browser, for quality evaluation and benchmarks; `npm run traces`
// (platform/evals/scripts/traces.ts) summarizes them and turns one into a test draft.
// Rules: local development only and never committed (traces/ is git-ignored). Nothing is removed at write time, so a
// trace stays a faithful record; personal details are removed when a trace is promoted into a test. Date folders
// older than the retention period are deleted. Writing a trace never affects serving: a failed write is reported
// once and dropped.
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { BrainLogEntry } from '../agent/types.ts';
import type { LinkTap } from './server.ts';

/** One line of a trace: a message the client sent, the brain's refusal of it, an event the brain sent, or a log entry. */
export type TraceLine =
  | { at: string; in: unknown }
  | { at: string; refused: { status: number; error: string; traceId?: string } }
  | { at: string; out: unknown }
  | { at: string; log: BrainLogEntry };

export interface TraceOptions {
  /** The traces folder; each site gets its own folder inside it. */
  dir: string;
  site: string;
  /** Date folders older than this many days are deleted. */
  keepDays: number;
  now?: () => Date;
}

const DATE_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
/** How many sessions and trace IDs the writer remembers; the oldest go first, so a long-running brain stays small. */
const REMEMBERED = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A session ID as a file name: the client makes it up, so anything outside a safe set is replaced. */
export function traceFileName(sessionId: string | undefined): string {
  if (!sessionId) return 'unmatched.jsonl';
  return `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100)}.jsonl`;
}

/** Sets a key, dropping the oldest entry beyond REMEMBERED (a Map keeps keys in insertion order). */
function remember(map: Map<string, string>, key: string, value: string): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > REMEMBERED) map.delete(map.keys().next().value!);
}

const field = (value: unknown, key: string): string | undefined => {
  const found = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return typeof found === 'string' ? found : undefined;
};

export class TraceWriter implements LinkTap {
  readonly siteDir: string;
  private readonly keepDays: number;
  private readonly now: () => Date;
  /**
   * Each session's file, fixed when the session is first seen, so a session that runs past midnight stays in one
   * file, and so does one the brain forgot while idle and then reopened under the same ID.
   */
  private readonly files = new Map<string, string>();
  /** Which session each trace ID belongs to: events carry only the trace ID. */
  private readonly sessionOfTrace = new Map<string, string>();
  private readonly prunedDays = new Set<string>();
  private failed = false;

  constructor(options: TraceOptions) {
    this.siteDir = path.join(options.dir, options.site);
    this.keepDays = options.keepDays;
    this.now = options.now ?? (() => new Date());
    this.prune();
  }

  received(message: unknown): void {
    const sessionId = field(message, 'sessionId');
    const traceId = field(message, 'traceId');
    if (sessionId && traceId) remember(this.sessionOfTrace, traceId, sessionId);
    this.write(sessionId, { at: this.stamp(), in: message });
  }

  refused(message: unknown, refusal: { status: number; error: string }): void {
    const traceId = field(message, 'traceId');
    this.write(field(message, 'sessionId'), { at: this.stamp(), refused: { ...refusal, ...(traceId ? { traceId } : {}) } });
  }

  sent(event: unknown): void {
    const traceId = field(event, 'traceId');
    this.write(traceId ? this.sessionOfTrace.get(traceId) : undefined, { at: this.stamp(), out: event });
  }

  // A forgotten session's lookups stay: the brain forgets an idle session when the next message for it arrives, after
  // received() has filed that message's trace ID, and the reopened session's events must still find its file.
  log(entry: BrainLogEntry): void {
    this.write(entry.sessionId, { at: this.stamp(), log: entry });
  }

  /** Deletes date folders older than the retention period. Runs at start and on the first write of each new day. */
  prune(): void {
    try {
      if (!existsSync(this.siteDir)) return;
      const oldest = new Date(this.now().getTime() - this.keepDays * DAY_MS).toISOString().slice(0, 10);
      for (const name of readdirSync(this.siteDir)) {
        if (DATE_FOLDER.test(name) && name < oldest) rmSync(path.join(this.siteDir, name), { recursive: true, force: true });
      }
    } catch (error) {
      this.report(error);
    }
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /**
   * Appends one line to the session's file.
   *   1. Find the session's file, or start one in today's folder (pruning old folders on a new day).
   *   2. Append the line. The write is synchronous, so lines land in the order things happened, and a crash loses
   *      at most the line being written.
   */
  private write(sessionId: string | undefined, line: TraceLine): void {
    try {
      // 1. The file.
      let file = sessionId ? this.files.get(sessionId) : undefined;
      if (!file) {
        const day = line.at.slice(0, 10);
        if (!this.prunedDays.has(day)) {
          this.prunedDays.add(day);
          this.prune();
        }
        const folder = path.join(this.siteDir, day);
        mkdirSync(folder, { recursive: true });
        file = path.join(folder, traceFileName(sessionId));
        if (sessionId) remember(this.files, sessionId, file);
      }
      // 2. The line.
      appendFileSync(file, JSON.stringify(line) + '\n');
    } catch (error) {
      this.report(error);
    }
  }

  /** Reports the first failure only: a broken traces folder stays broken, and one line says so. */
  private report(error: unknown): void {
    if (!this.failed) console.error(`traces: can't write (${String(error)}); serving goes on without them`);
    this.failed = true;
  }
}
