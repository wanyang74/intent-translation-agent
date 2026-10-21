// A conversation saved between pages of one site, so it follows the user around the site: after a Take me there
// button, a link on the site, or a new tab of the same site. The host keeps it (the extension in its own storage,
// an app in memory) and the next page's controller carries on from it. Platform code: nothing here names a site.
import type { SessionSnapshot } from '../../core/src/runtime/session.ts';
import type { SurfaceEvent } from '../../testkit/src/fake-surface.ts';

/** One thing the overlay showed: a message the user sent, or a finished part of a reply. */
export type ShownEntry = { type: 'user'; text: string } | Exclude<SurfaceEvent, { type: 'progress' }>;

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
}

/** The saved conversation if it's still fresh enough to carry on, otherwise null. */
export function conversationToResume(saved: SavedConversation | null | undefined, now: number): SavedConversation | null {
  if (!saved || typeof saved.savedAt !== 'number' || !saved.session || !Array.isArray(saved.shown)) return null;
  return now - saved.savedAt < CONVERSATION_IDLE_MS ? saved : null;
}
