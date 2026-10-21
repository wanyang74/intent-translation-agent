// The messages between the content script and the background worker. Brain requests go over one Chrome port each:
// the content script posts one `send`, the worker answers with each event the brain streams, then `end` or `fail`.
// The saved conversation goes as one-off messages: `load` answers with what's saved for the site, `save` stores it.
import type { ClientMessage } from '../../contract/generated/types.ts';
import type { SavedConversation } from '../src/conversation.ts';

/** The port's name, so the worker ignores ports opened for anything else. */
export const BRAIN_PORT = 'brain';

export type ToWorker = { type: 'send'; message: ClientMessage };

/** A one-off message about the site's saved conversation. */
export type ConversationRequest = { type: 'load'; site: string } | { type: 'save'; site: string; conversation: SavedConversation };

export type FromWorker =
  | { type: 'event'; event: unknown }
  | { type: 'end' }
  | { type: 'fail'; error: string };
