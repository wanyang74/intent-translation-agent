// L4: core.js gives the same results in every engine it targets, with nothing Node-specific in it. The cases in
// engine-cases.ts are bundled with core.js the way it will ship, then run in a bare Node context (no Node globals),
// QuickJS and JavaScriptCore. Each engine must produce exactly what Node produces.
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
import { runCases } from './engine-cases.ts';
import { sitePacks } from './sites.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const packs = sitePacks();
const expected = JSON.stringify(runCases(packs));
const bundle = (await build({
  stdin: { contents: `import { runCases } from './engine-cases.ts';\nglobalThis.__run = () => JSON.stringify(runCases(${JSON.stringify(packs)}));`, resolveDir: here, loader: 'ts' },
  bundle: true, format: 'iife', platform: 'neutral', target: 'es2020', write: false, logLevel: 'silent',
})).outputFiles[0]!.text;

test('core.js bundles for the browser with no Node built-ins, eval or new Function', async () => {
  const core = (await build({
    entryPoints: [path.join(here, '../src/index.ts')], bundle: true, format: 'iife', globalName: 'core',
    platform: 'browser', target: 'es2020', write: false, minify: true, logLevel: 'silent',
  })).outputFiles[0]!.text;
  assert.doesNotMatch(core, /\brequire\(|\bprocess\.|\bBuffer\b|\beval\(|\bnew Function\b|\bTextEncoder\b|\bbtoa\(/);
  assert.ok(gzipSync(core).length < 15 * 1024, `core.js pure logic is ${Math.round(gzipSync(core).length / 1024)} KB gzipped`);
});

test('same results in a bare Node context (no Node globals)', () => {
  assert.equal(vm.runInContext(`${bundle}\n__run()`, vm.createContext({})), expected);
});

test('same results in QuickJS', async () => {
  const QuickJS = await getQuickJS();
  const ctx = QuickJS.newContext();
  try {
    assert.equal(ctx.dump(ctx.unwrapResult(ctx.evalCode(`${bundle}\n__run()`))), expected);
  } finally {
    ctx.dispose();
  }
});

const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc';
test('same results in JavaScriptCore', { skip: !existsSync(JSC) && 'jsc not available' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'core-jsc-'));
  try {
    const file = path.join(dir, 'run.js');
    writeFileSync(file, `${bundle}\nprint(__run());\n`);
    assert.equal(execFileSync(JSC, [file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim(), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
