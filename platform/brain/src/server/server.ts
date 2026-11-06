// The brain over HTTP, as core.js's web host calls it: POST /v1/turn, /v1/results and /v1/amend take one protocol message
// as JSON and answer with newline-delimited JSON, one event per line, written the moment each event exists, so every
// tool call reaches the client while the model is still writing. A message that breaks the protocol gets 400 and a
// JSON error. Browsers call it from the site's own pages, so it answers CORS for the site's origins. An optional tap
// sees every message on the link, both ways, for real-session traces (traces.ts).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Brain } from '../agent/brain.ts';

export interface ServerOptions {
  brain: Brain;
  /** Origins allowed to call from a browser: the site's own origins, and any added for development. */
  allowedOrigins: readonly string[];
  /** The largest request body accepted. Results carry tool outputs, so this is generous. */
  maxBodyBytes?: number;
  /** Sees every message on the link: each one the client sends, any refusal, and each event sent back. */
  tap?: LinkTap;
}

/** Watches the link without changing it. */
export interface LinkTap {
  /** Called before the brain takes the message, so the message comes before anything the brain logs about it. */
  received(message: unknown): void;
  refused(message: unknown, refusal: { status: number; error: string }): void;
  sent(event: unknown): void;
}

const MAX_BODY = 2 * 1024 * 1024;

class TooLarge extends Error {}

/**
 * The request body as text. Past the limit it's refused at once, and the rest is read and dropped so the client can
 * read the refusal; a client that keeps sending far past the limit is cut off.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit * 8) req.destroy();
      else if (size > limit) reject(new TooLarge());
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The brain's one HTTP server, built once per process (main.ts creates it and calls listen). Everything per request
 * happens in handleRequest, which Node calls once for each request that arrives; requests share only the Brain.
 */
export function createBrainServer(options: ServerOptions): Server {
  const allowed = new Set(options.allowedOrigins);
  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    }
  };
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  /**
   * One request, from its first byte to the end of its response. Several run at once on the one thread (a turn's
   * stream and an amend, say): each gets its own call with its own variables, and they meet only in the Brain.
   *   1. CORS, the preflight, the health check, and which endpoint this is.
   *   2. Read the body as JSON.
   *   3. Watch for the client hanging up, so the brain can stop the step it's running.
   *   4. Hand the message to the brain; a refusal goes back as a JSON error.
   *   5. Stream the brain's events back, one line each, until the brain ends the stream or the client goes away.
   */
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Routing.
    cors(req, res);
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type, accept',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }
    if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true });
    const endpoint = path === '/v1/turn' ? 'turn' : path === '/v1/results' ? 'results' : path === '/v1/amend' ? 'amend' : null;
    if (!endpoint) return json(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });

    // 2. The body.
    let message: unknown;
    try {
      message = JSON.parse(await readBody(req, options.maxBodyBytes ?? MAX_BODY));
    } catch (error) {
      if (error instanceof TooLarge) return json(res, 413, { error: 'the message is too large' }, { connection: 'close' });
      return json(res, 400, { error: 'the body is not JSON' });
    }
    // 3. If the client goes away before the stream ends, the brain stops the step that's running and ends the turn.
    const hangUp = new AbortController();
    let gone = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        gone = true;
        hangUp.abort();
      }
    });
    // 4. The brain finds the message's session (or opens one) and answers with a stream of events, or refuses.
    options.tap?.received(message);
    const accepted = options.brain.accept(message, { endpoint, signal: hangUp.signal });
    if (!accepted.ok) {
      options.tap?.refused(message, { status: accepted.status, error: accepted.error });
      return json(res, accepted.status, { error: accepted.error });
    }

    // 5. The events. Each `await events.next()` may wait on the model or the network; while it does, Node runs
    //    other requests' handleRequest calls, which is how an amend reaches a turn that's still streaming.
    req.socket.setNoDelay(true);
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const events = accepted.events[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await events.next();
        if (next.done) break;
        if (gone) {
          void events.return?.();
          break;
        }
        res.write(JSON.stringify(next.value) + '\n');
        options.tap?.sent(next.value);
      }
    } catch {
      // The brain turns every failure it expects into an error event; anything else just ends the stream.
    } finally {
      if (!gone) res.end();
    }
  }

  return createServer(handleRequest);
}
