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
  .flatMap((entry) => entry.isDirectory() ? filesIn(path.join(dir, entry.name)).map((file) => `${entry.name}/${file}`) : [entry.name]).sort();

test('at least two sites have fixtures', () => {
  assert.ok(sites.length >= 2, `sites with fixtures: ${sites.join(', ')}`);
});

for (const site of sites) {
  const { pack } = contract.sites[site]!;
  const fixtures = loadFixtures(site);
  const validator = (rel: string) => contract.siteValidator(site, rel);
  const isJson = (endpoint: string) => (pack.endpoints[endpoint]?.responseFormat ?? 'json') === 'json';

  test(`${site}: fixture ids are unique, and each fixture names this site and one of its endpoints`, () => {
    assert.equal(new Set(fixtures.map((fixture) => fixture.id)).size, fixtures.length);
    for (const fixture of fixtures) {
      assert.equal(fixture.site, site, fixture.id);
      assert.ok(pack.endpoints[fixture.endpoint], `${fixture.id}: unknown endpoint ${fixture.endpoint}`);
      assert.equal(fixture.request.method, pack.endpoints[fixture.endpoint]!.method, fixture.id);
    }
  });

  test(`${site}: the index lists exactly the fixture files on disk`, () => {
    const index: { file: string }[] = JSON.parse(readFileSync(path.join(fixtureDir(site), 'index.json'), 'utf8'));
    assert.deepEqual(index.map((entry) => entry.file).sort(), filesIn(fixtureDir(site)).filter((file) => file !== 'index.json'));
  });

  test(`${site}: every fixture request meets the contract, except the observed errors, which must break it`, () => {
    for (const fixture of fixtures) {
      const validate = validator(pack.endpoints[fixture.endpoint]!.request);
      const ok = validate(requestValue(pack, fixture.request));
      if (fixture.kind === 'observed') assert.equal(ok, false, `${fixture.id}: an observed-error request should break the contract`);
      else assert.ok(ok, `${fixture.id}: ${describeErrors(validate.errors)}`);
    }
  });

  test(`${site}: every 200 response meets the contract, except deliberate shape changes`, () => {
    for (const fixture of fixtures.filter((candidate) => candidate.response.status === 200 && isJson(candidate.endpoint))) {
      const validate = validator(pack.endpoints[fixture.endpoint]!.response);
      const ok = validate(fixture.response.body);
      if (fixture.expect === 'contract_violation') assert.equal(ok, false, `${fixture.id}: should break the contract`);
      else assert.ok(ok, `${fixture.id}: ${describeErrors(validate.errors)}`);
    }
  });

  test(`${site}: every identifier the site pack scrubs holds a placeholder`, () => {
    const fields = new Set(pack.recording.scrubFields);
    const headers = new Set(pack.recording.scrubHeaders.map((header) => header.toLowerCase()));
    const bad: string[] = [];
    const walk = (node: unknown, where: string) => {
      if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${where}[${i}]`));
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (fields.has(key) && typeof value === 'string' && !PLACEHOLDER.test(value)) bad.push(`${where}.${key}`);
          walk(value, `${where}.${key}`);
        }
      }
    };
    for (const fixture of fixtures) {
      walk(fixture.request.body, `${fixture.id} request`);
      walk(fixture.response.body, `${fixture.id} response`);
      for (const [key, value] of new URL(fixture.request.url).searchParams) if (fields.has(key) && !PLACEHOLDER.test(value)) bad.push(`${fixture.id} url ?${key}`);
      for (const [key, value] of Object.entries(fixture.request.headers)) if (headers.has(key) && !PLACEHOLDER.test(value)) bad.push(`${fixture.id} header ${key}`);
    }
    assert.deepEqual(bad, []);
  });

  const hars = (pack.recording.hars ?? []).map((file) => path.join(repoRoot, file));
  const skip = !hars.length ? 'no recording: fixtures are hand-written' : !hars.every((file) => existsSync(file)) && 'recordings not present';
  test(`${site}: rebuilding from the recordings gives byte-identical fixtures`, { skip }, () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'fixtures-'));
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build-fixtures.ts', import.meta.url)), site, hars.join(','), tmp], { stdio: 'pipe' });
      assert.deepEqual(filesIn(tmp), filesIn(fixtureDir(site)));
      for (const file of filesIn(fixtureDir(site))) {
        assert.equal(readFileSync(path.join(tmp, file), 'utf8'), readFileSync(path.join(fixtureDir(site), file), 'utf8'), `${file} differs after a rebuild`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
