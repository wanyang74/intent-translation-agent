// The web controller: joins one core.js session to the overlay. It decides what a message the user sends does: with
// no turn running it starts one on the current page; during a turn it amends that turn, and a message the brain can no
// longer fit in waits and runs as the next turn. Platform code, used by the extension and later by an embedded SDK.
import type { PageContext } from '../../contract/generated/types.ts';
import { amendTurn, runTurn, type Surface } from '../../core/src/link/link.ts';
import type { Session } from '../../core/src/runtime/session.ts';

export class AgentController {
  private readonly session: Session;
  private readonly surface: Surface;
  private readonly readPage: () => PageContext;
  private readonly onIdle: (() => void) | undefined;
  private running = false;
  /** Messages that missed the running turn, in order; they run together as the next turn. */
  private waiting: string[] = [];

  /**
   * `readPage` is asked for the page context at the start of every turn, since the user may have navigated.
   * `onIdle` is called each time the last turn ends, when the conversation is in a state worth saving.
   */
  constructor(session: Session, surface: Surface, readPage: () => PageContext, onIdle?: () => void) {
    this.session = session;
    this.surface = surface;
    this.readPage = readPage;
    this.onIdle = onIdle;
  }

  /**
   * Handles one message from the user:
   *   1. During a turn: amend it; if the brain says it's too late, or the amend fails, keep it for the next turn.
   *   2. Otherwise: run turns until no message is waiting.
   */
  async send(message: string): Promise<void> {
    // 1. A turn is running. Awaiting the amend lets the turn's own loop keep going meanwhile; both share the session.
    if (this.running) {
      if ((await amendTurn(this.session, message)) !== 'queued') this.waiting.push(message);
      return;
    }
    // 2. Turns until nothing waits. A message that arrives during the last turn is pushed before `running` is false,
    //    so it can't be lost between the loop's check and the end of send().
    this.running = true;
    try {
      let next: string | undefined = message;
      while (next !== undefined) {
        this.session.setPage(this.readPage());
        await runTurn(this.session, next, this.surface);
        next = this.waiting.length ? this.waiting.splice(0).join('\n\n') : undefined;
      }
    } finally {
      this.running = false;
    }
    this.onIdle?.();
  }
}
