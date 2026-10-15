// The Host interface: everything core.js needs from the platform it runs on. core.js reaches the outside world only
// through it, so the same bundle runs in a web page, in JavaScriptCore on iOS, in QuickJS on Android and later on the
// gateway. Each platform supplies one Host; tests use a fake one.
import type { ClientMessage } from '../../contract/generated/types.ts';

export interface HostRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface HostResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type ScriptResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Runs a model-written script in the platform's sandbox. Its only way out is `callTool`. */
export interface ScriptRunner {
  run(source: string, callTool: (name: string, args: unknown) => Promise<unknown>, limits: { timeoutMs: number; memoryBytes: number }): Promise<ScriptResult>;
}

export interface LogEntry {
  traceId?: string | undefined;
  kind: string;
  detail: unknown;
}

export interface Host {
  /** Sends a request with the page's or app's own session (decision D1). Rejects only when no response came back. */
  request(req: HostRequest): Promise<HostResponse>;
  /** Milliseconds since the epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** A fresh random ID (a UUID), for tracking fields and trace IDs. */
  randomId(): string;
  /** Sends a message to the agentic brain and yields the events it streams back (steps ② and ⑦, then ④ and ⑧). */
  brain?(message: ClientMessage): AsyncIterable<unknown>;
  /** What the current page carries about the item on screen, as the site's page reader found it; null if nothing. */
  pageData?(): unknown;
  /** The platform's script sandbox. Without one, scripts are refused and the model calls tools one at a time. */
  scripts?: ScriptRunner;
  /** Checks the remote config's signature. Without it, remote config isn't accepted. */
  verifyConfig?(config: unknown): Promise<boolean>;
  /** The development log: every message and call, by trace ID. */
  log?(entry: LogEntry): void;
}
