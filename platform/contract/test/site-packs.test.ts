// Tests: every site pack (sites/<id>/site.yaml and what it refers to), and the platform's generality.
// How: loads each pack against the site-pack schema, resolves every reference, and scans every platform file.
// Passes when: each pack is valid and complete, a pack with broken references is caught, there is more than one, and
// no platform file names a site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadContract } from '../src/load.ts';
import { PRESENTATION_TOOLS, contrastWithWhite, crossCheck, entriesOf, listSites, readSite, repoRoot } from '../src/site-pack.ts';

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

test("references: a token's endpoint must exist and answer JSON, a token needs an expiry, and eventKind needs a stream", () => {
  const site = readSite(sites[0]!);
  const unknown = structuredClone(site.pack);
  unknown.token = { endpoint: 'no_such_endpoint', value: 'token', header: 'X-Token', refusedStatuses: [401] };
  const [name] = entriesOf(unknown.endpoints).find(([, endpoint]) => (endpoint.responseFormat ?? 'json') === 'json')!;
  unknown.endpoints[name]!.eventKind = 'type';
  const htmlIssuer = structuredClone(site.pack);
  htmlIssuer.endpoints.token_page = { method: 'GET', url: `${site.pack.site.origins[0]}/token`, request: unknown.endpoints[name]!.request, response: unknown.endpoints[name]!.response, responseFormat: 'html', matchKey: [] };
  htmlIssuer.token = { endpoint: 'token_page', value: 'token', lifetimeSeconds: 3600, header: 'X-Token', refusedStatuses: [401] };
  const problems = (pack: typeof site.pack) => crossCheck({ ...site, pack }).map((problem) => problem.slice(problem.indexOf(': ') + 2));
  assert.deepEqual(problems(unknown), [
    `endpoints.${name}.eventKind: only applies to responseFormat: sse`,
    'token.endpoint: unknown endpoint no_such_endpoint',
    'token: needs expiresAt or lifetimeSeconds',
  ]);
  assert.deepEqual(problems(htmlIssuer), ['token.endpoint: must answer with JSON']);
});

test("references: a card's destination takes its one ID, and a page action must be listed, on known pages, with a builder", () => {
  const site = readSite(sites[0]!);
  const broken = structuredClone(site.pack);
  const [kind, entity] = entriesOf(broken.entities).find(([, candidate]) => candidate.card && !candidate.internal)!;
  const [otherKind] = entriesOf(broken.entities).find(([candidate]) => candidate !== kind)!;
  broken.deepLinks = { ...broken.deepLinks, plain: { template: 'https://example.invalid/' } };
  broken.destinations = {
    other_item: { title: 'T', description: 'D', params: { id: { type: 'string', entity: otherKind } } },
    unlisted_action: { title: 'T', description: 'D', pageAction: 'no_such_action' },
    with_link: { title: 'T', description: 'D', link: 'plain', pageAction: 'open_details' },
  };
  broken.pageActions = { open_details: { description: 'D', effect: 'shows_information', pageTypes: ['no_such_page'] } };
  entity!.card!.destination = 'other_item';
  const linked = entity!.card!.link !== undefined;
  const problems = crossCheck({ ...site, pack: broken }).map((problem) => problem.slice(problem.indexOf(': ') + 2));
  assert.deepEqual(problems, [
    `entities.${kind}.card.destination: other_item must take exactly one param, a ${kind} ID`,
    ...(linked ? [`entities.${kind}.card: takes either link or destination, not both`] : []),
    'destinations.unlisted_action.pageAction: unknown page action no_such_action',
    "destinations.with_link: a page action needs the site code's builder, not a link",
    'pageActions.open_details.pageTypes: unknown page type no_such_page',
  ]);
});

test("references: an action that changes the site needs its button, consent and done text, and can't be a card's button", () => {
  const site = readSite(sites[0]!);
  const broken = structuredClone(site.pack);
  const [kind, entity] = entriesOf(broken.entities).find(([, candidate]) => candidate.card && !candidate.internal)!;
  // An item with no page of its own, the kind a card's destination is for.
  delete entity!.card!.link;
  entity!.noPage = true;
  broken.destinations = {
    add_item: { title: 'T', description: 'D', params: { id: { type: 'string', entity: kind } }, pageAction: 'add_to_cart' },
    show_item: { title: 'T', description: 'D', params: { id: { type: 'string', entity: kind } }, pageAction: 'open_details' },
  };
  broken.pageActions = {
    add_to_cart: { description: 'D', effect: 'changes_site_state', pageTypes: [site.pack.site.pageTypes![0]!], button: 'Add to cart', consent: ' ' },
    open_details: { description: 'D', effect: 'shows_information', pageTypes: [site.pack.site.pageTypes![0]!], button: 'Add to cart' },
  };
  entity!.card!.destination = 'add_item';
  const problems = (pack: typeof broken) => crossCheck({ ...site, pack }).map((problem) => problem.slice(problem.indexOf(': ') + 2));
  assert.deepEqual(problems(broken), [
    `entities.${kind}.card.destination: add_item changes the site, so it can't be a card's button`,
    'pageActions.add_to_cart: changes the site, so it needs consent',
    'pageActions.add_to_cart: changes the site, so it needs done',
    'pageActions.open_details: only shows information, so button would never show',
  ]);
  // Fixed: the card shows the item, and the write action has all three texts.
  entity!.card!.destination = 'show_item';
  broken.pageActions.add_to_cart = { ...broken.pageActions.add_to_cart!, consent: 'Puts it in your cart on the site.', done: 'Added: {hint}.' };
  delete broken.pageActions.open_details!.button;
  assert.deepEqual(problems(broken), []);
});

test("references: a brand color must be dark enough for the panel's white text", () => {
  const site = readSite(sites[0]!);
  const problems = (brandColor: string) => crossCheck({ ...site, pack: { ...site.pack, site: { ...site.pack.site, brandColor } } }).map((problem) => problem.slice(problem.indexOf(': ') + 2));
  assert.deepEqual(problems('#1f5eff'), []);
  assert.deepEqual(problems('#7aa2ff'), ['site.brandColor: too light for white text: 2.49:1, needs 4.5:1']);
  assert.equal(contrastWithWhite('#000000').toFixed(2), '21.00');
  assert.equal(contrastWithWhite('#ffffff').toFixed(2), '1.00');
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
