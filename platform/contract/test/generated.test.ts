// The generated code, for the platform and every site pack: up to date, in agreement with the runtime
// validator, and runnable in every engine core.js targets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { build } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';
import { AJV_OPTIONS, loadContract, type SchemaFile } from '../src/load.ts';
import { mustReject as platformCases, type MustReject } from '../src/cases.ts';
import { validatorName } from '../src/names.ts';

const contract = loadContract();
const platformGenerated = fileURLToPath(new URL('../generated/', import.meta.url));

interface Scope {
  label: string;
  schemas: SchemaFile[];
  generatedDir: string;
  validator(rel: string): ValidateFunction;
  cases: MustReject[];
}

const scopes: Scope[] = [
  { label: 'platform', schemas: contract.platform, generatedDir: platformGenerated, validator: contract.validator, cases: platformCases },
];
for (const [id, site] of Object.entries(contract.sites)) {
  const casesFile = path.join(site.dir, 'cases.ts');
  scopes.push({
    label: `sites/${id}`,
    schemas: site.schemas,
    generatedDir: path.join(site.dir, 'generated'),
    validator: (rel) => contract.siteValidator(id, rel),
    cases: existsSync(casesFile) ? (await import(pathToFileURL(casesFile).href)).mustReject : [],
  });
}

test('the committed generated code matches a fresh generation', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/generate.ts', import.meta.url)), '--check'], { stdio: 'pipe' });
});

// Bundle each scope's validators the way core.js will bundle them.
const bundleOf = async (dir: string, contents: string, minify = false) => (await build({
  stdin: { contents, resolveDir: dir, loader: 'js' },
  bundle: true, format: 'iife', platform: 'neutral', target: 'es2020', write: false, minify, logLevel: 'silent',
})).outputFiles[0]!.text;

for (const scope of scopes) {
  const generated = await import(pathToFileURL(path.join(scope.generatedDir, 'validators.js')).href) as Record<string, (data: unknown) => boolean>;
  const exported = scope.schemas.filter((schema) => schema.rel !== 'common.json');

  // Every example (valid) and every must-reject case (invalid), with the runtime validator's verdict.
  const cases = [
    ...exported.flatMap((schema) => (schema.doc.examples ?? []).map((ex) => ({ rel: schema.rel, data: ex }))),
    ...scope.cases.map((rejectCase) => ({ rel: rejectCase.schema, data: rejectCase.instance })),
  ].map((testCase) => ({ ...testCase, fn: validatorName(testCase.rel), expected: scope.validator(testCase.rel)(testCase.data) as boolean }));

  test(`${scope.label}: a generated validator for every schema except the shared definitions`, () => {
    for (const schema of exported) assert.equal(typeof generated[validatorName(schema.rel)], 'function', schema.rel);
  });

  test(`${scope.label}: generated validators agree with the runtime validator on every example and must-reject case`, () => {
    assert.ok(cases.some((testCase) => testCase.expected), 'no valid examples');
    if (scope.cases.length) assert.ok(cases.some((testCase) => !testCase.expected), 'must-reject cases were accepted');
    for (const testCase of cases) assert.equal(generated[testCase.fn]!(testCase.data), testCase.expected, `${testCase.rel}: ${JSON.stringify(testCase.data).slice(0, 80)}`);
  });

  test(`${scope.label}: each tool definition stands alone and accepts and refuses what its schema does`, () => {
    const defs = JSON.parse(readFileSync(path.join(scope.generatedDir, 'tools.json'), 'utf8')) as { name: string; inputSchema: object }[];
    const site = Object.values(contract.sites).find((siteInfo) => scope.generatedDir === path.join(siteInfo.dir, 'generated'));
    assert.ok(defs.length > 0);
    for (const def of defs) {
      const rel = site ? site.pack.tools[def.name]!.input : scope.schemas.find((schema) => schema.rel.endsWith(`/${def.name}.json`))!.rel;
      assert.doesNotMatch(JSON.stringify(def.inputSchema), /\$ref|\$id|"examples"/, def.name);
      const alone = new Ajv2020({ ...AJV_OPTIONS, allErrors: false }).compile(def.inputSchema);
      const own = cases.filter((testCase) => testCase.rel === rel);
      assert.ok(own.some((testCase) => testCase.expected), `${def.name}: no example to check against`);
      for (const testCase of own) assert.equal(alone(testCase.data), testCase.expected, `${def.name}: ${JSON.stringify(testCase.data).slice(0, 80)}`);
    }
  });

  const bundle = await bundleOf(scope.generatedDir, `import * as v from './validators.js';\nglobalThis.__run = (cases) => JSON.stringify(cases.map((c) => v[c.fn](c.data)));`);
  const expected = JSON.stringify(cases.map((testCase) => testCase.expected));
  const input = JSON.stringify(cases.map(({ fn, data }) => ({ fn, data })));

  test(`${scope.label}: the bundled validators use no eval or new Function`, () => {
    assert.doesNotMatch(bundle, /\beval\(|\bnew Function\b/);
  });

  test(`${scope.label}: same verdicts in a bare Node context (no Node globals)`, () => {
    assert.equal(vm.runInContext(`${bundle}\n__run(${input})`, vm.createContext({})), expected);
  });

  test(`${scope.label}: same verdicts in QuickJS`, async () => {
    const QuickJS = await getQuickJS();
    const ctx = QuickJS.newContext();
    try {
      assert.equal(ctx.dump(ctx.unwrapResult(ctx.evalCode(`${bundle}\n__run(${input})`))), expected);
    } finally {
      ctx.dispose();
    }
  });

  const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc';
  test(`${scope.label}: same verdicts in JavaScriptCore`, { skip: !existsSync(JSC) && 'jsc not available' }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'validators-jsc-'));
    try {
      const file = path.join(dir, 'run.js');
      writeFileSync(file, `${bundle}\nprint(__run(${input}));\n`);
      assert.equal(execFileSync(JSC, [file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim(), expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Budget on what one app ships: the platform's validators plus one site's, minified and gzipped.
// Bundlers can't drop unused validators here, because Ajv sets bookkeeping properties (.evaluated) on the
// functions at the top level of the file. If core.js needs to be smaller, generate a file with only the
// validators it uses (it doesn't need the site-pack validator at runtime, for one).
for (const [id, site] of Object.entries(contract.sites)) {
  test(`platform + ${id}: the minified, gzipped validators stay within 60 KB`, async () => {
    const contents = [platformGenerated, path.join(site.dir, 'generated')]
      .map((dir, i) => `import * as v${i} from ${JSON.stringify(path.join(dir, 'validators.js'))}; globalThis.v${i} = v${i};`).join('\n');
    const kb = gzipSync(await bundleOf(platformGenerated, contents, true)).length / 1024;
    assert.ok(kb < 60, `gzipped bundle is ${Math.round(kb)} KB`);
  });
}
