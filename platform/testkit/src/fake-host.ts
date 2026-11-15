// FakeHost: stands in for a site's network in tests. It answers requests from the site's fixture library.
//   1. Requests are checked against the site's endpoint schemas first. A request that breaks the contract gets
//      the error the site was seen returning for that broken field (observed fixtures), or a generic 400.
//   2. Valid requests are matched to a fixture by the fields that decide the response (the endpoint's matchKey
//      in the site pack). No match is a test failure, never a silent default.
//   3. Faults can be injected: a status, a delay, or a network error, for the next N calls.
//   4. For a site with a token (the site pack's token section), every other call must carry, in the token's header, a
//      token one of the token endpoint's fixtures issues, or it's refused with the site's first refused status, as the
//      real site refuses it. So a test sees a missing or misformatted token header, not a silent pass. Where the
//      token rule says signedIn: page, a call to an endpoint that needs sign-in must carry the test page's signed-in
//      token (FAKE_PAGE_TOKEN) instead, so a tool that sent the anonymous one fails as it would on the real site.
// A response is sent the way the site sends it: a stream's fixture holds its events, and they go out as a stream.
import type { ErrorObject } from 'ajv/dist/2020.js';
import { loadContract, describeErrors, type Contract } from '../../contract/src/load.ts';
import { select } from '../../contract/src/paths.ts';
import { endpointOf, matchKey, requestValue, type Endpoint, type SitePack } from '../../contract/src/site-pack.ts';
import { type Fixture, type HostRequest, type HostResponse, loadFixtures, responseText } from './fixtures.ts';

/** The made-up signed-in token a test page keeps (Host.pageToken in tests), unless a test says otherwise. */
export const FAKE_PAGE_TOKEN = 'fixture-page-token-0001';

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toResponse = (fixture: Fixture, endpoint: Endpoint): HostResponse => ({
  status: fixture.response.status,
  headers: fixture.response.headers,
  body: responseText(fixture, endpoint),
});

/** Dotted paths of the fields an Ajv error list complains about, e.g. "analyticsData.clientId". */
function errorFields(errors: ErrorObject[]): string[] {
  return errors.map((problem) => {
    const base = problem.instancePath.split('/').filter(Boolean);
    if (problem.keyword === 'required') base.push(String((problem.params as { missingProperty: string }).missingProperty));
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
  /** The token header values the site would accept: one per token its token endpoint's fixtures issue. */
  #acceptedTokens = new Set<string>();

  constructor(site: string, fixtures: Fixture[] = loadFixtures(site)) {
    this.site = site;
    this.#contract = loadContract({ sites: [site] });
    this.#pack = this.#contract.sites[site]!.pack;
    for (const fixture of fixtures) {
      if (fixture.trigger) { this.#observed.push(fixture); continue; }
      const endpoint = this.#pack.endpoints[fixture.endpoint];
      if (!endpoint) throw new Error(`FakeHost: fixture ${fixture.id} names endpoint ${fixture.endpoint}, which ${site} doesn't have`);
      const key = `${fixture.endpoint} ${matchKey(endpoint, requestValue(this.#pack, fixture.request))}`;
      if (!this.#byKey.has(key)) this.#byKey.set(key, fixture);
    }
    const rule = this.#pack.token;
    for (const fixture of fixtures.filter((candidate) => rule && candidate.endpoint === rule.endpoint && candidate.response.status === 200)) {
      const token = select(fixture.response.body, rule!.value);
      if (typeof token === 'string') this.#acceptedTokens.add((rule!.format ?? '{token}').replace('{token}', token));
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
    const rule = this.#pack.token;
    if (rule && name !== rule.endpoint) {
      const sent = Object.entries(req.headers ?? {}).find(([header]) => header.toLowerCase() === rule.header.toLowerCase())?.[1];
      const pageSigned = rule.signedIn?.from === 'page' && endpoint.signIn === true;
      const accepted = pageSigned ? sent === (rule.format ?? '{token}').replace('{token}', FAKE_PAGE_TOKEN) : sent !== undefined && this.#acceptedTokens.has(sent);
      if (!accepted) return this.#record(name, null, null, { status: rule.refusedStatuses[0], headers: {}, body: '' });
    }

    const value = requestValue(this.#pack, req);
    const validate = this.#contract.siteValidator(this.site, endpoint.request);
    if (!validate(value)) {
      const broken = errorFields(validate.errors ?? []);
      const observed = this.#observed.find((recorded) => recorded.endpoint === name &&
        recorded.trigger!.fields.some((field) => broken.some((brokenField) => brokenField === field || field.startsWith(brokenField + '.') || brokenField.startsWith(field + '.'))));
      if (observed) return this.#record(name, null, observed.id, toResponse(observed, endpoint));
      return this.#record(name, null, null, {
        status: 400, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'FakeHost: request breaks the contract', details: describeErrors(validate.errors) }),
      });
    }

    const key = matchKey(endpoint, value);
    const fixture = this.#byKey.get(`${name} ${key}`);
    if (!fixture) {
      const known = [...this.#byKey.keys()].filter((fixtureKey) => fixtureKey.startsWith(name + ' ')).map((fixtureKey) => '  ' + fixtureKey.slice(name.length + 1));
      throw new Error(`FakeHost: no ${name} fixture matches\n  ${key}\nRecorded ${name} requests:\n${known.join('\n') || '  (none)'}`);
    }
    return this.#record(name, key, fixture.id, toResponse(fixture, endpoint));
  }

  #takeFault(endpoint: string): Fault | undefined {
    const i = this.#faults.findIndex((candidate) => !candidate.endpoint || candidate.endpoint === endpoint);
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
