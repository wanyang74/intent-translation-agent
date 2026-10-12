// Builds the Carvana fixture library from a HAR recording.
//   recorded:  real traffic, copied as recorded, with visitor, session and request IDs replaced by fixed placeholders
//   observed:  errors seen live in phase 0 (2026-10-11), rebuilt from a recorded request
//   synthetic: edited copies of recorded traffic for failures we expect but haven't seen
// The output is deterministic: rebuilding from the same recording gives identical files.
// Usage: node testkit/scripts/build-fixtures.ts [path/to/recording.har] [output folder]
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Endpoint, type Fixture, type FixtureIndexEntry, endpointOf, fixtureDir, keyOf, requestValue } from '../src/fixtures.ts';

const harPath = process.argv[2] ?? fileURLToPath(new URL('../../recordings/www.carvana.com.har', import.meta.url));
const outDir = process.argv[3] ?? fixtureDir;
const recordedOn = '2026-10-08';

const KEEP_HEADERS = ['accept', 'content-type', 'clientid', 'browsercookieid', 'correlationid', 'x-cvna-ncc-disabled', 'x-cvna-sebs-srp'];
const ID_FIELDS = new Set(['browserCookieId', 'searchSessionId', 'searchRequestId', 'previousSearchRequestId', 'correlationId', 'suggestedFiltersRequestId', 'traceId']);
const ID_HEADERS = new Set(['browsercookieid', 'correlationid']);

// One placeholder per distinct identifier, numbered in order of first appearance,
// so links between requests (previousSearchRequestId -> searchRequestId) survive.
const placeholders = new Map<string, string>();
function placeholder(v: string): string {
  if (!v) return v;
  let p = placeholders.get(v);
  if (!p) {
    p = `00000000-0000-4000-8000-${String(placeholders.size + 1).padStart(12, '0')}`;
    placeholders.set(v, p);
  }
  return p;
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ID_FIELDS.has(k) && typeof v === 'string' ? placeholder(v) : scrub(v)]));
  }
  return value;
}

function scrubHeaders(headers: { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of headers) {
    const n = name.toLowerCase();
    if (KEEP_HEADERS.includes(n)) out[n] = ID_HEADERS.has(n) ? placeholder(value) : value;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function describeFilters(f: Record<string, any> = {}): string {
  const parts: string[] = [];
  for (const m of f.makes ?? []) parts.push([m.name, ...(m.parentModels ?? []).map((p: { name: string }) => p.name)].join(' '));
  if (f.year?.min) parts.push(`${f.year.min} or newer`);
  if (f.mileage?.max) parts.push(`under ${f.mileage.max} mi`);
  if (f.price?.max) parts.push(`under $${f.price.max}`);
  if (f.colors?.length) parts.push(f.colors.join('/'));
  if (f.interiorColors?.length) parts.push(`${f.interiorColors.join('/')} interior`);
  if (f.driveTypes?.length) parts.push(f.driveTypes.join('/'));
  return parts.join(' · ') || 'no filters';
}

function describe(endpoint: Endpoint, req: Record<string, any>, res: Record<string, any>): string {
  switch (endpoint) {
    case 'search': return `${describeFilters(req.filters)}, page ${req.pagination?.page}: ${res.inventory?.vehicles?.length} cars of ${res.inventory?.pagination?.totalMatchedInventory}`;
    case 'facets': return `${describeFilters(req.filters)}: valid filter values`;
    case 'suggest': return `${describeFilters(req.filters)}: ${res.suggestedFilters?.length} suggestions`;
    case 'availability': return `${req.vehicles?.length} car${req.vehicles?.length === 1 ? '' : 's'}, ${'userId' in req ? 'search-page' : 'vehicle-page'} shape`;
    case 'pricing': return `car ${req.vehicleId}, delivery route, zip ${req.zip5}`;
    case 'reviews': return `${req.year} ${req.make} ${req.model} ${req.trim}`;
    case 'gap': return `car ${req.vehicleId}, ${req.amountFinanced} financed`;
  }
}

// ---------------------------------------------------------------- recorded traffic
const entries = JSON.parse(readFileSync(harPath, 'utf8')).log.entries;
const fixtures: Fixture[] = [];
const counters: Partial<Record<Endpoint, number>> = {};
const seenKeys = new Map<string, string>();

for (const [i, e] of entries.entries()) {
  const url: string = e.request.url;
  let endpoint: Endpoint | null = null;
  try { endpoint = endpointOf(url); } catch { endpoint = null; }
  if (!endpoint || e.response.status !== 200) continue;

  const method = e.request.method as 'GET' | 'POST';
  const body = method === 'GET' ? null : scrub(JSON.parse(e.request.postData.text));
  const response = scrub(JSON.parse(e.response.content.text)) as Record<string, any>;
  const n = (counters[endpoint] = (counters[endpoint] ?? 0) + 1);
  const id = `${endpoint}-${String(n).padStart(2, '0')}`;
  const value = requestValue({ method, url, body }) as Record<string, any>;

  const key = `${endpoint} ${keyOf(endpoint, value)}`;
  if (seenKeys.has(key)) console.warn(`warning: ${id} has the same match key as ${seenKeys.get(key)}; FakeHost will use the first`);
  else seenKeys.set(key, id);

  fixtures.push({
    id, endpoint, kind: 'recorded',
    source: `recording ${recordedOn}, HAR entry ${i}`,
    description: describe(endpoint, value, response),
    request: { method, url, headers: scrubHeaders(e.request.headers), body },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: response },
  });
}

// ---------------------------------------------------------------- derived error fixtures
const first = (ep: Endpoint) => {
  const f = fixtures.find((x) => x.endpoint === ep && x.kind === 'recorded');
  if (!f) throw new Error(`no recorded ${ep} fixture to derive from`);
  return structuredClone(f);
};
const without = (body: unknown, ...keys: string[]) => Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => !keys.includes(k)));
const PHASE0 = 'phase 0 live check, 2026-10-11';

{
  const f = first('pricing');
  fixtures.push({
    ...f, id: 'pricing-err-no-client-id', kind: 'observed', source: PHASE0, trigger: { fields: ['analyticsData.clientId'] },
    description: 'quote request without analyticsData.clientId: 400 "ClientId cannot be null"',
    request: { ...f.request, body: without(f.request.body, 'analyticsData', 'browserCookieId') },
    response: { status: 400, headers: { 'content-type': 'text/plain' }, body: 'ClientId cannot be null' },
  });
}
{
  const f = first('suggest');
  fixtures.push({
    ...f, id: 'suggest-err-no-ids', kind: 'observed', source: PHASE0, trigger: { fields: ['browserCookieId', 'analyticsData.clientId'] },
    description: 'suggestions request without a visitor ID and client ID: 400 "Invalid Request"',
    request: { ...f.request, body: without(f.request.body, 'analyticsData', 'browserCookieId') },
    response: { status: 400, headers: { 'content-type': 'text/plain' }, body: 'Invalid Request' },
  });
}
{
  const f = first('gap');
  const url = new URL(f.request.url);
  url.searchParams.set('amountFinanced', 'null');
  fixtures.push({
    ...f, id: 'gap-err-null-amount', kind: 'observed', source: PHASE0, trigger: { fields: ['amountFinanced'] },
    description: 'GAP waiver request with amountFinanced=null: 400 validation problem',
    request: { ...f.request, url: url.toString() },
    response: {
      status: 400, headers: { 'content-type': 'application/problem+json' },
      body: { type: 'https://tools.ietf.org/html/rfc7231#section-6.5.1', title: 'One or more validation errors occurred.', status: 400, traceId: placeholder('|8bf72f0f-48ab2b42fd05a20c.'), errors: { AmountFinanced: ["The value 'null' is not valid for AmountFinanced."] } },
    },
  });
}
{
  const f = first('search');
  const body = structuredClone(f.request.body) as Record<string, any>;
  body.filters = { makes: [{ name: 'Tesla' }], year: { min: 2026 }, mileage: { max: 100 } };
  const res = structuredClone(f.response.body) as Record<string, any>;
  res.inventory.vehicles = [];
  res.inventory.conditionalTiles = [];
  Object.assign(res.inventory.pagination, { totalMatchedInventory: 0, totalMatchedPages: 0 });
  fixtures.push({
    ...f, id: 'search-no-results', kind: 'synthetic', source: `edited copy of ${f.id}`,
    description: `${describeFilters(body.filters)}, page 1: no matching cars`,
    request: { ...f.request, body }, response: { ...f.response, body: res },
  });
}
{
  const f = first('availability');
  const body = structuredClone(f.request.body) as Record<string, any>;
  body.vehicles = body.vehicles.slice(0, 1);
  const res = structuredClone(f.response.body) as Record<string, any>;
  res.content = res.content.filter((c: { vehicleId: number }) => c.vehicleId === body.vehicles[0].vehicleId);
  res.content[0].soonestDelivery = { content: null, status: 'Failed', errorMessage: 'No delivery route available' };
  fixtures.push({
    ...f, id: 'availability-no-delivery', kind: 'synthetic', source: `edited copy of ${f.id}`,
    description: `1 car whose delivery option failed (pickup still available); the failure shape is a guess`,
    request: { ...f.request, body }, response: { ...f.response, body: res },
  });
}
{
  const f = first('pricing');
  const body = structuredClone(f.request.body) as Record<string, any>;
  body.zip5 = '99701';
  const res = structuredClone(f.response.body) as Record<string, any>;
  res.price.pricingErrorMessage = 'Unable to price vehicle for this location';
  res.errors = ['Unable to price vehicle for this location'];
  fixtures.push({
    ...f, id: 'pricing-error', kind: 'synthetic', source: `edited copy of ${f.id}`,
    description: `car ${body.vehicleId} at zip ${body.zip5}: Carvana couldn't price it; the error shape is a guess`,
    request: { ...f.request, body }, response: { ...f.response, body: res },
  });
}
{
  const f = first('search');
  const body = structuredClone(f.request.body) as Record<string, any>;
  body.pagination = { ...body.pagination, page: 30 };
  const res = structuredClone(f.response.body) as Record<string, any>;
  for (const v of res.inventory.vehicles) delete v.price.estimatedTaxesAndFees;
  fixtures.push({
    ...f, id: 'search-shape-changed', kind: 'synthetic', source: `edited copy of ${f.id}`, expect: 'contract_violation',
    description: 'search response missing price.estimatedTaxesAndFees on every car: a shape change the change monitor must catch',
    request: { ...f.request, body }, response: { ...f.response, body: res },
  });
}

// ---------------------------------------------------------------- write, then check nothing personal leaked
rmSync(outDir, { recursive: true, force: true });
const index: FixtureIndexEntry[] = [];
for (const f of fixtures) {
  const file = `${f.endpoint}/${f.id}.json`;
  mkdirSync(path.join(outDir, f.endpoint), { recursive: true });
  writeFileSync(path.join(outDir, file), JSON.stringify(f, null, 2) + '\n');
  index.push({ id: f.id, endpoint: f.endpoint, kind: f.kind, description: f.description, file });
}
writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');

const written = index.map((e) => readFileSync(path.join(outDir, e.file), 'utf8')).join('\n');
const sessionIds = entries.flatMap((e: any) => e.request.headers)
  .filter((h: { name: string }) => ['baggage', 'correlation-context'].includes(h.name.toLowerCase()))
  .map((h: { value: string }) => h.value.split('=').pop() as string);
const leaks = [...placeholders.keys(), ...sessionIds].filter((v) => v && v.length > 8 && written.includes(v));
if (leaks.length) {
  console.error(`Aborting: ${leaks.length} original identifier(s) remain in the fixtures.`);
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

const byKind = fixtures.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {});
console.log(`Wrote ${fixtures.length} fixtures (${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ')}) to ${path.relative(process.cwd(), outDir)}`);
console.log(`Replaced ${placeholders.size} identifiers with placeholders; no originals remain.`);
