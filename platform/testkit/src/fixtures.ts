// The fixture format every site pack uses, how fixtures are loaded, and the hooks a site can add to the builder.
// Fixtures live in sites/<id>/fixtures: one folder per endpoint, plus index.json.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sitesDir } from '../../contract/src/site-pack.ts';

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
  response: { status: number; headers: Record<string, string>; body: unknown };
}

export interface FixtureIndexEntry {
  id: string;
  endpoint: string;
  kind: Fixture['kind'];
  description: string;
  file: string;
}

export const fixtureDir = (site: string) => path.join(sitesDir, site, 'fixtures');

export const hasFixtures = (site: string) => existsSync(path.join(fixtureDir(site), 'index.json'));

export function loadFixtures(site: string, dir: string = fixtureDir(site)): Fixture[] {
  const index: FixtureIndexEntry[] = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
  return index.map((e) => JSON.parse(readFileSync(path.join(dir, e.file), 'utf8')) as Fixture);
}

/** The request as FakeHost receives it: JSON bodies as text. */
export const toHostRequest = (f: Fixture, body: unknown = f.request.body): HostRequest => ({
  method: f.request.method,
  url: f.request.url,
  headers: f.request.headers,
  body: body === null || body === undefined ? null : JSON.stringify(body),
});

/** A fixture with its keys in the standard order, so every builder writes identical files. */
export function normalizeFixture(f: Fixture): Fixture {
  const { id, site, endpoint, kind, source, description, trigger, expect, request, response } = f;
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
}
