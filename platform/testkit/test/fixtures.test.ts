// Every site's fixture library: valid against the site's contract where it should be, scrubbed, consistent
// with its index, and reproducible from the recording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContract, describeErrors } from '../../contract/src/load.ts';
import { repoRoot, requestValue } from '../../contract/src/site-pack.ts';
import { fixtureDir, hasFixtures, loadFixtures } from '../src/fixtures.ts';

const contract = loadContract();
const sites = Object.keys(contract.sites).filter(hasFixtures);
const PLACEHOLDER = /^(00000000-0000-4000-8000-\d{12})?$/;

const filesIn = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => d.isDirectory() ? filesIn(path.join(dir, d.name)).map((f) => `${d.name}/${f}`) : [d.name]).sort();

test('at least two sites have fixtures', () => {
  assert.ok(sites.length >= 2, `sites with fixtures: ${sites.join(', ')}`);
});

for (const site of sites) {
  const { pack } = contract.sites[site]!;
  const fixtures = loadFixtures(site);
  const validator = (rel: string) => contract.siteValidator(site, rel);
  const isJson = (endpoint: string) => (pack.endpoints[endpoint]?.responseFormat ?? 'json') === 'json';

  test(`${site}: fixture ids are unique, and each fixture names this site and one of its endpoints`, () => {
    assert.equal(new Set(fixtures.map((f) => f.id)).size, fixtures.length);
    for (const f of fixtures) {
      assert.equal(f.site, site, f.id);
      assert.ok(pack.endpoints[f.endpoint], `${f.id}: unknown endpoint ${f.endpoint}`);
      assert.equal(f.request.method, pack.endpoints[f.endpoint]!.method, f.id);
    }
  });

  test(`${site}: the index lists exactly the fixture files on disk`, () => {
    const index: { file: string }[] = JSON.parse(readFileSync(path.join(fixtureDir(site), 'index.json'), 'utf8'));
    assert.deepEqual(index.map((e) => e.file).sort(), filesIn(fixtureDir(site)).filter((f) => f !== 'index.json'));
  });

  test(`${site}: every fixture request meets the contract, except the observed errors, which must break it`, () => {
    for (const f of fixtures) {
      const validate = validator(pack.endpoints[f.endpoint]!.request);
      const ok = validate(requestValue(pack, f.request));
      if (f.kind === 'observed') assert.equal(ok, false, `${f.id}: an observed-error request should break the contract`);
      else assert.ok(ok, `${f.id}: ${describeErrors(validate.errors)}`);
    }
  });

  test(`${site}: every 200 response meets the contract, except deliberate shape changes`, () => {
    for (const f of fixtures.filter((x) => x.response.status === 200 && isJson(x.endpoint))) {
      const validate = validator(pack.endpoints[f.endpoint]!.response);
      const ok = validate(f.response.body);
      if (f.expect === 'contract_violation') assert.equal(ok, false, `${f.id}: should break the contract`);
      else assert.ok(ok, `${f.id}: ${describeErrors(validate.errors)}`);
    }
  });

  test(`${site}: every identifier the site pack scrubs holds a placeholder`, () => {
    const fields = new Set(pack.recording.scrubFields);
    const headers = new Set(pack.recording.scrubHeaders.map((h) => h.toLowerCase()));
    const bad: string[] = [];
    const walk = (v: unknown, where: string) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (fields.has(k) && typeof x === 'string' && !PLACEHOLDER.test(x)) bad.push(`${where}.${k}`);
          walk(x, `${where}.${k}`);
        }
      }
    };
    for (const f of fixtures) {
      walk(f.request.body, `${f.id} request`);
      walk(f.response.body, `${f.id} response`);
      for (const [k, x] of new URL(f.request.url).searchParams) if (fields.has(k) && !PLACEHOLDER.test(x)) bad.push(`${f.id} url ?${k}`);
      for (const [k, x] of Object.entries(f.request.headers)) if (headers.has(k) && !PLACEHOLDER.test(x)) bad.push(`${f.id} header ${k}`);
    }
    assert.deepEqual(bad, []);
  });

  const har = pack.recording.har ? path.join(repoRoot, pack.recording.har) : null;
  const skip = !har ? 'no recording: fixtures are hand-written' : !existsSync(har) && 'recording not present';
  test(`${site}: rebuilding from the recording gives byte-identical fixtures`, { skip }, () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'fixtures-'));
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build-fixtures.ts', import.meta.url)), site, har!, tmp], { stdio: 'pipe' });
      assert.deepEqual(filesIn(tmp), filesIn(fixtureDir(site)));
      for (const f of filesIn(fixtureDir(site))) {
        assert.equal(readFileSync(path.join(tmp, f), 'utf8'), readFileSync(path.join(fixtureDir(site), f), 'utf8'), `${f} differs after a rebuild`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
