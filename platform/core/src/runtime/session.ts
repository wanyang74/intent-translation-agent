// One user's session on one site: the IDs it has seen, its share of the call budget and rate limit, cached responses,
// the latest response of each endpoint (for allowed-value checks), site code's scratch space, the records Respond
// fills cards from, and the site token while one is held. Sessions share nothing.
import type { PageContext, SitePack } from '../../../contract/generated/types.ts';
import type { Host } from './host.ts';
import { IdSet, type KnownId } from '../boundary/ids.ts';
import { CallBudget, RateLimiter, type Policy } from '../boundary/limits.ts';
import type { SiteCode } from '../execute/site-code.ts';
import type { Validators } from '../shared/validate.ts';

export interface SessionOptions {
  pack: SitePack;
  site: SiteCode;
  validators: Validators;
  host: Host;
  policy: Policy;
  /** Restores today's call count kept by the host from earlier sessions. */
  usedToday?: { day: number; dayKey: number };
  id?: string;
  /** A session saved on an earlier page of the same site (snapshot()), to carry on from. */
  restore?: SessionSnapshot;
}

/**
 * What a session needs to carry on after the page changes: when the user follows a Take me there button, or opens
 * another page of the site, the host saves this and starts the next page's session from it. Plain JSON, so any host
 * can keep it. The response cache isn't kept: a repeated request is simply made again.
 */
export interface SessionSnapshot {
  id: string;
  ids: KnownId[];
  /** Each item's records by tool, in the order they were kept. */
  records: { kind: string; id: string | number; byTool: [string, unknown][] }[];
  tracking: [string, string][];
  store: [string, unknown][];
  responses: Record<string, unknown>;
  used: { session: number; day: number; dayKey: number };
  /** The site token, so the next page doesn't fetch a new one. It stays on the device, like the rest. */
  siteToken?: SiteToken | null;
}

/** A token from the site's token endpoint (the site pack's token section), and when to stop using it. */
export interface SiteToken {
  value: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
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
  /** The trace of the turn that's running, while one is; amendments go to it. */
  activeTurn: string | undefined;
  /** Where progress lines go while tools run. */
  onProgress: ((text: string) => void) | undefined;
  /** The site token while one is held. Kept in memory on the device: it never goes into a message to the brain. */
  siteToken: SiteToken | null = null;
  /** A token request on its way, shared, so tool calls running side by side wait for one token instead of each fetching its own. */
  tokenRequest: Promise<string> | null = null;
  private records = new Map<string, Map<string, unknown>>();
  private tracking = new Map<string, string>();

  constructor(options: SessionOptions) {
    this.pack = options.pack;
    this.site = options.site;
    this.validators = options.validators;
    this.host = options.host;
    this.policy = options.policy;
    const saved = options.restore;
    this.id = saved?.id ?? options.id ?? `sess_${options.host.randomId()}`;
    this.ids = new IdSet(options.pack.entities);
    const used = saved ? saved.used : options.usedToday ? { day: options.usedToday.day, dayKey: options.usedToday.dayKey } : {};
    this.budget = new CallBudget(options.policy.budgets, () => options.host.now(), used);
    this.limiter = new RateLimiter(options.policy.rateLimitPerSecond);
    if (saved) {
      this.ids.restore(saved.ids);
      for (const record of saved.records) for (const [tool, value] of record.byTool) this.putRecord(record.kind, record.id, tool, value);
      for (const [name, id] of saved.tracking) this.tracking.set(name, id);
      for (const [name, value] of saved.store) this.store.set(name, value);
      Object.assign(this.responses, saved.responses);
      this.siteToken = saved.siteToken ?? null;
    }
  }

  /**
   * The session as plain JSON, to carry on from on the next page (SessionOptions.restore). The round trip through
   * JSON drops anything that wouldn't survive being stored, so what's restored is exactly what was saved.
   */
  snapshot(): SessionSnapshot {
    const { session, day, dayKey } = this.budget.used();
    const records = [...this.records.entries()].map(([recordKey, byTool]) => {
      const cut = recordKey.indexOf('\u0000');
      const kind = recordKey.slice(0, cut);
      const rawId = recordKey.slice(cut + 1);
      // Keys hold the ID as text; the kind's ID type says whether it was a number.
      const id = this.pack.entities[kind]?.id.type === 'integer' ? Number(rawId) : rawId;
      return { kind, id, byTool: [...byTool.entries()] };
    });
    const snapshot: SessionSnapshot = {
      id: this.id, ids: this.ids.entries(), records, tracking: [...this.tracking.entries()], store: [...this.store.entries()],
      responses: this.responses, used: { session, day, dayKey }, siteToken: this.siteToken,
    };
    return JSON.parse(JSON.stringify(snapshot)) as SessionSnapshot;
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
