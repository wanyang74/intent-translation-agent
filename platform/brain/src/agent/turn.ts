// One turn: from a user message to an answer, an error, or a wait for the client. The brain drives the turn and the
// client runs the tools: a turn is a series of model calls (ModelSteps), and a step that calls the site's tools ends
// by waiting for the client's results.
// A call for the client is checked and sent the moment the model finishes writing it (eager dispatch), under the
// brain's own call ID (call_1, call_2, … per session); calls that fail the checks (made-up tools, bad arguments,
// unknown IDs) are refused and never reach the client. Presentation and skill calls wait for the step's end, where
// they're handled together. A step whose only calls are presentation calls is the answer: they're checked,
// required notices are added, and the turn ends. If the model sends them with no text, they're kept, and its next
// step writes the words. A message the user sends while the turn runs (an amendment) is queued on the turn and
// handed to the model with the next tool results, as a reminder; one that misses the turn's last model call comes
// back on the answer as a follow-up, which the client sends as the next turn. A new turn instead starts over. The
// step budget, timeouts and quotas end a turn early with a plain message, and the session's history stays valid for
// the next turn.
import type {
  AnswerEvent, AwaitResultsEvent, ClientResults, ErrorEvent, PageContext, PresentationCall, ProgressEvent, ServerEvent, ToolCallEvent, ToolError,
} from '../../../contract/generated/types.ts';
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
  /** The model's arguments; {} when they weren't an object. */
  input: Record<string, unknown>;
  /** Whether the model's arguments were an object; a call whose arguments weren't is refused. */
  argumentsOk: boolean;
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

/**
 * How a step ends: the events to send, in order, and whether the loop makes another model call or the stream ends.
 * Every allowed ending is listed here, and the constructor is private, so a step can only end in one of these ways:
 * StepEndingResult.nextStep, .stopped, .failed(…), .awaitingResults(…) or .answered(…).
 */
class StepEndingResult {
  /** Go round again: the next model call, with no request in between. */
  static readonly nextStep = new StepEndingResult('next_step', [], 'continue');
  /** The turn is over and the client hears nothing: a new message replaced it, or its client went away. */
  static readonly stopped = new StepEndingResult('stopped', [], 'return');

  /** The turn ended with an error the client sees. */
  static failed(error: ErrorEvent): StepEndingResult {
    return new StepEndingResult('failed', [error], 'return');
  }

  /** The client must run tools: a progress line if the model wrote one, then await_results. The stream ends, and takeResults resumes the turn. */
  static awaitingResults(progress: ProgressEvent | null, awaitResults: AwaitResultsEvent): StepEndingResult {
    return new StepEndingResult('awaiting_results', progress ? [progress, awaitResults] : [awaitResults], 'return');
  }

  /** The turn answered. */
  static answered(answer: AnswerEvent): StepEndingResult {
    return new StepEndingResult('answered', [answer], 'return');
  }

  /** Which ending this is, for logs and tests. */
  readonly kind: 'next_step' | 'stopped' | 'failed' | 'awaiting_results' | 'answered';
  readonly events: readonly ServerEvent[];
  readonly next: 'continue' | 'return';

  private constructor(kind: StepEndingResult['kind'], events: readonly ServerEvent[], next: 'continue' | 'return') {
    this.kind = kind;
    this.events = events;
    this.next = next;
  }
}

/** What a finished model call leaves besides the step itself: its usage and why it stopped. */
interface StreamedStep {
  usage: Usage;
  reason: string;
}

/** A presentation call, and why it was refused, if it was. */
interface CheckedCard {
  call: CallRecord;
  problem: ToolError | null;
}

/** Whether the client runs this call: anything but a presentation call or the skill tool (made-up tools included, which the checks refuse). */
function isClientCall(name: string): boolean {
  return !isPresentation(name) && name !== SKILL_TOOL;
}

/** A new record for a tool call the model just finished writing; nothing is decided yet. */
function newCallRecord(event: Extract<ModelEvent, { type: 'tool-call' }>): CallRecord {
  const { input } = event;
  const argumentsOk = isObject(input);
  return { modelId: event.id, name: event.name, input: argumentsOk ? input : {}, argumentsOk, kind: 'server' };
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

/**
 * Where a turn is. The only ways between the states, each one method of Turn:
 *   running ──startWaiting──▶ awaiting_client_calls ──resume──▶ running
 *   running or awaiting_client_calls ──end──▶ done
 */
export type TurnState = 'running' | 'awaiting_client_calls' | 'done';

export class Turn {
  readonly session: AgentSession;
  readonly traceId: string;
  readonly page: PageContext;
  private readonly services: BrainServices;
  private readonly started: number;
  /** Model calls made so far, for the step budget. */
  private steps = 0;
  /** running: making model calls. awaiting_client_calls: the client is running tools. done: answered, failed or replaced. */
  private current: TurnState = 'running';
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

  // ------------------------------------------------------------------ lifecycle
  //
  // How a turn stops. Four mechanisms, each for its own case:
  //   - isLive: false once the turn ended or a new message replaced it. Checked after every pause (each await and
  //     yield), because other requests may have run in the meantime; a turn that isn't live touches nothing.
  //   - this.signal: the client of the request being served hung up. Checked before each step, and wired into the
  //     model call so the call stops at once.
  //   - this.modelCall: aborts the model call in flight (a new message, the client hanging up, or the step's timeout).
  //   - run()'s finally: the HTTP layer stopped reading mid-step; the step is dropped and the turn ends.

  /** Where the turn is; it changes only through startWaiting, resume and end. */
  get state(): TurnState {
    return this.current;
  }

  /**
   * Whether the turn still counts: not ended, and so not replaced (a new message ends the turn it replaces, and only
   * end() makes a turn done).
   */
  get isLive(): boolean {
    return this.current !== 'done';
  }

  /** running → awaiting_client_calls: the step's client calls are out; their results must come in time. */
  private startWaiting(step: ModelStep, clientToolCalls: CallRecord[]): void {
    if (this.current !== 'running') throw new Error(`startWaiting from ${this.current}`);
    this.current = 'awaiting_client_calls';
    this.awaitingClientCalls = { step, byCallId: new Map(clientToolCalls.map((clientToolCall) => [clientToolCall.callId!, clientToolCall])) };
    this.timer = unref(setTimeout(() => this.expire(), this.services.limits.resultsTimeoutMs));
  }

  /** awaiting_client_calls → running: the results came in time and are in the history. */
  private resume(): void {
    if (this.current !== 'awaiting_client_calls') throw new Error(`resume from ${this.current}`);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.awaitingClientCalls = null;
    this.current = 'running';
  }

  /**
   * Any state → done, once: stops the wait timer and frees the session for the next turn. If the client's calls are
   * still out, each one gets an error result first, saying why (`unanswered`), so the history stays valid.
   */
  end(why: string, unanswered = why): void {
    if (this.current === 'done') return;
    this.closeAwaitedClientCalls(unanswered);
    this.current = 'done';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.session.turn === this) this.session.turn = null;
    this.log('turn_end', { why, steps: this.steps });
  }

  /** A new message replaced this turn: stop the model call and end it; calls it was waiting on get error results. */
  supersede(): void {
    this.modelCall.abort(new Error('superseded'));
    this.end('superseded by a new message', 'the user sent a new message first');
  }

  /** The client didn't send results in time: the waiting calls get error results and the turn ends. */
  private expire(): void {
    if (this.current !== 'awaiting_client_calls') return;
    this.end('results timed out', "the user's device didn't send it in time");
  }

  /** Gives every awaited call that has no result yet an error result, so the history stays valid. Only end() calls it. */
  private closeAwaitedClientCalls(details: string): void {
    const waiting = this.awaitingClientCalls;
    if (!waiting) return;
    for (const call of waiting.step.calls) call.result ??= errorResult(call, platformError('no_result', { tool: call.name, details }));
    this.pushToolResults(waiting.step);
    this.awaitingClientCalls = null;
  }

  // ------------------------------------------------------------------ requests

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

  /**
   * POST /v1/results, after the session found this turn waiting:
   *   1. Check the results answer exactly the awaited calls, each once; anything else ends the turn.
   *   2. Turn each result into what the model sees: errors as they are, outputs checked against the tool's format,
   *      and the IDs in good outputs learned.
   *   3. Add the step's results to the history, in the order the model made the calls.
   *   4. Back to running (resume, which stops the wait timer), and stream the next steps (run).
   */
  takeResults(resultsMessage: ClientResults, signal: AbortSignal | undefined): ServerResponse {
    const waiting = this.awaitingClientCalls!;
    // 1. Results only for the calls the brain issued and is waiting for: each one exactly once.
    const ids = resultsMessage.results.map((result) => result.id);
    const exact = ids.length === waiting.byCallId.size && new Set(ids).size === ids.length && ids.every((id) => waiting.byCallId.has(id));
    if (!exact) {
      this.log('results_refused', { got: ids, awaited: [...waiting.byCallId.keys()] });
      this.end('results did not match', 'the client sent results that did not match');
      return { ok: true, events: once({ type: 'error', traceId: this.traceId, code: 'internal', message: MESSAGES.mismatch }) };
    }
    // 2. Each result as the model will see it. A tool error passes through; an output in the wrong format becomes an
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
    // 3. One tool message with every call of the step, including those the brain answered itself, in model order.
    this.pushToolResults(waiting.step);
    // 4. Back to running: the next model call starts when the caller reads the stream.
    this.resume();
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

  // ------------------------------------------------------------------ steps

  /**
   * The agent loop for one turn: model call after model call, until the turn waits for the client, answers or stops.
   * Each pass of the loop is one step:
   *   1. Stop early if the turn was replaced, the client went away, the turn ran too long, or a quota is used up.
   *   2. Prepare the request: hand over queued amendments.
   *   3. Call the model. Each call for the client is checked and sent the moment it's complete; the others wait.
   *   4. If the call failed, end the turn with a plain message.
   *   5. Record the step: usage and cache figures in the log, and what the model wrote and called in the history.
   *   6. Handle the calls that didn't go to the client (skills, presentation calls), then one of three endings:
   *      a. it called site tools: send progress and await_results, and stop until the client's results arrive;
   *      b. it presented (or wrote only text, or it's the last step): check the cards, and either send the answer,
   *         or go round again when a card was refused or came without words; on the last step, anything short of a
   *         finished answer ends the turn with an error instead of a partial answer;
   *      c. it only made calls the brain (aka server) answered itself (skills, refused calls): go round again with their results.
   * The helpers below do each part: stopBeforeStep (1), deliverAmendments (2), streamStep (3, 4), recordStep (5) and
   * endStep (6). Only run() and streamStep yield. The helpers that change the history or the turn's state are plain
   * functions that return the events to send, so each update between two yields still happens all at once.
   * Each `yield` hands one event to the HTTP layer and pauses here until it asks for the next. The stream ends when
   * the turn answers, fails, or starts waiting for the client; takeResults starts a new stream for the next steps.
   */
  private async *run(): AsyncGenerator<ServerEvent> {
    const { session } = this;
    const { site, limits, quotas } = this.services;
    try {
      for (;;) {
        // 1. Reasons not to make another model call.
        const stopped = this.stopBeforeStep();
        if (stopped) {
          for (const event of stopped.events) yield event;
          return;
        }
        // 2. Prepare the request. The last allowed step runs like any other: the model isn't rushed.
        const isFinalStep = this.steps + 1 >= limits.stepsPerTurn;
        this.deliverAmendments();
        this.steps++;
        quotas.startModelCall(site.id, session.usage);

        // 3 and 4. Call the model and stream its step. `yield*` passes every event streamStep yields (tool calls sent
        //    early, or the error that ends the turn) straight to our caller, and evaluates to streamStep's return
        //    value: null when the turn is over.
        const step: ModelStep = { text: '', calls: [] };
        const started = performance.now();
        const streamed = yield* this.streamStep(step, isFinalStep);
        if (!streamed || !this.isLive) return;

        // 5. The step is complete. Everything from here to the next yield runs at once, so the history is never
        //    half-updated.
        this.recordStep(step, streamed, started);

        // 6. Wait for the client, answer, or go round again.
        const ending = this.endStep(step, isFinalStep);
        for (const event of ending.events) yield event;
        if (ending.next === 'return') return;
      }
    } finally {
      // The caller stopped reading mid-step (the client went away): the step is dropped and the turn ends.
      if (this.current === 'running') {
        this.modelCall.abort(new Error('the client went away'));
        this.end('the client went away');
      }
    }
  }

  /**
   * Step 1 of run(): whether the turn stops before another model call, and with what.
   *   1. Replaced by a new turn: stop without a word; the new turn speaks for it.
   *   2. The client went away: end the turn; no one is listening for an event.
   *   3. The turn ran too long: end it with a plain message.
   *   4. A quota is used up: end it with the quota's message.
   */
  private stopBeforeStep(): StepEndingResult | null {
    const { site, limits, quotas } = this.services;
    // 1. Replaced.
    if (!this.isLive) return StepEndingResult.stopped;
    // 2. The client went away.
    if (this.signal?.aborted) {
      this.end('the client went away');
      return StepEndingResult.stopped;
    }
    // 3. Too long.
    if (this.services.now() - this.started > limits.turnTimeoutMs) {
      return StepEndingResult.failed(this.stopWith('timeout', MESSAGES.turnSlow, 'the turn took too long'));
    }
    // 4. Out of quota.
    const refusal = quotas.beforeModelCall(site.id, this.session.usage);
    if (refusal) {
      this.log('quota', refusal);
      return StepEndingResult.failed(this.stopWith('budget_reached', refusal.message, 'quota'));
    }
    return null;
  }

  /**
   * Step 2 of run(): amendments queued so far go to the model now, next to the latest tool results; ones that arrive
   * later wait for the next step. Cards held for the answer are listed in the reminder and put up for review.
   */
  private deliverAmendments(): void {
    const delivered = this.amendments.splice(0);
    if (!delivered.length) return;
    this.session.history.push({ role: 'user', content: [{ type: 'text', text: amendmentReminder(delivered, this.kept) }] });
    if (this.kept.length) this.keptUnderReview = true;
    this.log('amendments_delivered', { count: delivered.length });
  }

  /**
   * Steps 3 and 4 of run(): one model call, streamed into `step`. Returns the call's usage and finish reason, or null
   * when the turn is over.
   *   1. Collect the text and record every tool call. A call for the client is checked as soon as it's complete
   *      (sendClientCall) and yielded right away, while the model may still be writing (eager dispatch). Presentation
   *      and skill calls are only recorded; endStep handles them once the step is complete.
   *   2. If the call failed (the client went away, it took too long, or the API failed), the step is dropped, so
   *      nothing half-written reaches the history, and the turn ends.
   * A replaced turn stops at once, at either point, without a word.
   */
  private async *streamStep(step: ModelStep, isFinalStep: boolean): AsyncGenerator<ServerEvent, StreamedStep | null> {
    let usage: Usage = NO_USAGE;
    let reason = 'other';
    try {
      // 1. Stream the step.
      for await (const event of this.callModel()) {
        if (!this.isLive) return null;
        if (event.type === 'text') step.text += event.text;
        else if (event.type === 'tool-call') {
          // Every call is recorded: the history needs a result for each one.
          const call = newCallRecord(event);
          step.calls.push(call);
          // Eager dispatch: the only reason to act mid-stream is to get a client call out early.
          if (isClientCall(call.name)) {
            const sent = this.sendClientCall(call, isFinalStep);
            if (sent) yield sent;
          }
        } else {
          usage = event.usage;
          reason = event.reason;
        }
      }
    } catch (error) {
      // 2. The call failed: end quietly when the client went away, with a plain message otherwise.
      if (!this.isLive) return null;
      if (error instanceof ClientGone) {
        this.end('the client went away');
        return null;
      }
      const timedOut = error instanceof ModelTimeout;
      this.log('model_failed', { error: String(error), timedOut });
      yield this.stopWith(timedOut ? 'timeout' : 'internal', timedOut ? MESSAGES.modelSlow : MESSAGES.modelFailed, timedOut ? 'the model took too long' : 'the model failed');
      return null;
    }
    return { usage, reason };
  }

  /**
   * A call for the client, the moment the model finishes writing it: checked, then sent or refused. It runs between
   * two tokens of the model's stream, so it's synchronous and quick. Returns the event to send, or null if refused.
   *   1. Arguments that aren't an object: refused.
   *   2. On the last allowed step: refused; there's no step left to use its result.
   *   3. The same checks core.js runs (known tool, valid and allowed arguments, known IDs): refused if any fails.
   *   4. It passed: it goes to the client under the brain's own call ID ('client').
   */
  private sendClientCall(call: CallRecord, isFinalStep: boolean): ToolCallEvent | null {
    // 1. Malformed arguments.
    if (!call.argumentsOk) return this.refuse(call, platformError('bad_arguments', { tool: call.name, details: 'the arguments must be an object' }));
    // 2. No step left to read a result.
    if (isFinalStep) return this.refuse(call, platformError('out_of_steps', { tool: call.name }));
    // 3. The checks, here before anything is sent.
    const problem = checkClientCall(this.checks(), call.name, call.input);
    if (problem) return this.refuse(call, problem);
    // 4. Send it.
    call.kind = 'client';
    call.callId = this.session.issueCallId();
    this.log('tool_call', { id: call.callId, tool: call.name });
    return { type: 'tool_call', traceId: this.traceId, call: { id: call.callId, name: call.name, args: call.input } };
  }

  /**
   * Step 5 of run(): tokens toward the quotas, timing and cache figures in the log, and what the model wrote and
   * called in the history, as one assistant message.
   */
  private recordStep(step: ModelStep, streamed: StreamedStep, started: number): void {
    const { usage: stepUsage, reason } = streamed;
    this.services.quotas.endModelCall(this.session.usage, stepUsage.inputTokens + stepUsage.outputTokens);
    this.log('model_step', {
      step: this.steps, finish: reason, ms: Math.round(performance.now() - started), calls: step.calls.map((call) => call.name),
      inputTokens: stepUsage.inputTokens, outputTokens: stepUsage.outputTokens, cacheReadTokens: stepUsage.cacheReadTokens, cacheWriteTokens: stepUsage.cacheWriteTokens,
      cacheHitRate: stepUsage.inputTokens ? stepUsage.cacheReadTokens / stepUsage.inputTokens : null,
    });
    if (step.text || step.calls.length) {
      this.session.history.push({
        role: 'assistant',
        content: [...(step.text ? [{ type: 'text' as const, text: step.text }] : []),
          ...step.calls.map((call) => ({ type: 'tool-call' as const, id: call.modelId, name: call.name, input: call.input }))],
      });
    }
  }

  /**
   * Step 6 of run(): how the step ends.
   *   1. Handle the calls that didn't go to the client (handleNonClientCalls): skills are loaded, presentation calls
   *      are set aside to be checked with the answer.
   *   2. Choose the ending from all the calls together:
   *      a. it called site tools: wait for the client (awaitClient);
   *      b. it presented, wrote only text, or is the last allowed step: answer, or go round again (answerOrRetry);
   *      c. it only made calls the brain answered itself, such as skills and refused calls: their results go straight
   *         back, and the loop makes the next model call without a round trip to the client.
   */
  private endStep(step: ModelStep, isFinalStep: boolean): StepEndingResult {
    // 1. The calls that didn't go to the client.
    this.handleNonClientCalls(step);
    // 2. The ending.
    const clientToolCalls = step.calls.filter((call) => call.kind === 'client');
    const presentsToolCalls = step.calls.filter((call) => call.kind === 'present');
    //    a. Site tools.
    if (clientToolCalls.length) return this.awaitClient(step, clientToolCalls, presentsToolCalls);
    //    b. Maybe the answer.
    if (presentsToolCalls.length || !step.calls.length || isFinalStep) return this.answerOrRetry(step, presentsToolCalls, isFinalStep);
    //    c. Only calls the brain answered.
    this.pushToolResults(step);
    return StepEndingResult.nextStep;
  }

  /**
   * Step 6.1: the calls the brain handles itself, now that the step is complete. Client calls were settled as they
   * arrived (sendClientCall); these are the rest, in the order the model made them:
   *   1. Arguments that aren't an object: refused.
   *   2. A presentation call: part of the answer ('present'). awaitClient or answerOrRetry checks it next.
   *   3. The skill tool: skills are text the brain already has, so the brain loads one and answers the call itself.
   */
  private handleNonClientCalls(step: ModelStep): void {
    const { session } = this;
    const { site } = this.services;
    for (const call of step.calls.filter((candidate) => !isClientCall(candidate.name))) {
      // 1. Malformed arguments.
      if (!call.argumentsOk) {
        this.refuse(call, platformError('bad_arguments', { tool: call.name, details: 'the arguments must be an object' }));
        continue;
      }
      // 2. Part of the answer.
      if (isPresentation(call.name)) {
        call.kind = 'present';
        continue;
      }
      // 3. A skill.
      const loaded = loadSkill(site.bundle, call.input.name, session.skills, site.policy.disabledSkills);
      if (!loaded.ok) {
        this.refuse(call, loaded.error);
        continue;
      }
      call.result = { type: 'tool-result', id: call.modelId, name: call.name, output: loaded.text, isError: false };
      this.log('skill_loaded', { skill: call.input.name });
    }
  }

  /**
   * Step 6a: the step called site tools, so the turn waits for the client.
   *   1. Cards in the same step are too early: the results they'd show aren't back yet.
   *   2. Wait, with a timer that ends the turn if the results don't come in time.
   *   3. Send a progress line and await_results. The stream then ends; takeResults picks the turn up again.
   */
  private awaitClient(step: ModelStep, clientToolCalls: CallRecord[], presentsToolCalls: CallRecord[]): StepEndingResult {
    // 1. Too early.
    for (const presentsToolCall of presentsToolCalls) presentsToolCall.result = errorResult(presentsToolCall, platformError('present_too_early', { tool: presentsToolCall.name }));
    // 2. Wait.
    this.startWaiting(step, clientToolCalls);
    // 3. Tell the client.
    const line = progressLine(step.text);
    // The stream ends here; takeResults resumes the turn.
    return StepEndingResult.awaitingResults(
      line ? { type: 'progress', traceId: this.traceId, text: line } : null,
      { type: 'await_results', traceId: this.traceId, callIds: clientToolCalls.map((clientToolCall) => clientToolCall.callId!) as [string, ...string[]] },
    );
  }

  /**
   * Step 6b: the step presented, wrote only text, or is the last allowed one, so this may be the answer.
   *   1. Check every card (known IDs, valid arguments, declared fields).
   *   2. On the last allowed step there is no step left to finish with: if the model still needed site tools, or a
   *      card was refused, or there's no answer at all, the turn ends with an error rather than a rushed answer.
   *   3. A card was refused: the answer goes back to the model to fix; nothing is shown yet.
   *   4. After an amendment, new presentation calls replace the held cards; with none, the held cards stand.
   *   5. Cards with no words yet: they're kept for the answer, and the model's next step writes the text.
   *   6. Otherwise this is the answer (sendAnswer).
   */
  private answerOrRetry(step: ModelStep, presentsToolCalls: CallRecord[], isFinalStep: boolean): StepEndingResult {
    // 1. Check the cards.
    const ctx = this.checks();
    const checked = presentsToolCalls.map((call): CheckedCard => ({ call, problem: checkPresentationCall(ctx, call.name, call.input) }));
    const refused = checked.filter((check) => check.problem);
    // 2. Out of steps without an answer.
    const needsMore = step.calls.some((call) => call.kind === 'server' && (call.result?.output as ToolError | undefined)?.reason === 'out_of_steps');
    if (isFinalStep && (needsMore || refused.length || (!presentsToolCalls.length && !step.text.trim() && !this.kept.length))) {
      for (const check of checked) check.call.result = errorResult(check.call, check.problem ?? platformError('not_shown'));
      this.pushToolResults(step);
      this.log('out_of_steps', { needsMore, refused: refused.length });
      return StepEndingResult.failed(this.stopWith('budget_reached', MESSAGES.outOfSteps, 'out of steps without an answer'));
    }
    // 3. Refused cards go back to the model.
    if (refused.length) {
      for (const check of checked) check.call.result = errorResult(check.call, check.problem ?? platformError('not_shown'));
      this.log('presentation_refused', refused.map((check) => ({ tool: check.call.name, reason: check.problem!.reason })));
      this.pushToolResults(step);
      return StepEndingResult.nextStep;
    }
    // 4. New cards replace the ones under review.
    const acceptedPresentCards = checked.filter((check) => !check.problem).map((check) => ({ name: check.call.name, args: check.call.input }) as unknown as PresentationCall);
    if (this.keptUnderReview && acceptedPresentCards.length) {
      this.kept = [];
      this.keptUnderReview = false;
    }
    // 5. Cards without words.
    if (acceptedPresentCards.length && !step.text.trim() && !isFinalStep) {
      this.kept.push(...acceptedPresentCards);
      for (const check of checked) check.call.result = { type: 'tool-result', id: check.call.modelId, name: check.call.name, output: KEPT_NOTE, isError: false };
      this.log('presentation_kept', { calls: acceptedPresentCards.length });
      this.pushToolResults(step);
      return StepEndingResult.nextStep;
    }
    // 6. The answer.
    return this.sendAnswer(step, checked, acceptedPresentCards);
  }

  /**
   * Step 6b's answer:
   *   1. Close every call in the history: shown, or the reason it wasn't.
   *   2. The cards: those kept from earlier steps first, each distinct call once.
   *   3. The text: the model's own, or a plain fallback when it wrote nothing and showed nothing.
   *   4. Amendments that came in during this last model call are answered as the next turn. Required notices are
   *      added, the turn ends, and the answer is sent.
   */
  private sendAnswer(step: ModelStep, checked: CheckedCard[], acceptedPresentCards: PresentationCall[]): StepEndingResult {
    // 1. Close the calls.
    for (const check of checked) {
      check.call.result = check.problem ? errorResult(check.call, check.problem) : { type: 'tool-result', id: check.call.modelId, name: check.call.name, output: { shown: true }, isError: false };
    }
    if (step.calls.length) this.pushToolResults(step);
    // 2. The cards.
    const seen = new Set<string>();
    const shown = [...this.kept, ...acceptedPresentCards].filter((presentation) => {
      const key = JSON.stringify(presentation);
      return seen.has(key) ? false : (seen.add(key), true);
    });
    // 3. The text.
    const text = step.text.trim() || (shown.length ? '' : MESSAGES.noAnswer);
    // 4. Follow-ups, notices, and the end of the turn.
    const followUps = this.amendments.splice(0);
    this.end('answered');
    return StepEndingResult.answered({
      type: 'answer', traceId: this.traceId, text, present: withRequiredNotices(this.services.site.bundle.pack, shown),
      ...(followUps.length ? { followUps: followUps as [string, ...string[]] } : {}),
    });
  }

  /**
   * Answers a call with an error. It never reaches the client; the model reads the error at its next step and can
   * correct itself. Returns null, so sendClientCall can refuse and return in one line.
   */
  private refuse(call: CallRecord, error: ToolError): null {
    call.result = errorResult(call, error);
    this.log('call_refused', { tool: call.name, reason: error.reason });
    return null;
  }

  /** Ends the turn and builds the error event the client sees. */
  private stopWith(code: ErrorEvent['code'], message: string, why: string): ErrorEvent {
    this.end(why);
    return { type: 'error', traceId: this.traceId, code, message };
  }

  /** Adds one tool message to the history: a result for every call of the step, in the order the model made them. */
  private pushToolResults(step: ModelStep): void {
    this.session.history.push({ role: 'tool', content: step.calls.map((call) => call.result!) });
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
}
