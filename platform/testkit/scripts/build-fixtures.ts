// Builds a site's fixture library from its HAR recordings, read in the order the site pack lists them.
//   recorded:  real traffic for the site pack's JSON endpoints, copied as recorded, with the identifiers the site
//              pack lists (recording.scrubFields, recording.scrubHeaders) replaced by fixed placeholders. A request
//              that FakeHost can't tell from one already kept (same match key) is skipped: it could never be served
//   pages:     for endpoints whose response is a page (responseFormat: html), only the part the site's hooks keep
//              (sites/<id>/fixture-hooks.ts, page), since a page can carry the visitor's own data; without the hook,
//              pages are left out
//   observed and synthetic: added by the site's hooks, if it has them
// The output is deterministic: rebuilding from the same recordings gives identical files, and adding a recording at
// the end of the list leaves the fixtures from the earlier ones as they were. Before keeping the
// output, it checks that no identifier from the recording survives: neither the scrubbed values nor
// ID-like tokens from the headers it dropped.
// Usage: node platform/testkit/scripts/build-fixtures.ts <site> [path/to/recording.har[,more.har]] [output folder]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadContract } from '../../contract/src/load.ts';
import { endpointOf, matchKey, repoRoot, requestValue } from '../../contract/src/site-pack.ts';
import { type DeriveContext, type Fixture, type FixtureHooks, type FixtureIndexEntry, fixtureDir, normalizeFixture } from '../src/fixtures.ts';

const [site, harArg, outArg] = process.argv.slice(2);
if (!site) {
  console.error('Usage: node platform/testkit/scripts/build-fixtures.ts <site> [path/to/recording.har[,more.har]] [output folder]');
  process.exit(2);
}
const { pack, dir: siteDir } = loadContract({ sites: [site] }).sites[site]!;
const harPaths = harArg ? harArg.split(',') : (pack.recording.hars ?? []).map((file) => path.join(repoRoot, file));
const missing = harPaths.filter((file) => !existsSync(file));
if (!harPaths.length || missing.length) {
  console.error(`No recording for ${site}${missing.length ? ` at ${missing.join(', ')}` : ''}: pass HAR files, or list them in recording.hars in sites/${site}/site.yaml and put them there.`);
  process.exit(1);
}
const outDir = outArg ?? fixtureDir(site);
const hooksFile = path.join(siteDir, 'fixture-hooks.ts');
const hooks: FixtureHooks = existsSync(hooksFile) ? await import(pathToFileURL(hooksFile).href) : {};

const lower = (xs: string[]) => new Set(xs.map((item) => item.toLowerCase()));
const scrubFields = new Set(pack.recording.scrubFields);
const scrubHeaders = lower(pack.recording.scrubHeaders);
const keepHeaders = lower(pack.recording.keepHeaders);

// One placeholder per distinct identifier, numbered in order of first appearance,
// so links between requests (one response's request ID sent back in the next request) survive.
const placeholders = new Map<string, string>();
function placeholder(value: string): string {
  if (!value) return value;
  let replacement = placeholders.get(value);
  if (!replacement) {
    replacement = `00000000-0000-4000-8000-${String(placeholders.size + 1).padStart(12, '0')}`;
    placeholders.set(value, replacement);
  }
  return replacement;
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, fieldValue]) => [key, scrubFields.has(key) && typeof fieldValue === 'string' ? placeholder(fieldValue) : scrub(fieldValue)]));
  }
  return value;
}

function scrubUrl(url: string): string {
  const address = new URL(url);
  const names = [...address.searchParams.keys()].filter((key) => scrubFields.has(key));
  if (!names.length) return url;
  for (const key of names) address.searchParams.set(key, placeholder(address.searchParams.get(key)!));
  return address.toString();
}

function scrubHeaderList(headers: { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of headers) {
    const lowerName = name.toLowerCase();
    if (keepHeaders.has(lowerName)) out[lowerName] = scrubHeaders.has(lowerName) ? placeholder(value) : value;
  }
  return Object.fromEntries(Object.entries(out).sort(([left], [right]) => (left < right ? -1 : 1)));
}

// ---------------------------------------------------------------- recorded traffic
const recorded: Fixture[] = [];
const used: any[] = [];
const counters = new Map<string, number>();
const seenKeys = new Map<string, string>();
let skippedHtml = 0;
let skippedRepeats = 0;

for (const harPath of harPaths) {
  const entries = JSON.parse(readFileSync(harPath, 'utf8')).log.entries;
  for (const [i, entry] of entries.entries()) {
    const match = endpointOf(pack, entry.request.url);
    if (!match || entry.response.status !== 200 || entry.request.method !== match.endpoint.method) continue;
    const { name: endpoint } = match;
    const isPage = (match.endpoint.responseFormat ?? 'json') === 'html';
    const page = isPage ? hooks.page?.(endpoint, entry.response.content.text) ?? null : null;
    if (isPage && page === null) { skippedHtml++; continue; }

    const method = entry.request.method as 'GET' | 'POST';
    const url = scrubUrl(entry.request.url);
    const body = method === 'GET' ? null : scrub(JSON.parse(entry.request.postData.text));
    const value = requestValue(pack, { method, url, body });
    // The same request again (a page reloaded, a car opened twice): FakeHost would always serve the first.
    const key = `${endpoint} ${matchKey(match.endpoint, value)}`;
    if (seenKeys.has(key)) { skippedRepeats++; continue; }
    const response = isPage ? page : scrub(JSON.parse(entry.response.content.text));
    const count = (counters.get(endpoint) ?? 0) + 1;
    counters.set(endpoint, count);
    const id = `${endpoint}-${String(count).padStart(2, '0')}`;
    seenKeys.set(key, id);

    used.push(entry);
    recorded.push({
      id, site, endpoint, kind: 'recorded',
      source: `recording ${String(entry.startedDateTime).slice(0, 10)}, HAR entry ${i}`,
      description: hooks.describe?.(endpoint, value, response) ?? `${method} ${endpoint}`,
      request: { method, url, headers: scrubHeaderList(entry.request.headers), body },
      response: { status: 200, headers: { 'content-type': isPage ? 'text/html' : 'application/json' }, body: response },
    });
  }
}

// ---------------------------------------------------------------- fixtures the site derives from them
const ctx: DeriveContext = {
  site,
  recorded,
  first(endpoint) {
    const fixture = recorded.find((candidate) => candidate.endpoint === endpoint);
    if (!fixture) throw new Error(`no recorded ${endpoint} fixture to derive from`);
    return structuredClone(fixture);
  },
  placeholder,
};
const derived = (hooks.derive?.(ctx) ?? []).map((fixture) => ({ ...fixture, site }));
const fixtures = [...recorded, ...derived].map(normalizeFixture);
const ids = fixtures.map((fixture) => fixture.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) throw new Error(`Duplicate fixture ids: ${dupes.join(', ')}`);

// ---------------------------------------------------------------- write, then check nothing identifying leaked
rmSync(outDir, { recursive: true, force: true });
const index: FixtureIndexEntry[] = [];
for (const fixture of fixtures) {
  const file = `${fixture.endpoint}/${fixture.id}.json`;
  mkdirSync(path.join(outDir, fixture.endpoint), { recursive: true });
  writeFileSync(path.join(outDir, file), JSON.stringify(fixture, null, 2) + '\n');
  index.push({ id: fixture.id, endpoint: fixture.endpoint, kind: fixture.kind, description: fixture.description, file });
}
writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');

// UUIDs, long hex strings and long digit strings in the headers that weren't kept as they are:
// session, trace and visitor IDs the site pack doesn't list must not turn up in a body either.
const ID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{16,}\b|\b\d{12,}\b/gi;
const droppedTokens = used.flatMap((entry) => [...entry.request.headers, ...entry.response.headers]
  .filter((header: { name: string }) => !header.name.startsWith(':') && (!keepHeaders.has(header.name.toLowerCase()) || scrubHeaders.has(header.name.toLowerCase())))
  .flatMap((header: { value: string }) => header.value.match(ID_LIKE) ?? []));
const written = index.map((entry) => readFileSync(path.join(outDir, entry.file), 'utf8')).join('\n');
const leaks = [...new Set([...placeholders.keys(), ...droppedTokens])].filter((value) => value.length > 8 && written.includes(value));
if (leaks.length) {
  console.error(`Aborting: ${leaks.length} identifier(s) from the recording remain in the fixtures. Add the fields to recording.scrubFields.`);
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

const byKind = fixtures.reduce<Record<string, number>>((acc, fixture) => ({ ...acc, [fixture.kind]: (acc[fixture.kind] ?? 0) + 1 }), {});
console.log(`Wrote ${fixtures.length} ${site} fixtures (${Object.entries(byKind).map(([kind, count]) => `${count} ${kind}`).join(', ')}) to ${path.relative(process.cwd(), outDir)}`);
if (skippedRepeats) console.log(`Skipped ${skippedRepeats} repeated request(s): FakeHost serves the first of each.`);
if (skippedHtml) console.log(`Skipped ${skippedHtml} page(s): the site's fixture hooks keep no part of them.`);
console.log(`Replaced ${placeholders.size} identifiers with placeholders; no identifier from the recording remains.`);
