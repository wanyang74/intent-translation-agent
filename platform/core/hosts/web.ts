// The web host: core.js inside a page on the site (a content script or an embedded SDK). Requests go out from the
// page with its own cookies and origin (decision D1). The brain is reached over HTTP, and its events stream back as
// newline-delimited JSON, one event per line, so each tool call can start the moment it arrives.
import type { ClientMessage } from '../../contract/generated/types.ts';
import type { Host, ScriptRunner } from '../src/host.ts';

export interface WebHostOptions {
  /** The agentic brain, such as https://agent.example.com */
  brainUrl: string;
  /** Reads what the current page carries about the item on screen (the site's page reader). */
  readPage?: () => unknown;
  scripts?: ScriptRunner;
  verifyConfig?: (config: unknown) => Promise<boolean>;
  log?: Host['log'];
  /** For tests; the page's own fetch otherwise. */
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

/** Parses a newline-delimited JSON body as it arrives. */
export async function* ndjsonEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield JSON.parse(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally {
    reader.releaseLock();
  }
}

export function webHost(o: WebHostOptions): Host {
  const f = o.fetch ?? fetch.bind(globalThis);
  const brainBase = o.brainUrl.replace(/\/+$/, '');
  const host: Host = {
    async request(req) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), o.requestTimeoutMs ?? 15_000);
      try {
        const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body, credentials: 'include', signal: controller.signal });
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => { headers[key] = value; });
        return { status: res.status, headers, body: await res.text() };
      } finally {
        clearTimeout(timer);
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomId: () => crypto.randomUUID(),
    async *brain(message: ClientMessage) {
      const res = await f(`${brainBase}/v1/${message.type === 'turn' ? 'turn' : 'results'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(message),
      });
      if (!res.ok || !res.body) throw new Error(`the brain answered ${res.status}`);
      yield* ndjsonEvents(res.body);
    },
    pageData: () => o.readPage?.() ?? null,
  };
  if (o.scripts) host.scripts = o.scripts;
  if (o.verifyConfig) host.verifyConfig = o.verifyConfig;
  if (o.log) host.log = o.log;
  return host;
}
