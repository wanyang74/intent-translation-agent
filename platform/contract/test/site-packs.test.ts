// Tests: every site pack (sites/<id>/site.yaml and what it refers to), and the platform's generality.
// How: loads each pack against the site-pack schema, resolves every reference, and scans every platform file.
// Passes when: each pack is valid and complete, a pack with broken references is caught, there is more than one, and
// no platform file names a site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadContract } from '../src/load.ts';
import { PRESENTATION_TOOLS, crossCheck, entriesOf, listSites, readSite, repoRoot } from '../src/site-pack.ts';

const sites = listSites();

test('generality: there is more than one site pack, so the platform is tested on more than one site', () => {
  assert.ok(sites.length >= 2, `site packs: ${sites.join(', ')}`);
});

test('format: every site.yaml matches the site-pack schema', () => {
  assert.doesNotThrow(() => loadContract());
});

for (const id of sites) {
  test(`${id}: references: everything the site pack refers to exists`, () => {
    assert.deepEqual(crossCheck(readSite(id)), []);
  });

  test(`${id}: presentation: every tool that shows something names a platform presentation tool`, () => {
    for (const [name, tool] of entriesOf(readSite(id).pack.tools)) {
      if (tool.presentation) assert.ok(PRESENTATION_TOOLS.includes(tool.presentation), `${name}: ${tool.presentation}`);
    }
  });
}

test("references: a destination's tool, reader, deep link and params, and every card's link, are checked", () => {
  // A real site pack with mistakes added, so only the added mistakes are reported.
  const site = readSite(sites[0]!);
  const broken = structuredClone(site.pack);
  const [kind] = entriesOf(broken.entities).find(([, entity]) => entity.card && !entity.internal && !entity.noPage)!;
  delete broken.entities[kind]!.card!.link;
  broken.deepLinks = { ...broken.deepLinks, by_slug: { template: 'https://example.invalid/{slug}' } };
  broken.destinations = {
    both: { title: 'T', description: 'D', argsOf: 'no_such_tool', params: { slug: { type: 'string' } }, reader: 'no_reader' },
    no_link: { title: 'T', description: 'D', link: 'no_such_link' },
    wrong_param: { title: 'T', description: 'D', params: { id: { type: 'string', entity: 'no_kind' } }, link: 'by_slug', app: 'app://{slug}' },
  };
  assert.deepEqual(crossCheck({ ...site, pack: broken }).map((problem) => problem.slice(problem.indexOf(': ') + 2)), [
    `entities.${kind}.card: needs a link to the item's page`,
    'destinations.both.argsOf: unknown tool no_such_tool',
    'destinations.both: takes either argsOf or params, not both',
    'destinations.both.reader: unknown tool no_reader',
    'destinations.no_link.link: unknown deep link no_such_link',
    'destinations.wrong_param.params.id: unknown entity kind no_kind',
    "destinations.wrong_param.link: the template's {slug} isn't one of the destination's params",
    "destinations.wrong_param.app: the route's {slug} isn't one of the destination's params",
  ]);
});

// The words that would tie platform code to a site: its id and its hostnames.
function siteWords(id: string): string[] {
  const { pack } = readSite(id);
  const hosts = pack.site.origins.map((origin) => new URL(origin).hostname.replace(/^(www|api)\./, ''));
  return [...new Set([id, ...hosts])];
}

function platformFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? platformFiles(entryPath) : /\.(ts|js|json|ya?ml|md)$/.test(entry.name) ? [entryPath] : [];
  });
}

test('no site names in the platform: site-specific facts live in sites/<id>/', () => {
  const words = sites.flatMap(siteWords);
  const hits: string[] = [];
  for (const file of platformFiles(path.join(repoRoot, 'platform'))) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const word of words) if (text.includes(word.toLowerCase())) hits.push(`${path.relative(repoRoot, file)} mentions "${word}"`);
  }
  assert.deepEqual(hits, []);
});
