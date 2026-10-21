// Tests: the overlay looks the same as when its screenshots were last approved (phase 7's gate: "UI fixture
// screenshots match"). Opt-in, since fonts and Chrome versions differ between machines: `npm run test:screenshots`.
// How: each conversation's UI fixture, and each platform state, is drawn alone in headless Chrome and captured;
// compared with sites/<id>/ui-fixtures/screenshots/<fixture>.png and platform/web/test/screenshots/<state>.png.
// After a deliberate change, look at the new screenshots and keep them with UPDATE=1.
// Passes when: at most 0.1% of pixels differ noticeably from each saved screenshot.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listSites } from '../../contract/src/site-pack.ts';
import { chromePath, openChrome } from '../build/chrome.ts';
import { galleryPage } from '../build/gallery.ts';
import { decodePng, differentPixels } from '../build/png.ts';
import { loadUiFixtures, uiFixturesDir } from '../build/ui-fixtures.ts';
import type { UiFixture } from '../src/ui-fixture.ts';
import { UI_STATES } from './ui-states.ts';

const enabled = process.env.SCREENSHOTS === '1';
const update = process.env.UPDATE === '1';
const skip = (!enabled && 'opt-in: npm run test:screenshots') || (!chromePath() && 'Chrome not installed');
const here = fileURLToPath(new URL('.', import.meta.url));
const workDir = mkdtempSync(path.join(os.tmpdir(), 'overlay-shots-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const groups: { name: string; fixtures: UiFixture[]; dir: string }[] = [
  ...listSites().map((site) => ({ name: site, fixtures: loadUiFixtures(site).filter((fixture) => fixture.source === 'conversation'), dir: path.join(uiFixturesDir(site), 'screenshots') })),
  { name: 'platform states', fixtures: UI_STATES, dir: path.join(here, 'screenshots') },
];

for (const { name, fixtures, dir } of groups) {
  test(`${name}: each UI fixture looks like its saved screenshot`, { skip }, async () => {
    const file = path.join(workDir, `${name.replace(/\W+/g, '-')}.html`);
    writeFileSync(file, await galleryPage(name, fixtures));
    const page = await openChrome({ width: 400, height: 900 });
    const mismatches: string[] = [];
    try {
      for (const fixture of fixtures) {
        // A query that changes each time makes this a real navigation; a change of the #hash alone would only scroll.
        await page.goto(`${pathToFileURL(file).href}?${fixtures.indexOf(fixture)}#${encodeURIComponent(fixture.id)}`);
        const shot = await page.screenshot('.overlay');
        const saved = path.join(dir, `${fixture.id}.png`);
        if (update) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(saved, shot);
          continue;
        }
        if (!existsSync(saved)) {
          mismatches.push(`${fixture.id}: no saved screenshot (run with UPDATE=1)`);
          continue;
        }
        const share = differentPixels(decodePng(readFileSync(saved)), decodePng(shot));
        if (share > 0.001) {
          writeFileSync(path.join(workDir, `${fixture.id}.actual.png`), shot);
          mismatches.push(`${fixture.id}: ${(share * 100).toFixed(1)}% of pixels differ`);
        }
      }
    } finally {
      await page.close();
    }
    assert.deepEqual(mismatches, []);
  });
}
