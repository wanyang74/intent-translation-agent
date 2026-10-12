// The Carvana fixture format, and how a request is matched to a fixture.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Endpoint = 'search' | 'facets' | 'suggest' | 'availability' | 'pricing' | 'reviews' | 'gap';

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
  endpoint: Endpoint;
  /** recorded: real traffic. observed: an error seen live in phase 0, rebuilt from a recorded request. synthetic: an edited copy for a failure not seen yet. */
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
  endpoint: Endpoint;
  kind: Fixture['kind'];
  description: string;
  file: string;
}

export const fixtureDir = fileURLToPath(new URL('../fixtures/carvana/', import.meta.url));

export function loadFixtures(dir: string = fixtureDir): Fixture[] {
  const index: FixtureIndexEntry[] = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
  return index.map((e) => JSON.parse(readFileSync(path.join(dir, e.file), 'utf8')) as Fixture);
}

const ROUTES: [Endpoint, RegExp][] = [
  ['facets', /^\/merch\/search\/api\/v2\/search\/facets$/],
  ['search', /^\/merch\/search\/api\/v2\/search$/],
  ['suggest', /^\/merch\/search\/api\/v1\/suggest\/filters$/],
  ['availability', /^\/merch\/buffering\/api\/v1\/soonestavailabilitybulk$/],
  ['pricing', /^\/merch\/search\/api\/v2\/pricing\/vehicle$/],
  ['reviews', /^\/merch\/reviews\/api\/review\/sv$/],
  ['gap', /^\/ancillary-products-api\/api\/v2\/GapWaiver\/availability$/],
];

export function endpointOf(url: string): Endpoint | null {
  const { pathname } = new URL(url);
  return ROUTES.find(([, re]) => re.test(pathname))?.[0] ?? null;
}

/** The request as a value: the JSON body, or the query parameters for GET endpoints. */
export function requestValue(req: { method: string; url: string; body?: unknown }): unknown {
  if (req.method === 'GET') return Object.fromEntries(new URL(req.url).searchParams);
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? null;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined && !(Array.isArray(x) && x.length === 0))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

const canon = (v: unknown) => JSON.stringify(sortKeys(v));

/**
 * The fields that decide which response a request gets. Tracking fields and IDs are left out,
 * so a request with fresh IDs still matches the recorded one.
 */
export function keyOf(endpoint: Endpoint, value: unknown): string {
  const b = (value ?? {}) as Record<string, any>;
  switch (endpoint) {
    case 'search':
      return canon({ filters: b.filters, page: b.pagination?.page, sortBy: b.sortBy, zip5: b.zip5 });
    case 'facets':
    case 'suggest':
      return canon({ filters: b.filters, zip5: b.zip5 });
    case 'availability':
      return canon({ vehicleIds: (b.vehicles ?? []).map((v: { vehicleId: number }) => v.vehicleId).sort((x: number, y: number) => x - y), zip: b.zipCode });
    case 'pricing':
      return canon({ vehicleId: b.vehicleId, routeId: b.routeId, zip5: b.zip5 });
    case 'reviews':
      return canon({ make: b.make, model: b.model, trim: b.trim, year: b.year, from: b.from, size: b.size });
    case 'gap':
      return canon({ vehicleId: b.vehicleId, amountFinanced: b.amountFinanced, homeState: b.homeState });
  }
}
