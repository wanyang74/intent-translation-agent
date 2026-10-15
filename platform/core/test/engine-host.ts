// A host made only of the JavaScript language, for running core.js's I/O inside other engines (QuickJS,
// JavaScriptCore): the site's recorded responses by endpoint and match key, a plain clock, and predictable IDs.
// No Node, no timers: sleeping just moves the clock.
import type { SitePack } from '../../contract/generated/types.ts';
import type { Host, HostRequest, HostResponse } from '../src/host.ts';
import { matchKey } from '../src/index.ts';

export interface RecordedResponse {
  endpoint: string;
  key: string;
  response: HostResponse;
}

const special = /[.*+?^$()|[\]\\]/g;

/** The endpoint a URL belongs to, and its path parameters. */
export function endpointFor(pack: SitePack, url: string): { name: string; params: Record<string, string> } | null {
  const base = url.split('?')[0]!;
  for (const [name, e] of Object.entries(pack.endpoints)) {
    if (!e) continue;
    const pattern = '^' + e.url.replace(special, '\\$&').replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '(?<$1>[^/]+)') + '$';
    const m = new RegExp(pattern).exec(base);
    if (m) return { name, params: { ...(m.groups ?? {}) } };
  }
  return null;
}

/** The request as a value: path and query parameters for GET, the JSON body for POST. */
export function requestValueOf(req: HostRequest, params: Record<string, string>): unknown {
  if (req.method === 'POST') return req.body ? JSON.parse(req.body) : null;
  const query: Record<string, string> = {};
  const q = req.url.indexOf('?');
  if (q >= 0) {
    for (const pair of req.url.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      const k = eq < 0 ? pair : pair.slice(0, eq);
      const v = eq < 0 ? '' : pair.slice(eq + 1);
      query[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    }
  }
  return { ...params, ...query };
}

export function recordedHost(pack: SitePack, recorded: RecordedResponse[], start: number, pageData: unknown): Host & { calls: string[] } {
  const byKey = new Map(recorded.map((r) => [`${r.endpoint} ${r.key}`, r.response]));
  let now = start;
  let ids = 0;
  const calls: string[] = [];
  return {
    calls,
    async request(req) {
      const match = endpointFor(pack, req.url);
      if (!match) return { status: 404, headers: {}, body: '' };
      const key = `${match.name} ${matchKey(pack.endpoints[match.name]!, requestValueOf(req, match.params))}`;
      calls.push(key.length > 120 ? key.slice(0, 120) : key);
      return byKey.get(key) ?? { status: 404, headers: {}, body: '' };
    },
    now: () => now,
    sleep: async (ms) => { now += ms; },
    randomId: () => `00000000-0000-4000-9000-${String(++ids).padStart(12, '0')}`,
    pageData: () => pageData ?? null,
  };
}
