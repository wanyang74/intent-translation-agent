// The web host: core.js inside a page on the site (a content script or an embedded SDK). Requests go out from the
// page with its own cookies and origin (decision D1). The brain is reached over HTTP, and its events stream back as
// newline-delimited JSON, one event per line, so each tool call can start the moment it arrives. A surface that
// reaches the brain another way (the extension, through its background worker) passes its own brain link instead.
import type { ClientMessage } from '../../contract/generated/types.ts';
import type { Host, ScriptRunner } from '../src/runtime/host.ts';

export interface WebHostOptions {
  /** The agentic brain, such as https://agent.example.com; or `brain`, a link to it supplied by the surface. */
  brainUrl?: string;
  brain?: Host['brain'];
  /** Reads what the current page carries about the item on screen (the site's page reader). */
  readPage?: () => unknown;
  scripts?: ScriptRunner;
  verifyConfig?: (config: unknown) => Promise<boolean>;
  log?: Host['log'];
  /** For tests; the page's own fetch otherwise. */
  fetch?: typeof fetch;
  /** How long a site call may take, unless its endpoint says otherwise. Default 15 seconds. */
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

export function webHost(options: WebHostOptions): Host {
  const fetcher = options.fetch ?? fetch.bind(globalThis);
  const brainBase = (options.brainUrl ?? '').replace(/\/+$/, '');
  const host: Host = {
    async request(req) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? options.requestTimeoutMs ?? 15_000);
      try {
        // Cookies go only to the page's own origin, as the browser's default. A site's API on another host answers
        // its frontend without them, and a server that doesn't allow credentials rejects a request that sends them
        // (seen live: the CORS preflight fails), so 'include' would break exactly the calls the site itself makes.
        const res = await fetcher(req.url, { method: req.method, headers: req.headers, body: req.body, credentials: 'same-origin', signal: controller.signal });
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
    brain: options.brain ?? async function* brain(message: ClientMessage) {
      const res = await fetcher(`${brainBase}/v1/${message.type}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(message),
      });
      if (!res.ok || !res.body) throw new Error(`the brain answered ${res.status}`);
      yield* ndjsonEvents(res.body);
    },
    pageData: () => options.readPage?.() ?? null,
  };
  if (options.scripts) host.scripts = options.scripts;
  if (options.verifyConfig) host.verifyConfig = options.verifyConfig;
  if (options.log) host.log = options.log;
  return host;
}
