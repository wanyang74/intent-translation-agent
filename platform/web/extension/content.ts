// The extension's content script: core.js, the site's pack and code, and the overlay, running in the site's pages
// (site.pages). Requests to the site go out from the page with the user's own session (D1); messages to the brain go
// through the background worker (background.ts). The script sandbox isn't in the extension yet, so the model calls
// tools one at a time. The conversation follows the user around the site: it's saved after every turn and before a
// Take me there button opens its page, and the next page of the site carries on from it (conversation.ts).
import type { ClientMessage } from '../../contract/generated/types.ts';
import { pack, code, platformValidators, siteValidators, readPage } from 'site:bundle';
import { webHost } from '../../core/hosts/web.ts';
import { startSession } from '../../core/src/runtime/runtime.ts';
import { AgentController } from '../src/agent.ts';
import { conversationToResume, type SavedConversation } from '../src/conversation.ts';
import { Overlay } from '../src/overlay.ts';
import { viewOf } from '../src/page.ts';
import { BRAIN_PORT, type ConversationRequest, type FromWorker, type ToWorker } from './messages.ts';

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

/** Asks the worker for this site's saved conversation; null if there's none, or the worker can't be reached. */
async function loadConversation(): Promise<SavedConversation | null> {
  try {
    return (await chrome.runtime.sendMessage({ type: 'load', site: pack.site.id } satisfies ConversationRequest)) as SavedConversation | null;
  } catch {
    return null;
  }
}

/**
 * Starts the agent on this page. A function rather than top-level code because a content script is a classic script,
 * where top-level await isn't allowed.
 *   1. The host, and the conversation to carry on, if this site has a fresh one saved.
 *   2. The session: a new one, or the saved one restored.
 *   3. The overlay on the page, drawing the saved conversation as it was.
 *   4. The controller between them, which saves the conversation after every turn; a Take me there button saves it
 *      before it opens its page.
 */
async function start(): Promise<void> {
  // 1. The host and the saved conversation.
  const host = webHost({
    brain: brainThroughWorker,
    readPage: () => currentPage().data,
    // The development log goes to the console, where the extension's tests read it.
    log: (entry) => console.debug('[intent-agent]', JSON.stringify(entry)),
  });
  const saved = conversationToResume(await loadConversation(), Date.now());
  // 2. The session.
  const { session } = await startSession({ pack, site: code, validators: { platform: platformValidators, site: siteValidators }, host, ...(saved ? { restore: saved.session } : {}) });
  if (saved) host.log?.({ traceId: undefined, kind: 'conversation_resumed', detail: { sessionId: session.id, entries: saved.shown.length } });
  // 3. The overlay.
  const mountPoint = document.createElement('div');
  mountPoint.id = 'intent-agent-overlay';
  document.documentElement.append(mountPoint);
  const save = () => {
    const conversation: SavedConversation = { session: session.snapshot(), shown: overlay.shown(), open: overlay.isOpen, savedAt: Date.now() };
    return chrome.runtime.sendMessage({ type: 'save', site: pack.site.id, conversation } satisfies ConversationRequest).catch(() => false);
  };
  const overlay = new Overlay(document, mountPoint, {
    title: `Ask ${pack.site.name}`,
    onSend: (message) => void controller.send(message),
    onNavigate: (url) => void save().then(() => location.assign(url)),
  });
  if (saved) {
    overlay.restore(saved.shown);
    if (saved.open) overlay.open();
  }
  // 4. The controller.
  const controller = new AgentController(session, overlay, () => currentPage().context, () => void save());
}

void start();
