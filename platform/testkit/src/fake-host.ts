// FakeHost: stands in for a site's network in tests. It answers requests from the site's fixture library.
//   1. Requests are checked against the site's endpoint schemas first. A request that breaks the contract gets
//      the error the site was seen returning for that broken field (observed fixtures), or a generic 400.
//   2. Valid requests are matched to a fixture by the fields that decide the response (the endpoint's matchKey
//      in the site pack). No match is a test failure, never a silent default.
//   3. Faults can be injected: a status, a delay, or a network error, for the next N calls.
import type { ErrorObject } from 'ajv/dist/2020.js';
import { loadContract, describeErrors, type Contract } from '../../contract/src/load.ts';
import { endpointOf, matchKey, requestValue, type SitePack } from '../../contract/src/site-pack.ts';
import { type Fixture, type HostRequest, type HostResponse, loadFixtures } from './fixtures.ts';

export interface Fault {
  /** Only calls to this endpoint; any endpoint if omitted. */
  endpoint?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Wait this long before answering (or before failing). */
  delayMs?: number;
  /** Reject with this message, like a dropped connection. */
  networkError?: string;
  /** How many calls this applies to. Default 1. */
  times?: number;
}

export interface CallRecord {
  endpoint: string;
  key: string | null;
  status: number;
  fixtureId: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const toResponse = (f: Fixture): HostResponse => ({
  status: f.response.status,
  headers: f.response.headers,
  body: typeof f.response.body === 'string' ? f.response.body : JSON.stringify(f.response.body),
});

/** Dotted paths of the fields an Ajv error list complains about, e.g. "analyticsData.clientId". */
function errorFields(errors: ErrorObject[]): string[] {
  return errors.map((e) => {
    const base = e.instancePath.split('/').filter(Boolean);
    if (e.keyword === 'required') base.push(String((e.params as { missingProperty: string }).missingProperty));
    return base.join('.');
  });
}

export class FakeHost {
  readonly site: string;
  readonly calls: CallRecord[] = [];
  #pack: SitePack;
  #contract: Contract;
  #byKey = new Map<string, Fixture>();
  #observed: Fixture[] = [];
  #faults: (Fault & { times: number })[] = [];

  constructor(site: string, fixtures: Fixture[] = loadFixtures(site)) {
    this.site = site;
    this.#contract = loadContract({ sites: [site] });
    this.#pack = this.#contract.sites[site]!.pack;
    for (const f of fixtures) {
      if (f.trigger) { this.#observed.push(f); continue; }
      const endpoint = this.#pack.endpoints[f.endpoint];
      if (!endpoint) throw new Error(`FakeHost: fixture ${f.id} names endpoint ${f.endpoint}, which ${site} doesn't have`);
      const key = `${f.endpoint} ${matchKey(endpoint, requestValue(this.#pack, f.request))}`;
      if (!this.#byKey.has(key)) this.#byKey.set(key, f);
    }
  }

  /** Make the next matching call(s) fail or slow down. */
  inject(fault: Fault): void {
    this.#faults.push({ times: 1, ...fault });
  }

  async request(req: HostRequest): Promise<HostResponse> {
    const match = endpointOf(this.#pack, req.url);
    if (!match) throw new Error(`FakeHost: no ${this.site} endpoint matches ${req.method} ${req.url}`);
    const { name, endpoint } = match;
    if (req.method !== endpoint.method) throw new Error(`FakeHost: ${name} is ${endpoint.method}, not ${req.method}`);

    const fault = this.#takeFault(name);
    if (fault?.delayMs) await sleep(fault.delayMs);
    if (fault?.networkError) {
      this.calls.push({ endpoint: name, key: null, status: 0, fixtureId: null });
      throw new Error(fault.networkError);
    }
    if (fault?.status) {
      return this.#record(name, null, null, { status: fault.status, headers: fault.headers ?? {}, body: fault.body ?? '' });
    }

    const value = requestValue(this.#pack, req);
    const validate = this.#contract.siteValidator(this.site, endpoint.request);
    if (!validate(value)) {
      const broken = errorFields(validate.errors ?? []);
      const observed = this.#observed.find((f) => f.endpoint === name &&
        f.trigger!.fields.some((t) => broken.some((b) => b === t || t.startsWith(b + '.') || b.startsWith(t + '.'))));
      if (observed) return this.#record(name, null, observed.id, toResponse(observed));
      return this.#record(name, null, null, {
        status: 400, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'FakeHost: request breaks the contract', details: describeErrors(validate.errors) }),
      });
    }

    const key = matchKey(endpoint, value);
    const fixture = this.#byKey.get(`${name} ${key}`);
    if (!fixture) {
      const known = [...this.#byKey.keys()].filter((k) => k.startsWith(name + ' ')).map((k) => '  ' + k.slice(name.length + 1));
      throw new Error(`FakeHost: no ${name} fixture matches\n  ${key}\nRecorded ${name} requests:\n${known.join('\n') || '  (none)'}`);
    }
    return this.#record(name, key, fixture.id, toResponse(fixture));
  }

  #takeFault(endpoint: string): Fault | undefined {
    const i = this.#faults.findIndex((f) => !f.endpoint || f.endpoint === endpoint);
    if (i < 0) return undefined;
    const fault = this.#faults[i]!;
    fault.times -= 1;
    if (fault.times <= 0) this.#faults.splice(i, 1);
    return fault;
  }

  #record(endpoint: string, key: string | null, fixtureId: string | null, res: HostResponse): HostResponse {
    this.calls.push({ endpoint, key, status: res.status, fixtureId });
    return res;
  }
}
