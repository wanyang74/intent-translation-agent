// Every site pack is valid and complete, and the platform stays general: no platform file names a site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadContract } from '../src/load.ts';
import { PRESENTATION_TOOLS, crossCheck, entriesOf, listSites, readSite, repoRoot } from '../src/site-pack.ts';

const sites = listSites();

test('there is more than one site pack, so the platform is tested for generality', () => {
  assert.ok(sites.length >= 2, `site packs: ${sites.join(', ')}`);
});

test('every site.yaml matches the site-pack format', () => {
  assert.doesNotThrow(() => loadContract());
});

for (const id of sites) {
  test(`${id}: everything the site pack refers to exists`, () => {
    assert.deepEqual(crossCheck(readSite(id)), []);
  });

  test(`${id}: every tool that shows something names a platform presentation tool`, () => {
    for (const [name, tool] of entriesOf(readSite(id).pack.tools)) {
      if (tool.presentation) assert.ok(PRESENTATION_TOOLS.includes(tool.presentation), `${name}: ${tool.presentation}`);
    }
  });
}

// The words that would tie platform code to a site: its id and its hostnames.
function siteWords(id: string): string[] {
  const { pack } = readSite(id);
  const hosts = pack.site.origins.map((o) => new URL(o).hostname.replace(/^(www|api)\./, ''));
  return [...new Set([id, ...hosts])];
}

function platformFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules') return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? platformFiles(p) : /\.(ts|js|json|ya?ml|md)$/.test(e.name) ? [p] : [];
  });
}

test('no platform file names a site: site-specific facts live in sites/<id>/', () => {
  const words = sites.flatMap(siteWords);
  const hits: string[] = [];
  for (const file of platformFiles(path.join(repoRoot, 'platform'))) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const w of words) if (text.includes(w.toLowerCase())) hits.push(`${path.relative(repoRoot, file)} mentions "${w}"`);
  }
  assert.deepEqual(hits, []);
});
