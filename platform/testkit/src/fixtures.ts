// The fixture format every site pack uses, how fixtures are loaded, and the hooks a site can add to the builder.
// Fixtures live in sites/<id>/fixtures: one folder per endpoint, plus index.json. A response body is kept in the form
// easiest to read: JSON as JSON, a page as its text, a stream of events (responseFormat: sse) as the list of events.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { eventStreamText, groupEvents, type StreamEvent } from '../../contract/src/events.ts';
import { type Endpoint, sitesDir } from '../../contract/src/site-pack.ts';

export interface HostRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface HostResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Fixture {
  id: string;
  site: string;
  /** An endpoint name from the site pack. */
  endpoint: string;
  /** recorded: real traffic. observed: an error seen live, rebuilt from a recorded request. synthetic: an edited or hand-written copy for a case not recorded. */
  kind: 'recorded' | 'observed' | 'synthetic';
  source: string;
  description: string;
  /** Returned, instead of matching by key, when a request is missing one of these fields or has an invalid value in it. Dotted paths, e.g. "analyticsData.clientId". */
  trigger?: { fields: string[] };
  /** The response deliberately breaks the contract (for change-monitor tests). */
  expect?: 'contract_violation';
  request: { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body: unknown };
  /** body: JSON, a page's text, or for a stream the list of its events. */
  response: { status: number; headers: Record<string, string>; body: unknown };
}

/** A fixture's response as the site sends it: JSON as text, a page as it is, a list of events as a stream. */
export function responseText(fixture: Fixture, endpoint: Endpoint): string {
  const { body } = fixture.response;
  if (typeof body === 'string') return body;
  if ((endpoint.responseFormat ?? 'json') === 'sse' && Array.isArray(body)) return eventStreamText(body as StreamEvent[]);
  return JSON.stringify(body);
}

/**
 * A 200 response as core.js reads it, which is what the endpoint's response schema checks: JSON as it is, a stream's
 * events grouped by kind. A page needs the site's own reader, so a page fixture gives null here.
 */
export function responseValue(fixture: Fixture, endpoint: Endpoint): unknown {
  const format = endpoint.responseFormat ?? 'json';
  if (format === 'html') return null;
  if (format === 'sse') return groupEvents(fixture.response.body as StreamEvent[], endpoint.eventKind);
  return fixture.response.body;
}

export interface FixtureIndexEntry {
  id: string;
  endpoint: string;
  kind: Fixture['kind'];
  description: string;
  file: string;
}

/**
 * The token every fixture uses, for a site with a token (the site pack's token section): the token endpoint's fixture
 * issues it and every other fixture's request sends it, so FakeHost accepts a fixture's own request. A recorded token
 * never lands in a fixture.
 */
export const FIXTURE_TOKEN = 'fixture-token-0001';

export const fixtureDir = (site: string) => path.join(sitesDir, site, 'fixtures');

export const hasFixtures = (site: string) => existsSync(path.join(fixtureDir(site), 'index.json'));

export function loadFixtures(site: string, dir: string = fixtureDir(site)): Fixture[] {
  const index: FixtureIndexEntry[] = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
  return index.map((entry) => JSON.parse(readFileSync(path.join(dir, entry.file), 'utf8')) as Fixture);
}

/** The request as FakeHost receives it: JSON bodies as text. */
export const toHostRequest = (fixture: Fixture, body: unknown = fixture.request.body): HostRequest => ({
  method: fixture.request.method,
  url: fixture.request.url,
  headers: fixture.request.headers,
  body: body === null || body === undefined ? null : JSON.stringify(body),
});

/** A fixture with its keys in the standard order, so every builder writes identical files. */
export function normalizeFixture(fixture: Fixture): Fixture {
  const { id, site, endpoint, kind, source, description, trigger, expect, request, response } = fixture;
  return { id, site, endpoint, kind, source, description, ...(trigger ? { trigger } : {}), ...(expect ? { expect } : {}), request, response };
}

// ---------------------------------------------------------------- site hooks for the fixture builder

/** What a site's hooks get to derive extra fixtures from the recorded ones. */
export interface DeriveContext {
  site: string;
  recorded: readonly Fixture[];
  /** A copy of the first recorded fixture for an endpoint. */
  first(endpoint: string): Fixture;
  /** The placeholder for an identifier; the same value always gets the same placeholder. */
  placeholder(value: string): string;
}

/**
 * Optional module sites/<id>/fixture-hooks.ts. The builder works without it; a site adds it to describe its
 * traffic in its own terms and to add the errors it has seen live or expects.
 */
export interface FixtureHooks {
  /** One line for the index: what the request asks and what came back. */
  describe?(endpoint: string, request: any, response: any): string;
  /** Extra fixtures: errors seen live (observed) and failures expected but not seen yet (synthetic). */
  derive?(ctx: DeriveContext): Omit<Fixture, 'site'>[];
  /**
   * For a page endpoint (responseFormat: html): the part of a recorded page its fixture keeps, as a page the site's
   * parser reads the same way, or null to leave the page out. A page can carry the visitor's own data (location,
   * sign-in state, device), so pages become fixtures only through this hook, keeping only what the parser needs.
   */
  page?(endpoint: string, html: string): string | null;
  /**
   * For a streaming endpoint (responseFormat: sse): the events its fixture keeps. A recorded stream can be large (a
   * search sends every result), so a site can keep a few results and the events that frame them. Without the hook,
   * every event is kept.
   */
  stream?(endpoint: string, events: StreamEvent[]): StreamEvent[];
}
