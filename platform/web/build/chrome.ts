// A small driver for a headless Chrome, over the Chrome DevTools Protocol, for the overlay's tests and screenshots
// and the extension's. No browser library: Chrome is started with a DevTools pipe, and one page is driven over it.
// Only the handful of protocol commands the tests need are wrapped.
// Chrome is found at CHROME_PATH, or where macOS and Linux install it; without it, tests that need it are skipped.
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => !!candidate);

/** Where Chrome is, or null when it isn't installed. */
export function chromePath(): string | null {
  return CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

export interface ChromeOptions {
  /** The viewport in CSS pixels. */
  width?: number;
  height?: number;
  /** An unpacked extension folder to load. */
  extension?: string;
  /** A visible window instead of headless, for a person to see (and to answer a site's "are you human" check). */
  headed?: boolean;
  /** A profile folder that's kept between runs (cookies, such as a passed check); a throwaway one otherwise. */
  profile?: string;
}

/** A request the page made, as interception sees it. */
export interface InterceptedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** An answer to an intercepted request; null lets it go to the network. */
export type InterceptedResponse = { status: number; headers: Record<string, string>; body: string } | null;

export interface ChromePage {
  goto(url: string): Promise<void>;
  /** Answers the page's requests to URLs matching these patterns (* is a wildcard) with `answer`. */
  intercept(patterns: string[], answer: (request: InterceptedRequest) => Promise<InterceptedResponse>): Promise<void>;
  /** Every console message so far, from the page and its content scripts, as text. */
  readonly console: string[];
  /** Records why requests fail (into `console`, as "[network] ..."), for debugging a live page. */
  watchNetwork(): Promise<void>;
  /** Evaluates an expression in the page and returns its value; a promise is awaited. */
  evaluate<T>(expression: string): Promise<T>;
  /** A PNG of the whole page (beyond the viewport too), of one element's box, or of what's in view, at scale 1. */
  screenshot(selector?: string | 'viewport'): Promise<Buffer>;
  close(): Promise<void>;
}

/**
 * Starts Chrome and opens one page:
 *   1. Launch with a throwaway profile, talking DevTools over a pipe: Chrome reads commands on file descriptor 3 and
 *      writes answers on 4, each a JSON message ended by a NUL byte. The pipe (not a port) is what lets the test load
 *      an unpacked extension: Chrome 137 and later ignore --load-extension, and Extensions.loadUnpacked works only
 *      over a pipe.
 *   2. Commands carry an id, matched to their answers; page commands also carry the page's session id.
 *   3. Load the extension, if any; then attach to the page Chrome opened at launch.
 */
export async function openChrome(options: ChromeOptions = {}): Promise<ChromePage> {
  const executable = chromePath();
  if (!executable) throw new Error('Chrome not found; set CHROME_PATH');

  // 1. Launch.
  const profile = options.profile ?? mkdtempSync(path.join(os.tmpdir(), 'overlay-chrome-'));
  const args = [
    ...(options.headed ? [] : ['--headless=new']), '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--force-color-profile=srgb', '--disable-gpu', '--font-render-hinting=none',
    `--window-size=${options.width ?? 400},${options.height ?? 900}`,
    ...(options.extension ? ['--enable-unsafe-extension-debugging'] : []),
    'about:blank',
  ];
  const chrome: ChildProcess = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const toChrome = chrome.stdio[3] as Writable;
  const fromChrome = chrome.stdio[4] as Readable;
  let stderr = '';
  chrome.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });

  // 2. Commands and events.
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const waiters: { method: string; resolve: () => void }[] = [];
  const consoleLines: string[] = [];
  const listeners = new Map<string, (params: any) => void>();
  const onMessage = (message: any) => {
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(`${message.error.message} ${message.error.data ?? ''}`));
      else waiting?.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(message.params.args.map((arg: { value?: unknown; description?: string }) => (arg.value !== undefined ? String(arg.value) : arg.description ?? '')).join(' '));
    }
    listeners.get(message.method)?.(message.params);
    for (const waiter of waiters.filter((candidate) => candidate.method === message.method)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  let buffered = '';
  fromChrome.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    for (let end = buffered.indexOf('\0'); end >= 0; end = buffered.indexOf('\0')) {
      onMessage(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  });
  const exited = new Promise<void>((resolve) => chrome.once('exit', () => {
    for (const waiting of pending.values()) waiting.reject(new Error(`Chrome exited:\n${stderr.slice(-500)}`));
    resolve();
  }));
  let sessionId: string | undefined;
  const sendTo = (session: string | undefined, method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    toChrome.write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + '\0');
  });
  const send = (method: string, params: object = {}) => sendTo(sessionId, method, params);

  // 3. The extension, then the page.
  if (options.extension) await sendTo(undefined, 'Extensions.loadUnpacked', { path: options.extension });
  const { targetInfos } = await sendTo(undefined, 'Target.getTargets');
  const target = (targetInfos as { type: string; targetId: string }[]).find((candidate) => candidate.type === 'page');
  if (!target) throw new Error('Chrome opened no page');
  sessionId = (await sendTo(undefined, 'Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  const next = (method: string, timeoutMs = 30_000) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${method} within ${timeoutMs / 1000} s`)), timeoutMs);
    waiters.push({ method, resolve: () => { clearTimeout(timer); resolve(); } });
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: options.width ?? 400, height: options.height ?? 900, deviceScaleFactor: 1, mobile: false });

  const page: ChromePage = {
    console: consoleLines,
    async watchNetwork() {
      const urls = new Map<string, string>();
      listeners.set('Network.requestWillBeSent', (params) => urls.set(params.requestId, `${params.request.method} ${params.request.url}`));
      listeners.set('Network.loadingFailed', (params) => {
        consoleLines.push(`[network] failed ${urls.get(params.requestId) ?? params.requestId}: ${params.errorText} ${params.corsErrorStatus ? JSON.stringify(params.corsErrorStatus) : ''} ${params.blockedReason ?? ''}`);
      });
      listeners.set('Network.responseReceived', (params) => {
        if (params.response.status >= 400) consoleLines.push(`[network] ${params.response.status} ${urls.get(params.requestId)}`);
      });
      await send('Network.enable');
    },
    async intercept(patterns, answer) {
      // Fetch.requestPaused arrives for each matching request; it must be fulfilled or continued, or it hangs.
      listeners.set('Fetch.requestPaused', async (params) => {
        const { request, requestId } = params;
        try {
          const response = await answer({ url: request.url, method: request.method, headers: request.headers, body: request.postData ?? null });
          if (!response) return void (await send('Fetch.continueRequest', { requestId }));
          await send('Fetch.fulfillRequest', {
            requestId, responseCode: response.status, body: Buffer.from(response.body).toString('base64'),
            responseHeaders: Object.entries(response.headers).map(([name, value]) => ({ name, value })),
          });
        } catch (error) {
          consoleLines.push(`[intercept] ${request.url}: ${String(error)}`);
          await send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        }
      });
      await send('Fetch.enable', { patterns: patterns.map((urlPattern) => ({ urlPattern, requestStage: 'Request' })) });
    },
    async goto(url) {
      const loaded = next('Page.loadEventFired');
      await send('Page.navigate', { url });
      await loaded;
    },
    async evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(`in the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      return result.value;
    },
    async screenshot(selector) {
      const box = await page.evaluate<{ x: number; y: number; width: number; height: number }>(selector === 'viewport'
        ? '({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight })'
        : selector
        ? `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`
        : '({ x: 0, y: 0, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })');
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, scale: 1 } });
      return Buffer.from(data, 'base64');
    },
    async close() {
      chrome.kill();
      await exited;
      if (!options.profile) rmSync(profile, { recursive: true, force: true });
    },
  };
  return page;
}
