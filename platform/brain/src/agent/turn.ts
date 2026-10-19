// One turn: from a user message to an answer, an error, or a wait for the client. The brain drives the turn and the
// client runs the tools: a turn is a series of model calls (ModelSteps), and a step that calls the site's tools ends
// by waiting for the client's results.
// Each tool call is sent the moment the model finishes writing it (eager dispatch), under the brain's own call ID
// (call_1, call_2, … per session). Calls the brain can refuse or answer itself (made-up tools, bad arguments, unknown
// IDs, skills) never reach the client. A step whose only calls are presentation calls is the answer: they're checked,
// required notices are added, and the turn ends. If the model sends them with no text, they're kept, and its next
// step writes the words. A message the user sends while the turn runs (an amendment) is queued on the turn and
// handed to the model with the next tool results, as a reminder; one that misses the turn's last model call comes
// back on the answer as a follow-up, which the client sends as the next turn. A new turn instead starts over. The
// step budget, timeouts and quotas end a turn early with a plain message, and the session's history stays valid for
// the next turn.
import type { ClientResults, ErrorEvent, PageContext, PresentationCall, ServerEvent, ToolCallEvent, ToolError } from '../../../contract/generated/types.ts';
import { withRequiredNotices } from '../../../core/src/boundary/checks.ts';
import { platformError } from '../../../core/src/boundary/errors.ts';
import { NO_USAGE, type ModelEvent, type ToolResultPart, type Usage } from '../model/model.ts';
import { SKILL_TOOL } from '../prompt/prompt.ts';
import { loadSkill } from '../prompt/skills.ts';
import { checkClientCall, checkPresentationCall, isPresentation, learnIds, outputProblem, type ServerContext } from '../system/checks.ts';
import type { AgentSession } from './session.ts';
import { isObject, MESSAGES, once, type ServerResponse, type BrainServices } from './types.ts';

/** One tool call the model made, and what became of it. */
export interface CallRecord {
  /** The model's own ID for the call; the history uses it. */
  modelId: string;
  name: string;
  input: Record<string, unknown>;
  /** client: sent to the client to run. present: part of the answer. server: answered by the brain. */
  kind: 'client' | 'present' | 'server';
  /** The brain's ID, the only one the client sees; set for client calls. */
  callId?: string;
  result?: ToolResultPart;
}

/** One model call within a turn: what the model wrote, and every tool call it made. */
export interface ModelStep {
  text: string;
  calls: CallRecord[];
}

/** A presentation call in a few words, for telling the model what it was about to show. */
function describeCall(presentation: PresentationCall): string {
  const args = presentation.args as { entity?: string; ids?: unknown[]; id?: unknown; notice?: string; form?: string };
  const what = args.ids ? `${args.entity} ${args.ids.join(', ')}` : args.id !== undefined ? `${args.entity} ${String(args.id)}` : args.notice ?? args.form ?? '';
  return `${presentation.name} (${what})`;
}

/**
 * How amendments reach the model: right after the latest tool results, in the same user message. Cards the model
 * was about to show stay held, and the reminder lists them, so the model decides whether they still fit.
 */
export function amendmentReminder(messages: readonly string[], held: readonly PresentationCall[] = []): string {
  const said = messages.map((message) => `The user sent a new message while you were working:\n${message}`).join('\n\n');
  const heldNote = held.length
    ? `\n\nYou were about to show: ${held.map(describeCall).join('; ')}. Handle the user's message however it needs, with more tools if useful. When you answer, those cards are shown with it, unless you call presentation tools again; whatever you send then replaces them.`
    : '';
  return `<system-reminder>\n${said}\n\nTake it into account from here on, and make sure your answer covers it. Nothing has been shown to the user yet.${heldNote}\n</system-reminder>`;
}

/** The result for presentation calls kept while the model writes its answer. */
const KEPT_NOTE = 'Accepted: it will be shown with your answer. Now write the answer text; there is no need to call it again.';

class ModelTimeout extends Error {}
/** Why a step stops when the client that asked for it has gone away. */
class ClientGone extends Error {}

/** A timer that doesn't keep the process alive by itself. */
function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** The model's text before its tool calls, as a progress line: whitespace collapsed, at most 200 characters. */
export function progressLine(text: string): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  const chars = Array.from(collapsed);
  if (chars.length <= 200) return collapsed;
  const sentence = /^.{1,199}?[.!?…](?=\s|$)/u.exec(collapsed)?.[0];
  return sentence ?? chars.slice(0, 199).join('') + '…';
}

/** A tool result that carries an error, under the model's ID for the call. */
function errorResult(call: CallRecord, error: ToolError): ToolResultPart {
  return { type: 'tool-result', id: call.modelId, name: call.name, output: error, isError: true };
}

/**
 * Resolves like `promise`, or rejects as soon as the signal aborts, so a model that ignores the signal still stops.
 * A race: whichever comes first, the promise settling or the abort, decides the outcome. A promise's state can change
 * only once, so the later of the two is ignored. Built with `new Promise` and `.then` rather than `await`, because
 * it must listen for both at the same time.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    // Listens only while this one wait lasts.
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    // .then registers callbacks and returns at once. Once the promise settles, the race is over, so the listener is
    // removed. callModel calls this once per stream event on the same signal; without the removal, hundreds of
    // listeners would pile up on it during one response.
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export class Turn {
  readonly session: AgentSession;
  readonly traceId: string;
  readonly page: PageContext;
  private readonly services: BrainServices;
  private readonly started: number;
  /** Model calls made so far, for the step budget. */
  private steps = 0;
  /** running: making model calls. awaiting_client_calls: the client is running tools. done: answered, failed or replaced. */
  state: 'running' | 'awaiting_client_calls' | 'done' = 'running';
  /** The off switch of the model call in flight; replaced for each call. */
  private modelCall = new AbortController();
  /** While awaiting_client_calls: the step whose client calls are out, and those calls by the brain's call ID. */
  private awaitingClientCalls: { step: ModelStep; byCallId: Map<string, CallRecord> } | null = null;
  /** While awaiting_client_calls: ends the turn if the client's results don't come in time. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Presentation calls accepted in an earlier step of this turn, shown with the answer. */
  private kept: PresentationCall[] = [];
  /** Whether the held cards were put to the model with an amendment: presentation calls it sends next replace them. */
  private keptUnderReview = false;
  /** Amendments queued for the model's next step, in the order the user sent them. */
  private amendments: string[] = [];
  /** Aborts when the client of the request being served goes away. */
  private signal: AbortSignal | undefined;

  constructor(session: AgentSession, traceId: string, page: PageContext, started: number) {
    this.session = session;
    this.services = session.services;
    this.traceId = traceId;
    this.page = page;
    this.started = started;
  }

  /** Streams the turn's next steps; a model call stops if the client of this request goes away. */
  stream(signal: AbortSignal | undefined): ServerResponse {
    this.signal = signal;
    return { ok: true, events: this.run() };
  }

  /** Queues a message the user sent while this turn runs; the model gets it at its next step. */
  amend(message: string): void {
    this.amendments.push(message);
    this.log('amendment_queued', { message: message.length, queued: this.amendments.length });
  }

  /** A new message replaced this turn: stop the model call, close the calls it was waiting on, and end it. */
  supersede(): void {
    if (this.state === 'awaiting_client_calls') this.closeAwaitedClientCalls('the user sent a new message first');
    this.modelCall.abort(new Error('superseded'));
    this.end('superseded by a new message');
  }

  /** Ends the turn once: stops the wait timer and frees the session for the next turn. */
  end(why: string): void {
    if (this.state === 'done') return;
    this.state = 'done';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.session.turn === this) this.session.turn = null;
    this.log('turn_end', { why, steps: this.steps });
  }

  /**
   * POST /v1/results, after the session found this turn waiting:
   *   1. Check the results answer exactly the awaited calls, each once; anything else ends the turn.
   *   2. Stop the wait timer.
   *   3. Turn each result into what the model sees: errors as they are, outputs checked against the tool's format,
   *      and the IDs in good outputs learned.
   *   4. Add the step's results to the history, in the order the model made the calls.
   *   5. Mark the turn running again and stream its next steps (run).
   */
  takeResults(resultsMessage: ClientResults, signal: AbortSignal | undefined): ServerResponse {
    const { history } = this.session;
    const waiting = this.awaitingClientCalls!;
    // 1. Results only for the calls the brain issued and is waiting for: each one exactly once.
    const ids = resultsMessage.results.map((result) => result.id);
    const exact = ids.length === waiting.byCallId.size && new Set(ids).size === ids.length && ids.every((id) => waiting.byCallId.has(id));
    if (!exact) {
      this.log('results_refused', { got: ids, awaited: [...waiting.byCallId.keys()] });
      this.closeAwaitedClientCalls('the client sent results that did not match');
      this.end('results did not match');
      return { ok: true, events: once({ type: 'error', traceId: this.traceId, code: 'internal', message: MESSAGES.mismatch }) };
    }
    // 2. The results came in time: stop the wait timer.
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // 3. Each result as the model will see it. A tool error passes through; an output in the wrong format becomes an
    //    error; a good output teaches the brain its IDs, so later presentation calls can use them.
    const ctx = this.checks();
    for (const result of resultsMessage.results) {
      const call = waiting.byCallId.get(result.id)!;
      if (!result.ok) {
        call.result = errorResult(call, result.error);
        continue;
      }
      const problem = outputProblem(this.services.site.bundle, call.name, result.output);
      if (problem) {
        this.log('result_refused', { call: result.id, tool: call.name, problem });
        call.result = errorResult(call, platformError('response_changed', { tool: call.name }));
        continue;
      }
      learnIds(ctx, call.name, result.output);
      call.result = { type: 'tool-result', id: call.modelId, name: call.name, output: result.output, isError: false };
    }
    // 4. One tool message with every call of the step, including those the brain answered itself, in model order.
    history.push({ role: 'tool', content: waiting.step.calls.map((call) => call.result!) });
    // 5. Back to running: the next model call starts when the caller reads the stream.
    this.awaitingClientCalls = null;
    this.state = 'running';
    this.log('results', { calls: ids.length, failed: resultsMessage.results.filter((result) => !result.ok).length });
    return this.stream(signal);
  }

  private log(kind: string, detail: unknown): void {
    this.session.log(this.traceId, kind, detail);
  }

  /** What the server checks need: the site, its policy, this session's known IDs, the time, and the page. */
  private checks(): ServerContext {
    const { site } = this.services;
    return { bundle: site.bundle, policy: site.policy, ids: this.session.ids, now: this.services.now(), page: this.page };
  }

  /** Gives every awaited call that has no result yet an error result, so the history stays valid. */
  private closeAwaitedClientCalls(details: string): void {
    const waiting = this.awaitingClientCalls;
    if (!waiting) return;
    for (const call of waiting.step.calls) call.result ??= errorResult(call, platformError('no_result', { tool: call.name, details }));
    this.session.history.push({ role: 'tool', content: waiting.step.calls.map((call) => call.result!) });
    this.awaitingClientCalls = null;
  }

  /** The client stopped sending results: the waiting calls get error results and the turn ends. */
  private expire(): void {
    if (this.session.turn !== this || this.state !== 'awaiting_client_calls') return;
    this.closeAwaitedClientCalls("the user's device didn't send it in time");
    this.end('results timed out');
  }

  // ------------------------------------------------------------------ steps

  /**
   * The agent loop for one turn: model call after model call, until the turn waits for the client, answers or stops.
   * Each pass of the loop is one step:
   *   1. Stop early if the turn was replaced, the client went away, the turn ran too long, or a quota is used up.
   *   2. Prepare the request: hand over queued amendments.
   *   3. Call the model. Each tool call is decided the moment it's complete; calls for the client are sent at once.
   *   4. If the call failed, end the turn with a plain message.
   *   5. Record the step: usage and cache figures in the log, and what the model wrote and called in the history.
   *   6. Then one of three endings for the step:
   *      a. it called site tools: send progress and await_results, and stop until the client's results arrive;
   *      b. it presented (or wrote only text, or it's the last step): check the cards, and either send the answer,
   *         or go round again when a card was refused or came without words; on the last step, anything short of a
   *         finished answer ends the turn with an error instead of a partial answer;
   *      c. it only made calls the brain answered itself (skills, refused calls): go round again with their results.
   * Each `yield` hands one event to the HTTP layer and pauses here until it asks for the next. The stream ends when
   * the turn answers, fails, or starts waiting for the client; takeResults starts a new stream for the next steps.
   */
  private async *run(): AsyncGenerator<ServerEvent> {
    const { session } = this;
    const { history, usage: sessionUsage } = session;
    const { site, limits, quotas } = this.services;
    // Ends the turn and builds the error event the client sees.
    const stop = (code: ErrorEvent['code'], message: string, why: string): ServerEvent => {
      this.end(why);
      return { type: 'error', traceId: this.traceId, code, message };
    };
    try {
      for (;;) {
        // 1. Reasons not to make another model call. A replaced turn just stops: the new turn speaks for it.
        if (session.turn !== this) return;
        if (this.signal?.aborted) {
          this.end('the client went away');
          return;
        }
        if (this.services.now() - this.started > limits.turnTimeoutMs) {
          yield stop('timeout', MESSAGES.turnSlow, 'the turn took too long');
          return;
        }
        const refusal = quotas.beforeModelCall(site.id, sessionUsage);
        if (refusal) {
          this.log('quota', refusal);
          yield stop('budget_reached', refusal.message, 'quota');
          return;
        }
        // 2. Prepare the request. Amendments queued so far go in now, next to the latest tool results; ones that arrive
        //    later wait for the next step. The last allowed step runs like any other: the model isn't rushed.
        const isFinalStep = this.steps + 1 >= limits.stepsPerTurn;
        const delivered = this.amendments.splice(0);
        if (delivered.length) {
          history.push({ role: 'user', content: [{ type: 'text', text: amendmentReminder(delivered, this.kept) }] });
          if (this.kept.length) this.keptUnderReview = true;
          this.log('amendments_delivered', { count: delivered.length });
        }
        this.steps++;
        quotas.startModelCall(site.id, sessionUsage);

        // 3. Call the model and stream its step. Text is collected; each tool call is decided as soon as it's complete
        //    (onToolCall), and a call for the client is sent right away, while the model may still be writing.
        const step: ModelStep = { text: '', calls: [] };
        let stepUsage: Usage = NO_USAGE;
        let reason = 'other';
        const started = performance.now();
        try {
          for await (const event of this.callModel()) {
            if (session.turn !== this) return;
            if (event.type === 'text') step.text += event.text;
            else if (event.type === 'tool-call') {
              // Eager dispatch: a call that passed the checks goes to the client now, while the model keeps writing.
              const sent = this.onToolCall(step, event, isFinalStep);
              if (sent) yield sent;
            } else {
              stepUsage = event.usage;
              reason = event.reason;
            }
          }
        } catch (error) {
          // 4. The model call failed: the client went away, it took too long, or the API failed. The step is dropped,
          //    so nothing half-written reaches the history.
          if (session.turn !== this) return;
          if (error instanceof ClientGone) {
            this.end('the client went away');
            return;
          }
          const timedOut = error instanceof ModelTimeout;
          this.log('model_failed', { error: String(error), timedOut });
          yield stop(timedOut ? 'timeout' : 'internal', timedOut ? MESSAGES.modelSlow : MESSAGES.modelFailed, timedOut ? 'the model took too long' : 'the model failed');
          return;
        }
        // 5. Record the step: tokens toward the quotas, and timing and cache figures in the log.
        if (session.turn !== this) return;
        quotas.endModelCall(sessionUsage, stepUsage.inputTokens + stepUsage.outputTokens);
        this.log('model_step', {
          step: this.steps, finish: reason, ms: Math.round(performance.now() - started), calls: step.calls.map((call) => call.name),
          inputTokens: stepUsage.inputTokens, outputTokens: stepUsage.outputTokens, cacheReadTokens: stepUsage.cacheReadTokens, cacheWriteTokens: stepUsage.cacheWriteTokens,
          cacheHitRate: stepUsage.inputTokens ? stepUsage.cacheReadTokens / stepUsage.inputTokens : null,
        });

        // The step is complete. Everything from here to the next yield runs at once, so the history is never half-updated.
        // Save what the model wrote and called, as one assistant message.
        if (step.text || step.calls.length) {
          history.push({
            role: 'assistant',
            content: [...(step.text ? [{ type: 'text' as const, text: step.text }] : []),
              ...step.calls.map((call) => ({ type: 'tool-call' as const, id: call.modelId, name: call.name, input: call.input }))],
          });
        }
        // onToolCall sorted each call as it arrived; the step's ending depends on all of them together.
        const client = step.calls.filter((call) => call.kind === 'client');
        const presents = step.calls.filter((call) => call.kind === 'present');

        // 6a. The step called site tools: wait for the client. Cards in the same step are too early (the results they'd
        //     show aren't back yet). The turn waits with a timer, the client gets a progress line and await_results,
        //     and this stream ends; takeResults picks the turn up again.
        if (client.length) {
          for (const call of presents) call.result = errorResult(call, platformError('present_too_early', { tool: call.name }));
          this.state = 'awaiting_client_calls';
          this.awaitingClientCalls = { step, byCallId: new Map(client.map((call) => [call.callId!, call])) };
          this.timer = unref(setTimeout(() => this.expire(), limits.resultsTimeoutMs));
          const line = progressLine(step.text);
          if (line) yield { type: 'progress', traceId: this.traceId, text: line };
          yield { type: 'await_results', traceId: this.traceId, callIds: client.map((call) => call.callId!) as [string, ...string[]] };
          return;
        }

        // 6b. The step presented, wrote only text, or is the last allowed one: this may be the answer.
        if (presents.length || !step.calls.length || isFinalStep) {
          //   Check every card (known IDs, valid arguments, declared fields).
          const ctx = this.checks();
          const checked = presents.map((call) => ({ call, problem: checkPresentationCall(ctx, call.name, call.input) }));
          const refused = checked.filter((check) => check.problem);
          // On the last allowed step there is no step left to finish with: if the model still needed site tools, or a
          // card was refused, or there's no answer at all, the turn ends with an error rather than a rushed answer.
          const needsMore = step.calls.some((call) => call.kind === 'server' && (call.result?.output as ToolError | undefined)?.reason === 'out_of_steps');
          if (isFinalStep && (needsMore || refused.length || (!presents.length && !step.text.trim() && !this.kept.length))) {
            for (const check of checked) check.call.result = errorResult(check.call, check.problem ?? platformError('not_shown'));
            history.push({ role: 'tool', content: step.calls.map((call) => call.result!) });
            this.log('out_of_steps', { needsMore, refused: refused.length });
            yield stop('budget_reached', MESSAGES.outOfSteps, 'out of steps without an answer');
            return;
          }
          if (refused.length) {
            // The answer goes back to the model to fix; nothing is shown yet.
            for (const check of checked) check.call.result = errorResult(check.call, check.problem ?? platformError('not_shown'));
            this.log('presentation_refused', refused.map((check) => ({ tool: check.call.name, reason: check.problem!.reason })));
            history.push({ role: 'tool', content: step.calls.map((call) => call.result!) });
            continue;
          }
          const accepted = checked.filter((check) => !check.problem).map((check) => ({ name: check.call.name, args: check.call.input }) as unknown as PresentationCall);
          // After an amendment, new presentation calls replace the held cards; with none, the held cards stand.
          if (this.keptUnderReview && accepted.length) {
            this.kept = [];
            this.keptUnderReview = false;
          }
          if (accepted.length && !step.text.trim() && !isFinalStep) {
            // Cards with no words yet: they're kept for the answer, and the model's next step writes the text.
            this.kept.push(...accepted);
            for (const check of checked) check.call.result = { type: 'tool-result', id: check.call.modelId, name: check.call.name, output: KEPT_NOTE, isError: false };
            this.log('presentation_kept', { calls: accepted.length });
            history.push({ role: 'tool', content: step.calls.map((call) => call.result!) });
            continue;
          }
          //   This is the answer. Close every call in the history (shown, or the reason it wasn't).
          for (const check of checked) {
            check.call.result = check.problem ? errorResult(check.call, check.problem) : { type: 'tool-result', id: check.call.modelId, name: check.call.name, output: { shown: true }, isError: false };
          }
          if (step.calls.length) history.push({ role: 'tool', content: step.calls.map((call) => call.result!) });
          // Calls kept from earlier steps first, each distinct call once.
          const seen = new Set<string>();
          const shown = [...this.kept, ...accepted].filter((presentation) => {
            const key = JSON.stringify(presentation);
            return seen.has(key) ? false : (seen.add(key), true);
          });
          //   The answer text: the model's own, or a plain fallback when it wrote nothing and showed nothing.
          const text = step.text.trim() || (shown.length ? '' : MESSAGES.noAnswer);
          //   Amendments that came in during this last model call are answered as the next turn. Required notices are
          //   added, the turn ends, and the answer is sent.
          const followUps = this.amendments.splice(0);
          this.end('answered');
          yield {
            type: 'answer', traceId: this.traceId, text, present: withRequiredNotices(site.bundle.pack, shown),
            ...(followUps.length ? { followUps: followUps as [string, ...string[]] } : {}),
          };
          return;
        }

        // 6c. Only calls the brain answered itself, such as skills and refused calls: their results go straight back,
        //     and the loop makes the next model call without a round trip to the client.
        history.push({ role: 'tool', content: step.calls.map((call) => call.result!) });
      }
    } finally {
      // The caller stopped reading mid-step (the client went away): the step is dropped and the turn ends.
      if (session.turn === this && this.state === 'running') {
        this.modelCall.abort(new Error('the client went away'));
        this.end('the client went away');
      }
    }
  }

  /**
   * One model call, with the step's timeout. It ends early when the turn is superseded or the client goes away.
   * It streams one model response, which is finite: the stream closes after its 'finish' event, and that ends the
   * caller's `for await` in run(). Three things can stop it sooner, all through one AbortController: the timeout,
   * the client hanging up, and a new turn (supersede aborts this.modelCall). Whichever way it ends, `finally` cleans up.
   */
  private async *callModel(): AsyncGenerator<ModelEvent> {
    const { promptPrefix } = this.services.site;
    // The call's single off switch. Kept on the turn so supersede can abort it from outside ('superseded').
    const controller = new AbortController();
    this.modelCall = controller;
    // Client hung up: this.signal is the HTTP request's abort signal.
    const gone = () => controller.abort(new ClientGone('the client went away'));
    if (this.signal?.aborted) gone();
    else this.signal?.addEventListener('abort', gone, { once: true });
    // Too slow: setTimeout only schedules the callback, so timedOut stays false unless the timer fires. No thread
    // watches this function: Node's event loop runs the callback on the same thread when it's due, which can
    // happen while this function is paused at an `await` below. The callback shares timedOut through the closure,
    // so `catch` sees the change. unref: this timer alone doesn't keep the Node process alive (tests, shutdown).
    let timedOut = false;
    const timer = unref(setTimeout(() => {
      timedOut = true;
      controller.abort(new ModelTimeout('the model took too long'));
    }, this.services.limits.modelTimeoutMs));
    // A copy of the history: run() keeps adding to the session's history while this call streams.
    const iterator = this.services.model.stream({
      system: promptPrefix.system, tools: promptPrefix.tools, messages: [...this.session.history], maxOutputTokens: this.services.limits.maxOutputTokens, signal: controller.signal,
    })[Symbol.asyncIterator]();
    let finished = false;
    try {
      // Hand-written for (;;) rather than for await, so each wait can go through untilAborted.
      for (;;) {
        // iterator.next() is a Promise; `await` unwraps it to an IteratorResult, { value, done }. Nobody writes
        // those two fields: the JS engine wraps each `yield x` of the async generator model.stream() as
        // { value: x, done: false }, and its end as { done: true }. untilAborted races the wait against the
        // abort signal, so a timeout or hang-up stops us at once even if the provider's stream is stuck.
        const next = await untilAborted(iterator.next(), controller.signal);
        if (next.done) {
          finished = true;
          return;
        }
        yield next.value;
      }
    } catch (error) {
      // After a timeout the provider may throw a generic abort error; name it, so run() shows the right message.
      throw timedOut ? new ModelTimeout('the model took too long') : error;
    } finally {
      // Runs on every exit, including run() leaving its `for await` early (for await calls our return()).
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', gone);
      // Stopped mid-stream: close the provider's stream so its HTTP connection isn't left open.
      if (!finished) iterator.return?.()?.catch(() => {});
    }
  }

  /**
   * Decides what happens to a tool call the moment the model finishes writing it; returns the event to send, if any.
   * It runs between two tokens of the model's stream, so it's synchronous and quick. Every call is recorded in the
   * step, because the history needs a result for each one. Its `kind` says where it went, and run() reads the kinds
   * once the step is complete to choose the step's ending:
   *   1. Arguments that aren't an object: refused.
   *   2. A presentation call: kept in the step, checked with the others when the step ends ('present').
   *   3. The skill tool: the brain loads the skill and answers it itself.
   *   4. On the last allowed step, any other call is refused: there's no step left to use its result.
   *   5. A site tool or script that passes the checks (known tool, valid and allowed arguments, known IDs) goes to
   *      the client under the brain's own call ID ('client'). Anything that fails is refused.
   * A refused call is answered with an error result here and never reaches the client; the model reads the error at
   * its next step and can correct itself.
   */
  private onToolCall(step: ModelStep, event: Extract<ModelEvent, { type: 'tool-call' }>, isFinalStep: boolean): ToolCallEvent | null {
    const { session } = this;
    const { site } = this.services;
    const call: CallRecord = { modelId: event.id, name: event.name, input: isObject(event.input) ? event.input : {}, kind: 'server' };
    step.calls.push(call);
    const refuse = (error: ToolError) => {
      call.result = errorResult(call, error);
      this.log('call_refused', { tool: event.name, reason: error.reason });
      return null;
    };
    // 1. Malformed arguments.
    if (!isObject(event.input)) return refuse(platformError('bad_arguments', { tool: event.name, details: 'the arguments must be an object' }));
    // 2. Part of the answer: nothing to run now.
    if (isPresentation(event.name)) {
      call.kind = 'present';
      return null;
    }
    // 3. Skills are text the brain already has: no round trip to the client.
    if (event.name === SKILL_TOOL) {
      const loaded = loadSkill(site.bundle, call.input.name, session.skills, site.policy.disabledSkills);
      if (!loaded.ok) return refuse(loaded.error);
      call.result = { type: 'tool-result', id: call.modelId, name: call.name, output: loaded.text, isError: false };
      this.log('skill_loaded', { skill: call.input.name });
      return null;
    }
    // 4. No step left to read a result.
    if (isFinalStep) return refuse(platformError('out_of_steps', { tool: event.name }));
    // 5. The same checks core.js runs, here before anything is sent.
    const problem = checkClientCall(this.checks(), event.name, call.input);
    if (problem) return refuse(problem);
    call.kind = 'client';
    call.callId = session.issueCallId();
    this.log('tool_call', { id: call.callId, tool: event.name });
    return { type: 'tool_call', traceId: this.traceId, call: { id: call.callId, name: event.name, args: call.input } };
  }
}
