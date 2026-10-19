// One conversation with one user: what lasts across its turns. The history the model sees (every turn's messages,
// tool calls and results), the IDs tools have returned, the skills already loaded, the counter for the brain's call
// IDs, and usage toward the quotas. At most one turn runs at a time: a new message replaces it, results and
// amendments go to it, and between turns there is none. The brain creates sessions and forgets idle ones; the turn
// itself (the agent loop) is in turn.ts.
import type { ClientAmend, ClientResults, ClientTurn } from '../../../contract/generated/types.ts';
import { IdSet } from '../../../core/src/boundary/ids.ts';
import type { ChatMessage } from '../model/model.ts';
import { contextBlock, SKILL_TOOL } from '../prompt/prompt.ts';
import { loadSkill, skillsForPage } from '../prompt/skills.ts';
import type { SessionUsage } from '../system/quotas.ts';
import { MESSAGES, once, type Accepted, type BrainServices } from './shared.ts';
import { Turn } from './turn.ts';

export class AgentSession {
  readonly id: string;
  readonly services: BrainServices;
  /** Everything the model has seen in this conversation, across turns. Turns append to it; nothing rewrites it. */
  readonly history: ChatMessage[] = [];
  /** Every ID a tool returned in this conversation, so later calls and cards can use only those. */
  readonly ids: IdSet;
  readonly skills = new Set<string>();
  readonly usage: SessionUsage = { turns: 0, modelCalls: 0, tokens: 0 };
  /** The turn that's running or waiting for results; null between turns. */
  turn: Turn | null = null;
  lastSeen: number;
  private nextCall = 0;
  /** Tells the brain this session was just used, so it keeps its sessions in order of last use. */
  private readonly onUse: () => void;

  constructor(id: string, services: BrainServices, onUse: () => void) {
    this.id = id;
    this.services = services;
    this.ids = new IdSet(services.site.bundle.pack.entities);
    this.lastSeen = services.now();
    this.onUse = onUse;
  }

  /** The brain's own ID for the next call sent to the client: call_1, call_2, … for the whole conversation. */
  issueCallId(): string {
    return `call_${++this.nextCall}`;
  }

  log(traceId: string | undefined, kind: string, detail: unknown): void {
    this.services.log(this.id, traceId, kind, detail);
  }

  /**
   * POST /v1/turn: a new message from the user starts a turn.
   *   1. A turn still running is replaced: its model call stops, and calls it was waiting on get error results.
   *   2. The session's turn quota is checked before anything is added to the history.
   *   3. The message goes into the history with the page context. The item on screen counts as a known ID.
   *   4. A skill for this kind of page loads before the first model call, as if the model had asked for it.
   *   5. The turn's steps stream back to the client.
   */
  startTurn(turnMessage: ClientTurn, signal: AbortSignal | undefined): Accepted {
    this.touch();
    // 1. One turn at a time: the new message wins.
    this.turn?.supersede();
    // 2. Quota: a refused turn leaves the history as it was.
    const { quotas, site } = this.services;
    const refusal = quotas.beforeTurn(turnMessage.site, this.usage);
    if (refusal) {
      this.log(turnMessage.traceId, 'quota', refusal);
      return { ok: true, events: once({ type: 'error', traceId: turnMessage.traceId, code: 'budget_reached', message: refusal.message }) };
    }
    this.usage.turns++;
    // 3. The user's words, then the page and time in a fenced block at the end, where they don't break the cache.
    const now = this.services.now();
    const page = turnMessage.pageContext;
    if (page.entity) this.ids.learn(page.entity.kind, page.entity.id, { now });
    this.history.push({ role: 'user', content: [{ type: 'text', text: turnMessage.message }, { type: 'text', text: contextBlock(page, now) }] });
    const turn = new Turn(this, turnMessage.traceId, page, now);
    this.turn = turn;
    this.log(turn.traceId, 'turn', { message: turnMessage.message.length, pageType: page.pageType });
    // 4. Context up front: each preloaded skill goes in as a skill call and its result, the shape the model knows.
    for (const name of skillsForPage(site.bundle, page.pageType, this.skills, site.policy.disabledSkills)) {
      const loaded = loadSkill(site.bundle, name, this.skills, site.policy.disabledSkills);
      if (!loaded.ok) continue;
      const id = `preload_${name}`;
      this.history.push({ role: 'assistant', content: [{ type: 'tool-call', id, name: SKILL_TOOL, input: { name } }] });
      this.history.push({ role: 'tool', content: [{ type: 'tool-result', id, name: SKILL_TOOL, output: loaded.text, isError: false }] });
      this.log(turn.traceId, 'skill_preloaded', { skill: name });
    }
    // 5. The first model call starts when the caller reads the stream.
    return turn.stream(signal);
  }

  /**
   * POST /v1/results: results for the calls the turn is waiting on. They must be for the current turn; while that
   * turn is still running (not yet waiting), they're refused with 409. The turn checks the results themselves.
   */
  takeResults(resultsMessage: ClientResults, signal: AbortSignal | undefined): Accepted {
    const { turn } = this;
    if (!turn || turn.traceId !== resultsMessage.traceId) {
      return { ok: true, events: once({ type: 'error', traceId: resultsMessage.traceId, code: 'timeout', message: MESSAGES.expired }) };
    }
    if (turn.state === 'running') return { ok: false, status: 409, error: 'this turn is already running' };
    this.touch();
    return turn.takeResults(resultsMessage, signal);
  }

  /** POST /v1/amend: queues the message on the turn it names, while that turn is still running or waiting. */
  amend(amendMessage: ClientAmend): Accepted {
    const { turn } = this;
    const reply = (status: 'queued' | 'too_late'): Accepted => ({ ok: true, events: once({ type: 'amended', traceId: amendMessage.traceId, status }) });
    if (!turn || turn.traceId !== amendMessage.traceId || turn.state === 'done') return reply('too_late');
    turn.amend(amendMessage.message);
    this.touch();
    return reply('queued');
  }

  /** The brain is dropping this session: a turn still open ends here. */
  forget(): void {
    this.turn?.end('session forgotten');
  }

  private touch(): void {
    this.lastSeen = this.services.now();
    this.onUse();
  }
}
