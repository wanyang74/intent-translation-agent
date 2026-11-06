// Opens a live site's page in Chrome for the scripts that read a site directly (record-pages, scan-api), the way
// `npm run live` does: headless by default, or a visible window with the kept profile (dist/live/profile) so a person
// can answer the site's "are you human" check. Nothing here ever answers or gets around that check; it only waits
// for a person, and stops if nobody does.
// Calls to the site are paced at the site pack's rate limit, with one pacer per run.
import path from 'node:path';
import { repoRoot } from '../../contract/src/site-pack.ts';
import { openChrome, type ChromePage } from './chrome.ts';

/** True while the page shows a bot check instead of the site. */
export const HUMAN_CHECK = `/Verify you are human|Performing security verification|Just a moment/i.test(document.title + ' ' + (document.body?.innerText ?? '').slice(0, 2000))`;

/** Waits in the page for a moment; for pages that finish drawing after their load event. */
export const settle = (page: ChromePage, ms: number) => page.evaluate(`new Promise((resolve) => setTimeout(resolve, ${ms}))`);

/**
 * Waits for a person to answer the page's bot check, if it shows one: headless stops with a hint to rerun headed;
 * headed waits up to 10 minutes. Never answers the check itself.
 */
export async function passCheck(page: ChromePage, headed: boolean): Promise<void> {
  if (!(await page.evaluate<boolean>(HUMAN_CHECK))) return;
  if (!headed) throw new Error("the site shows an 'are you human' check; rerun with --headed so a person can answer it");
  console.log('WAITING: answer the site\'s check in the Chrome window');
  // Polled from here, not awaited in the page: the check reloads the page when it's answered, and a promise waiting
  // in the page would die with it.
  const started = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const showing = await page.evaluate<boolean>(HUMAN_CHECK).catch(() => true);
    if (!showing) break;
    if (Date.now() - started > 600_000) throw new Error('the check was not answered within 10 minutes');
  }
  await settle(page, 3000);
  if (await page.evaluate<boolean>(HUMAN_CHECK)) throw new Error('the check came back');
  console.log('check passed');
}

/**
 * Opens a page of the live site:
 *   1. Start Chrome: headless with a throwaway profile, or headed with the kept one.
 *   2. Load the page, and wait for a person to answer a bot check if it shows one.
 */
export async function openSitePage(url: string, options: { headed: boolean }): Promise<ChromePage> {
  // 1. Chrome.
  const page = await openChrome({
    width: 1280, height: 1000,
    ...(options.headed ? { headed: true, profile: path.join(repoRoot, 'dist', 'live', 'profile') } : {}),
  });
  try {
    // 2. The page, and the check if there is one.
    await page.goto(url);
    await settle(page, 2000);
    await passCheck(page, options.headed);
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

/** Waits as needed before each call so calls never go faster than `perSecond`. */
export function pacer(perSecond: number): () => Promise<void> {
  const gapMs = 1000 / perSecond;
  let last = 0;
  return async () => {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    last = Date.now();
  };
}
