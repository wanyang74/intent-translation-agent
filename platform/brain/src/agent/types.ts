// What one brain shares with its sessions and turns: the limits, the services every level uses (the site, the model,
// quotas, clock and log), the plain messages users see when a turn ends early, and a few small helpers.
// The levels, from longest-lived to shortest:
//   Brain (brain.ts)          one per site, always on: the site, the model, quotas, and the sessions
//   AgentSession (session.ts) one per conversation: its history, known IDs, usage, and at most one running turn
//   Turn (turn.ts)            one user message to one answer: the agent loop, a ModelStep per model call
import type { ServerEvent } from '../../../contract/generated/types.ts';
import type { Policy } from '../../../core/src/boundary/limits.ts';
import type { ModelAdapter } from '../model/model.ts';
import type { PromptPrefix } from '../prompt/prompt.ts';
import type { SiteBundle } from '../prompt/site.ts';
import type { Quotas } from '../system/quotas.ts';

export interface BrainLimits {
  /** Model calls in one turn. The last one is told to answer with what it has. */
  stepsPerTurn: number;
  maxOutputTokens: number;
  /** The output limit after a reply is cut off at maxOutputTokens: the step is asked for again once, with this. */
  retryOutputTokens: number;
  /** How often in one turn a refused card goes back to the model to fix; after that, the cards that passed are shown. */
  cardRetriesPerTurn: number;
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
  retryOutputTokens: 16_384,
  cardRetriesPerTurn: 2,
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

/** The site as this brain serves it: the site pack's ID, its bundle, its cached prompt prefixes, and its policy. */
export interface ServedSite {
  id: string;
  bundle: SiteBundle;
  /** One prefix for devices with a script sandbox and one for devices without, each built once and shared. */
  promptPrefixes: { withScripts: PromptPrefix; withoutScripts: PromptPrefix };
  policy: Policy;
}

/**
 * What the brain hands down to every session and turn. One object per brain, read-only below it: sessions and turns
 * use these instead of reaching into the Brain, so each level sees only what it needs.
 */
export interface BrainServices {
  readonly site: ServedSite;
  readonly model: ModelAdapter;
  readonly limits: BrainLimits;
  readonly quotas: Quotas;
  readonly now: () => number;
  log(sessionId: string | undefined, traceId: string | undefined, kind: string, detail: unknown): void;
}

/** What the brain does with a message: stream events back, or refuse it as the HTTP layer should (400, 409). */
export type ServerResponse = { ok: true; events: AsyncIterable<ServerEvent> } | { ok: false; status: number; error: string };

// What the user sees when a turn ends early. Plain, with no internals.
export const MESSAGES = {
  expired: 'This request expired. Ask again.',
  mismatch: 'Something went wrong. Try again.',
  modelFailed: "The assistant couldn't answer just now. Try again.",
  modelSlow: 'The assistant took too long to answer. Try again.',
  turnSlow: 'This took too long. Try a narrower question.',
  noAnswer: "I couldn't put together an answer. Try asking another way.",
  cutOff: 'The answer came out too long to finish. Try asking for less at once.',
  outOfSteps: "I couldn't finish this within the steps I can take for one request, so I'm not showing a partial answer. Try asking for less at once.",
} as const;

/** A stream of exactly one event, for replies that need no model call. */
export async function* once(event: ServerEvent): AsyncGenerator<ServerEvent> {
  yield event;
}

export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
