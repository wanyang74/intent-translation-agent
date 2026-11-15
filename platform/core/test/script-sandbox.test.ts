// Tests: the script sandbox (core/src/execute/): a script the model writes runs in QuickJS and can call tools (L3).
// How: real QuickJS on the made-up shop, with scripts that call tools, try to escape, loop forever or eat memory.
// Passes when: scripts call tools only through Execute (same checks, same budget), reach nothing else, are stopped
// when they run too long or use too much memory, and return a small object whose known IDs are listed for the brain,
// marked with the levels of account data it read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickJsRunner } from '../hosts/quickjs.ts';
import { runToolCall } from '../src/index.ts';
import { examplePack } from './example-pack.ts';
import { exampleSession, exampleValidators } from './example-site.ts';

const runner = quickJsRunner();
const withScripts = () => exampleSession({ host: { scripts: runner } });
const script = async (source: string) => {
  const { session, requests } = await withScripts();
  return { outcome: await runToolCall(session, 'run_script', { source }), session, requests };
};

test('tool calls: a script calls tools through Execute; the known IDs it returns are listed by kind', async () => {
  const { outcome, session } = await script(`
    const { products } = await tools.search_products({ query: 'shoe' });
    const cheap = products.filter((p) => p.total < 100);
    return { ids: cheap.map((p) => p.id), summary: cheap.length + ' under $100' };`);
  assert.deepEqual(outcome, { ok: true, output: { result: { ids: [1], summary: '1 under $100' }, knownIds: { product: [1] } } });
  assert.equal(session.ids.status('product', 2, session.host.now()), 'known', "IDs the script's tool calls returned are known to the session");
});

test("privacy levels: a script that read the user's account says which levels, for the brain to keep them out of its records; one that didn't, doesn't", async () => {
  // A copy of the shop's pack, so making its orders personal below changes no other test's.
  const pack = structuredClone(examplePack);
  const { session } = await exampleSession({ pack, validators: exampleValidators({}, pack), host: { scripts: runner } });
  session.setPage({ url: 'https://www.example.com/account', pageType: 'account', signedIn: true });
  session.accountAllowed = true;
  const readOrders = `const { orders } = await tools.my_orders({}); return { count: orders.length };`;
  assert.deepEqual(await runToolCall(session, 'run_script', { source: readOrders }), { ok: true, output: { result: { count: 1 }, knownIds: {}, account: true } });
  pack.tools.my_orders!.privacy = { personal: ['orders[].status'] };
  assert.deepEqual(await runToolCall(session, 'run_script', { source: readOrders }), { ok: true, output: { result: { count: 1 }, knownIds: {}, personal: true } });
  const shop = await runToolCall(session, 'run_script', { source: `const { products } = await tools.search_products({ query: 'shoe' }); return { count: products.length };` });
  assert.deepEqual(shop.ok && [shop.output.personal, shop.output.account], [undefined, undefined]);
});

test('isolation: a script has no network, timers, modules or host objects', async () => {
  const { outcome } = await script("return { seen: [typeof fetch, typeof XMLHttpRequest, typeof setTimeout, typeof require, typeof process, typeof __call === 'function' ? 'bridge' : 'none'].join(',') };");
  assert.deepEqual(outcome.ok && outcome.output.result, { seen: 'undefined,undefined,undefined,undefined,undefined,bridge' });
});

test("refusals: a tool's refusal reaches the script as an exception it can catch", async () => {
  const { outcome } = await script(`
    try { await tools.place_order({ offerId: 'of_ab12' }); return { ok: 'no' }; }
    catch (error) { return { refused: error.message }; }`);
  assert.match(outcome.ok ? String(outcome.output.result && (outcome.output.result as { refused: string }).refused) : '', /would change something on the site/);
});

test('call budget: scripts share the task budget; a loop of calls stops at the limit', async () => {
  const { outcome } = await script(`
    let made = 0, stopped = '';
    for (let i = 0; i < 10; i++) {
      try { await tools.search_products({ query: 'q' + i }); made++; } catch (error) { stopped = error.message; break; }
    }
    return { made, stopped };`);
  assert.ok(outcome.ok);
  assert.equal((outcome.output.result as { made: number }).made, 5);
  assert.match((outcome.output.result as { stopped: string }).stopped, /This task reached its limit of 5 calls/);
});

test("limits: a script can't start another script or add IDs, and must return a small object", async () => {
  const nested = await script("try { await tools.run_script({ source: 'return {}' }); } catch (error) { return { error: error.message }; }");
  assert.match(nested.outcome.ok ? String((nested.outcome.output.result as { error: string }).error) : '', /can't start another script/);
  const notObject = await script("return 'done';");
  assert.equal(!notObject.outcome.ok && notObject.outcome.error.reason, 'bad_script');
  const big = await script("return { text: 'x'.repeat(20000) };");
  assert.match(!big.outcome.ok ? big.outcome.error.message : '', /return IDs and a short summary/);
  const syntax = await script('return {');
  assert.equal(!syntax.outcome.ok && syntax.outcome.error.reason, 'bad_script');
  const forged = await script("await tools.search_products({ query: 'x' }); return { ids: [999] };");
  assert.deepEqual(forged.outcome.ok && forged.outcome.output.knownIds, {}, '999 was never returned, so it is not listed as known');
});

test('availability: refused where the host has no sandbox; a missing source is refused', async () => {
  const { session } = await exampleSession();
  const off = await runToolCall(session, 'run_script', { source: 'return {}' });
  assert.deepEqual(!off.ok && [off.error.code, off.error.reason], ['tool_disabled', 'scripts_off']);
  const s2 = await withScripts();
  assert.equal(await runToolCall(s2.session, 'run_script', {}).then((outcome) => !outcome.ok && outcome.error.reason), 'bad_script');
});

test('time limit: an endless loop is stopped; time spent waiting for tools does not count', async () => {
  const limits = { timeoutMs: 200, memoryBytes: 16 * 1024 * 1024 };
  const t0 = Date.now();
  const loop = await runner.run('while (true) {}', async () => ({}), limits);
  assert.deepEqual(loop, { ok: false, error: 'the script ran past its time limit' });
  assert.ok(Date.now() - t0 < 3000);
  const slowTool = async () => { await new Promise((resolve) => setTimeout(resolve, 350)); return { done: true }; };
  const waited = await runner.run('const first = await tools.slow({}); const second = await tools.slow({}); return { first, second };', slowTool, limits);
  assert.deepEqual(waited, { ok: true, value: { first: { done: true }, second: { done: true } } });
});

test('memory limit: runaway memory use is stopped', async () => {
  const result = await runner.run('const a = []; for (;;) a.push(new Array(100000).fill(1));', async () => ({}), { timeoutMs: 5000, memoryBytes: 8 * 1024 * 1024 });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : '', /memory/i);
});

test('overall limit: a script that waits forever is stopped', async () => {
  const quick = quickJsRunner({ wallLimitMs: 300 });
  const result = await quick.run('await tools.never({}); return {};', () => new Promise(() => {}), { timeoutMs: 1000, memoryBytes: 16 * 1024 * 1024 });
  assert.deepEqual(result, { ok: false, error: 'the script took too long overall' });
});
