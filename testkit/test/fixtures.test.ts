// The fixture library: valid against the contract where it should be, private, and reproducible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContract, describeErrors } from '../../contract/src/load.ts';
import { fixtureDir, loadFixtures, requestValue } from '../src/fixtures.ts';

const fixtures = loadFixtures();
const { validator } = loadContract();

test('every fixture request meets the contract, except the observed errors, which must break it', () => {
  for (const f of fixtures) {
    const validate = validator(`carvana/${f.endpoint}.request.json`);
    const ok = validate(requestValue(f.request));
    if (f.kind === 'observed') assert.equal(ok, false, `${f.id}: an observed-error request should break the contract`);
    else assert.ok(ok, `${f.id}: ${describeErrors(validate.errors)}`);
  }
});

test('every 200 response meets the contract, except the deliberate shape change', () => {
  for (const f of fixtures.filter((x) => x.response.status === 200)) {
    const validate = validator(`carvana/${f.endpoint}.response.json`);
    const ok = validate(f.response.body);
    if (f.expect === 'contract_violation') assert.equal(ok, false, `${f.id}: should break the contract`);
    else assert.ok(ok, `${f.id}: ${describeErrors(validate.errors)}`);
  }
});

test('every identifier is a placeholder: no real visitor, session or request IDs', () => {
  const ID_FIELDS = new Set(['browserCookieId', 'searchSessionId', 'searchRequestId', 'previousSearchRequestId', 'correlationId', 'suggestedFiltersRequestId', 'traceId', 'browsercookieid', 'correlationid']);
  const PLACEHOLDER = /^(00000000-0000-4000-8000-\d{12})?$/;
  const bad: string[] = [];
  const walk = (v: unknown, where: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (ID_FIELDS.has(k) && typeof x === 'string' && !PLACEHOLDER.test(x)) bad.push(`${where}.${k}`);
        walk(x, `${where}.${k}`);
      }
    }
  };
  for (const f of fixtures) walk(f, f.id);
  assert.deepEqual(bad, []);
});

const har = fileURLToPath(new URL('../../recordings/www.carvana.com.har', import.meta.url));
test('rebuilding from the recording gives byte-identical fixtures', { skip: !existsSync(har) && 'recording not present' }, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fixtures-'));
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build-fixtures.ts', import.meta.url)), har, tmp], { stdio: 'pipe' });
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((d) => d.isDirectory() ? files(path.join(dir, d.name)).map((f) => `${d.name}/${f}`) : [d.name]).sort();
    assert.deepEqual(files(tmp), files(fixtureDir));
    for (const f of files(fixtureDir)) {
      assert.equal(readFileSync(path.join(tmp, f), 'utf8'), readFileSync(path.join(fixtureDir, f), 'utf8'), `${f} differs after a rebuild`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
