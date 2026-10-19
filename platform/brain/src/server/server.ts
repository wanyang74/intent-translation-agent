// The brain over HTTP, as core.js's web host calls it: POST /v1/turn, /v1/results and /v1/amend take one protocol message
// as JSON and answer with newline-delimited JSON, one event per line, written the moment each event exists, so every
// tool call reaches the client while the model is still writing. A message that breaks the protocol gets 400 and a
// JSON error. Browsers call it from the site's own pages, so it answers CORS for the site's origins.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Brain } from '../agent/brain.ts';

export interface ServerOptions {
  brain: Brain;
  /** Origins allowed to call from a browser: the site's own origins, and any added for development. */
  allowedOrigins: readonly string[];
  /** The largest request body accepted. Results carry tool outputs, so this is generous. */
  maxBodyBytes?: number;
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

  return createServer(async (req, res) => {
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

    let message: unknown;
    try {
      message = JSON.parse(await readBody(req, options.maxBodyBytes ?? MAX_BODY));
    } catch (error) {
      if (error instanceof TooLarge) return json(res, 413, { error: 'the message is too large' }, { connection: 'close' });
      return json(res, 400, { error: 'the body is not JSON' });
    }
    // If the client goes away before the stream ends, the brain stops the step that's running and ends the turn.
    const hangUp = new AbortController();
    let gone = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        gone = true;
        hangUp.abort();
      }
    });
    const accepted = options.brain.accept(message, { endpoint, signal: hangUp.signal });
    if (!accepted.ok) return json(res, accepted.status, { error: accepted.error });

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
      }
    } catch {
      // The brain turns every failure it expects into an error event; anything else just ends the stream.
    } finally {
      if (!gone) res.end();
    }
  });
}
