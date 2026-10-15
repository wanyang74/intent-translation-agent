// Phase 0 toy: the script sandbox.
// Model-written scripts run in QuickJS (compiled to WebAssembly, the same engine the web sandbox would use).
// The only way out of the sandbox is one host function, so scripts can call registered tools and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const QuickJS = await getQuickJS();

async function runScript(code, hostTools, { timeoutMs = 1000, memoryBytes = 16 * 1024 * 1024 } = {}) {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
  const vm = runtime.newContext();
  let disposed = false;
  try {
    // The single host entry point: __call(toolName, argsJson) returns a promise of resultJson.
    const callFn = vm.newFunction('__call', (nameH, argsH) => {
      const name = vm.getString(nameH);
      const args = JSON.parse(vm.getString(argsH));
      const deferred = vm.newPromise();
      Promise.resolve()
        .then(() => {
          if (!Object.hasOwn(hostTools, name)) throw new Error(`Unknown tool: ${name}`);
          return hostTools[name](args);
        })
        .then(
          (out) => { if (!disposed) { const h = vm.newString(JSON.stringify(out)); deferred.resolve(h); h.dispose(); } },
          (err) => { if (!disposed) { const h = vm.newError(err.message); deferred.reject(h); h.dispose(); } },
        );
      deferred.settled.then(() => { if (!disposed) runtime.executePendingJobs(); });
      return deferred.handle;
    });
    vm.setProp(vm.global, '__call', callFn);
    callFn.dispose();

    const prelude = `const tools = new Proxy({}, { get: (_, name) => async (args) => JSON.parse(await __call(String(name), JSON.stringify(args ?? {}))) });`;
    const started = vm.evalCode(`${prelude}\n(async () => {\n${code}\n})()`);
    if (started.error) {
      const error = vm.dump(started.error); started.error.dispose();
      return { ok: false, error };
    }
    const settledP = vm.resolvePromise(started.value);
    runtime.executePendingJobs(); // run the promise callbacks for scripts that finish without calling a tool
    const settled = await settledP;
    started.value.dispose();
    if (settled.error) {
      const error = vm.dump(settled.error); settled.error.dispose();
      return { ok: false, error };
    }
    const value = vm.dump(settled.value); settled.value.dispose();
    return { ok: true, value };
  } finally {
    disposed = true;
    vm.dispose();
    runtime.dispose();
  }
}

const errText = (e) => (typeof e === 'string' ? e : `${e?.name ?? ''}: ${e?.message ?? JSON.stringify(e)}`);

// Host tools with a host-side ID set, as core.js would have.
function hostTools() {
  const known = new Set();
  return {
    async search() {
      const vehicles = [
        { vehicleId: 4773662, estimatedTotal: 38326 },
        { vehicleId: 4812031, estimatedTotal: 39427 },
        { vehicleId: 4811903, estimatedTotal: 38766 },
      ];
      vehicles.forEach((v) => known.add(v.vehicleId));
      return { vehicles };
    },
    async availability({ vehicleIds }) {
      if (vehicleIds.some((id) => !known.has(id))) {
        throw new Error("This ID wasn't returned in this session. Use an ID from the search results.");
      }
      const days = { 4773662: 1, 4812031: 3, 4811903: 5 };
      return Object.fromEntries(vehicleIds.map((id) => [id, { daysToAvailability: days[id] }]));
    },
  };
}

test('a script can call registered tools and returns IDs, not content', async () => {
  const r = await runScript(`
    const { vehicles } = await tools.search({ model: 'Model Y' });
    const avail = await tools.availability({ vehicleIds: vehicles.map(v => v.vehicleId) });
    const picks = vehicles
      .filter(v => avail[v.vehicleId].daysToAvailability <= 3)
      .filter(v => v.estimatedTotal <= 40000)
      .sort((a, b) => a.estimatedTotal - b.estimatedTotal);
    return { ids: picks.map(v => v.vehicleId), checked: vehicles.length };
  `, hostTools());
  assert.equal(r.ok, true, errText(r.error));
  assert.deepEqual(r.value, { ids: [4773662, 4812031], checked: 3 });
});

test('the sandbox has no network, modules, timers or process access', async () => {
  const r = await runScript(`
    return [typeof fetch, typeof XMLHttpRequest, typeof require, typeof process, typeof setTimeout, typeof importScripts, typeof WebSocket].join(',');
  `, hostTools());
  assert.equal(r.ok, true, errText(r.error));
  assert.equal(r.value, 'undefined,undefined,undefined,undefined,undefined,undefined,undefined');
});

test('only registered tools exist: a script cannot add IDs or call anything else', async () => {
  const r = await runScript(`await tools.addKnownId({ vehicleId: 123 });`, hostTools());
  assert.equal(r.ok, false);
  assert.match(errText(r.error), /Unknown tool: addKnownId/);
});

test('an ID the session never saw is refused by the host, and the script can see why', async () => {
  const r = await runScript(`
    try { await tools.availability({ vehicleIds: [9999999] }); return 'not refused'; }
    catch (e) { return e.message; }
  `, hostTools());
  assert.equal(r.ok, true, errText(r.error));
  assert.match(r.value, /wasn't returned in this session/);
});

test('an endless loop is stopped by the deadline', async () => {
  const t0 = Date.now();
  const r = await runScript(`while (true) {}`, hostTools(), { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.match(errText(r.error), /interrupted/i);
  assert.ok(Date.now() - t0 < 2000, 'should stop close to the deadline');
});

test('runaway memory use is capped', async () => {
  const r = await runScript(`const a = []; for (;;) a.push(new Array(100000).fill(1));`, hostTools(), { timeoutMs: 5000, memoryBytes: 8 * 1024 * 1024 });
  assert.equal(r.ok, false);
  assert.match(errText(r.error), /memory|interrupted/i);
});
