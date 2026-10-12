// FakeHost: stands in for Carvana's network in tests. It answers requests from the fixture library.
//   1. Requests are checked against the contract first. A request that breaks it gets the error Carvana
//      was seen returning for that broken field (observed fixtures), or a generic 400.
//   2. Valid requests are matched to a fixture by the fields that decide the response (see keyOf).
//      No match is a test failure, never a silent default.
//   3. Faults can be injected: a status, a delay, or a network error, for the next N calls.
import { loadContract, describeErrors } from '../../contract/src/load.ts';
import type { ErrorObject } from 'ajv/dist/2020.js';
import { type Endpoint, type Fixture, type HostRequest, type HostResponse, endpointOf, keyOf, loadFixtures, requestValue } from './fixtures.ts';

export interface Fault {
  /** Only calls to this endpoint; any endpoint if omitted. */
  endpoint?: Endpoint;
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
  endpoint: Endpoint;
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
  readonly calls: CallRecord[] = [];
  #byKey = new Map<string, Fixture>();
  #observed: Fixture[] = [];
  #faults: (Fault & { times: number })[] = [];
  #contract = loadContract();

  constructor(fixtures: Fixture[] = loadFixtures()) {
    for (const f of fixtures) {
      if (f.trigger) { this.#observed.push(f); continue; }
      const key = `${f.endpoint} ${keyOf(f.endpoint, requestValue(f.request))}`;
      if (!this.#byKey.has(key)) this.#byKey.set(key, f);
    }
  }

  /** Make the next matching call(s) fail or slow down. */
  inject(fault: Fault): void {
    this.#faults.push({ times: 1, ...fault });
  }

  async request(req: HostRequest): Promise<HostResponse> {
    const endpoint = endpointOf(req.url);
    if (!endpoint) throw new Error(`FakeHost: no Carvana endpoint matches ${req.method} ${req.url}`);

    const fault = this.#takeFault(endpoint);
    if (fault?.delayMs) await sleep(fault.delayMs);
    if (fault?.networkError) {
      this.calls.push({ endpoint, key: null, status: 0, fixtureId: null });
      throw new Error(fault.networkError);
    }
    if (fault?.status) {
      return this.#record(endpoint, null, null, { status: fault.status, headers: fault.headers ?? {}, body: fault.body ?? '' });
    }

    const value = requestValue(req);
    const validate = this.#contract.validator(`carvana/${endpoint}.request.json`);
    if (!validate(value)) {
      const broken = errorFields(validate.errors ?? []);
      const observed = this.#observed.find((f) => f.endpoint === endpoint &&
        f.trigger!.fields.some((t) => broken.some((b) => b === t || t.startsWith(b + '.') || b.startsWith(t + '.'))));
      if (observed) return this.#record(endpoint, null, observed.id, toResponse(observed));
      return this.#record(endpoint, null, null, {
        status: 400, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'FakeHost: request breaks the contract', details: describeErrors(validate.errors) }),
      });
    }

    const key = keyOf(endpoint, value);
    const fixture = this.#byKey.get(`${endpoint} ${key}`);
    if (!fixture) {
      const known = [...this.#byKey.keys()].filter((k) => k.startsWith(endpoint + ' ')).map((k) => '  ' + k.slice(endpoint.length + 1));
      throw new Error(`FakeHost: no ${endpoint} fixture matches\n  ${key}\nRecorded ${endpoint} requests:\n${known.join('\n')}`);
    }
    return this.#record(endpoint, key, fixture.id, toResponse(fixture));
  }

  #takeFault(endpoint: Endpoint): Fault | undefined {
    const i = this.#faults.findIndex((f) => !f.endpoint || f.endpoint === endpoint);
    if (i < 0) return undefined;
    const fault = this.#faults[i]!;
    fault.times -= 1;
    if (fault.times <= 0) this.#faults.splice(i, 1);
    return fault;
  }

  #record(endpoint: Endpoint, key: string | null, fixtureId: string | null, res: HostResponse): HostResponse {
    this.calls.push({ endpoint, key, status: res.status, fixtureId });
    return res;
  }
}
