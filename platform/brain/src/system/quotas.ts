// LLM quotas: turns, model calls and tokens per session, and model calls per day for each site. They protect us from
// cost abuse; core.js's call budget protects the site. A model call is counted when it starts, so parallel sessions
// can't run past the daily limit; its tokens are counted when it ends. Time comes from the caller, so tests are exact.

export interface QuotaLimits {
  turnsPerSession: number | null;
  modelCallsPerSession: number | null;
  /** Input and output tokens together, cached input included. */
  tokensPerSession: number | null;
  /** Across all sessions of one site, per UTC day. */
  modelCallsPerDay: number | null;
}

export const DEFAULT_QUOTAS: QuotaLimits = {
  turnsPerSession: 50,
  modelCallsPerSession: 200,
  tokensPerSession: 4_000_000,
  modelCallsPerDay: 20_000,
};

export interface SessionUsage {
  turns: number;
  modelCalls: number;
  tokens: number;
}

export interface QuotaRefusal {
  scope: 'session' | 'day';
  limit: keyof QuotaLimits;
  /** For the user, as the brain's error event says it. */
  message: string;
}

const DAY = 86_400_000;
const SESSION_MESSAGE = 'This conversation has reached its limit. Start a new one to keep going.';
const DAY_MESSAGE = "The assistant has reached today's limit. Try again tomorrow.";

export class Quotas {
  private limits: QuotaLimits;
  private clock: () => number;
  private days = new Map<string, { day: number; calls: number }>();

  constructor(limits: QuotaLimits, clock: () => number) {
    this.limits = limits;
    this.clock = clock;
  }

  private today(site: string): { day: number; calls: number } {
    const day = Math.floor(this.clock() / DAY);
    let entry = this.days.get(site);
    if (!entry || entry.day !== day) {
      entry = { day, calls: 0 };
      this.days.set(site, entry);
    }
    return entry;
  }

  private over(limit: keyof QuotaLimits, used: number): boolean {
    const max = this.limits[limit];
    return max !== null && used >= max;
  }

  private sessionRefusal(usage: SessionUsage): QuotaRefusal | null {
    if (this.over('modelCallsPerSession', usage.modelCalls)) return { scope: 'session', limit: 'modelCallsPerSession', message: SESSION_MESSAGE };
    if (this.over('tokensPerSession', usage.tokens)) return { scope: 'session', limit: 'tokensPerSession', message: SESSION_MESSAGE };
    return null;
  }

  /** Whether a new turn may start: the session's turns, its model calls and tokens so far, and today's calls. */
  beforeTurn(site: string, usage: SessionUsage): QuotaRefusal | null {
    if (this.over('turnsPerSession', usage.turns)) return { scope: 'session', limit: 'turnsPerSession', message: SESSION_MESSAGE };
    return this.beforeModelCall(site, usage);
  }

  beforeModelCall(site: string, usage: SessionUsage): QuotaRefusal | null {
    const refusal = this.sessionRefusal(usage);
    if (refusal) return refusal;
    if (this.over('modelCallsPerDay', this.today(site).calls)) return { scope: 'day', limit: 'modelCallsPerDay', message: DAY_MESSAGE };
    return null;
  }

  startModelCall(site: string, usage: SessionUsage): void {
    usage.modelCalls++;
    this.today(site).calls++;
  }

  endModelCall(usage: SessionUsage, tokens: number): void {
    usage.tokens += tokens;
  }

  /** Model calls today for a site, for logs and tests. */
  callsToday(site: string): number {
    return this.today(site).calls;
  }
}
