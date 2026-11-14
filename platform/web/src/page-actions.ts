// Page actions: what the extension may do on the site's own page after a button in the panel, such as opening the
// chosen item's details. The site pack lists them (pageActions); the site's page code (page.ts) does them; this file
// runs one and tells the user how it went.
// Two kinds, kept apart: actions that only show information (page.ts `pageActions`, run by runFocus), and actions
// that change the site (D6), such as adding to its cart (page.ts `writeActions`, run by runWrite, then runCheck). A
// write comes only from a confirming button the user pressed. The site code finds the one button to press and presses
// nothing else; this file presses it once, after saving a check, so the result is confirmed even when the press takes
// the browser to a new page.
// Rules: an action runs only if the site pack lists it with its kind, on one of its page types; page code sees the
// page only through PageControl, a small slice of the DOM, so it can be tested in Node with a fake; and when the
// target isn't found exactly, it presses nothing. Platform code: nothing here names a site.
import type { SitePack } from '../../contract/generated/types.ts';
import type { PageFocus } from '../../core/src/present/present.ts';

/** One element of the page, as page code may use it. */
export interface PageElement {
  /** The text as the user sees it (innerText), lines separated by newlines. */
  readonly text: string;
  attribute(name: string): string | null;
  find(selector: string): PageElement | null;
  findAll(selector: string): PageElement[];
  /** The page element with this ID (for aria-controls), or null. */
  byId(id: string): PageElement | null;
  /** The element this one is inside, or null at the top: for finding the card around a button. */
  parent(): PageElement | null;
  click(): void;
  scrollIntoView(): void;
}

/** The page, as page code may use it. `wait` lets the page's own code run, such as results arriving. */
export interface PageControl {
  findAll(selector: string): PageElement[];
  byId(id: string): PageElement | null;
  wait(ms: number): Promise<void>;
  /** The page's address now: a site may change it without loading a new page. */
  url(): string;
}

/** How an action ended. Anything but done means nothing was clicked, except not_confirmed. */
export type PageActionOutcome =
  | { done: true }
  | { done: false; reason: 'not_found' | 'ambiguous' }
  /** It clicked, but what opened doesn't show it was the right item. */
  | { done: false; reason: 'not_confirmed' };

/** One site's page action: its target from the site code's destination builder. */
export type PageAction = (page: PageControl, target: any, options: { timeoutMs: number }) => Promise<PageActionOutcome>;

/** Why a write stopped before pressing anything. */
export type WriteStop =
  | { done: false; reason: 'not_found' | 'ambiguous' }
  /** The page's price for the item isn't the one the user confirmed; `shown` is the page's. */
  | { done: false; reason: 'price_changed'; shown: string }
  /** The site wants the user to accept its terms first (the page code opened it and stopped there). */
  | { done: false; reason: 'needs_user' }
  /** The button is there but turned off. */
  | { done: false; reason: 'unavailable' };

/**
 * One site's action that changes the site (D6), in two halves so the platform owns the press:
 *   prepare  finds the item and checks it is exactly the one confirmed; it may open things that only show
 *            information, and presses nothing that changes the site. It returns the one press to make.
 *   check    reads the page after the press, on the same page or the one it led to: confirmed once the site shows the
 *            change; unchanged while the page looks as it did before the press (the site ignored it); else waiting.
 */
export interface WriteAction {
  prepare(page: PageControl, target: any, options: { timeoutMs: number }): Promise<{ ready: true; press: () => void } | WriteStop>;
  check(page: PageControl, target: any): 'confirmed' | 'waiting' | 'unchanged';
}

/** What the user reads after a write, and what the model is told with the next message (PageContext.pageAction). */
export interface ActionReport {
  action: string;
  result: 'done' | 'stopped' | 'unconfirmed';
  message: string;
}

/** A write's check, saved just before the press, so the page the press leads to can confirm it. */
export interface PendingCheck {
  action: string;
  target: unknown;
  hint: string;
  /** When it was saved, in milliseconds since 1970. */
  savedAt: number;
}

/** How long an action may wait for its target to appear: a site's results can take a while to arrive. */
export const PAGE_ACTION_TIMEOUT_MS = 30_000;

/** How long a write's check waits for the site to show the change, on either page, and how often it looks. */
export const WRITE_CHECK_MS = 15_000;
export const WRITE_CHECK_POLL_MS = 500;

/** What the user reads when a write didn't finish; {hint} is the site code's, {shown} the page's price. */
export const WRITE_MESSAGES: Record<WriteStop['reason'] | 'not_saved' | 'ignored' | 'unconfirmed', string> = {
  not_saved: "I couldn't keep track of this step, so I didn't press anything. Look for {hint}.",
  not_found: "I couldn't find it on this page, so I didn't press anything. Look for {hint}.",
  ambiguous: 'More than one item here matches, so I didn\'t press anything. Look for {hint}.',
  price_changed: "The price on this page is now {shown}, not the one you confirmed, so I didn't press anything. Look for {hint}.",
  needs_user: "It's open, but the site asks you to accept its terms first, so I stopped there. Accept them and press the button yourself: {hint}.",
  unavailable: "Its button is turned off on this page, so I didn't press it. Look for {hint}.",
  ignored: "I pressed the button, but the page didn't respond, so it may not have gone through. It's open for you to press yourself: {hint}.",
  unconfirmed: "I pressed the button, but couldn't confirm the site took it. Check the site's page for {hint}.",
};

/** What the user reads when an action couldn't finish; {hint} is the site code's, such as a flight and its time. */
export const PAGE_ACTION_MESSAGES: Record<Exclude<PageActionOutcome, { done: true }>['reason'], string> = {
  not_found: "I couldn't find it on this page. Look for {hint}.",
  ambiguous: 'More than one item here matches, so I left them closed. Look for {hint}.',
  not_confirmed: "I opened the details I think match, but couldn't confirm them. Check they're for {hint}.",
};

/**
 * Runs a focus on the page it was meant for:
 *   1. Only an action the site pack lists, on one of its page types, that the page code has.
 *   2. The action, given a time limit.
 *   3. A message for the user when it didn't finish; null when it did, or didn't run.
 */
export async function runFocus(pack: SitePack, actions: Record<string, PageAction>, focus: PageFocus, page: PageControl, pageType: string): Promise<string | null> {
  // 1. Listed and on its page. A write never runs here, even if page code lists it among the actions that show.
  const listed = pack.pageActions?.[focus.action];
  const action = actions[focus.action];
  if (!listed || listed.effect !== 'shows_information' || !action || !listed.pageTypes.includes(pageType)) return null;
  // 2. The action. A failure in page code is the same as not finding the target: nothing more is clicked.
  let outcome: PageActionOutcome;
  try {
    outcome = await action(page, focus.target, { timeoutMs: PAGE_ACTION_TIMEOUT_MS });
  } catch {
    outcome = { done: false, reason: 'not_found' };
  }
  // 3. The message.
  return outcome.done ? null : PAGE_ACTION_MESSAGES[outcome.reason].replace('{hint}', focus.hint);
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);

/** The site pack's listing of a write action, if this is one it may run: listed as changing the site, with page code. */
function writeListed(pack: SitePack, actions: Record<string, WriteAction>, name: string) {
  const listed = pack.pageActions?.[name];
  const action = actions[name];
  return listed?.effect === 'changes_site_state' && action ? { listed, action } : null;
}

/**
 * Waits for the site to show a write's change: confirmed, or by the time limit, unchanged or still waiting. A failure in
 * page code counts as waiting: the press may have worked, so it's never reported as ignored.
 */
async function awaitChange(action: WriteAction, page: PageControl, target: unknown): Promise<'confirmed' | 'waiting' | 'unchanged'> {
  let state: 'confirmed' | 'waiting' | 'unchanged' = 'waiting';
  for (let waited = 0; ; waited += WRITE_CHECK_POLL_MS) {
    try {
      state = action.check(page, target);
    } catch {
      state = 'waiting';
    }
    if (state === 'confirmed' || waited >= WRITE_CHECK_MS) return state;
    await page.wait(WRITE_CHECK_POLL_MS);
  }
}

/**
 * Runs a write the user confirmed, on the page it was meant for:
 *   1. Only an action the site pack lists as changing the site, on one of its page types, that the page code has.
 *   2. Prepare: find the item and its one button, and check it's exactly the one confirmed. A stop presses nothing.
 *   3. Save the check before pressing: the press may take the browser to a new page, which ends this script, and
 *      that page confirms it (runCheck). If it can't be saved, nothing is pressed. Then press, once.
 *   4. Wait for the site to show the change. A page that looks as before means the site ignored the press.
 * Returns the report for the user and the model, or null when it didn't run.
 */
export async function runWrite(pack: SitePack, actions: Record<string, WriteAction>, focus: PageFocus, page: PageControl, pageType: string, savePending: (pending: PendingCheck) => Promise<boolean>, now: () => number): Promise<ActionReport | null> {
  // 1. Listed and on its page.
  const found = writeListed(pack, actions, focus.action);
  if (!found || !found.listed.pageTypes.includes(pageType)) return null;
  const report = (result: ActionReport['result'], text: string, values: Record<string, string> = {}): ActionReport => ({ action: focus.action, result, message: fill(text, { hint: focus.hint, ...values }) });
  // 2. Prepare. A failure in page code is the same as not finding the item: nothing is pressed.
  let prepared: Awaited<ReturnType<WriteAction['prepare']>>;
  try {
    prepared = await found.action.prepare(page, focus.target, { timeoutMs: PAGE_ACTION_TIMEOUT_MS });
  } catch {
    prepared = { done: false, reason: 'not_found' };
  }
  if (!('ready' in prepared)) return report('stopped', WRITE_MESSAGES[prepared.reason], 'shown' in prepared ? { shown: prepared.shown } : {});
  // 3. The check, then the press. Awaiting the save means the check is stored before anything can leave the page.
  if (!(await savePending({ action: focus.action, target: focus.target, hint: focus.hint, savedAt: now() }))) return report('stopped', WRITE_MESSAGES.not_saved);
  try {
    prepared.press();
  } catch {
    return report('unconfirmed', WRITE_MESSAGES.unconfirmed);
  }
  // 4. The change.
  const state = await awaitChange(found.action, page, focus.target);
  if (state === 'confirmed') return report('done', found.listed.done!);
  return report('unconfirmed', state === 'unchanged' ? WRITE_MESSAGES.ignored : WRITE_MESSAGES.unconfirmed);
}

/**
 * Confirms a write whose press took the browser to this page: the check runWrite saved, if it's fresh and listed.
 * The page changed, so "unchanged" can't mean ignored here: anything short of confirmed is unconfirmed.
 */
export async function runCheck(pack: SitePack, actions: Record<string, WriteAction>, pending: PendingCheck, page: PageControl): Promise<ActionReport | null> {
  const found = writeListed(pack, actions, pending.action);
  if (!found) return null;
  const state = await awaitChange(found.action, page, pending.target);
  const confirmed = state === 'confirmed';
  return { action: pending.action, result: confirmed ? 'done' : 'unconfirmed', message: fill(confirmed ? found.listed.done! : WRITE_MESSAGES.unconfirmed, { hint: pending.hint }) };
}

/** A write that stops before it starts, such as when its button's focus couldn't be dropped (so it might run twice). */
export function writeStopped(focus: PageFocus, reason: keyof typeof WRITE_MESSAGES): ActionReport {
  return { action: focus.action, result: 'stopped', message: fill(WRITE_MESSAGES[reason], { hint: focus.hint }) };
}

interface DomElement {
  readonly textContent: string | null;
  readonly innerText?: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  readonly parentElement: DomElement | null;
  click?(): void;
  scrollIntoView?(options?: unknown): void;
}

interface DomDocument {
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  getElementById(id: string): DomElement | null;
  readonly location: { readonly href: string } | null;
}

/** A PageControl of a live document (typed by what it uses, so this file also compiles where there's no DOM). */
export function controlOf(doc: DomDocument): PageControl {
  const wrap = (node: DomElement): PageElement => ({
    get text() {
      return node.innerText ?? node.textContent ?? '';
    },
    attribute: (name) => node.getAttribute(name),
    find: (selector) => {
      const found = node.querySelector(selector);
      return found ? wrap(found) : null;
    },
    findAll: (selector) => Array.from(node.querySelectorAll(selector), wrap),
    byId: (id) => {
      const found = doc.getElementById(id);
      return found ? wrap(found) : null;
    },
    parent: () => (node.parentElement ? wrap(node.parentElement) : null),
    click: () => node.click?.(),
    scrollIntoView: () => node.scrollIntoView?.({ block: 'center', behavior: 'smooth' }),
  });
  return {
    findAll: (selector) => Array.from(doc.querySelectorAll(selector), wrap),
    byId: (id) => {
      const found = doc.getElementById(id);
      return found ? wrap(found) : null;
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    url: () => doc.location?.href ?? '',
  };
}
