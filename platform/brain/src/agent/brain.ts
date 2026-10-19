// The brain at service level: one per site, always on. It holds what every conversation shares (the site with its
// cached prompt prefix and policy, the model, limits and quotas) and the conversations themselves, as AgentSessions
// kept in order of last use. It checks each message against the protocol, finds or opens the session the message
// belongs to, and hands the message over; everything about turns happens in the session and its turn.
//   POST /v1/turn     the user's message and page context → the first steps' events
//   POST /v1/results  the results the brain awaited → the next steps' events
//   POST /v1/amend    a message sent while the turn runs → queued, or too late
// One brain serves one site: each site deploys its own, with its own model keys, quotas and logs. A host that serves
// several sites from one process would run one Brain per site behind a router that picks by the turn's site.
import type { ClientAmend, ClientResults, ClientTurn, RemoteConfig } from '../../../contract/generated/types.ts';
import { effectivePolicy } from '../../../core/src/boundary/limits.ts';
import { describeProblems, validatorFor } from '../../../core/src/shared/validate.ts';
import type { ChatMessage, ModelAdapter } from '../model/model.ts';
import { buildPromptPrefix, type PromptPrefix } from '../prompt/prompt.ts';
import type { SiteBundle } from '../prompt/site.ts';
import { DEFAULT_QUOTAS, Quotas, type QuotaLimits } from '../system/quotas.ts';
import { AgentSession } from './session.ts';
import { DEFAULT_LIMITS, isObject, MESSAGES, once, type ServerResponse, type BrainLimits, type BrainLogEntry, type BrainServices } from './types.ts';

export interface BrainOptions {
  site: SiteBundle;
  model: ModelAdapter;
  limits?: Partial<BrainLimits> | undefined;
  quotas?: Partial<QuotaLimits> | undefined;
  /** The site's remote config: switched-off tools and skills. */
  config?: RemoteConfig | undefined;
  now?: (() => number) | undefined;
  log?: ((entry: BrainLogEntry) => void) | undefined;
}

export class Brain {
  readonly limits: BrainLimits;
  private readonly services: BrainServices;
  /** Every open conversation, in order of last use: the first is the one idle longest. */
  private readonly sessions = new Map<string, AgentSession>();
  private readonly validateMessage: ReturnType<typeof validatorFor>;

  constructor(options: BrainOptions) {
    const { site: bundle } = options;
    const siteId = bundle.pack.site.id;
    if (options.config && options.config.site !== siteId) throw new Error(`the remote config is for ${options.config.site}, not ${siteId}`);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    const now = options.now ?? Date.now;
    const logger = options.log;
    this.services = {
      site: { id: siteId, bundle, promptPrefix: buildPromptPrefix(bundle), policy: effectivePolicy(bundle.pack, options.config ?? null).policy },
      model: options.model,
      limits: this.limits,
      quotas: new Quotas({ ...DEFAULT_QUOTAS, ...options.quotas }, now),
      now,
      log: (sessionId, traceId, kind, detail) => logger?.({ ...(sessionId ? { sessionId } : {}), ...(traceId ? { traceId } : {}), kind, detail }),
    };
    this.validateMessage = validatorFor(bundle.validators.platform, 'messages.json');
  }

  /** The site's prompt prefix: the same object for every session, so every request shares its bytes. */
  get promptPrefix(): PromptPrefix {
    return this.services.site.promptPrefix;
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

  /**
   * Takes a message from the client. Messages that break the protocol are refused (400); anything else streams
   * events. `endpoint` is the path it arrived on, when there is one, and must match the message's type. `signal`
   * aborts when the client goes away: a step still running is stopped, and the turn ends.
   */
  accept(message: unknown, options: { endpoint?: 'turn' | 'results' | 'amend'; signal?: AbortSignal } = {}): ServerResponse {
    // 1. The protocol: a known message type, on its own endpoint, valid against the contract.
    const type = isObject(message) ? message.type : undefined;
    if (type !== 'turn' && type !== 'results' && type !== 'amend') return { ok: false, status: 400, error: 'expected a turn, results or amend message' };
    if (options.endpoint && options.endpoint !== type) return { ok: false, status: 400, error: `a ${type} message goes to /v1/${type}` };
    if (!this.validateMessage(message)) return { ok: false, status: 400, error: `the message breaks the protocol: ${describeProblems(this.validateMessage)}` };
    // 2. Hand it to its session. Only a turn can open a session; results and amendments need one that exists.
    if (type === 'turn') return this.startTurn(message as ClientTurn, options.signal);
    if (type === 'results') return this.takeResults(message as ClientResults, options.signal);
    return this.amend(message as ClientAmend);
  }

  // ------------------------------------------------------------------ routing to sessions

  /**
   * A new user message:
   *   1. It must name this brain's site.
   *   2. Forget idle sessions first, so the cap counts only live ones.
   *   3. Find the conversation, or open it on its first message.
   *   4. The session starts the turn, replacing one still running.
   */
  private startTurn(turnMessage: ClientTurn, signal: AbortSignal | undefined): ServerResponse {
    const { site } = this.services;
    if (turnMessage.site !== site.id) return { ok: false, status: 400, error: `this brain serves ${site.id}, not ${turnMessage.site}` };
    this.evict();
    let session = this.sessions.get(turnMessage.sessionId);
    if (!session) {
      const opened = new AgentSession(turnMessage.sessionId, this.services, () => this.markUsed(opened));
      session = opened;
      session.log(turnMessage.traceId, 'session_start', { site: turnMessage.site });
    }
    return session.startTurn(turnMessage, signal);
  }

  /** Results for the turn the client was running tools for. With no session, the turn is long gone. */
  private takeResults(resultsMessage: ClientResults, signal: AbortSignal | undefined): ServerResponse {
    const session = this.sessions.get(resultsMessage.sessionId);
    if (!session) return { ok: true, events: once({ type: 'error', traceId: resultsMessage.traceId, code: 'timeout', message: MESSAGES.expired }) };
    return session.takeResults(resultsMessage, signal);
  }

  /** A message for a running turn. With no session, there's no turn to add it to. */
  private amend(amendMessage: ClientAmend): ServerResponse {
    const session = this.sessions.get(amendMessage.sessionId);
    if (!session) return { ok: true, events: once({ type: 'amended', traceId: amendMessage.traceId, status: 'too_late' }) };
    return session.amend(amendMessage);
  }

  // ------------------------------------------------------------------ session bookkeeping

  /** A session was just used: move it to the end, so the map stays in order of last use. */
  private markUsed(session: AgentSession): void {
    this.sessions.delete(session.id);
    this.sessions.set(session.id, session);
  }

  /** Forgets idle sessions, oldest first (the map is kept in order of last use), and the oldest beyond the cap. */
  private evict(): void {
    const now = this.services.now();
    for (const session of this.sessions.values()) {
      const idle = now - session.lastSeen > this.limits.sessionIdleMs;
      if (!idle && this.sessions.size < this.limits.maxSessions) break;
      session.forget();
      this.sessions.delete(session.id);
      session.log(undefined, 'session_forgotten', { idle });
    }
  }
}
