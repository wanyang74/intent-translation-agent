// Drives the extension on the live site in headless Chrome, for trying it before a person does: opens a page, types
// each message into the overlay, waits for the reply, and saves what the user saw. Needs the brain running locally
// (npm run brain) and the extension built for it (npm run extension -- --site <id>). Live site calls go at the site
// pack's rate limit, through the user's (here: a fresh headless profile's) own page, as the site's frontend would.
//   npm run live -- --site <id> --url <page> --message "..." [--message "..."] [--name <run name>] [--headed] [--inspect]
// --headed opens a visible window with a profile kept in dist/live/profile, so a person can answer the site's "are
// you human" check once; the run waits for that (up to 10 minutes) and never tries to answer it itself.
// --inspect prints what a page reader could use: the page's title, its embedded data's key names (never values) and
// its cookie names (never values).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from '../../contract/src/site-pack.ts';
import { openChrome } from '../build/chrome.ts';

const { values: options } = parseArgs({
  options: {
    site: { type: 'string' }, url: { type: 'string' }, message: { type: 'string', multiple: true }, name: { type: 'string', default: 'run' },
    wait: { type: 'string', default: '180' }, headed: { type: 'boolean', default: false }, inspect: { type: 'boolean', default: false },
  },
});
if (!options.site || !options.url || (!options.message?.length && !options.inspect)) {
  console.error('Pass --site, --url and at least one --message (or --inspect).');
  process.exit(1);
}
const outDir = path.join(repoRoot, 'dist', 'live', `${new Date().toISOString().replace(/[:.]/g, '-')}-${options.name}`);
mkdirSync(outDir, { recursive: true });
const overlay = `document.querySelector('#intent-agent-overlay')?.shadowRoot`;

/**
 * One live run:
 *   1. Open the page with the extension; wait for a person to pass the site's check, if it shows one; wait for the
 *      overlay. With --inspect, print what a page reader could use.
 *   2. For each message: type it, wait until the reply has no progress line, and keep its text and a screenshot.
 *   3. Save the transcript and the extension's development log.
 */
const page = await openChrome({
  width: 1280, height: 1000, extension: path.join(repoRoot, 'dist', 'extension', options.site),
  ...(options.headed ? { headed: true, profile: path.join(repoRoot, 'dist', 'live', 'profile') } : {}),
});
const transcript: string[] = [];
try {
  // 1. The page.
  await page.watchNetwork();
  await page.goto(options.url);
  const CHECK = `/Verify you are human|Performing security verification|Just a moment/i.test(document.title + ' ' + (document.body?.innerText ?? '').slice(0, 2000))`;
  if (await page.evaluate<boolean>(CHECK)) {
    if (!options.headed) throw new Error("the site shows an 'are you human' check; rerun with --headed so a person can answer it");
    console.log('WAITING: answer the site\'s check in the Chrome window');
    await page.evaluate(`new Promise((resolve, reject) => { const started = Date.now(); const wait = () => !(${CHECK}) ? resolve(true) : Date.now() - started > 600000 ? reject(new Error('the check was not answered within 10 minutes')) : setTimeout(wait, 1000); wait(); })`)
      .catch(async () => page.evaluate(`new Promise((resolve) => setTimeout(resolve, 3000))`));
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 3000))`);
    if (await page.evaluate<boolean>(CHECK)) throw new Error('the check was not answered');
    console.log('check passed');
  }
  if (options.inspect) {
    const facts = await page.evaluate(`(() => {
      const keys = (value, depth) => value && typeof value === 'object' && depth > 0 ? Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, inner]) => [key, keys(inner, depth - 1)])) : typeof value;
      const embedded = document.querySelector('#__NEXT_DATA__');
      let data = null;
      try { data = embedded ? keys(JSON.parse(embedded.textContent), 5) : null; } catch {}
      const scripts = [...document.querySelectorAll('script:not([src])')].map((script) => ({ type: script.type || 'js', id: script.id || undefined, length: script.textContent.length, start: script.type === 'application/ld+json' ? undefined : script.textContent.slice(0, 40).replace(/[0-9]{3,}/g, '#') }));
      const linkedData = [...document.querySelectorAll('script[type="application/ld+json"]')].map((script) => { try { return keys(JSON.parse(script.textContent), 3); } catch { return 'unreadable'; } });
      return { title: document.title, nextData: data, linkedData, scripts: scripts.filter((script) => script.length > 200).slice(0, 30), cookies: document.cookie.split(';').map((part) => part.split('=')[0].trim()).filter(Boolean),
        localStorage: Object.keys(localStorage) };
    })()`);
    console.log(JSON.stringify(facts, null, 1));
    writeFileSync(path.join(outDir, 'inspect.json'), JSON.stringify(facts, null, 1));
  }
  await page.evaluate(`new Promise((resolve, reject) => { const started = Date.now(); const wait = () => ${overlay} ? resolve(true) : Date.now() - started > 20000 ? reject(new Error('no overlay: the content script did not start (title: ' + document.title + ')')) : setTimeout(wait, 100); wait(); })`);
  // Open the panel. A scripted click in the first moments after load can be dropped (seen on a vehicle page), so
  // click until it's open.
  await page.evaluate(`new Promise((resolve, reject) => { const started = Date.now(); const open = () => { ${overlay}.querySelector('.launcher').click(); if (!${overlay}.querySelector('.panel').hidden) return resolve(true); if (Date.now() - started > 10000) return reject(new Error('the panel did not open')); setTimeout(open, 300); }; open(); })`);

  // 2. The messages.
  for (const [i, message] of (options.message ?? []).entries()) {
    const before = await page.evaluate<number>(`${overlay}.querySelectorAll('.agent').length`);
    await page.evaluate(`(() => { const input = ${overlay}.querySelector('textarea'); input.value = ${JSON.stringify(message)}; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    const started = Date.now();
    const reply = await page.evaluate<string>(`new Promise((resolve) => { const check = () => { const replies = [...${overlay}.querySelectorAll('.agent')]; const last = replies.at(-1); if (replies.length > ${before} && last && last.childNodes.length && !last.querySelector('.progress')) return resolve(last.innerText); if (Date.now() - ${Date.now()} > ${Number(options.wait) * 1000}) return resolve('(no reply within ${options.wait} s) ' + (last ? last.innerText : '')); setTimeout(check, 250); }; check(); })`);
    const links = await page.evaluate<string[]>(`[...[...${overlay}.querySelectorAll('.agent')].at(-1).querySelectorAll('a')].map((link) => link.href)`);
    transcript.push(`USER: ${message}`, `AGENT (${((Date.now() - started) / 1000).toFixed(1)} s):\n${reply}`, ...(links.length ? [`LINKS:\n${links.join('\n')}`] : []), '');
    console.log(transcript.slice(-3).join('\n'));
    writeFileSync(path.join(outDir, `turn-${i + 1}.png`), await page.screenshot('viewport'));
  }
} catch (error) {
  transcript.push(`FAILED: ${String(error)}`);
  console.log(`FAILED: ${String(error)}`);
  writeFileSync(path.join(outDir, 'page.png'), await page.screenshot('viewport').catch(() => Buffer.alloc(0)));
} finally {
  // 3. What happened.
  writeFileSync(path.join(outDir, 'transcript.txt'), transcript.join('\n') + '\n');
  writeFileSync(path.join(outDir, 'log.txt'), page.console.join('\n') + '\n');
  await page.close();
  console.log(`saved in ${path.relative(repoRoot, outDir)}`);
}
