// L3 for scripts: a model-written script runs in QuickJS, calls tools only through Execute (same checks, same budget),
// can reach nothing else, is stopped when it runs too long or uses too much memory, and returns a small object
// whose known IDs are listed for the brain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickJsRunner } from '../hosts/quickjs.ts';
import { runToolCall } from '../src/index.ts';
import { exampleSession } from './example-site.ts';

const runner = quickJsRunner();
const withScripts = () => exampleSession({ host: { scripts: runner } });
const script = async (source: string) => {
  const { session, requests } = await withScripts();
  return { r: await runToolCall(session, 'run_script', { source }), session, requests };
};

test('a script calls tools through Execute and returns an object, with the known IDs it mentions listed by kind', async () => {
  const { r, session } = await script(`
    const { products } = await tools.search_products({ query: 'shoe' });
    const cheap = products.filter((p) => p.total < 100);
    return { ids: cheap.map((p) => p.id), summary: cheap.length + ' under $100' };`);
  assert.deepEqual(r, { ok: true, output: { result: { ids: [1], summary: '1 under $100' }, knownIds: { product: [1] } } });
  assert.equal(session.ids.status('product', 2, session.host.now()), 'known', "IDs the script's tool calls returned are known to the session");
});

test('a script has no network, timers, modules or host objects', async () => {
  const { r } = await script("return { seen: [typeof fetch, typeof XMLHttpRequest, typeof setTimeout, typeof require, typeof process, typeof __call === 'function' ? 'bridge' : 'none'].join(',') };");
  assert.deepEqual(r.ok && r.output.result, { seen: 'undefined,undefined,undefined,undefined,undefined,bridge' });
});

test("a tool's refusal reaches the script as an exception it can catch", async () => {
  const { r } = await script(`
    try { await tools.place_order({ offerId: 'of_ab12' }); return { ok: 'no' }; }
    catch (e) { return { refused: e.message }; }`);
  assert.match(r.ok ? String(r.output.result && (r.output.result as { refused: string }).refused) : '', /would change something on the site/);
});

test('scripts share the task budget: a loop of calls stops at the limit', async () => {
  const { r } = await script(`
    let made = 0, stopped = '';
    for (let i = 0; i < 10; i++) {
      try { await tools.search_products({ query: 'q' + i }); made++; } catch (e) { stopped = e.message; break; }
    }
    return { made, stopped };`);
  assert.ok(r.ok);
  assert.equal((r.output.result as { made: number }).made, 5);
  assert.match((r.output.result as { stopped: string }).stopped, /This task reached its limit of 5 calls/);
});

test("a script can't start another script, can't add IDs, and must return a small object", async () => {
  const nested = await script("try { await tools.run_script({ source: 'return {}' }); } catch (e) { return { e: e.message }; }");
  assert.match(nested.r.ok ? String((nested.r.output.result as { e: string }).e) : '', /can't start another script/);
  const notObject = await script("return 'done';");
  assert.equal(!notObject.r.ok && notObject.r.error.reason, 'bad_script');
  const big = await script("return { text: 'x'.repeat(20000) };");
  assert.match(!big.r.ok ? big.r.error.message : '', /return IDs and a short summary/);
  const syntax = await script('return {');
  assert.equal(!syntax.r.ok && syntax.r.error.reason, 'bad_script');
  const forged = await script("await tools.search_products({ query: 'x' }); return { ids: [999] };");
  assert.deepEqual(forged.r.ok && forged.r.output.knownIds, {}, '999 was never returned, so it is not listed as known');
});

test('scripts are refused where the host has no sandbox, and a missing source is refused', async () => {
  const { session } = await exampleSession();
  const off = await runToolCall(session, 'run_script', { source: 'return {}' });
  assert.deepEqual(!off.ok && [off.error.code, off.error.reason], ['tool_disabled', 'scripts_off']);
  const s2 = await withScripts();
  assert.equal(await runToolCall(s2.session, 'run_script', {}).then((r) => !r.ok && r.error.reason), 'bad_script');
});

test('an endless loop is stopped by the time limit, and time spent waiting for tools does not count', async () => {
  const limits = { timeoutMs: 200, memoryBytes: 16 * 1024 * 1024 };
  const t0 = Date.now();
  const loop = await runner.run('while (true) {}', async () => ({}), limits);
  assert.deepEqual(loop, { ok: false, error: 'the script ran past its time limit' });
  assert.ok(Date.now() - t0 < 3000);
  const slowTool = async () => { await new Promise((r) => setTimeout(r, 350)); return { done: true }; };
  const waited = await runner.run('const a = await tools.slow({}); const b = await tools.slow({}); return { a, b };', slowTool, limits);
  assert.deepEqual(waited, { ok: true, value: { a: { done: true }, b: { done: true } } });
});

test('runaway memory use is stopped', async () => {
  const r = await runner.run('const a = []; for (;;) a.push(new Array(100000).fill(1));', async () => ({}), { timeoutMs: 5000, memoryBytes: 8 * 1024 * 1024 });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /memory/i);
});

test('a script that waits forever is stopped by the overall limit', async () => {
  const quick = quickJsRunner({ wallLimitMs: 300 });
  const r = await quick.run('await tools.never({}); return {};', () => new Promise(() => {}), { timeoutMs: 1000, memoryBytes: 16 * 1024 * 1024 });
  assert.deepEqual(r, { ok: false, error: 'the script took too long overall' });
});
