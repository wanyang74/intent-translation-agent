// The agent loop. The brain drives each turn and the client runs the tools: a turn is a series of model calls
// (steps), and a step that calls the site's tools ends by waiting for the client's results.
//   POST /v1/turn     the user's message and page context → the first steps' events
//   POST /v1/results  the results the brain awaited → the next steps' events
// Each tool call is sent the moment the model finishes writing it (eager dispatch), under the brain's own call ID
// (call_1, call_2, … per session). Calls the brain can refuse or answer itself (made-up tools, bad arguments, unknown
// IDs, skills) never reach the client. A step whose only calls are presentation calls is the answer: they're checked,
// required notices are added, and the turn ends. If the model sends them with no text, they're kept, and its next
// step writes the words. The step budget, timeouts and quotas end a turn early with a plain message, and the
// session's history stays valid for the next turn.
import type {
  ClientResults, ClientTurn, ErrorEvent, PageContext, PresentationCall, RemoteConfig, ServerEvent, ToolCallEvent, ToolError,
} from '../../contract/generated/types.ts';
import { withRequiredNotices } from '../../core/src/checks.ts';
import { platformError } from '../../core/src/errors.ts';
import { IdSet } from '../../core/src/ids.ts';
import { effectivePolicy, type Policy } from '../../core/src/limits.ts';
import { describeProblems, validatorFor } from '../../core/src/validate.ts';
import { checkClientCall, checkPresentationCall, isPresentation, learnIds, outputProblem, type ServerContext } from './checks.ts';
import { NO_USAGE, type ChatMessage, type ModelAdapter, type ModelEvent, type ToolResultPart, type Usage } from './model.ts';
import { contextBlock, globalSegment, SKILL_TOOL, type GlobalSegment } from './prompt.ts';
import { DEFAULT_QUOTAS, Quotas, type QuotaLimits, type SessionUsage } from './quotas.ts';
import type { SiteBrain } from './site.ts';
import { loadSkill, skillsForPage } from './skills.ts';

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
  sites: SiteBrain[];
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
  outOfSteps: 'I ran out of steps before I could finish. Here is what I found so far; ask me to continue.',
} as const;

const FINAL_STEP_NOTE = "This request is out of steps. Answer now with what you have: a short text and presentation tools only. Other tools won't run.";
/** The result for presentation calls kept while the model writes its answer. */
const KEPT_NOTE = 'Accepted: it will be shown with your answer. Now write the answer text; there is no need to call it again.';

interface SiteState {
  site: SiteBrain;
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
  abort: AbortController;
  awaiting: { step: Step; byCallId: Map<string, CallRecord> } | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Presentation calls accepted in an earlier step of this turn, shown with the answer. */
  kept: PresentationCall[];
  /** Aborts when the client of the request being served goes away. */
  signal: AbortSignal | undefined;
}

interface BrainSession {
  id: string;
  site: SiteState;
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

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The model's text before its tool calls, as a progress line: whitespace collapsed, at most 200 characters. */
export function progressLine(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const chars = Array.from(t);
  if (chars.length <= 200) return t;
  const sentence = /^.{1,199}?[.!?…](?=\s|$)/u.exec(t)?.[0];
  return sentence ?? chars.slice(0, 199).join('') + '…';
}

async function* once(event: ServerEvent): AsyncGenerator<ServerEvent> {
  yield event;
}

/** Resolves like `p`, or rejects as soon as the signal aborts, so a model that ignores the signal still stops. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

export class Brain {
  readonly limits: BrainLimits;
  private sites = new Map<string, SiteState>();
  private sessions = new Map<string, BrainSession>();
  private model: ModelAdapter;
  private quotas: Quotas;
  private now: () => number;
  private logger: ((entry: BrainLogEntry) => void) | undefined;
  private validateMessage: ReturnType<typeof validatorFor>;

  constructor(o: BrainOptions) {
    if (!o.sites.length) throw new Error('the brain needs at least one site');
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.model = o.model;
    this.now = o.now ?? Date.now;
    this.logger = o.log;
    this.quotas = new Quotas({ ...DEFAULT_QUOTAS, ...o.quotas }, this.now);
    for (const site of o.sites) {
      const id = site.pack.site.id;
      const config = o.configs?.find((c) => c.site === id) ?? null;
      this.sites.set(id, { site, global: globalSegment(site), policy: effectivePolicy(site.pack, config).policy });
    }
    this.validateMessage = validatorFor(o.sites[0]!.validators.platform, 'messages.json');
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
    const s = this.sessions.get(sessionId);
    return s ? structuredClone(s.history) : undefined;
  }

  private log(s: { id: string } | null, traceId: string | undefined, kind: string, detail: unknown): void {
    this.logger?.({ ...(s ? { sessionId: s.id } : {}), ...(traceId ? { traceId } : {}), kind, detail });
  }

  /**
   * Takes a message from the client. Messages that break the protocol are refused (400); anything else streams
   * events. `endpoint` is the path it arrived on, when there is one, and must match the message's type. `signal`
   * aborts when the client goes away: a step still running is stopped, and the turn ends.
   */
  accept(message: unknown, options: { endpoint?: 'turn' | 'results'; signal?: AbortSignal } = {}): Accepted {
    const type = isObject(message) ? message.type : undefined;
    if (type !== 'turn' && type !== 'results') return { ok: false, status: 400, error: 'expected a turn or results message' };
    if (options.endpoint && options.endpoint !== type) return { ok: false, status: 400, error: `a ${type} message goes to /v1/${type}` };
    if (!this.validateMessage(message)) return { ok: false, status: 400, error: `the message breaks the protocol: ${describeProblems(this.validateMessage)}` };
    return type === 'turn' ? this.startTurn(message as ClientTurn, options.signal) : this.takeResults(message as ClientResults, options.signal);
  }

  /** Streams a turn's next steps; a model call stops if the client of this request goes away. */
  private stream(s: BrainSession, turn: Turn, signal: AbortSignal | undefined): Accepted {
    turn.signal = signal;
    return { ok: true, events: this.run(s, turn) };
  }

  // ------------------------------------------------------------------ sessions

  private touch(s: BrainSession): void {
    s.lastSeen = this.now();
    this.sessions.delete(s.id);
    this.sessions.set(s.id, s);
  }

  /** Forgets idle sessions, oldest first (the map is kept in order of last use), and the oldest beyond the cap. */
  private evict(): void {
    const now = this.now();
    for (const s of this.sessions.values()) {
      const idle = now - s.lastSeen > this.limits.sessionIdleMs;
      if (!idle && this.sessions.size < this.limits.maxSessions) break;
      if (s.turn) this.endTurn(s, s.turn, 'session forgotten');
      this.sessions.delete(s.id);
      this.log(s, undefined, 'session_forgotten', { idle });
    }
  }

  private endTurn(s: BrainSession, turn: Turn, why: string): void {
    if (turn.state === 'done') return;
    turn.state = 'done';
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = null;
    if (s.turn === turn) s.turn = null;
    this.log(s, turn.traceId, 'turn_end', { why, steps: turn.steps });
  }

  /** Gives every awaited call that has no result yet an error result, so the history stays valid. */
  private closeAwaited(s: BrainSession, turn: Turn, details: string): void {
    const waiting = turn.awaiting;
    if (!waiting) return;
    for (const c of waiting.step.calls) c.result ??= this.errorResult(c, platformError('no_result', { tool: c.name, details }));
    s.history.push({ role: 'tool', content: waiting.step.calls.map((c) => c.result!) });
    turn.awaiting = null;
  }

  private checks(s: BrainSession, turn: Turn): ServerContext {
    return { site: s.site.site, policy: s.site.policy, ids: s.ids, now: this.now(), page: turn.page };
  }

  // ------------------------------------------------------------------ turns

  private startTurn(m: ClientTurn, signal: AbortSignal | undefined): Accepted {
    const siteState = this.sites.get(m.site);
    if (!siteState) return { ok: false, status: 400, error: `this brain doesn't serve ${m.site}` };
    this.evict();
    let s = this.sessions.get(m.sessionId);
    if (s && s.site !== siteState) return { ok: false, status: 400, error: 'this session belongs to another site' };
    if (!s) {
      s = {
        id: m.sessionId, site: siteState, history: [], ids: new IdSet(siteState.site.pack.entities), nextCall: 0,
        skills: new Set(), usage: { turns: 0, modelCalls: 0, tokens: 0 }, turn: null, lastSeen: this.now(),
      };
      this.log(s, m.traceId, 'session_start', { site: m.site });
    }
    this.touch(s);
    if (s.turn) {
      const old = s.turn;
      if (old.state === 'awaiting') this.closeAwaited(s, old, 'the user sent a new message first');
      old.abort.abort(new Error('superseded'));
      this.endTurn(s, old, 'superseded by a new message');
    }
    const refusal = this.quotas.beforeTurn(m.site, s.usage);
    if (refusal) {
      this.log(s, m.traceId, 'quota', refusal);
      return { ok: true, events: once({ type: 'error', traceId: m.traceId, code: 'budget_reached', message: refusal.message }) };
    }
    s.usage.turns++;
    const now = this.now();
    const page = m.pageContext;
    if (page.entity) s.ids.learn(page.entity.kind, page.entity.id, { now });
    s.history.push({ role: 'user', content: [{ type: 'text', text: m.message }, { type: 'text', text: contextBlock(page, now) }] });
    const turn: Turn = {
      traceId: m.traceId, page, started: now, steps: 0, state: 'running', abort: new AbortController(), awaiting: null, timer: null, kept: [], signal: undefined,
    };
    s.turn = turn;
    this.log(s, turn.traceId, 'turn', { message: m.message.length, pageType: page.pageType });
    // Context up front: a skill for this kind of page loads before the first model call, as if the model had asked.
    for (const name of skillsForPage(s.site.site, page.pageType, s.skills, s.site.policy.disabledSkills)) {
      const loaded = loadSkill(s.site.site, name, s.skills, s.site.policy.disabledSkills);
      if (!loaded.ok) continue;
      const id = `preload_${name}`;
      s.history.push({ role: 'assistant', content: [{ type: 'tool-call', id, name: SKILL_TOOL, input: { name } }] });
      s.history.push({ role: 'tool', content: [{ type: 'tool-result', id, name: SKILL_TOOL, output: loaded.text, isError: false }] });
      this.log(s, turn.traceId, 'skill_preloaded', { skill: name });
    }
    return this.stream(s, turn, signal);
  }

  private takeResults(m: ClientResults, signal: AbortSignal | undefined): Accepted {
    const s = this.sessions.get(m.sessionId);
    const turn = s?.turn;
    const fail = (code: ErrorEvent['code'], message: string): Accepted => ({ ok: true, events: once({ type: 'error', traceId: m.traceId, code, message }) });
    if (!s || !turn || turn.traceId !== m.traceId) return fail('timeout', MESSAGES.expired);
    if (turn.state === 'running') return { ok: false, status: 409, error: 'this turn is already running' };
    const waiting = turn.awaiting!;
    this.touch(s);
    // Results only for the calls the brain issued and is waiting for: each one exactly once.
    const ids = m.results.map((r) => r.id);
    const exact = ids.length === waiting.byCallId.size && new Set(ids).size === ids.length && ids.every((id) => waiting.byCallId.has(id));
    if (!exact) {
      this.log(s, turn.traceId, 'results_refused', { got: ids, awaited: [...waiting.byCallId.keys()] });
      this.closeAwaited(s, turn, 'the client sent results that did not match');
      this.endTurn(s, turn, 'results did not match');
      return fail('internal', MESSAGES.mismatch);
    }
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = null;
    const ctx = this.checks(s, turn);
    for (const r of m.results) {
      const call = waiting.byCallId.get(r.id)!;
      if (!r.ok) {
        call.result = this.errorResult(call, r.error);
        continue;
      }
      const problem = outputProblem(s.site.site, call.name, r.output);
      if (problem) {
        this.log(s, turn.traceId, 'result_refused', { call: r.id, tool: call.name, problem });
        call.result = this.errorResult(call, platformError('response_changed', { tool: call.name }));
        continue;
      }
      learnIds(ctx, call.name, r.output);
      call.result = { type: 'tool-result', id: call.modelId, name: call.name, output: r.output, isError: false };
    }
    s.history.push({ role: 'tool', content: waiting.step.calls.map((c) => c.result!) });
    turn.awaiting = null;
    turn.state = 'running';
    this.log(s, turn.traceId, 'results', { calls: ids.length, failed: m.results.filter((r) => !r.ok).length });
    return this.stream(s, turn, signal);
  }

  /** The client stopped sending results: the waiting calls get error results and the turn ends. */
  private expire(s: BrainSession, turn: Turn): void {
    if (s.turn !== turn || turn.state !== 'awaiting') return;
    this.closeAwaited(s, turn, "the user's device didn't send it in time");
    this.endTurn(s, turn, 'results timed out');
  }

  private errorResult(call: CallRecord, error: ToolError): ToolResultPart {
    return { type: 'tool-result', id: call.modelId, name: call.name, output: error, isError: true };
  }

  // ------------------------------------------------------------------ steps

  private async *run(s: BrainSession, turn: Turn): AsyncGenerator<ServerEvent> {
    const site = s.site.site;
    const stop = (code: ErrorEvent['code'], message: string, why: string): ServerEvent => {
      this.endTurn(s, turn, why);
      return { type: 'error', traceId: turn.traceId, code, message };
    };
    try {
      for (;;) {
        if (s.turn !== turn) return;
        if (turn.signal?.aborted) {
          this.endTurn(s, turn, 'the client went away');
          return;
        }
        if (this.now() - turn.started > this.limits.turnTimeoutMs) {
          yield stop('timeout', MESSAGES.turnSlow, 'the turn took too long');
          return;
        }
        const refusal = this.quotas.beforeModelCall(site.pack.site.id, s.usage);
        if (refusal) {
          this.log(s, turn.traceId, 'quota', refusal);
          yield stop('budget_reached', refusal.message, 'quota');
          return;
        }
        const final = turn.steps + 1 >= this.limits.stepsPerTurn;
        if (final) s.history.push({ role: 'user', content: [{ type: 'text', text: FINAL_STEP_NOTE }] });
        turn.steps++;
        this.quotas.startModelCall(site.pack.site.id, s.usage);

        const step: Step = { text: '', calls: [] };
        let usage: Usage = NO_USAGE;
        let reason = 'other';
        const started = performance.now();
        try {
          for await (const ev of this.callModel(s, turn)) {
            if (s.turn !== turn) return;
            if (ev.type === 'text') step.text += ev.text;
            else if (ev.type === 'tool-call') {
              const sent = this.onToolCall(s, turn, step, ev, final);
              if (sent) yield sent;
            } else {
              usage = ev.usage;
              reason = ev.reason;
            }
          }
        } catch (e) {
          if (s.turn !== turn) return;
          if (e instanceof ClientGone) {
            this.endTurn(s, turn, 'the client went away');
            return;
          }
          const timedOut = e instanceof ModelTimeout;
          this.log(s, turn.traceId, 'model_failed', { error: String(e), timedOut });
          yield stop(timedOut ? 'timeout' : 'internal', timedOut ? MESSAGES.modelSlow : MESSAGES.modelFailed, timedOut ? 'the model took too long' : 'the model failed');
          return;
        }
        if (s.turn !== turn) return;
        this.quotas.endModelCall(s.usage, usage.inputTokens + usage.outputTokens);
        this.log(s, turn.traceId, 'model_step', {
          step: turn.steps, finish: reason, ms: Math.round(performance.now() - started), calls: step.calls.map((c) => c.name),
          inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
          cacheHitRate: usage.inputTokens ? usage.cacheReadTokens / usage.inputTokens : null,
        });

        // The step is complete. Everything from here to the next yield runs at once, so the history is never half-updated.
        if (step.text || step.calls.length) {
          s.history.push({
            role: 'assistant',
            content: [...(step.text ? [{ type: 'text' as const, text: step.text }] : []),
              ...step.calls.map((c) => ({ type: 'tool-call' as const, id: c.modelId, name: c.name, input: c.input }))],
          });
        }
        const client = step.calls.filter((c) => c.kind === 'client');
        const presents = step.calls.filter((c) => c.kind === 'present');

        if (client.length) {
          for (const p of presents) p.result = this.errorResult(p, platformError('present_too_early', { tool: p.name }));
          turn.state = 'awaiting';
          turn.awaiting = { step, byCallId: new Map(client.map((c) => [c.callId!, c])) };
          turn.timer = unref(setTimeout(() => this.expire(s, turn), this.limits.resultsTimeoutMs));
          const line = progressLine(step.text);
          if (line) yield { type: 'progress', traceId: turn.traceId, text: line };
          yield { type: 'await_results', traceId: turn.traceId, callIds: client.map((c) => c.callId!) as [string, ...string[]] };
          return;
        }

        if (presents.length || !step.calls.length || final) {
          const ctx = this.checks(s, turn);
          const checked = presents.map((p) => ({ p, problem: checkPresentationCall(ctx, p.name, p.input) }));
          const refused = checked.filter((c) => c.problem);
          if (refused.length && !final) {
            // The answer goes back to the model to fix; nothing is shown yet.
            for (const c of checked) c.p.result = this.errorResult(c.p, c.problem ?? platformError('not_shown'));
            this.log(s, turn.traceId, 'presentation_refused', refused.map((c) => ({ tool: c.p.name, reason: c.problem!.reason })));
            s.history.push({ role: 'tool', content: step.calls.map((c) => c.result!) });
            continue;
          }
          const accepted = checked.filter((c) => !c.problem).map((c) => ({ name: c.p.name, args: c.p.input }) as unknown as PresentationCall);
          if (accepted.length && !step.text.trim() && !final) {
            // Cards with no words yet: they're kept for the answer, and the model's next step writes the text.
            turn.kept.push(...accepted);
            for (const c of checked) c.p.result = { type: 'tool-result', id: c.p.modelId, name: c.p.name, output: KEPT_NOTE, isError: false };
            this.log(s, turn.traceId, 'presentation_kept', { calls: accepted.length });
            s.history.push({ role: 'tool', content: step.calls.map((c) => c.result!) });
            continue;
          }
          for (const c of checked) {
            c.p.result = c.problem ? this.errorResult(c.p, c.problem) : { type: 'tool-result', id: c.p.modelId, name: c.p.name, output: { shown: true }, isError: false };
          }
          if (step.calls.length) s.history.push({ role: 'tool', content: step.calls.map((c) => c.result!) });
          // Calls kept from earlier steps first, each distinct call once.
          const seen = new Set<string>();
          const shown = [...turn.kept, ...accepted].filter((c) => {
            const key = JSON.stringify(c);
            return seen.has(key) ? false : (seen.add(key), true);
          });
          const skipped = final && step.calls.some((c) => c.kind === 'server' && (c.result?.output as ToolError | undefined)?.reason === 'out_of_steps');
          const text = skipped ? MESSAGES.outOfSteps : step.text.trim() || (shown.length ? '' : MESSAGES.noAnswer);
          this.endTurn(s, turn, 'answered');
          yield {
            type: 'answer', traceId: turn.traceId, text, present: withRequiredNotices(site.pack, shown), ...(final ? { budgetReached: true } : {}),
          };
          return;
        }

        // Only calls the brain answered itself, such as skills and refused calls: their results go straight back.
        s.history.push({ role: 'tool', content: step.calls.map((c) => c.result!) });
      }
    } finally {
      // The caller stopped reading mid-step (the client went away): the step is dropped and the turn ends.
      if (s.turn === turn && turn.state === 'running') {
        turn.abort.abort(new Error('the client went away'));
        this.endTurn(s, turn, 'the client went away');
      }
    }
  }

  /** One model call, with the step's timeout. It ends early when the turn is superseded or the client goes away. */
  private async *callModel(s: BrainSession, turn: Turn): AsyncGenerator<ModelEvent> {
    const { global } = s.site;
    const controller = new AbortController();
    turn.abort = controller;
    const gone = () => controller.abort(new ClientGone('the client went away'));
    if (turn.signal?.aborted) gone();
    else turn.signal?.addEventListener('abort', gone, { once: true });
    let timedOut = false;
    const timer = unref(setTimeout(() => {
      timedOut = true;
      controller.abort(new ModelTimeout('the model took too long'));
    }, this.limits.modelTimeoutMs));
    const iterator = this.model.stream({
      system: global.system, tools: global.tools, messages: [...s.history], maxOutputTokens: this.limits.maxOutputTokens, signal: controller.signal,
    })[Symbol.asyncIterator]();
    let finished = false;
    try {
      for (;;) {
        const next = await untilAborted(iterator.next(), controller.signal);
        if (next.done) {
          finished = true;
          return;
        }
        yield next.value;
      }
    } catch (e) {
      throw timedOut ? new ModelTimeout('the model took too long') : e;
    } finally {
      clearTimeout(timer);
      turn.signal?.removeEventListener('abort', gone);
      if (!finished) iterator.return?.()?.catch(() => {});
    }
  }

  /** Decides what happens to a tool call the moment the model finishes writing it; returns the event to send, if any. */
  private onToolCall(s: BrainSession, turn: Turn, step: Step, ev: Extract<ModelEvent, { type: 'tool-call' }>, final: boolean): ToolCallEvent | null {
    const call: CallRecord = { modelId: ev.id, name: ev.name, input: isObject(ev.input) ? ev.input : {}, kind: 'server' };
    step.calls.push(call);
    const refuse = (error: ToolError) => {
      call.result = this.errorResult(call, error);
      this.log(s, turn.traceId, 'call_refused', { tool: ev.name, reason: error.reason });
      return null;
    };
    if (!isObject(ev.input)) return refuse(platformError('bad_arguments', { tool: ev.name, details: 'the arguments must be an object' }));
    if (isPresentation(ev.name)) {
      call.kind = 'present';
      return null;
    }
    if (ev.name === SKILL_TOOL) {
      const loaded = loadSkill(s.site.site, call.input.name, s.skills, s.site.policy.disabledSkills);
      if (!loaded.ok) return refuse(loaded.error);
      call.result = { type: 'tool-result', id: call.modelId, name: call.name, output: loaded.text, isError: false };
      this.log(s, turn.traceId, 'skill_loaded', { skill: call.input.name });
      return null;
    }
    if (final) return refuse(platformError('out_of_steps', { tool: ev.name }));
    const problem = checkClientCall(this.checks(s, turn), ev.name, call.input);
    if (problem) return refuse(problem);
    call.kind = 'client';
    call.callId = `call_${++s.nextCall}`;
    this.log(s, turn.traceId, 'tool_call', { id: call.callId, tool: ev.name });
    return { type: 'tool_call', traceId: turn.traceId, call: { id: call.callId, name: ev.name, args: call.input } };
  }
}
