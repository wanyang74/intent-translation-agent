// The extension's content script: core.js, the site's pack and code, and the overlay, running in the site's pages
// (site.pages). Requests to the site go out from the page with the user's own session (D1); messages to the brain go
// through the background worker (background.ts). The script sandbox isn't in the extension yet, so the model calls
// tools one at a time. One conversation per page load.
import type { ClientMessage } from '../../contract/generated/types.ts';
import { pack, code, platformValidators, siteValidators, readPage } from 'site:bundle';
import { webHost } from '../../core/hosts/web.ts';
import { startSession } from '../../core/src/runtime/runtime.ts';
import { AgentController } from '../src/agent.ts';
import { Overlay } from '../src/overlay.ts';
import { viewOf } from '../src/page.ts';
import { BRAIN_PORT, type FromWorker, type ToWorker } from './messages.ts';

/**
 * The brain link, through the worker: one port per request. Chrome delivers port messages as callbacks; the queue
 * and `wake` turn them into the async iterator Brain link reads. When Brain link stops reading (it breaks out once
 * the brain awaits results), `finally` closes the port, and the worker aborts its request.
 */
async function* brainThroughWorker(message: ClientMessage): AsyncGenerator<unknown> {
  const port = chrome.runtime.connect({ name: BRAIN_PORT });
  const queue: FromWorker[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  port.onMessage.addListener((incoming: FromWorker) => {
    queue.push(incoming);
    wake?.();
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    wake?.();
  });
  port.postMessage({ type: 'send', message } satisfies ToWorker);
  try {
    for (;;) {
      const next = queue.shift();
      if (!next) {
        if (closed) throw new Error('the extension worker went away');
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
        continue;
      }
      if (next.type === 'event') yield next.event;
      else if (next.type === 'end') return;
      else throw new Error(next.error);
    }
  } finally {
    port.disconnect();
  }
}

/** What the page shows now; read at the start of every turn, since a site's page can change without reloading. */
const currentPage = () => readPage(viewOf(document, location.href));

/**
 * Starts the agent on this page: the host, the session, the overlay on the page, and the controller between them.
 * A function rather than top-level code because a content script is a classic script, where top-level await isn't
 * allowed.
 */
async function start(): Promise<void> {
  const host = webHost({
    brain: brainThroughWorker,
    readPage: () => currentPage().data,
    // The development log goes to the console, where the extension's tests read it.
    log: (entry) => console.debug('[intent-agent]', JSON.stringify(entry)),
  });
  const { session } = await startSession({ pack, site: code, validators: { platform: platformValidators, site: siteValidators }, host });
  const mountPoint = document.createElement('div');
  mountPoint.id = 'intent-agent-overlay';
  document.documentElement.append(mountPoint);
  const overlay = new Overlay(document, mountPoint, { title: `Ask ${pack.site.name}`, onSend: (message) => void controller.send(message) });
  const controller = new AgentController(session, overlay, () => currentPage().context);
}

void start();
