// The agent loop. The brain drives each turn and the client runs the tools: a turn is a series of model calls
// (steps), and a step that calls the site's tools ends by waiting for the client's results.
//   POST /v1/turn     the user's message and page context → the first steps' events
//   POST /v1/results  the results the brain awaited → the next steps' events
// Each tool call is sent the moment the model finishes writing it (eager dispatch), under the brain's own call ID
// (call_1, call_2, … per session). Calls the brain can refuse or answer itself (made-up tools, bad arguments, unknown
// IDs, skills) never reach the client. A step whose only calls are presentation calls is the answer: they're checked,
// required notices are added, and the turn ends. If the model sends them with no text, they're kept, and its next
// step writes the words. A message the user sends while the turn runs (an amendment) is queued on the turn and
// handed to the model with the next tool results, as a reminder; one that misses the turn's last model call comes
// back on the answer as a follow-up, which the client sends as the next turn. A new turn instead starts over. The
// step budget, timeouts and quotas end a turn early with a plain message, and the session's history stays valid for
// the next turn.
import type {
  ClientAmend, ClientResults, ClientTurn, ErrorEvent, PageContext, PresentationCall, RemoteConfig, ServerEvent, ToolCallEvent, ToolError,
} from '../../../contract/generated/types.ts';
import { withRequiredNotices } from '../../../core/src/boundary/checks.ts';
import { platformError } from '../../../core/src/boundary/errors.ts';
import { IdSet } from '../../../core/src/boundary/ids.ts';
import { effectivePolicy, type Policy } from '../../../core/src/boundary/limits.ts';
import { describeProblems, validatorFor } from '../../../core/src/shared/validate.ts';
import { checkClientCall, checkPresentationCall, isPresentation, learnIds, outputProblem, type ServerContext } from '../system/checks.ts';
import { NO_USAGE, type ChatMessage, type ModelAdapter, type ModelEvent, type ToolResultPart, type Usage } from '../model/model.ts';
import { contextBlock, globalSegment, SKILL_TOOL, type GlobalSegment } from '../prompt/prompt.ts';
import { DEFAULT_QUOTAS, Quotas, type QuotaLimits, type SessionUsage } from '../system/quotas.ts';
import type { SiteBundle } from '../prompt/site.ts';
import { loadSkill, skillsForPage } from '../prompt/skills.ts';

export interface BrainLimits {
  /** Model calls in one turn. The last one is told to answer with what it has. */
  stepsPerTurn: number;
  maxOutputTokens: number;
  /** One model call, from the request to its last event. */
  modelTimeoutMs: number;
  /** How long the brain waits for the client's results. Scripts can take minutes, so it's long. */
  resultsTimeoutMs: number;
  /** A whole turn, every step and wait included. */
  turnTimeoutMs: number;
  /** A session idle this long is forgotten. */
  sessionIdleMs: number;
  maxSessions: number;
}

export const DEFAULT_LIMITS: BrainLimits = {
  stepsPerTurn: 10,
  maxOutputTokens: 4096,
  modelTimeoutMs: 90_000,
  resultsTimeoutMs: 240_000,
  turnTimeoutMs: 600_000,
  sessionIdleMs: 30 * 60_000,
  maxSessions: 10_000,
};

export interface BrainLogEntry {
  sessionId?: string;
  traceId?: string;
  kind: string;
  detail: unknown;
}

export interface BrainOptions {
  sites: SiteBundle[];
  model: ModelAdapter;
  limits?: Partial<BrainLimits> | undefined;
  quotas?: Partial<QuotaLimits> | undefined;
  /** Remote config per site: switched-off tools and skills. */
  configs?: RemoteConfig[] | undefined;
  now?: (() => number) | undefined;
  log?: ((entry: BrainLogEntry) => void) | undefined;
}

/** What the brain does with a message: stream events back, or refuse it as the HTTP layer should (400, 409). */
export type Accepted = { ok: true; events: AsyncIterable<ServerEvent> } | { ok: false; status: number; error: string };

// What the user sees when a turn ends early. Plain, with no internals.
const MESSAGES = {
  expired: 'This request expired. Ask again.',
  mismatch: 'Something went wrong. Try again.',
  modelFailed: "The assistant couldn't answer just now. Try again.",
  modelSlow: 'The assistant took too long to answer. Try again.',
  turnSlow: 'This took too long. Try a narrower question.',
  noAnswer: "I couldn't put together an answer. Try asking another way.",
  outOfSteps: "I couldn't finish this within the steps I can take for one request, so I'm not showing a partial answer. Try asking for less at once.",
} as const;

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

/** A site as this brain serves it: the site pack's ID, its bundle, its cached prompt segment, and its policy. */
interface ServedSite {
  id: string;
  bundle: SiteBundle;
  global: GlobalSegment;
  policy: Policy;
}

/** One tool call the model made, and what became of it. */
interface CallRecord {
  modelId: string;
  name: string;
  input: Record<string, unknown>;
  /** client: sent to the client to run. present: part of the answer. server: answered by the brain. */
  kind: 'client' | 'present' | 'server';
  callId?: string;
  result?: ToolResultPart;
}

interface Step {
  text: string;
  calls: CallRecord[];
}

interface Turn {
  traceId: string;
  page: PageContext;
  started: number;
  steps: number;
  state: 'running' | 'awaiting' | 'done';
  modelCall: AbortController;
  awaiting: { step: Step; byCallId: Map<string, CallRecord> } | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Presentation calls accepted in an earlier step of this turn, shown with the answer. */
  kept: PresentationCall[];
  /** Whether the held cards were put to the model with an amendment: presentation calls it sends next replace them. */
  keptUnderReview: boolean;
  /** Amendments queued for the model's next step, in the order the user sent them. */
  amendments: string[];
  /** Aborts when the client of the request being served goes away. */
  signal: AbortSignal | undefined;
}

interface BrainSession {
  id: string;
  site: ServedSite;
  history: ChatMessage[];
  ids: IdSet;
  nextCall: number;
  skills: Set<string>;
  usage: SessionUsage;
  turn: Turn | null;
  lastSeen: number;
}

class ModelTimeout extends Error {}
/** Why a step stops when the client that asked for it has gone away. */
class ClientGone extends Error {}

/** A timer that doesn't keep the process alive by itself. */
function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The model's text before its tool calls, as a progress line: whitespace collapsed, at most 200 characters. */
export function progressLine(text: string): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  const chars = Array.from(collapsed);
  if (chars.length <= 200) return collapsed;
  const sentence = /^.{1,199}?[.!?…](?=\s|$)/u.exec(collapsed)?.[0];
  return sentence ?? chars.slice(0, 199).join('') + '…';
}

async function* once(event: ServerEvent): AsyncGenerator<ServerEvent> {
  yield event;
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

export class Brain {
  readonly limits: BrainLimits;
  private sites = new Map<string, ServedSite>();
  private sessions = new Map<string, BrainSession>();
  private model: ModelAdapter;
  private quotas: Quotas;
  private now: () => number;
  private logger: ((entry: BrainLogEntry) => void) | undefined;
  private validateMessage: ReturnType<typeof validatorFor>;

  constructor(options: BrainOptions) {
    if (!options.sites.length) throw new Error('the brain needs at least one site');
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.model = options.model;
    this.now = options.now ?? Date.now;
    this.logger = options.log;
    this.quotas = new Quotas({ ...DEFAULT_QUOTAS, ...options.quotas }, this.now);
    for (const bundle of options.sites) {
      const id = bundle.pack.site.id;
      const config = options.configs?.find((remoteConfig) => remoteConfig.site === id) ?? null;
      this.sites.set(id, { id, bundle, global: globalSegment(bundle), policy: effectivePolicy(bundle.pack, config).policy });
    }
    this.validateMessage = validatorFor(options.sites[0]!.validators.platform, 'messages.json');
  }

  /** The global segment for a site: the same object for every session, so every request shares its bytes. */
  globalFor(site: string): GlobalSegment | undefined {
    return this.sites.get(site)?.global;
  }

  /** How many sessions the brain is holding. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** A copy of a session's history as the model sees it, for tests and debugging. */
  historyOf(sessionId: string): ChatMessage[] | undefined {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session.history) : undefined;
  }

  private log(session: { id: string } | null, traceId: string | undefined, kind: string, detail: unknown): void {
    this.logger?.({ ...(session ? { sessionId: session.id } : {}), ...(traceId ? { traceId } : {}), kind, detail });
  }

  /**
   * Takes a message from the client. Messages that break the protocol are refused (400); anything else streams
   * events. `endpoint` is the path it arrived on, when there is one, and must match the message's type. `signal`
   * aborts when the client goes away: a step still running is stopped, and the turn ends.
   */
  accept(message: unknown, options: { endpoint?: 'turn' | 'results' | 'amend'; signal?: AbortSignal } = {}): Accepted {
    const type = isObject(message) ? message.type : undefined;
    if (type !== 'turn' && type !== 'results' && type !== 'amend') return { ok: false, status: 400, error: 'expected a turn, results or amend message' };
    if (options.endpoint && options.endpoint !== type) return { ok: false, status: 400, error: `a ${type} message goes to /v1/${type}` };
    if (!this.validateMessage(message)) return { ok: false, status: 400, error: `the message breaks the protocol: ${describeProblems(this.validateMessage)}` };
    if (type === 'amend') return this.amend(message as ClientAmend);
    return type === 'turn' ? this.startTurn(message as ClientTurn, options.signal) : this.takeResults(message as ClientResults, options.signal);
  }

  /** Queues an amendment on the turn it names, while that turn is still running or waiting for results. */
  private amend(amendMessage: ClientAmend): Accepted {
    const session = this.sessions.get(amendMessage.sessionId);
    const turn = session?.turn;
    const reply = (status: 'queued' | 'too_late'): Accepted => ({ ok: true, events: once({ type: 'amended', traceId: amendMessage.traceId, status }) });
    if (!session || !turn || turn.traceId !== amendMessage.traceId || turn.state === 'done') return reply('too_late');
    turn.amendments.push(amendMessage.message);
    this.touch(session);
    this.log(session, turn.traceId, 'amendment_queued', { message: amendMessage.message.length, queued: turn.amendments.length });
    return reply('queued');
  }

  /** Streams a turn's next steps; a model call stops if the client of this request goes away. */
  private stream(session: BrainSession, turn: Turn, signal: AbortSignal | undefined): Accepted {
    turn.signal = signal;
    return { ok: true, events: this.run(session, turn) };
  }

  // ------------------------------------------------------------------ sessions

  private touch(session: BrainSession): void {
    session.lastSeen = this.now();
    // for LRU eviction use
    this.sessions.delete(session.id);
    this.sessions.set(session.id, session);
  }

  /** Forgets idle sessions, oldest first (the map is kept in order of last use), and the oldest beyond the cap. */
  private evict(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      const idle = now - session.lastSeen > this.limits.sessionIdleMs;
      if (!idle && this.sessions.size < this.limits.maxSessions) break;
      if (session.turn) this.endTurn(session, session.turn, 'session forgotten');
      this.sessions.delete(session.id);
      this.log(session, undefined, 'session_forgotten', { idle });
    }
  }

  private endTurn(session: BrainSession, turn: Turn, why: string): void {
    if (turn.state === 'done') return;
    turn.state = 'done';
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = null;
    if (session.turn === turn) session.turn = null;
    this.log(session, turn.traceId, 'turn_end', { why, steps: turn.steps });
  }

  /** Gives every awaited call that has no result yet an error result, so the history stays valid. */
  private closeAwaited(session: BrainSession, turn: Turn, details: string): void {
    const waiting = turn.awaiting;
    if (!waiting) return;
    for (const call of waiting.step.calls) call.result ??= this.errorResult(call, platformError('no_result', { tool: call.name, details }));
    session.history.push({ role: 'tool', content: waiting.step.calls.map((call) => call.result!) });
    turn.awaiting = null;
  }

  private checks(session: BrainSession, turn: Turn): ServerContext {
    return { bundle: session.site.bundle, policy: session.site.policy, ids: session.ids, now: this.now(), page: turn.page };
  }

  // ------------------------------------------------------------------ turns

  private startTurn(turnMessage: ClientTurn, signal: AbortSignal | undefined): Accepted {
    const siteState = this.sites.get(turnMessage.site);
    if (!siteState) return { ok: false, status: 400, error: `this brain doesn't serve ${turnMessage.site}` };
    this.evict();
    let session = this.sessions.get(turnMessage.sessionId);
    if (session && session.site !== siteState) return { ok: false, status: 400, error: 'this session belongs to another site' };
    if (!session) {
      session = {
        id: turnMessage.sessionId, site: siteState, history: [], ids: new IdSet(siteState.bundle.pack.entities), nextCall: 0,
        skills: new Set(), usage: { turns: 0, modelCalls: 0, tokens: 0 }, turn: null, lastSeen: this.now(),
      };
      this.log(session, turnMessage.traceId, 'session_start', { site: turnMessage.site });
    }
    this.touch(session);
    if (session.turn) {
      const old = session.turn;
      if (old.state === 'awaiting') this.closeAwaited(session, old, 'the user sent a new message first');
      old.modelCall.abort(new Error('superseded'));
      this.endTurn(session, old, 'superseded by a new message');
    }
    const refusal = this.quotas.beforeTurn(turnMessage.site, session.usage);
    if (refusal) {
      this.log(session, turnMessage.traceId, 'quota', refusal);
      return { ok: true, events: once({ type: 'error', traceId: turnMessage.traceId, code: 'budget_reached', message: refusal.message }) };
    }
    session.usage.turns++;
    const now = this.now();
    const page = turnMessage.pageContext;
    if (page.entity) session.ids.learn(page.entity.kind, page.entity.id, { now });
    session.history.push({ role: 'user', content: [{ type: 'text', text: turnMessage.message }, { type: 'text', text: contextBlock(page, now) }] });
    const turn: Turn = {
      traceId: turnMessage.traceId, page, started: now, steps: 0, state: 'running', modelCall: new AbortController(), awaiting: null, timer: null, kept: [], keptUnderReview: false, amendments: [], signal: undefined,
    };
    session.turn = turn;
    this.log(session, turn.traceId, 'turn', { message: turnMessage.message.length, pageType: page.pageType });
    // Context up front: a skill for this kind of page loads before the first model call, as if the model had asked.
    for (const name of skillsForPage(session.site.bundle, page.pageType, session.skills, session.site.policy.disabledSkills)) {
      const loaded = loadSkill(session.site.bundle, name, session.skills, session.site.policy.disabledSkills);
      if (!loaded.ok) continue;
      const id = `preload_${name}`;
      session.history.push({ role: 'assistant', content: [{ type: 'tool-call', id, name: SKILL_TOOL, input: { name } }] });
      session.history.push({ role: 'tool', content: [{ type: 'tool-result', id, name: SKILL_TOOL, output: loaded.text, isError: false }] });
      this.log(session, turn.traceId, 'skill_preloaded', { skill: name });
    }
    return this.stream(session, turn, signal);
  }

  /**
   * POST /v1/results: the client sends back the results of the calls the brain is waiting for, and the turn goes on.
   *   1. Find the turn: it must exist and match the trace; one that's already running gets 409.
   *   2. Check the results answer exactly the awaited calls, each once; anything else ends the turn.
   *   3. Stop the wait timer.
   *   4. Turn each result into what the model sees: errors as they are, outputs checked against the tool's format,
   *      and the IDs in good outputs learned.
   *   5. Add the step's results to the history, in the order the model made the calls.
   *   6. Mark the turn running again and stream its next steps (run).
   */
  private takeResults(resultsMessage: ClientResults, signal: AbortSignal | undefined): Accepted {
    // 1. Find the turn these results are for.
    const session = this.sessions.get(resultsMessage.sessionId);
    const turn = session?.turn;
    const fail = (code: ErrorEvent['code'], message: string): Accepted => ({ ok: true, events: once({ type: 'error', traceId: resultsMessage.traceId, code, message }) });
    if (!session || !turn || turn.traceId !== resultsMessage.traceId) return fail('timeout', MESSAGES.expired);
    if (turn.state === 'running') return { ok: false, status: 409, error: 'this turn is already running' };
    const waiting = turn.awaiting!;
    this.touch(session);
    // 2. Results only for the calls the brain issued and is waiting for: each one exactly once.
    const ids = resultsMessage.results.map((result) => result.id);
    const exact = ids.length === waiting.byCallId.size && new Set(ids).size === ids.length && ids.every((id) => waiting.byCallId.has(id));
    if (!exact) {
      this.log(session, turn.traceId, 'results_refused', { got: ids, awaited: [...waiting.byCallId.keys()] });
      this.closeAwaited(session, turn, 'the client sent results that did not match');
      this.endTurn(session, turn, 'results did not match');
      return fail('internal', MESSAGES.mismatch);
    }
    // 3. The results came in time: stop the wait timer.
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = null;
    // 4. Each result as the model will see it. A tool error passes through; an output in the wrong format becomes an
    //    error; a good output teaches the brain its IDs, so later presentation calls can use them.
    const ctx = this.checks(session, turn);
    for (const result of resultsMessage.results) {
      const call = waiting.byCallId.get(result.id)!;
      if (!result.ok) {
        call.result = this.errorResult(call, result.error);
        continue;
      }
      const problem = outputProblem(session.site.bundle, call.name, result.output);
      if (problem) {
        this.log(session, turn.traceId, 'result_refused', { call: result.id, tool: call.name, problem });
        call.result = this.errorResult(call, platformError('response_changed', { tool: call.name }));
        continue;
      }
      learnIds(ctx, call.name, result.output);
      call.result = { type: 'tool-result', id: call.modelId, name: call.name, output: result.output, isError: false };
    }
    // 5. One tool message with every call of the step, including those the brain answered itself, in model order.
    session.history.push({ role: 'tool', content: waiting.step.calls.map((call) => call.result!) });
    // 6. Back to running: the next model call starts when the caller reads the stream.
    turn.awaiting = null;
    turn.state = 'running';
    this.log(session, turn.traceId, 'results', { calls: ids.length, failed: resultsMessage.results.filter((result) => !result.ok).length });
    return this.stream(session, turn, signal);
  }

  /** The client stopped sending results: the waiting calls get error results and the turn ends. */
  private expire(session: BrainSession, turn: Turn): void {
    if (session.turn !== turn || turn.state !== 'awaiting') return;
    this.closeAwaited(session, turn, "the user's device didn't send it in time");
    this.endTurn(session, turn, 'results timed out');
  }

  private errorResult(call: CallRecord, error: ToolError): ToolResultPart {
    return { type: 'tool-result', id: call.modelId, name: call.name, output: error, isError: true };
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
   */
  private async *run(session: BrainSession, turn: Turn): AsyncGenerator<ServerEvent> {
    const site_bundle = session.site.bundle;
    const stop = (code: ErrorEvent['code'], message: string, why: string): ServerEvent => {
      this.endTurn(session, turn, why);
      return { type: 'error', traceId: turn.traceId, code, message };
    };
    try {
      for (;;) {
        // 1. Reasons not to make another model call.
        if (session.turn !== turn) return;
        if (turn.signal?.aborted) {
          this.endTurn(session, turn, 'the client went away');
          return;
        }
        if (this.now() - turn.started > this.limits.turnTimeoutMs) {
          yield stop('timeout', MESSAGES.turnSlow, 'the turn took too long');
          return;
        }
        const refusal = this.quotas.beforeModelCall(session.site.id, session.usage);
        if (refusal) {
          this.log(session, turn.traceId, 'quota', refusal);
          yield stop('budget_reached', refusal.message, 'quota');
          return;
        }
        // 2. Prepare the request. Amendments queued so far go in now, next to the latest tool results; ones that arrive
        //    later wait for the next step. The last allowed step runs like any other: the model isn't rushed.
        const final = turn.steps + 1 >= this.limits.stepsPerTurn;
        const delivered = turn.amendments.splice(0);
        if (delivered.length) {
          session.history.push({ role: 'user', content: [{ type: 'text', text: amendmentReminder(delivered, turn.kept) }] });
          if (turn.kept.length) turn.keptUnderReview = true;
          this.log(session, turn.traceId, 'amendments_delivered', { count: delivered.length });
        }
        turn.steps++;
        this.quotas.startModelCall(session.site.id, session.usage);

        // 3. Call the model and stream its step. Text is collected; each tool call is decided as soon as it's complete
        //    (onToolCall), and a call for the client is sent right away, while the model may still be writing.
        const step: Step = { text: '', calls: [] };
        let usage: Usage = NO_USAGE;
        let reason = 'other';
        const started = performance.now();
        try {
          for await (const ev of this.callModel(session, turn)) {
            if (session.turn !== turn) return;
            if (ev.type === 'text') step.text += ev.text;
            else if (ev.type === 'tool-call') {
              const sent = this.onToolCall(session, turn, step, ev, final);
              if (sent) yield sent;
            } else {
              usage = ev.usage;
              reason = ev.reason;
            }
          }
        } catch (error) {
          // 4. The model call failed: the client went away, it took too long, or the API failed. The step is dropped.
          if (session.turn !== turn) return;
          if (error instanceof ClientGone) {
            this.endTurn(session, turn, 'the client went away');
            return;
          }
          const timedOut = error instanceof ModelTimeout;
          this.log(session, turn.traceId, 'model_failed', { error: String(error), timedOut });
          yield stop(timedOut ? 'timeout' : 'internal', timedOut ? MESSAGES.modelSlow : MESSAGES.modelFailed, timedOut ? 'the model took too long' : 'the model failed');
          return;
        }
        // 5. Record the step: tokens toward the quotas, and timing and cache figures in the log.
        if (session.turn !== turn) return;
        this.quotas.endModelCall(session.usage, usage.inputTokens + usage.outputTokens);
        this.log(session, turn.traceId, 'model_step', {
          step: turn.steps, finish: reason, ms: Math.round(performance.now() - started), calls: step.calls.map((call) => call.name),
          inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
          cacheHitRate: usage.inputTokens ? usage.cacheReadTokens / usage.inputTokens : null,
        });

        // The step is complete. Everything from here to the next yield runs at once, so the history is never half-updated.
        // Save what the model wrote and called, as one assistant message.
        if (step.text || step.calls.length) {
          session.history.push({
            role: 'assistant',
            content: [...(step.text ? [{ type: 'text' as const, text: step.text }] : []),
              ...step.calls.map((call) => ({ type: 'tool-call' as const, id: call.modelId, name: call.name, input: call.input }))],
          });
        }
        const client = step.calls.filter((call) => call.kind === 'client');
        const presents = step.calls.filter((call) => call.kind === 'present');

        // 6a. The step called site tools: wait for the client. Cards in the same step are too early (the results they'd
        //     show aren't back yet). The turn waits with a timer, the client gets a progress line and await_results,
        //     and this stream ends; takeResults picks the turn up again.
        if (client.length) {
          for (const call of presents) call.result = this.errorResult(call, platformError('present_too_early', { tool: call.name }));
          turn.state = 'awaiting';
          turn.awaiting = { step, byCallId: new Map(client.map((call) => [call.callId!, call])) };
          turn.timer = unref(setTimeout(() => this.expire(session, turn), this.limits.resultsTimeoutMs));
          const line = progressLine(step.text);
          if (line) yield { type: 'progress', traceId: turn.traceId, text: line };
          yield { type: 'await_results', traceId: turn.traceId, callIds: client.map((call) => call.callId!) as [string, ...string[]] };
          return;
        }

        // 6b. The step presented, wrote only text, or is the last allowed one: this may be the answer.
        if (presents.length || !step.calls.length || final) {
          //   Check every card (known IDs, valid arguments, declared fields).
          const ctx = this.checks(session, turn);
          const checked = presents.map((call) => ({ call, problem: checkPresentationCall(ctx, call.name, call.input) }));
          const refused = checked.filter((check) => check.problem);
          // On the last allowed step there is no step left to finish with: if the model still needed site tools, or a
          // card was refused, or there's no answer at all, the turn ends with an error rather than a rushed answer.
          const needsMore = step.calls.some((call) => call.kind === 'server' && (call.result?.output as ToolError | undefined)?.reason === 'out_of_steps');
          if (final && (needsMore || refused.length || (!presents.length && !step.text.trim() && !turn.kept.length))) {
            for (const check of checked) check.call.result = this.errorResult(check.call, check.problem ?? platformError('not_shown'));
            session.history.push({ role: 'tool', content: step.calls.map((call) => call.result!) });
            this.log(session, turn.traceId, 'out_of_steps', { needsMore, refused: refused.length });
            yield stop('budget_reached', MESSAGES.outOfSteps, 'out of steps without an answer');
            return;
          }
          if (refused.length) {
            // The answer goes back to the model to fix; nothing is shown yet.
            for (const check of checked) check.call.result = this.errorResult(check.call, check.problem ?? platformError('not_shown'));
            this.log(session, turn.traceId, 'presentation_refused', refused.map((check) => ({ tool: check.call.name, reason: check.problem!.reason })));
            session.history.push({ role: 'tool', content: step.calls.map((call) => call.result!) });
            continue;
          }
          const accepted = checked.filter((check) => !check.problem).map((check) => ({ name: check.call.name, args: check.call.input }) as unknown as PresentationCall);
          // After an amendment, new presentation calls replace the held cards; with none, the held cards stand.
          if (turn.keptUnderReview && accepted.length) {
            turn.kept = [];
            turn.keptUnderReview = false;
          }
          if (accepted.length && !step.text.trim() && !final) {
            // Cards with no words yet: they're kept for the answer, and the model's next step writes the text.
            turn.kept.push(...accepted);
            for (const check of checked) check.call.result = { type: 'tool-result', id: check.call.modelId, name: check.call.name, output: KEPT_NOTE, isError: false };
            this.log(session, turn.traceId, 'presentation_kept', { calls: accepted.length });
            session.history.push({ role: 'tool', content: step.calls.map((call) => call.result!) });
            continue;
          }
          //   This is the answer. Close every call in the history (shown, or the reason it wasn't).
          for (const check of checked) {
            check.call.result = check.problem ? this.errorResult(check.call, check.problem) : { type: 'tool-result', id: check.call.modelId, name: check.call.name, output: { shown: true }, isError: false };
          }
          if (step.calls.length) session.history.push({ role: 'tool', content: step.calls.map((call) => call.result!) });
          // Calls kept from earlier steps first, each distinct call once.
          const seen = new Set<string>();
          const shown = [...turn.kept, ...accepted].filter((presentation) => {
            const key = JSON.stringify(presentation);
            return seen.has(key) ? false : (seen.add(key), true);
          });
          //   The answer text: the model's own, or a plain fallback when it wrote nothing and showed nothing.
          const text = step.text.trim() || (shown.length ? '' : MESSAGES.noAnswer);
          //   Amendments that came in during this last model call are answered as the next turn. Required notices are
          //   added, the turn ends, and the answer is sent.
          const followUps = turn.amendments.splice(0);
          this.endTurn(session, turn, 'answered');
          yield {
            type: 'answer', traceId: turn.traceId, text, present: withRequiredNotices(site_bundle.pack, shown),
            ...(followUps.length ? { followUps: followUps as [string, ...string[]] } : {}),
          };
          return;
        }

        // 6c. Only calls the brain answered itself, such as skills and refused calls: their results go straight back,
        //     and the loop makes the next model call without a round trip to the client.
        session.history.push({ role: 'tool', content: step.calls.map((call) => call.result!) });
      }
    } finally {
      // The caller stopped reading mid-step (the client went away): the step is dropped and the turn ends.
      if (session.turn === turn && turn.state === 'running') {
        turn.modelCall.abort(new Error('the client went away'));
        this.endTurn(session, turn, 'the client went away');
      }
    }
  }

  /**
   * One model call, with the step's timeout. It ends early when the turn is superseded or the client goes away.
   * It streams one model response, which is finite: the stream closes after its 'finish' event, and that ends the
   * caller's `for await` in run(). Three things can stop it sooner, all through one AbortController: the timeout,
   * the client hanging up, and a new turn (startTurn aborts turn.modelCall). Whichever way it ends, `finally` cleans up.
   */
  private async *callModel(session: BrainSession, turn: Turn): AsyncGenerator<ModelEvent> {
    const { global } = session.site;
    // The call's single off switch. Kept on the turn so startTurn can abort it from outside ('superseded').
    const controller = new AbortController();
    turn.modelCall = controller;
    // Client hung up: turn.signal is the HTTP request's abort signal.
    const gone = () => controller.abort(new ClientGone('the client went away'));
    if (turn.signal?.aborted) gone();
    else turn.signal?.addEventListener('abort', gone, { once: true });
    // Too slow: setTimeout only schedules the callback, so timedOut stays false unless the timer fires. No thread
    // watches this function: Node's event loop runs the callback on the same thread when it's due, which can
    // happen while this function is paused at an `await` below. The callback shares timedOut through the closure,
    // so `catch` sees the change. unref: this timer alone doesn't keep the Node process alive (tests, shutdown).
    let timedOut = false;
    const timer = unref(setTimeout(() => {
      timedOut = true;
      controller.abort(new ModelTimeout('the model took too long'));
    }, this.limits.modelTimeoutMs));
    // A copy of the history: run() keeps adding to session.history while this call streams.
    const iterator = this.model.stream({
      system: global.system, tools: global.tools, messages: [...session.history], maxOutputTokens: this.limits.maxOutputTokens, signal: controller.signal,
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
      turn.signal?.removeEventListener('abort', gone);
      // Stopped mid-stream: close the provider's stream so its HTTP connection isn't left open.
      if (!finished) iterator.return?.()?.catch(() => {});
    }
  }

  /** Decides what happens to a tool call the moment the model finishes writing it; returns the event to send, if any. */
  private onToolCall(session: BrainSession, turn: Turn, step: Step, ev: Extract<ModelEvent, { type: 'tool-call' }>, final: boolean): ToolCallEvent | null {
    const call: CallRecord = { modelId: ev.id, name: ev.name, input: isObject(ev.input) ? ev.input : {}, kind: 'server' };
    step.calls.push(call);
    const refuse = (error: ToolError) => {
      call.result = this.errorResult(call, error);
      this.log(session, turn.traceId, 'call_refused', { tool: ev.name, reason: error.reason });
      return null;
    };
    if (!isObject(ev.input)) return refuse(platformError('bad_arguments', { tool: ev.name, details: 'the arguments must be an object' }));
    if (isPresentation(ev.name)) {
      call.kind = 'present';
      return null;
    }
    if (ev.name === SKILL_TOOL) {
      const loaded = loadSkill(session.site.bundle, call.input.name, session.skills, session.site.policy.disabledSkills);
      if (!loaded.ok) return refuse(loaded.error);
      call.result = { type: 'tool-result', id: call.modelId, name: call.name, output: loaded.text, isError: false };
      this.log(session, turn.traceId, 'skill_loaded', { skill: call.input.name });
      return null;
    }
    if (final) return refuse(platformError('out_of_steps', { tool: ev.name }));
    const problem = checkClientCall(this.checks(session, turn), ev.name, call.input);
    if (problem) return refuse(problem);
    call.kind = 'client';
    call.callId = `call_${++session.nextCall}`;
    this.log(session, turn.traceId, 'tool_call', { id: call.callId, tool: ev.name });
    return { type: 'tool_call', traceId: turn.traceId, call: { id: call.callId, name: ev.name, args: call.input } };
  }
}
