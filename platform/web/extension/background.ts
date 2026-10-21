// The extension's background worker: the only part that talks to the brain. The content script runs inside the
// site's page, where calls to another server are subject to the page's CORS and Chrome's rules for a public page
// calling a local server; the worker runs as the extension, whose host permission for the brain lifts both. It
// forwards each request and relays the brain's newline-delimited JSON events one by one, so tool calls still start
// the moment they arrive.
import { ndjsonEvents } from '../../core/hosts/web.ts';
import { BRAIN_PORT, type FromWorker, type ToWorker } from './messages.ts';

/** Set by the build: the brain's base URL. */
declare const BRAIN_URL: string;

/**
 * Serves one port, that is, one brain request:
 *   1. Post the message to the brain; an abort stops the request if the content script goes away (a closed tab).
 *   2. Relay every event, then `end`; any failure becomes `fail`, which the content script reports as a lost link.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== BRAIN_PORT) return;
  const request = new AbortController();
  port.onDisconnect.addListener(() => request.abort());
  const post = (message: FromWorker) => {
    if (!request.signal.aborted) port.postMessage(message);
  };
  port.onMessage.addListener(async (incoming: ToWorker) => {
    if (incoming.type !== 'send') return;
    try {
      // 1. The request.
      const response = await fetch(`${BRAIN_URL}/v1/${incoming.message.type}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(incoming.message),
        signal: request.signal,
      });
      if (!response.ok || !response.body) throw new Error(`the brain answered ${response.status}`);
      // 2. The events.
      for await (const event of ndjsonEvents(response.body)) post({ type: 'event', event });
      post({ type: 'end' });
    } catch (error) {
      post({ type: 'fail', error: String(error) });
    }
  });
});
