// The script sandbox for the web and Node hosts: QuickJS compiled to WebAssembly. A script sees one object, `tools`,
// whose methods go through the platform's tool runner (so the boundary checks and the shared budget apply); it has
// no network, timers, modules or host objects. Its time limit counts only time spent running the script's own code,
// not time waiting for tool calls, so a batch on a slow rate limit isn't cut short; a longer overall limit still
// applies. Memory and stack are capped.
import { getQuickJS, type QuickJSHandle, type QuickJSWASMModule } from 'quickjs-emscripten';
import type { ScriptResult, ScriptRunner } from '../src/host.ts';

/** How long a script may take overall, waiting for tool calls included. */
export const SCRIPT_WALL_LIMIT_MS = 180_000;

function describe(dumped: unknown): string {
  if (typeof dumped === 'string') return dumped;
  const e = dumped as { name?: string; message?: string } | null;
  if (e && typeof e === 'object' && (e.name || e.message)) return [e.name, e.message].filter(Boolean).join(': ');
  return JSON.stringify(dumped);
}

export function quickJsRunner(options: { wallLimitMs?: number } = {}): ScriptRunner {
  let module: Promise<QuickJSWASMModule> | undefined;
  return {
    async run(source, callTool, limits): Promise<ScriptResult> {
      const QuickJS = await (module ??= getQuickJS());
      const runtime = QuickJS.newRuntime();
      runtime.setMemoryLimit(limits.memoryBytes);
      runtime.setMaxStackSize(512 * 1024);
      // Time spent running script code, summed across slices; waiting for tool calls doesn't count.
      let used = 0;
      let sliceStart = 0;
      runtime.setInterruptHandler(() => used + (Date.now() - sliceStart) > limits.timeoutMs);
      const slice = <T>(run: () => T): T => {
        sliceStart = Date.now();
        try {
          return run();
        } finally {
          used += Date.now() - sliceStart;
        }
      };
      const vm = runtime.newContext();
      let disposed = false;
      // Tool calls still in flight when the script ends; their handles are released before the context goes.
      const pending = new Set<{ dispose(): void }>();
      try {
        const call = vm.newFunction('__call', (nameHandle, argsHandle) => {
          const name = vm.getString(nameHandle);
          const argsText = vm.getString(argsHandle);
          const deferred = vm.newPromise();
          pending.add(deferred);
          Promise.resolve()
            .then(() => callTool(name, JSON.parse(argsText)))
            .then(
              (out) => {
                if (disposed) return;
                const h = vm.newString(JSON.stringify(out));
                deferred.resolve(h);
                h.dispose();
              },
              (err: unknown) => {
                if (disposed) return;
                const h = vm.newError(err instanceof Error ? err.message : String(err));
                deferred.reject(h);
                h.dispose();
              },
            );
          void deferred.settled.then(() => {
            pending.delete(deferred);
            if (!disposed) slice(() => runtime.executePendingJobs());
          });
          return deferred.handle;
        });
        vm.setProp(vm.global, '__call', call);
        call.dispose();

        const prelude = 'const tools = new Proxy({}, { get: (_, name) => async (args) => JSON.parse(await __call(String(name), JSON.stringify(args ?? {}))) });';
        const started = slice(() => vm.evalCode(`${prelude}\n(async () => {\n${source}\n})()`));
        if (started.error) {
          const error = describe(vm.dump(started.error));
          started.error.dispose();
          return { ok: false, error };
        }
        const promise: QuickJSHandle = started.value;
        const settledP = vm.resolvePromise(promise);
        slice(() => runtime.executePendingJobs());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const overall = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), options.wallLimitMs ?? SCRIPT_WALL_LIMIT_MS); });
        const settled = await Promise.race([settledP, overall]);
        clearTimeout(timer);
        promise.dispose();
        if (settled === 'timeout') return { ok: false, error: 'the script took too long overall' };
        if (settled.error) {
          const error = describe(vm.dump(settled.error));
          settled.error.dispose();
          return { ok: false, error: /interrupted/i.test(error) ? 'the script ran past its time limit' : error };
        }
        const value = vm.dump(settled.value);
        settled.value.dispose();
        return { ok: true, value };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, error: /memory/i.test(message) ? 'the script ran out of memory' : message };
      } finally {
        disposed = true;
        for (const d of pending) d.dispose();
        vm.dispose();
        runtime.dispose();
      }
    },
  };
}
