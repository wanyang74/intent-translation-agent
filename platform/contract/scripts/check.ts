// Contract check, for the platform and every site pack:
//   1. every schema compiles (Ajv, JSON Schema 2020-12, strict mode) and its $id matches its path
//   2. every site.yaml matches the site-pack format, and everything it references exists
//   3. every example inside a schema validates
//   4. every must-reject case is rejected (platform/contract/src/cases.ts, sites/<id>/cases.ts)
//   5. if a site's recording is present, every recorded request and response for its endpoints validates
// Exits with code 1 on any failure.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadContract, describeErrors, type SchemaFile } from '../src/load.ts';
import { crossCheck, endpointOf, repoRoot, requestValue } from '../src/site-pack.ts';
import { mustReject as platformCases, type MustReject } from '../src/cases.ts';

const contract = loadContract();
const failures: string[] = [];
const fail = (what: string, detail: string) => failures.push(`${what}: ${detail}`);

function checkSchemas(label: string, schemas: SchemaFile[]) {
  let examples = 0;
  for (const s of schemas) {
    if (s.doc.$id !== s.id) fail(`${label}/${s.rel}`, `$id should be ${s.id}`);
    let validate;
    try { validate = contract.ajv.getSchema(s.id); } catch (e) { fail(`${label}/${s.rel}`, `does not compile: ${(e as Error).message}`); continue; }
    if (!validate) { fail(`${label}/${s.rel}`, 'not loaded'); continue; }
    for (const [i, ex] of (s.doc.examples ?? []).entries()) {
      examples++;
      if (!validate(ex)) fail(`${label}/${s.rel} example ${i}`, describeErrors(validate.errors));
    }
  }
  return examples;
}

function checkCases(label: string, cases: MustReject[], validatorFor: (rel: string) => (data: unknown) => boolean) {
  for (const { schema, instance, rule } of cases) {
    if (validatorFor(schema)(instance)) fail(`${label}/${schema} accepted an invalid case`, rule);
  }
}

const summary: string[] = [];
{
  const examples = checkSchemas('platform', contract.platform);
  checkCases('platform', platformCases, contract.validator);
  summary.push(`platform: ${contract.platform.length} schemas, ${examples} examples, ${platformCases.length} must-reject cases`);
}

for (const [id, site] of Object.entries(contract.sites)) {
  for (const p of crossCheck(site)) fail(`sites/${id}/site.yaml`, p);
  const siteValidator = (rel: string) => contract.siteValidator(id, rel);
  const examples = checkSchemas(`sites/${id}`, site.schemas);

  const casesFile = path.join(site.dir, 'cases.ts');
  const cases: MustReject[] = existsSync(casesFile) ? (await import(pathToFileURL(casesFile).href)).mustReject : [];
  checkCases(`sites/${id}`, cases, siteValidator);

  let recorded = 0;
  const har = site.pack.recording.har && path.join(repoRoot, site.pack.recording.har);
  if (har && existsSync(har)) {
    for (const [i, e] of JSON.parse(readFileSync(har, 'utf8')).log.entries.entries()) {
      const match = endpointOf(site.pack, e.request.url);
      if (!match || e.response.status !== 200 || (match.endpoint.responseFormat ?? 'json') !== 'json') continue;
      const request = requestValue(site.pack, { method: e.request.method, url: e.request.url, body: e.request.postData?.text ?? null });
      const response = JSON.parse(e.response.content?.text ?? 'null');
      for (const [kind, rel, body] of [['request', match.endpoint.request, request], ['response', match.endpoint.response, response]] as const) {
        recorded++;
        const validate = contract.siteValidator(id, rel);
        if (!validate(body)) fail(`sites/${id} recording entry ${i} ${match.name} ${kind}`, describeErrors(validate.errors));
      }
    }
  }
  const recordingNote = har ? (existsSync(har) ? `, ${recorded} recorded requests and responses` : ', recording not present') : '';
  summary.push(`sites/${id}: ${site.schemas.length} schemas, ${examples} examples, ${cases.length} must-reject cases${recordingNote}`);
}

summary.forEach((s) => console.log(s));
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  failures.slice(0, 40).forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
console.log('Contract check passed.');
