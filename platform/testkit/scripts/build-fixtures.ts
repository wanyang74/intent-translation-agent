// Builds a site's fixture library from its HAR recording.
//   recorded:  real traffic for the site pack's JSON endpoints, copied as recorded, with the identifiers the site
//              pack lists (recording.scrubFields, recording.scrubHeaders) replaced by fixed placeholders
//   observed and synthetic: added by the site's hooks, sites/<id>/fixture-hooks.ts, if it has them
// The output is deterministic: rebuilding from the same recording gives identical files. Before keeping the
// output, it checks that no identifier from the recording survives: neither the scrubbed values nor
// ID-like tokens from the headers it dropped.
// Usage: node platform/testkit/scripts/build-fixtures.ts <site> [path/to/recording.har] [output folder]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadContract } from '../../contract/src/load.ts';
import { endpointOf, matchKey, repoRoot, requestValue } from '../../contract/src/site-pack.ts';
import { type DeriveContext, type Fixture, type FixtureHooks, type FixtureIndexEntry, fixtureDir, normalizeFixture } from '../src/fixtures.ts';

const [site, harArg, outArg] = process.argv.slice(2);
if (!site) {
  console.error('Usage: node platform/testkit/scripts/build-fixtures.ts <site> [path/to/recording.har] [output folder]');
  process.exit(2);
}
const { pack, dir: siteDir } = loadContract({ sites: [site] }).sites[site]!;
const harPath = harArg ?? (pack.recording.har ? path.join(repoRoot, pack.recording.har) : undefined);
if (!harPath || !existsSync(harPath)) {
  console.error(`No recording for ${site}: pass a HAR file, or set recording.har in sites/${site}/site.yaml and put the file there.`);
  process.exit(1);
}
const outDir = outArg ?? fixtureDir(site);
const hooksFile = path.join(siteDir, 'fixture-hooks.ts');
const hooks: FixtureHooks = existsSync(hooksFile) ? await import(pathToFileURL(hooksFile).href) : {};

const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
const scrubFields = new Set(pack.recording.scrubFields);
const scrubHeaders = lower(pack.recording.scrubHeaders);
const keepHeaders = lower(pack.recording.keepHeaders);

// One placeholder per distinct identifier, numbered in order of first appearance,
// so links between requests (one response's request ID sent back in the next request) survive.
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
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubFields.has(k) && typeof v === 'string' ? placeholder(v) : scrub(v)]));
  }
  return value;
}

function scrubUrl(url: string): string {
  const u = new URL(url);
  const names = [...u.searchParams.keys()].filter((k) => scrubFields.has(k));
  if (!names.length) return url;
  for (const k of names) u.searchParams.set(k, placeholder(u.searchParams.get(k)!));
  return u.toString();
}

function scrubHeaderList(headers: { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of headers) {
    const n = name.toLowerCase();
    if (keepHeaders.has(n)) out[n] = scrubHeaders.has(n) ? placeholder(value) : value;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---------------------------------------------------------------- recorded traffic
const entries = JSON.parse(readFileSync(harPath, 'utf8')).log.entries;
const recorded: Fixture[] = [];
const used: any[] = [];
const counters = new Map<string, number>();
const seenKeys = new Map<string, string>();
let skippedHtml = 0;

for (const [i, e] of entries.entries()) {
  const match = endpointOf(pack, e.request.url);
  if (!match || e.response.status !== 200 || e.request.method !== match.endpoint.method) continue;
  if ((match.endpoint.responseFormat ?? 'json') !== 'json') { skippedHtml++; continue; }
  const { name: endpoint } = match;

  const method = e.request.method as 'GET' | 'POST';
  const url = scrubUrl(e.request.url);
  const body = method === 'GET' ? null : scrub(JSON.parse(e.request.postData.text));
  const response = scrub(JSON.parse(e.response.content.text));
  const n = (counters.get(endpoint) ?? 0) + 1;
  counters.set(endpoint, n);
  const id = `${endpoint}-${String(n).padStart(2, '0')}`;
  const value = requestValue(pack, { method, url, body });

  const key = `${endpoint} ${matchKey(match.endpoint, value)}`;
  if (seenKeys.has(key)) console.warn(`warning: ${id} has the same match key as ${seenKeys.get(key)}; FakeHost will use the first`);
  else seenKeys.set(key, id);

  used.push(e);
  recorded.push({
    id, site, endpoint, kind: 'recorded',
    source: `recording ${String(e.startedDateTime).slice(0, 10)}, HAR entry ${i}`,
    description: hooks.describe?.(endpoint, value, response) ?? `${method} ${endpoint}`,
    request: { method, url, headers: scrubHeaderList(e.request.headers), body },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: response },
  });
}

// ---------------------------------------------------------------- fixtures the site derives from them
const ctx: DeriveContext = {
  site,
  recorded,
  first(endpoint) {
    const f = recorded.find((x) => x.endpoint === endpoint);
    if (!f) throw new Error(`no recorded ${endpoint} fixture to derive from`);
    return structuredClone(f);
  },
  placeholder,
};
const derived = (hooks.derive?.(ctx) ?? []).map((f) => ({ ...f, site }));
const fixtures = [...recorded, ...derived].map(normalizeFixture);
const ids = fixtures.map((f) => f.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) throw new Error(`Duplicate fixture ids: ${dupes.join(', ')}`);

// ---------------------------------------------------------------- write, then check nothing identifying leaked
rmSync(outDir, { recursive: true, force: true });
const index: FixtureIndexEntry[] = [];
for (const f of fixtures) {
  const file = `${f.endpoint}/${f.id}.json`;
  mkdirSync(path.join(outDir, f.endpoint), { recursive: true });
  writeFileSync(path.join(outDir, file), JSON.stringify(f, null, 2) + '\n');
  index.push({ id: f.id, endpoint: f.endpoint, kind: f.kind, description: f.description, file });
}
writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');

// UUIDs, long hex strings and long digit strings in the headers that weren't kept as they are:
// session, trace and visitor IDs the site pack doesn't list must not turn up in a body either.
const ID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{16,}\b|\b\d{12,}\b/gi;
const droppedTokens = used.flatMap((e) => [...e.request.headers, ...e.response.headers]
  .filter((h: { name: string }) => !h.name.startsWith(':') && (!keepHeaders.has(h.name.toLowerCase()) || scrubHeaders.has(h.name.toLowerCase())))
  .flatMap((h: { value: string }) => h.value.match(ID_LIKE) ?? []));
const written = index.map((e) => readFileSync(path.join(outDir, e.file), 'utf8')).join('\n');
const leaks = [...new Set([...placeholders.keys(), ...droppedTokens])].filter((v) => v.length > 8 && written.includes(v));
if (leaks.length) {
  console.error(`Aborting: ${leaks.length} identifier(s) from the recording remain in the fixtures. Add the fields to recording.scrubFields.`);
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

const byKind = fixtures.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {});
console.log(`Wrote ${fixtures.length} ${site} fixtures (${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ')}) to ${path.relative(process.cwd(), outDir)}`);
if (skippedHtml) console.log(`Skipped ${skippedHtml} HTML page(s): their fixtures hold parsed output and come from the site's own tests.`);
console.log(`Replaced ${placeholders.size} identifiers with placeholders; no identifier from the recording remains.`);
