// One user's session on one site: the IDs it has seen, its share of the call budget and rate limit, cached responses,
// the latest response of each endpoint (for allowed-value checks), site code's scratch space, and the records Respond
// fills cards from. Sessions share nothing.
import type { PageContext, SitePack } from '../../contract/generated/types.ts';
import type { Host } from './host.ts';
import { IdSet } from './ids.ts';
import { CallBudget, RateLimiter, type Policy } from './limits.ts';
import type { SiteCode } from './site-code.ts';
import type { Validators } from './validate.ts';

export interface SessionOptions {
  pack: SitePack;
  site: SiteCode;
  validators: Validators;
  host: Host;
  policy: Policy;
  /** Restores today's call count kept by the host from earlier sessions. */
  usedToday?: { day: number; dayKey: number };
  id?: string;
}

export class Session {
  readonly id: string;
  readonly pack: SitePack;
  readonly site: SiteCode;
  readonly validators: Validators;
  readonly host: Host;
  readonly policy: Policy;
  readonly ids: IdSet;
  readonly budget: CallBudget;
  readonly limiter: RateLimiter;
  /** Responses by endpoint and match key: a repeated request is answered from here. */
  readonly cache = new Map<string, unknown>();
  /** The latest response of each endpoint. */
  readonly responses: Record<string, unknown> = {};
  readonly store = new Map<string, unknown>();
  page: PageContext | undefined;
  /** The current turn's trace ID, for the development log. */
  traceId: string | undefined;
  /** Where progress lines go while tools run. */
  onProgress: ((text: string) => void) | undefined;
  private records = new Map<string, Map<string, unknown>>();
  private tracking = new Map<string, string>();

  constructor(o: SessionOptions) {
    this.pack = o.pack;
    this.site = o.site;
    this.validators = o.validators;
    this.host = o.host;
    this.policy = o.policy;
    this.id = o.id ?? `sess_${o.host.randomId()}`;
    this.ids = new IdSet(o.pack.entities);
    this.budget = new CallBudget(o.policy.budgets, () => o.host.now(), o.usedToday ? { day: o.usedToday.day, dayKey: o.usedToday.dayKey } : {});
    this.limiter = new RateLimiter(o.policy.rateLimitPerSecond);
  }

  /** The page the user is on. The item on screen counts as a known ID. */
  setPage(page: PageContext | undefined): void {
    this.page = page;
    if (page?.entity) this.ids.learn(page.entity.kind, page.entity.id, { now: this.host.now() });
  }

  /**
   * A fresh random ID for a tracking field or header, the same for the whole session (decision D4). A body field and
   * a header with the same name share one, so a visitor ID matches wherever the site expects it.
   */
  trackingId(name: string): string {
    const key = (name.split('.').pop() ?? name).toLowerCase().replace(/[^a-z0-9]/g, '');
    let id = this.tracking.get(key);
    if (!id) this.tracking.set(key, (id = this.host.randomId()));
    return id;
  }

  /** Keeps what a tool returned about one item; the latest tool's record is merged last. */
  putRecord(kind: string, id: unknown, tool: string, record: unknown): void {
    if (typeof id !== 'string' && typeof id !== 'number') return;
    const key = `${kind}\u0000${id}`;
    let byTool = this.records.get(key);
    if (!byTool) this.records.set(key, (byTool = new Map()));
    byTool.delete(tool);
    byTool.set(tool, record);
  }

  recordsFor(kind: string, id: unknown): Map<string, unknown> | undefined {
    return this.records.get(`${kind}\u0000${String(id)}`);
  }

  log(kind: string, detail: unknown): void {
    this.host.log?.({ traceId: this.traceId, kind, detail });
  }
}
