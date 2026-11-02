// Intake, Brain link and Respond working together for one user turn (phases 1, 2 and 4 on the flow chart).
// Brain link is the only part of core.js that talks to the agentic brain. It sends the user's turn, starts each tool
// call the moment it arrives (eager dispatch: tool calls stream out as the model finishes writing each one), returns
// the results the brain waits for, and hands the answer to Respond. Every message, both ways, is checked against the
// protocol first. A call marked "render: direct" is shown as soon as its result is ready (the fast path).
import type { ClientAmend, ClientMessage, ClientTurn, ServerEvent, ToolResult } from '../../../contract/generated/types.ts';
import { platformError } from '../boundary/errors.ts';
import { runToolCall } from '../execute/execute.ts';
import { present, presentToolResult, type UiComponent } from '../present/present.ts';
import type { Session } from '../runtime/session.ts';
import { describeProblems, validatorFor } from '../shared/validate.ts';

/** Where the user sees the agent: the overlay, the SwiftUI sheet or the Compose sheet. */
export interface Surface {
  progress(text: string): void;
  answer(text: string, components: UiComponent[], meta: { budgetReached: boolean }): void;
  /** A tool result shown before the answer (the fast path). */
  early?(components: UiComponent[]): void;
  error(message: string): void;
}

export type TurnOutcome = { ok: true } | { ok: false; reason: string };

/** What became of an amendment: queued on the running turn, too late (send it as a new turn), or not sent. */
export type AmendOutcome = 'queued' | 'too_late' | 'failed';

/** The most round trips one turn may take; the brain's own step budget is normally far lower. */
const MAX_ROUNDS = 25;
const SERVER_EVENTS = new Set(['tool_call', 'progress', 'await_results', 'answer', 'error']);

/**
 * Intake: the user's words and the page they're on, as a protocol turn. A host with a script sandbox says so, so the
 * brain offers run_script; without one the field is left out, and the brain offers only the site's tools.
 */
export function makeTurn(session: Session, message: string): ClientTurn {
  if (!session.page) throw new Error('the surface must set the page context before a turn');
  return {
    type: 'turn', site: session.pack.site.id, sessionId: session.id,
    traceId: `trace_${session.host.randomId()}`, message, pageContext: session.page,
    ...(session.host.scripts ? { capabilities: { scripts: true } } : {}),
  };
}

function checked(session: Session, message: unknown): string | null {
  const validator = validatorFor(session.validators.platform, 'messages.json');
  return validator(message) ? null : describeProblems(validator);
}

/**
 * Runs one turn to its answer. Messages the user sent during it that the brain couldn't fit in (follow-ups) run
 * next, as one more turn, so nothing the user said goes unanswered.
 */
export async function runTurn(session: Session, message: string, surface: Surface): Promise<TurnOutcome> {
  let pending: string[] = [message];
  let outcome: TurnOutcome = { ok: true };
  while (pending.length) {
    const joined = pending.join('\n\n');
    const next = joined.length <= 2000 ? joined : pending[0]!;
    pending = joined.length <= 2000 ? [] : pending.slice(1);
    session.activeTurn = undefined;
    const done = await runOneTurn(session, next, surface);
    session.activeTurn = undefined;
    outcome = done.outcome;
    if (!outcome.ok) return outcome;
    pending.push(...done.followUps);
  }
  return outcome;
}

/**
 * Adds a message to the turn that's running, for the user who types while the agent works. The brain hands it to the
 * model with the next tool results. With no turn running, or once the brain says it's too late, the surface sends it
 * as a new turn instead.
 */
export async function amendTurn(session: Session, message: string): Promise<AmendOutcome> {
  const traceId = session.activeTurn;
  const brain = session.host.brain?.bind(session.host);
  if (!traceId) return 'too_late';
  if (!brain) return 'failed';
  const amendMessage: ClientAmend = { type: 'amend', sessionId: session.id, traceId, message };
  if (checked(session, amendMessage)) return 'failed';
  try {
    for await (const raw of brain(amendMessage)) {
      const event = raw as ServerEvent;
      if (!checked(session, raw) && event.type === 'amended' && event.traceId === traceId) {
        session.log('amend', { status: event.status });
        return event.status;
      }
    }
  } catch (error) {
    session.log('amend_failed', String(error));
  }
  return 'failed';
}

async function runOneTurn(session: Session, message: string, surface: Surface): Promise<{ outcome: TurnOutcome; followUps: string[] }> {
  const failed = (outcome: TurnOutcome) => ({ outcome, followUps: [] });
  const stop = (reason: string, userMessage: string): TurnOutcome => {
    session.log('turn_failed', reason);
    surface.error(userMessage);
    return { ok: false, reason };
  };
  const brain = session.host.brain?.bind(session.host);
  if (!brain) return failed(stop('no brain link on this host', "The assistant isn't available here."));
  if (!session.page) return failed(stop('no page context', "The assistant isn't ready on this page yet."));

  const turn = makeTurn(session, message);
  const bad = checked(session, turn);
  if (bad) return failed(stop(`the turn breaks the protocol: ${bad}`, message.length > 2000 ? 'That message is too long. Try saying it in fewer words.' : "That message couldn't be sent."));
  session.traceId = turn.traceId;
  session.activeTurn = turn.traceId;
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
        if (problem || !SERVER_EVENTS.has(ev.type)) return failed(stop(`the brain sent an invalid event: ${problem ?? ev.type}`, 'Something went wrong. Try again.'));
        if (ev.traceId !== turn.traceId) return failed(stop('the brain sent an event for another turn', 'Something went wrong. Try again.'));
        if (ev.type === 'tool_call') {
          const { id, name, args } = ev.call;
          if (running.has(id)) return failed(stop(`call ${id} arrived twice`, 'Something went wrong. Try again.'));
          session.log('tool_call', { id, name });
          const result = runToolCall(session, name, args).then(
            (outcome): ToolResult => (outcome.ok ? { id, ok: true, output: outcome.output } : { id, ok: false, error: outcome.error }),
            (error: unknown): ToolResult => {
              session.log('tool_crashed', { tool: name, error: String(error) });
              return { id, ok: false, error: platformError('site_code_error', { tool: name, details: 'an unexpected error' }) };
            },
          );
          running.set(id, result);
          if (ev.call.render === 'direct' && surface.early) {
            void result.then((settled) => {
              if (!settled.ok) return;
              const components = presentToolResult(session, name, settled.output);
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
          return { outcome: { ok: true }, followUps: ev.followUps ?? [] };
        } else if (ev.type === 'error') {
          session.log('brain_error', { code: ev.code });
          surface.error(ev.message);
          return failed({ ok: false, reason: `brain error: ${ev.code}` });
        }
      }
    } catch (error) {
      return failed(stop(`lost the brain link: ${String(error)}`, 'Lost the connection to the assistant. Try again.'));
    }
    if (!awaited) return failed(stop('the brain stopped without an answer', 'The assistant stopped without an answer. Try again.'));
    const unknown = awaited.filter((id) => !running.has(id));
    if (unknown.length) return failed(stop(`the brain awaits calls it never sent: ${unknown.join(', ')}`, 'Something went wrong. Try again.'));
    const results = await Promise.all(awaited.map((id) => running.get(id)!));
    for (const id of awaited) running.delete(id);
    outgoing = { type: 'results', sessionId: session.id, traceId: turn.traceId, results: results as [ToolResult, ...ToolResult[]] };
    const badResults = checked(session, outgoing);
    if (badResults) return failed(stop(`our results break the protocol: ${badResults}`, 'Something went wrong. Try again.'));
  }
  return failed(stop('too many round trips', 'This took too many steps. Try a narrower question.'));
}
