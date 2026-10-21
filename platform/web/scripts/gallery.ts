// Builds the UI fixture galleries into dist/gallery/: one page per site with its UI fixtures, and one with the
// platform's hand-written UI states. Open one in a browser; add #<fixture id> to see a single fixture.
//   npm run gallery
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listSites, repoRoot } from '../../contract/src/site-pack.ts';
import { galleryPage } from '../build/gallery.ts';
import { loadUiFixtures } from '../build/ui-fixtures.ts';
import { UI_STATES } from '../test/ui-states.ts';

const outDir = path.join(repoRoot, 'dist', 'gallery');
mkdirSync(outDir, { recursive: true });
const pages = [...listSites().map((site) => ({ name: site, fixtures: loadUiFixtures(site) })), { name: 'platform-states', fixtures: UI_STATES }];
for (const { name, fixtures } of pages) {
  const file = path.join(outDir, `${name}.html`);
  writeFileSync(file, await galleryPage(`UI fixtures: ${name}`, fixtures));
  console.log(`${path.relative(repoRoot, file)}: ${fixtures.length} fixtures`);
}
