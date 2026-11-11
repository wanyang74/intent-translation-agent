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
import { groupEvents, parseEventStream } from '../src/events.ts';
import { loadContract, describeErrors, type SchemaFile } from '../src/load.ts';
import { crossCheck, endpointOf, repoRoot, requestValue } from '../src/site-pack.ts';
import { mustReject as platformCases, type MustReject } from '../src/cases.ts';

const contract = loadContract();
const failures: string[] = [];
const fail = (what: string, detail: string) => failures.push(`${what}: ${detail}`);

function checkSchemas(label: string, schemas: SchemaFile[]) {
  let examples = 0;
  for (const schema of schemas) {
    if (schema.doc.$id !== schema.id) fail(`${label}/${schema.rel}`, `$id should be ${schema.id}`);
    let validate;
    try { validate = contract.ajv.getSchema(schema.id); } catch (error) { fail(`${label}/${schema.rel}`, `does not compile: ${(error as Error).message}`); continue; }
    if (!validate) { fail(`${label}/${schema.rel}`, 'not loaded'); continue; }
    for (const [i, ex] of (schema.doc.examples ?? []).entries()) {
      examples++;
      if (!validate(ex)) fail(`${label}/${schema.rel} example ${i}`, describeErrors(validate.errors));
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
  for (const problem of crossCheck(site)) fail(`sites/${id}/site.yaml`, problem);
  const siteValidator = (rel: string) => contract.siteValidator(id, rel);
  const examples = checkSchemas(`sites/${id}`, site.schemas);

  const casesFile = path.join(site.dir, 'cases.ts');
  const cases: MustReject[] = existsSync(casesFile) ? (await import(pathToFileURL(casesFile).href)).mustReject : [];
  checkCases(`sites/${id}`, cases, siteValidator);

  let recorded = 0;
  const hars = (site.pack.recording.hars ?? []).map((file) => path.join(repoRoot, file));
  const present = hars.filter((file) => existsSync(file));
  for (const har of present) {
    const name = path.basename(har);
    for (const [i, entry] of JSON.parse(readFileSync(har, 'utf8')).log.entries.entries()) {
      const match = endpointOf(site.pack, entry.request.url);
      const format = match?.endpoint.responseFormat ?? 'json';
      // A page's schema applies to what the site's reader makes of it, so recorded pages are checked through fixtures.
      if (!match || entry.response.status !== 200 || format === 'html') continue;
      const request = requestValue(site.pack, { method: entry.request.method, url: entry.request.url, body: entry.request.postData?.text ?? null });
      const text: string = entry.response.content?.text ?? 'null';
      const response = format === 'sse' ? groupEvents(parseEventStream(text), match.endpoint.eventKind) : JSON.parse(text);
      for (const [kind, rel, body] of [['request', match.endpoint.request, request], ['response', match.endpoint.response, response]] as const) {
        recorded++;
        const validate = contract.siteValidator(id, rel);
        if (!validate(body)) fail(`sites/${id} recording ${name} entry ${i} ${match.name} ${kind}`, describeErrors(validate.errors));
      }
    }
  }
  const recordingNote = hars.length ? `, ${recorded} recorded requests and responses from ${present.length} of ${hars.length} recordings` : '';
  summary.push(`sites/${id}: ${site.schemas.length} schemas, ${examples} examples, ${cases.length} must-reject cases${recordingNote}`);
}

summary.forEach((line) => console.log(line));
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  failures.slice(0, 40).forEach((failure) => console.log(' - ' + failure));
  process.exit(1);
}
console.log('Contract check passed.');
