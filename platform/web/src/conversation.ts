// A conversation saved between pages of one site, so it follows the user around the site: after a Take me there
// button, a link on the site, or a new tab of the same site. The host keeps it (the extension in its own storage,
// an app in memory) and the next page's controller carries on from it. Platform code: nothing here names a site.
import type { PanelPress } from '../../contract/generated/types.ts';
import type { PageFocus } from '../../core/src/present/present.ts';
import type { ActionReport, PendingCheck } from './page-actions.ts';
import type { SessionSnapshot } from '../../core/src/runtime/session.ts';
import type { SurfaceEvent } from '../../testkit/src/fake-surface.ts';

/** One thing the overlay showed: a message the user sent, a button they pressed, or a finished part of a reply. */
export type ShownEntry = { type: 'user'; text: string } | { type: 'press'; press: PanelPress } | Exclude<SurfaceEvent, { type: 'progress' }>;

/** After this long without a message, a saved conversation is dropped. The brain forgets an idle session at the same time. */
export const CONVERSATION_IDLE_MS = 30 * 60_000;

export interface SavedConversation {
  /** core.js's session: known IDs, the records cards are filled from, the call budget. */
  session: SessionSnapshot;
  /** What the overlay showed, to draw again. */
  shown: ShownEntry[];
  /** Whether the panel was open. */
  open: boolean;
  /** When it was saved, in milliseconds since 1970. */
  savedAt: number;
  /** A page action for the page a button is opening, saved just before it opens; run once there, then dropped. */
  focus?: { url: string; focus: PageFocus };
  /** A write's check, saved just before its press, for the page the press may lead to (page-actions.ts). */
  pendingCheck?: PendingCheck;
  /** How the last write went, for the model with the next message; dropped once sent. */
  actionReport?: ActionReport;
  /** The panel's buttons pressed since the last message, for the model with the next one; dropped once sent. */
  pressed?: PanelPress[];
}

/** How many presses the next message carries: the latest ones. The schema allows no more. */
export const MAX_PRESSES = 5;

/**
 * The presses with one more: the same button pressed again in a row counts once, and only the latest MAX_PRESSES
 * are kept, oldest first.
 */
export function withPress(pressed: readonly PanelPress[], press: PanelPress): PanelPress[] {
  const last = pressed[pressed.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(press)) return [...pressed];
  return [...pressed, press].slice(-MAX_PRESSES);
}

/** A focus older than this is stale: the page it was for has long since loaded, or never did. */
export const FOCUS_FRESH_MS = 60_000;

/**
 * The saved focus, if it's for this page and was saved moments ago. The URL is compared by its origin and path only,
 * since a site may add to the query as its page starts.
 */
export function focusToRun(saved: SavedConversation | null, url: string, now: number): PageFocus | null {
  if (!saved?.focus || now - saved.savedAt > FOCUS_FRESH_MS) return null;
  const page = (href: string) => {
    try {
      const parsed = new URL(href);
      return parsed.origin + parsed.pathname.replace(/\/+$/, '');
    } catch {
      return null;
    }
  };
  const target = page(saved.focus.url);
  return target !== null && target === page(url) ? saved.focus.focus : null;
}

/**
 * A write's check to run on this page, if it was saved moments ago. Any page of the site: a press can lead anywhere
 * on it. Its own time counts, not the conversation's, which later saves move on.
 */
export function checkToRun(saved: SavedConversation | null, now: number): PendingCheck | null {
  const pending = saved?.pendingCheck;
  return pending && typeof pending.savedAt === 'number' && now - pending.savedAt <= FOCUS_FRESH_MS ? pending : null;
}

/** The saved conversation if it's still fresh enough to carry on, otherwise null. */
export function conversationToResume(saved: SavedConversation | null | undefined, now: number): SavedConversation | null {
  if (!saved || typeof saved.savedAt !== 'number' || !saved.session || !Array.isArray(saved.shown)) return null;
  return now - saved.savedAt < CONVERSATION_IDLE_MS ? saved : null;
}

/** The line a pressed button leaves in the conversation. */
export function pressText(press: PanelPress, siteName = 'the site'): string {
  if (press.button === 'card') return `You opened ${press.title} on ${siteName}`;
  return `You pressed ${press.button === 'confirm' ? 'the confirming button' : 'Take me there'}: ${press.title}`;
}
