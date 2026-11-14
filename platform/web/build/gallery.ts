// Builds the UI fixture gallery: one self-contained HTML page with the overlay's code and a set of UI fixtures, for
// looking at in a browser and for the screenshot test. Open it with #<fixture id> to see one fixture alone.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { listSites, readSite } from '../../contract/src/site-pack.ts';
import type { UiFixture } from '../src/ui-fixture.ts';

const entry = fileURLToPath(new URL('../src/gallery.ts', import.meta.url));

/** The gallery's script: the overlay and the replay code, bundled for the browser. */
export async function galleryScript(): Promise<string> {
  const result = await build({ entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent' });
  return result.outputFiles[0]!.text;
}

/** Each site pack's brand color, by site id, so a site's fixtures are drawn in its colors. */
function brandColors(): Record<string, string> {
  return Object.fromEntries(listSites().flatMap((site) => {
    const color = readSite(site).pack.site.brandColor;
    return color ? [[site, color]] : [];
  }));
}

/** The whole page. `<` in the fixtures' JSON is escaped, so a fixture's text can't close the script tag early. */
export async function galleryPage(title: string, fixtures: UiFixture[]): Promise<string> {
  const data = JSON.stringify(fixtures).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<style>
  body { margin: 0; background: #eef0f3; font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #18202c; }
  .grid { display: flex; flex-wrap: wrap; gap: 24px; padding: 24px; align-items: flex-start; }
  .fixture { width: 400px; }
  .fixture h2 { font-size: 15px; margin: 0 0 2px; }
  .fixture p { margin: 0 0 8px; color: #5d6675; font-size: 12px; }
  body.one .grid { padding: 0; }
</style>
</head>
<body>
<script>window.uiFixtures = ${data}; window.brandColors = ${JSON.stringify(brandColors())}; if (location.hash) document.body.className = 'one';</script>
<script>${await galleryScript()}</script>
</body>
</html>
`;
}
