// The IDs this session has seen, typed by the entity kinds in the site pack. Tool calls and presentation calls may
// only use IDs from here, of the right kind, that haven't expired. IDs come from tool results (the paths each tool
// declares) and from the item on screen. Scripts get a read-only view.
import type { SitePack } from '../../contract/generated/types.ts';
import { valuesAt } from '../../contract/src/paths.ts';

type Entity = NonNullable<SitePack['entities'][string]>;
export type IdValue = string | number;
export type IdStatus = 'known' | 'unknown' | 'expired';

export interface IdPathSpec {
  kind: string;
  path: string;
  expiresAt?: string;
}

/** What scripts can see: they can read the set but not add to it. */
export interface IdView {
  has(kind: string, id: unknown, now: number): boolean;
  list(kind: string): IdValue[];
}

/** Whether a value has the type and pattern the entity kind declares for its IDs. */
export function idShapeOk(entity: Entity, id: unknown): id is IdValue {
  if (entity.id.type === 'integer') return typeof id === 'number' && Number.isSafeInteger(id);
  if (typeof id !== 'string' || id === '') return false;
  return !entity.id.pattern || new RegExp(entity.id.pattern).test(id);
}

const key = (kind: string, id: IdValue) => `${kind}\u0000${id}`;

/** Milliseconds since the epoch; a date that can't be read counts as already expired, so a format change fails safe. */
function toTime(value: string | number): number {
  if (typeof value === 'number') return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? -Infinity : t;
}

export class IdSet {
  private known = new Map<string, { kind: string; id: IdValue; expiresAt: number | null }>();
  private entities: SitePack['entities'];

  constructor(entities: SitePack['entities']) {
    this.entities = entities;
  }

  /** Records an ID. Returns false, recording nothing, for an unknown kind or an ID of the wrong shape. */
  learn(kind: string, id: unknown, options: { expiresAt?: string | number | null; now?: number } = {}): boolean {
    const entity = this.entities[kind];
    if (!entity || !idShapeOk(entity, id)) return false;
    let expiresAt: number | null = null;
    if (options.expiresAt !== undefined && options.expiresAt !== null) expiresAt = toTime(options.expiresAt);
    else if (entity.expires?.afterSeconds !== undefined && options.now !== undefined) expiresAt = options.now + entity.expires.afterSeconds * 1000;
    this.known.set(key(kind, id), { kind, id, expiresAt });
    return true;
  }

  /** Records every ID found at the given paths; an expiresAt path is read in step with its ID path. Returns how many. */
  learnFrom(value: unknown, paths: readonly IdPathSpec[] | undefined, now: number): number {
    let n = 0;
    for (const p of paths ?? []) {
      const ids = valuesAt(value, p.path);
      const expiries = p.expiresAt ? valuesAt(value, p.expiresAt) : [];
      ids.forEach((id, i) => {
        const e = expiries[i];
        const expiresAt = p.expiresAt ? (typeof e === 'string' || typeof e === 'number' ? e : 'missing') : undefined;
        if (this.learn(p.kind, id, expiresAt === undefined ? { now } : { expiresAt, now })) n++;
      });
    }
    return n;
  }

  status(kind: string, id: unknown, now: number): IdStatus {
    const entity = this.entities[kind];
    if (!entity || !idShapeOk(entity, id)) return 'unknown';
    const entry = this.known.get(key(kind, id));
    if (!entry) return 'unknown';
    return entry.expiresAt !== null && entry.expiresAt <= now ? 'expired' : 'known';
  }

  get size(): number {
    return this.known.size;
  }

  view(): IdView {
    return {
      has: (kind, id, now) => this.status(kind, id, now) === 'known',
      list: (kind) => [...this.known.values()].filter((e) => e.kind === kind).map((e) => e.id),
    };
  }
}
