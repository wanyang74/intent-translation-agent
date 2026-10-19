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
import { requestValue, sitesDir, listSites } from '../../contract/src/site-pack.ts';
import { loadConversations } from '../../testkit/src/conversations.ts';
import { hasFixtures, loadFixtures } from '../../testkit/src/fixtures.ts';
import { loadSiteRuntime } from '../../testkit/src/site-runtime.ts';
import { matchKey } from '../src/index.ts';
import { runCases } from './engine-cases.ts';
import { runIoCases, type IoCase } from './engine-io-cases.ts';
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

// ---------------------------------------------------------------- core.js's I/O, the whole client side of each conversation

const ioSites = listSites().filter(hasFixtures);
const ioCases: IoCase[] = [];
for (const site of ioSites) {
  const rt = await loadSiteRuntime(site);
  const fixtures = loadFixtures(site);
  for (const conversation of loadConversations(site)) {
    const recorded = fixtures.filter((fixture) => conversation.fixtures.includes(fixture.id) && !fixture.trigger).map((fixture) => ({
      endpoint: fixture.endpoint,
      key: matchKey(rt.pack.endpoints[fixture.endpoint]!, requestValue(rt.pack, fixture.request)),
      response: { status: fixture.response.status, headers: fixture.response.headers, body: typeof fixture.response.body === 'string' ? fixture.response.body : JSON.stringify(fixture.response.body) },
    }));
    ioCases.push({ pack: rt.pack, code: rt.code, siteValidators: rt.validators.site, conversation, recorded });
  }
}
const ioExpected = JSON.stringify(await runIoCases(ioCases, (await import('../../contract/generated/validators.js')) as Record<string, unknown>));

// The bundle imports each site's code and validators by path, as a site's core.js bundle would.
const imports = ioSites.map((site, i) => `import { site as code${i} } from ${JSON.stringify(path.join(sitesDir, site, 'tools.ts'))};\nimport * as v${i} from ${JSON.stringify(path.join(sitesDir, site, 'generated', 'validators.js'))};`).join('\n');
const codeOf = `{ ${ioSites.map((site, i) => `${JSON.stringify(site)}: [code${i}, v${i}]`).join(', ')} }`;
const ioData = JSON.stringify(ioCases.map((ioCase) => ({ site: ioCase.pack.site.id, pack: ioCase.pack, conversation: ioCase.conversation, recorded: ioCase.recorded })));
const ioBundle = (await build({
  stdin: {
    contents: `${imports}
import * as platform from '../../contract/generated/validators.js';
import { runIoCases } from './engine-io-cases.ts';
const code = ${codeOf};
const data = ${ioData};
globalThis.__runIo = async () => JSON.stringify(await runIoCases(data.map((d) => ({ ...d, code: code[d.site][0], siteValidators: code[d.site][1] })), platform));`,
    resolveDir: here, loader: 'ts',
  },
  bundle: true, format: 'iife', platform: 'neutral', target: 'es2020', write: false, logLevel: 'silent',
})).outputFiles[0]!.text;

test("every conversation's client side gives the same results in Node, with no differences from the conversation", () => {
  const results = JSON.parse(ioExpected) as { conversation: string; differences: string[]; finished: boolean; outcomes: { ok: boolean }[] }[];
  assert.ok(results.length >= 4);
  for (const result of results) {
    assert.deepEqual(result.differences, [], result.conversation);
    assert.ok(result.finished && result.outcomes.every((outcome) => outcome.ok), result.conversation);
  }
});

test('the client side gives the same results in a bare Node context', async () => {
  assert.equal(await vm.runInContext(`${ioBundle}\n__runIo()`, vm.createContext({})), ioExpected);
});

test('the client side gives the same results in QuickJS', async () => {
  const QuickJS = await getQuickJS();
  const ctx = QuickJS.newContext();
  try {
    const promise = ctx.unwrapResult(ctx.evalCode(`${ioBundle}\n__runIo()`));
    const settled = ctx.resolvePromise(promise);
    ctx.runtime.executePendingJobs(-1);
    const value = ctx.unwrapResult(await settled);
    assert.equal(ctx.dump(value), ioExpected);
    value.dispose();
    promise.dispose();
  } finally {
    ctx.dispose();
  }
});

test('the client side gives the same results in JavaScriptCore', { skip: !existsSync(JSC) && 'jsc not available' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'core-io-jsc-'));
  try {
    const file = path.join(dir, 'run.js');
    writeFileSync(file, `${ioBundle}\n__runIo().then((r) => print(r), (e) => print('ERROR ' + e));\n`);
    assert.equal(execFileSync(JSC, [file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim(), ioExpected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
