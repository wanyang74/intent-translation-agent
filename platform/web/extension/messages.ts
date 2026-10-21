// The messages between the content script and the background worker, over one Chrome port per brain request: the
// content script posts one `send`, the worker answers with each event the brain streams, then `end` or `fail`.
import type { ClientMessage } from '../../contract/generated/types.ts';

/** The port's name, so the worker ignores ports opened for anything else. */
export const BRAIN_PORT = 'brain';

export type ToWorker = { type: 'send'; message: ClientMessage };

export type FromWorker =
  | { type: 'event'; event: unknown }
  | { type: 'end' }
  | { type: 'fail'; error: string };
