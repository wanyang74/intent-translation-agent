// Contract check:
//   1. every schema compiles (Ajv, JSON Schema 2020-12, strict mode)
//   2. every schema's $id matches its file path
//   3. every example inside a schema validates against it
//   4. every must-reject case is rejected
//   5. if the HAR recording is present, every recorded Carvana request and response validates
//      against the matching endpoint schema
// Exits with code 1 on any failure.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASE, loadContract, describeErrors } from '../src/load.ts';
import { mustReject } from '../src/cases.ts';

const harPath = fileURLToPath(new URL('../../recordings/www.carvana.com.har', import.meta.url));
const { schemas, validator } = loadContract();

const failures: string[] = [];
const fail = (what: string, detail: string) => failures.push(`${what}: ${detail}`);

let examples = 0;
for (const s of schemas) {
  if (s.doc.$id !== BASE + s.rel) fail(s.rel, `$id should be ${BASE + s.rel}`);
  let validate;
  try { validate = validator(s.rel); } catch (e) { fail(s.rel, `does not compile: ${(e as Error).message}`); continue; }
  for (const [i, ex] of (s.doc.examples ?? []).entries()) {
    examples++;
    if (!validate(ex)) fail(`${s.rel} example ${i}`, describeErrors(validate.errors));
  }
}

// Cases the contract must reject (contract/src/cases.ts).
for (const { schema, instance, rule } of mustReject) {
  if (validator(schema)(instance)) fail(`${schema} accepted an invalid case`, rule);
}

let recorded = 0;
if (existsSync(harPath)) {
  const endpoints: { name: string; match: (u: string) => boolean; query?: boolean }[] = [
    { name: 'facets', match: (u) => u.includes('/merch/search/api/v2/search/facets') },
    { name: 'search', match: (u) => u.includes('/merch/search/api/v2/search') },
    { name: 'suggest', match: (u) => u.includes('/merch/search/api/v1/suggest/filters') },
    { name: 'availability', match: (u) => u.includes('/soonestavailabilitybulk') },
    { name: 'pricing', match: (u) => u.includes('/merch/search/api/v2/pricing/vehicle') },
    { name: 'reviews', match: (u) => u.includes('/merch/reviews/api/review/sv') },
    { name: 'gap', match: (u) => u.includes('/GapWaiver/availability'), query: true },
  ];
  const counts: Record<string, number> = {};
  const entries = JSON.parse(readFileSync(harPath, 'utf8')).log.entries;
  for (const [i, e] of entries.entries()) {
    const url: string = e.request.url;
    const ep = endpoints.find((x) => x.match(url));
    if (!ep || e.response.status !== 200) continue;
    const request = ep.query ? Object.fromEntries(new URL(url).searchParams) : JSON.parse(e.request.postData?.text ?? 'null');
    const response = JSON.parse(e.response.content?.text ?? 'null');
    counts[ep.name] = (counts[ep.name] ?? 0) + 1;
    for (const [kind, body] of [['request', request], ['response', response]] as const) {
      recorded++;
      const validate = validator(`carvana/${ep.name}.${kind}.json`);
      if (!validate(body)) fail(`HAR entry ${i} ${ep.name} ${kind}`, describeErrors(validate.errors));
    }
  }
  console.log(`Recorded traffic checked: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')}`);
} else {
  console.log('Recording not found; skipped the recorded-traffic check.');
}

console.log(`${schemas.length} schemas, ${examples} examples, ${mustReject.length} must-reject cases, ${recorded} recorded requests and responses checked.`);
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  failures.slice(0, 40).forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
console.log('Contract check passed.');
