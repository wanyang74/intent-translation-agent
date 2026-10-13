// The generated code: up to date, in agreement with the runtime validator, and runnable in every engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';
import { loadContract } from '../src/load.ts';
import { mustReject } from '../src/cases.ts';
import { validatorName } from '../src/names.ts';
import * as generated from '../generated/validators.js';

const { schemas, validator } = loadContract();
const validators = generated as unknown as Record<string, (data: unknown) => boolean>;

// Every example (valid) and every must-reject case (invalid), with the runtime validator's verdict.
const cases = [
  ...schemas.filter((s) => s.rel !== 'common.json').flatMap((s) => (s.doc.examples ?? []).map((ex) => ({ rel: s.rel, data: ex }))),
  ...mustReject.map((c) => ({ rel: c.schema, data: c.instance })),
].map((c) => ({ ...c, fn: validatorName(c.rel), expected: validator(c.rel)(c.data) as boolean }));

test('the committed generated code matches a fresh generation', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/generate.ts', import.meta.url)), '--check'], { stdio: 'pipe' });
});

test('there is a generated validator for every schema except the shared definitions', () => {
  for (const s of schemas.filter((x) => x.rel !== 'common.json')) {
    assert.equal(typeof validators[validatorName(s.rel)], 'function', s.rel);
  }
});

test('generated validators agree with the runtime validator on every example and must-reject case', () => {
  assert.ok(cases.some((c) => c.expected) && cases.some((c) => !c.expected));
  for (const c of cases) assert.equal(validators[c.fn]!(c.data), c.expected, `${c.rel}: ${JSON.stringify(c.data).slice(0, 80)}`);
});

// Bundle the validators the way core.js will be bundled, then run the same cases in each engine.
const bundle = (await build({
  stdin: {
    contents: `import * as v from './validators.js';\nglobalThis.__run = (cases) => JSON.stringify(cases.map((c) => v[c.fn](c.data)));`,
    resolveDir: fileURLToPath(new URL('../generated/', import.meta.url)),
    loader: 'js',
  },
  bundle: true, format: 'iife', platform: 'neutral', target: 'es2020', write: false, logLevel: 'silent',
})).outputFiles[0]!.text;
const expected = JSON.stringify(cases.map((c) => c.expected));
const program = `${bundle}\n__run(${JSON.stringify(cases.map(({ fn, data }) => ({ fn, data })))})`;

test('the bundled validators use no eval or new Function', () => {
  assert.doesNotMatch(bundle, /\beval\(|\bnew Function\b/);
});

test('bundled validators give the same verdicts in a bare Node context (no Node globals)', () => {
  assert.equal(vm.runInContext(program, vm.createContext({})), expected);
});

test('bundled validators give the same verdicts in QuickJS', async () => {
  const QuickJS = await getQuickJS();
  const ctx = QuickJS.newContext();
  try {
    assert.equal(ctx.dump(ctx.unwrapResult(ctx.evalCode(program))), expected);
  } finally {
    ctx.dispose();
  }
});

const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc';
test('bundled validators give the same verdicts in JavaScriptCore', { skip: !existsSync(JSC) && 'jsc not available' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'validators-jsc-'));
  try {
    const file = path.join(dir, 'run.js');
    writeFileSync(file, `${bundle}\nprint(__run(${JSON.stringify(cases.map(({ fn, data }) => ({ fn, data })))}));\n`);
    assert.equal(execFileSync(JSC, [file], { encoding: 'utf8' }).trim(), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Budget on what ships: minified and gzipped. Bundlers can't drop unused validators here, because
// Ajv sets bookkeeping properties (.evaluated) on the functions at the top level of the file.
// If core.js needs to be smaller, generate a separate file with only the validators it uses.
test('the minified, gzipped validators bundle stays within 60 KB', async () => {
  const minified = (await build({
    stdin: { contents: `import * as v from './validators.js'; globalThis.v = v;`, resolveDir: fileURLToPath(new URL('../generated/', import.meta.url)), loader: 'js' },
    bundle: true, format: 'iife', platform: 'neutral', target: 'es2020', write: false, minify: true, logLevel: 'silent',
  })).outputFiles[0]!.text;
  const kb = gzipSync(minified).length / 1024;
  assert.ok(kb < 60, `gzipped bundle is ${Math.round(kb)} KB`);
});
