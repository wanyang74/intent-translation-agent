// The extension's content script: core.js, the site's pack and code, and the overlay, running in the site's pages
// (site.pages). Requests to the site go out from the page with the user's own session (D1); messages to the brain go
// through the background worker (background.ts). The script sandbox isn't in the extension yet, so the model calls
// tools one at a time. The conversation follows the user around the site: it's saved after every turn and before a
// Take me there button opens its page, and the next page of the site carries on from it (conversation.ts). Where the
// user moved, resized or folded the panel is kept per site too, and the next page puts it back (placement.ts).
import type { ClientMessage, PageContext, PanelPress } from '../../contract/generated/types.ts';
import { pack, code, platformValidators, siteValidators, readPage, pageModule } from 'site:bundle';
import { webHost } from '../../core/hosts/web.ts';
import { startSession } from '../../core/src/runtime/runtime.ts';
import { AgentController } from '../src/agent.ts';
import type { PageFocus } from '../../core/src/present/present.ts';
import { checkToRun, conversationToResume, focusToRun, withPress, type SavedConversation } from '../src/conversation.ts';
import { controlOf, runCheck, runFocus, runWrite, writeStopped, type ActionReport, type PendingCheck } from '../src/page-actions.ts';
import { Overlay } from '../src/overlay.ts';
import { placementOf, type PanelPlacement } from '../src/placement.ts';
import { storageOf, viewOf } from '../src/page.ts';
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

/** Asks the worker where the user left the panel on this site; null for the default place. */
async function loadPlacement(): Promise<PanelPlacement | null> {
  try {
    return placementOf(await chrome.runtime.sendMessage({ type: 'loadPanel', site: pack.site.id } satisfies ConversationRequest));
  } catch {
    return null;
  }
}

/**
 * Starts the agent on this page. A function rather than top-level code because a content script is a classic script,
 * where top-level await isn't allowed.
 *   1. The host, the conversation to carry on, if this site has a fresh one saved, and where the panel was left.
 *   2. The session: a new one, or the saved one restored.
 *   3. The overlay on the page, where the user left it, drawing the saved conversation as it was.
 *   4. The controller between them, which saves the conversation after every turn; a Take me there button saves it
 *      before it opens its page, with the page action to run there. The model hears how the last write went, and
 *      which of the panel's buttons the user pressed, and whether they just allowed it to read their account, with
 *      the next message, once.
 *   5. A write's check, if the last page's press led here: confirmed on this page, then dropped.
 *   6. The page action saved for this page, if any: dropped by saving again without it, then run once. A write runs
 *      only once that save is stored, so a reload can't press its button twice.
 */
async function start(): Promise<void> {
  // 1. The host and the saved conversation.
  const host = webHost({
    brain: brainThroughWorker,
    readPage: () => currentPage().data,
    // Read for each call that needs it, by the site's own code; core.js never keeps it (D7).
    ...(pageModule.pageToken ? { pageToken: () => pageModule.pageToken!(storageOf(document, indexedDB)) } : {}),
    // The development log goes to the console, where the extension's tests read it.
    log: (entry) => console.debug('[intent-agent]', JSON.stringify(entry)),
  });
  const [loaded, placement] = await Promise.all([loadConversation(), loadPlacement()]);
  const saved = conversationToResume(loaded, Date.now());
  // 2. The session.
  const { session } = await startSession({ pack, site: code, validators: { platform: platformValidators, site: siteValidators }, host, ...(saved ? { restore: saved.session } : {}) });
  if (saved) host.log?.({ traceId: undefined, kind: 'conversation_resumed', detail: { sessionId: session.id, entries: saved.shown.length } });
  // 3. The overlay.
  const mountPoint = document.createElement('div');
  mountPoint.id = 'intent-agent-overlay';
  document.documentElement.append(mountPoint);
  // A write's state, saved with the conversation: its check until confirmed, and its report until the next message.
  let pendingCheck: PendingCheck | null = null;
  let actionReport: ActionReport | null = saved?.actionReport ?? null;
  // The panel's buttons pressed since the last message, saved with the conversation until that message is sent.
  let pressed: PanelPress[] = saved?.pressed ?? [];
  // The user just allowed the agent to read their account: the next message says so, once.
  let accountAllowed = false;
  /** Saves the conversation; true once the worker has stored it. */
  const save = async (focus?: SavedConversation['focus']): Promise<boolean> => {
    const conversation: SavedConversation = {
      session: session.snapshot(), shown: overlay.shown(), open: overlay.isOpen, savedAt: Date.now(),
      ...(focus ? { focus } : {}), ...(pendingCheck ? { pendingCheck } : {}), ...(actionReport ? { actionReport } : {}),
      ...(pressed.length ? { pressed } : {}),
    };
    return (await chrome.runtime.sendMessage({ type: 'save', site: pack.site.id, conversation } satisfies ConversationRequest).catch(() => false)) === true;
  };
  const overlay = new Overlay(document, mountPoint, {
    title: `Ask ${pack.site.name}`,
    siteName: pack.site.name,
    ...(pack.site.brandColor ? { brandColor: pack.site.brandColor } : {}),
    placement,
    onPlacement: (moved) => void chrome.runtime.sendMessage({ type: 'savePanel', site: pack.site.id, placement: moved } satisfies ConversationRequest).catch(() => false),
    onSend: (message) => void controller.send(message),
    onNavigate: (url, focus: PageFocus | undefined, press) => {
      pressed = withPress(pressed, press);
      void save(focus ? { url, focus } : undefined).then(() => location.assign(url));
    },
    onPress: (press) => {
      pressed = withPress(pressed, press);
      void save();
    },
    onAllowAccount: () => {
      accountAllowed = true;
    },
  });
  if (saved) {
    overlay.restore(saved.shown);
    if (saved.open) overlay.open();
  }
  // 4. The controller. Each turn's page context carries the last write's report and the presses since the last
  // message, once.
  const pageForTurn = (): PageContext => {
    const { context } = currentPage();
    const report = actionReport;
    const presses = pressed;
    const granted = accountAllowed;
    actionReport = null;
    pressed = [];
    accountAllowed = false;
    return {
      ...context, ...(report ? { pageAction: report } : {}), ...(presses.length ? { pressed: presses as NonNullable<PageContext['pressed']> } : {}),
      ...(granted ? { granted: ['account'] as NonNullable<PageContext['granted']> } : {}),
    };
  };
  const controller = new AgentController(session, overlay, pageForTurn, () => void save());
  /** Tells the user how a write went, and keeps the report for the model's next message. */
  const reportWrite = (report: ActionReport) => {
    host.log?.({ traceId: undefined, kind: 'page_action_done', detail: { action: report.action, result: report.result } });
    actionReport = report;
    overlay.answer(report.message, [], { budgetReached: false });
    overlay.open();
    void save();
  };
  // 5. A write's check from the last page.
  const pending = checkToRun(saved, Date.now());
  if (pending) {
    host.log?.({ traceId: undefined, kind: 'page_action_check', detail: { action: pending.action } });
    await save();
    const report = await runCheck(pack, pageModule.writeActions ?? {}, pending, controlOf(document));
    if (report) reportWrite(report);
  }
  // 6. The page action.
  const focus = focusToRun(saved, location.href, Date.now());
  if (focus) {
    host.log?.({ traceId: undefined, kind: 'page_action', detail: { action: focus.action } });
    const dropped = await save();
    const pageType = currentPage().context.pageType ?? '';
    if (pack.pageActions?.[focus.action]?.effect === 'changes_site_state') {
      const savePending = (check: PendingCheck) => {
        pendingCheck = check;
        return save();
      };
      const report = dropped ? await runWrite(pack, pageModule.writeActions ?? {}, focus, controlOf(document), pageType, savePending, Date.now) : writeStopped(focus, 'not_saved');
      // Still here, so the press didn't leave the page: the check is done (or never started).
      pendingCheck = null;
      if (report) reportWrite(report);
      else void save();
    } else {
      const message = await runFocus(pack, pageModule.pageActions ?? {}, focus, controlOf(document), pageType);
      host.log?.({ traceId: undefined, kind: 'page_action_done', detail: { action: focus.action, finished: message === null } });
      if (message) {
        overlay.answer(message, [], { budgetReached: false });
        overlay.open();
        void save();
      }
    }
  }
}

void start();
