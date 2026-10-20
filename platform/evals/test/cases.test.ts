// Every site's eval cases refer only to what exists (conversations, tools, entities, notices, fixtures, pages), cover
// every category between them, and their fixture edits apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSites } from '../../contract/src/site-pack.ts';
import { loadConversations } from '../../testkit/src/conversations.ts';
import { loadFixtures } from '../../testkit/src/fixtures.ts';
import { loadSiteRuntime } from '../../testkit/src/site-runtime.ts';
import { CATEGORIES, checkCases, editFixtures, hasEvals, loadCases } from '../src/cases.ts';

test('every site pack brings eval cases', () => {
  assert.deepEqual(listSites().filter((site) => !hasEvals(site)), []);
});

for (const site of listSites().filter(hasEvals)) {
  test(`${site}: every eval case refers only to what exists, and its fixture edits apply`, async () => {
    const cases = loadCases(site);
    const fixtures = loadFixtures(site);
    const { pack } = await loadSiteRuntime(site);
    assert.deepEqual(checkCases(cases, { pack, conversations: loadConversations(site), fixtures }), []);
    for (const evalCase of cases) assert.doesNotThrow(() => editFixtures(fixtures, evalCase.fixtures), evalCase.id);
  });
}

test('across all sites, every category has cases, and there are about fifty to start', () => {
  const cases = listSites().flatMap(loadCases);
  assert.deepEqual(CATEGORIES.filter((category) => !cases.some((evalCase) => evalCase.category === category)), []);
  assert.ok(cases.length >= 50, `${cases.length} cases`);
});

test('a case that names what does not exist is caught', async () => {
  const site = listSites().find(hasEvals)!;
  const { pack } = await loadSiteRuntime(site);
  const [first] = loadCases(site);
  const broken = {
    ...first!, id: 'Broken Case', after: { conversation: 'no-such-conversation', turns: 1 }, fixtures: [{ from: 'no-such-fixture', set: {} }],
    expect: { calls: [{ tool: 'no_such_tool' }], shows: [{ entity: 'no_such_entity' }], text: { matches: ['('] } },
  };
  const problems = checkCases([broken], { pack, conversations: [], fixtures: [] });
  for (const expected of ['lowercase words', 'no example conversation', 'no fixture', "isn't one of the site's tools", 'unknown entity', 'valid regular expression']) {
    assert.ok(problems.some((problem) => problem.includes(expected)), `expected a problem mentioning "${expected}": ${problems.join(' | ')}`);
  }
});
