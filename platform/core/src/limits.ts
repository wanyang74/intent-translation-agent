// Usage caps: one shared call budget per task, session and day, and one rate limit, drawn on by direct, parallel and
// script calls alike, so retries and parallel steps can't stack past a limit. The site pack sets them; the remote
// config can only make them stricter. Time comes from the caller, so this runs anywhere and tests are exact.
import type { RemoteConfig, SitePack } from '../../contract/generated/types.ts';

export interface Budgets {
  perTask: number;
  perSession: number | null;
  perDay: number | null;
}

export interface Policy {
  budgets: Budgets;
  rateLimitPerSecond: number;
  disabledTools: string[];
  disabledSkills: string[];
  writes: 'none' | 'with_approval';
}

const stricter = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/** The site pack's policy, tightened by the remote config if one is given for this site. */
export function effectivePolicy(pack: SitePack, config?: RemoteConfig | null): { policy: Policy; warnings: string[] } {
  const p = pack.policies;
  const policy: Policy = {
    budgets: { perTask: p.callBudget.perTask, perSession: p.callBudget.perSession, perDay: p.callBudget.perDay },
    rateLimitPerSecond: p.rateLimitPerSecond,
    disabledTools: [],
    disabledSkills: [],
    writes: p.writes,
  };
  const warnings: string[] = [];
  if (!config) return { policy, warnings };
  if (config.site !== pack.site.id) {
    warnings.push(`remote config is for ${config.site}, not ${pack.site.id}; ignored`);
    return { policy, warnings };
  }
  policy.budgets = {
    perTask: Math.min(p.callBudget.perTask, config.budgets.perTask),
    perSession: stricter(p.callBudget.perSession, config.budgets.perSession),
    perDay: stricter(p.callBudget.perDay, config.budgets.perDay),
  };
  policy.rateLimitPerSecond = Math.min(p.rateLimitPerSecond, config.rateLimitPerSecond);
  policy.disabledTools = [...config.disabledTools];
  policy.disabledSkills = [...config.disabledSkills];
  return { policy, warnings };
}

export type Scope = 'task' | 'session' | 'day';
export type Acquired = { ok: true } | { ok: false; scope: Scope; limit: number; used: number };

const DAY = 86_400_000;

export class CallBudget {
  private budgets: Budgets;
  private clock: () => number;
  private task = 0;
  private session: number;
  private day: number;
  private dayKey: number;

  /** `used` restores counts kept from earlier sessions today (the Host stores them). */
  constructor(budgets: Budgets, clock: () => number, used: { session?: number; day?: number; dayKey?: number } = {}) {
    this.budgets = budgets;
    this.clock = clock;
    this.dayKey = Math.floor(clock() / DAY);
    this.session = used.session ?? 0;
    this.day = used.dayKey === this.dayKey ? used.day ?? 0 : 0;
  }

  /** Takes n calls from every budget at once, or none if any budget would go over. */
  tryAcquire(n = 1): Acquired {
    const today = Math.floor(this.clock() / DAY);
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.day = 0;
    }
    const checks: [Scope, number | null, number][] = [
      ['task', this.budgets.perTask, this.task],
      ['session', this.budgets.perSession, this.session],
      ['day', this.budgets.perDay, this.day],
    ];
    for (const [scope, limit, used] of checks) {
      if (limit !== null && used + n > limit) return { ok: false, scope, limit, used };
    }
    this.task += n;
    this.session += n;
    this.day += n;
    return { ok: true };
  }

  /** A new task gets a fresh task budget; the session and day budgets carry on. */
  startTask(): void {
    this.task = 0;
  }

  used(): { task: number; session: number; day: number; dayKey: number } {
    return { task: this.task, session: this.session, day: this.day, dayKey: this.dayKey };
  }
}

/** Spaces call starts evenly: parallel calls queue instead of bursting. */
export class RateLimiter {
  private interval: number;
  private nextFree = -Infinity;

  constructor(perSecond: number) {
    if (!(perSecond > 0) || !Number.isFinite(perSecond)) throw new RangeError(`rate limit must be above zero, not ${perSecond}`);
    this.interval = 1000 / perSecond;
  }

  /** Reserves the next slot: the time (ms) at which this call may start, never earlier than now. */
  reserve(now: number): number {
    const start = Math.max(now, this.nextFree);
    this.nextFree = start + this.interval;
    return start;
  }
}
