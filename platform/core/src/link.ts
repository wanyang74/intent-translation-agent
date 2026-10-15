// Intake, Brain link and Respond working together for one user turn (phases 1, 2 and 4 on the flow chart).
// Brain link is the only part of core.js that talks to the agentic brain. It sends the user's turn, starts each tool
// call the moment it arrives (eager dispatch: tool calls stream out as the model finishes writing each one), returns
// the results the brain waits for, and hands the answer to Respond. Every message, both ways, is checked against the
// protocol first. A call marked render: direct is shown as soon as its result is ready (the fast path).
import type { ClientMessage, ClientTurn, ServerEvent, ToolResult } from '../../contract/generated/types.ts';
import { platformError } from './errors.ts';
import { runToolCall } from './execute.ts';
import { present, presentToolResult, type UiComponent } from './present.ts';
import type { Session } from './session.ts';
import { describeProblems, validatorFor } from './validate.ts';

/** Where the user sees the agent: the overlay, the SwiftUI sheet or the Compose sheet. */
export interface Surface {
  progress(text: string): void;
  answer(text: string, components: UiComponent[], meta: { budgetReached: boolean }): void;
  /** A tool result shown before the answer (the fast path). */
  early?(components: UiComponent[]): void;
  error(message: string): void;
}

export type TurnOutcome = { ok: true } | { ok: false; reason: string };

/** The most round trips one turn may take; the brain's own step budget is normally far lower. */
const MAX_ROUNDS = 25;
const SERVER_EVENTS = new Set(['tool_call', 'progress', 'await_results', 'answer', 'error']);

/** Intake: the user's words and the page they're on, as a protocol turn. */
export function makeTurn(session: Session, message: string): ClientTurn {
  if (!session.page) throw new Error('the surface must set the page context before a turn');
  return {
    type: 'turn', site: session.pack.site.id, sessionId: session.id,
    traceId: `trace_${session.host.randomId()}`, message, pageContext: session.page,
  };
}

function checked(session: Session, message: unknown): string | null {
  const v = validatorFor(session.validators.platform, 'messages.json');
  return v(message) ? null : describeProblems(v);
}

export async function runTurn(session: Session, message: string, surface: Surface): Promise<TurnOutcome> {
  const stop = (reason: string, userMessage: string): TurnOutcome => {
    session.log('turn_failed', reason);
    surface.error(userMessage);
    return { ok: false, reason };
  };
  const brain = session.host.brain?.bind(session.host);
  if (!brain) return stop('no brain link on this host', "The assistant isn't available here.");
  if (!session.page) return stop('no page context', "The assistant isn't ready on this page yet.");

  const turn = makeTurn(session, message);
  const bad = checked(session, turn);
  if (bad) return stop(`the turn breaks the protocol: ${bad}`, message.length > 2000 ? 'That message is too long. Try saying it in fewer words.' : "That message couldn't be sent.");
  session.traceId = turn.traceId;
  session.budget.startTask();
  session.onProgress = (text) => surface.progress(text);
  session.log('turn', { message: turn.message.length });

  const running = new Map<string, Promise<ToolResult>>();
  let outgoing: ClientMessage = turn;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let awaited: string[] | null = null;
    try {
      for await (const raw of brain(outgoing)) {
        const problem = checked(session, raw);
        const ev = raw as ServerEvent;
        if (problem || !SERVER_EVENTS.has(ev.type)) return stop(`the brain sent an invalid event: ${problem ?? ev.type}`, 'Something went wrong. Try again.');
        if (ev.traceId !== turn.traceId) return stop('the brain sent an event for another turn', 'Something went wrong. Try again.');
        if (ev.type === 'tool_call') {
          const { id, name, args } = ev.call;
          if (running.has(id)) return stop(`call ${id} arrived twice`, 'Something went wrong. Try again.');
          session.log('tool_call', { id, name });
          const result = runToolCall(session, name, args).then(
            (r): ToolResult => (r.ok ? { id, ok: true, output: r.output } : { id, ok: false, error: r.error }),
            (e: unknown): ToolResult => {
              session.log('tool_crashed', { tool: name, error: String(e) });
              return { id, ok: false, error: platformError('site_code_error', { tool: name, details: 'an unexpected error' }) };
            },
          );
          running.set(id, result);
          if (ev.call.render === 'direct' && surface.early) {
            void result.then((r) => {
              if (!r.ok) return;
              const components = presentToolResult(session, name, r.output);
              if (components.length) surface.early!(components);
            });
          }
        } else if (ev.type === 'progress') {
          surface.progress(ev.text);
        } else if (ev.type === 'await_results') {
          awaited = ev.callIds;
          break;
        } else if (ev.type === 'answer') {
          const shown = present(session, ev.present ?? []);
          surface.answer(ev.text, shown.components, { budgetReached: ev.budgetReached === true });
          session.log('answer', { components: shown.components.length, refused: shown.refused.length });
          return { ok: true };
        } else {
          session.log('brain_error', { code: ev.code });
          surface.error(ev.message);
          return { ok: false, reason: `brain error: ${ev.code}` };
        }
      }
    } catch (e) {
      return stop(`lost the brain link: ${String(e)}`, 'Lost the connection to the assistant. Try again.');
    }
    if (!awaited) return stop('the brain stopped without an answer', 'The assistant stopped without an answer. Try again.');
    const unknown = awaited.filter((id) => !running.has(id));
    if (unknown.length) return stop(`the brain awaits calls it never sent: ${unknown.join(', ')}`, 'Something went wrong. Try again.');
    const results = await Promise.all(awaited.map((id) => running.get(id)!));
    for (const id of awaited) running.delete(id);
    outgoing = { type: 'results', sessionId: session.id, traceId: turn.traceId, results: results as [ToolResult, ...ToolResult[]] };
    const badResults = checked(session, outgoing);
    if (badResults) return stop(`our results break the protocol: ${badResults}`, 'Something went wrong. Try again.');
  }
  return stop('too many round trips', 'This took too many steps. Try a narrower question.');
}
