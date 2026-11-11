// Tests: every site's eval cases (sites/<id>/evals/*.json), loaded the way the eval runner loads them.
// How: resolves each case's references against its site pack, conversations and fixtures, and applies its fixture
// edits.
// Passes when: every case refers only to what exists, its fixture edits apply, every category has cases, and a case
// that names something missing is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSites } from '../../contract/src/site-pack.ts';
import { loadConversations } from '../../testkit/src/conversations.ts';
import { loadFixtures } from '../../testkit/src/fixtures.ts';
import { loadSiteRuntime } from '../../testkit/src/site-runtime.ts';
import { CATEGORIES, checkCases, editFixtures, hasEvals, loadCases } from '../src/cases.ts';

test('coverage: every site pack brings eval cases', () => {
  assert.deepEqual(listSites().filter((site) => !hasEvals(site)), []);
});

for (const site of listSites().filter(hasEvals)) {
  test(`${site}: references: every case names only what exists, and its fixture edits apply`, async () => {
    const cases = loadCases(site);
    const fixtures = loadFixtures(site);
    const { pack } = await loadSiteRuntime(site);
    assert.deepEqual(checkCases(cases, { pack, conversations: loadConversations(site), fixtures }), []);
    for (const evalCase of cases) assert.doesNotThrow(() => editFixtures(fixtures, evalCase.fixtures), evalCase.id);
  });
}

test('coverage: across all sites, every category has cases, about fifty to start', () => {
  const cases = listSites().flatMap(loadCases);
  assert.deepEqual(CATEGORIES.filter((category) => !cases.some((evalCase) => evalCase.category === category)), []);
  assert.ok(cases.length >= 50, `${cases.length} cases`);
});

test('loader: a case that names something that does not exist is caught', async () => {
  const site = listSites().find(hasEvals)!;
  const { pack } = await loadSiteRuntime(site);
  const [first] = loadCases(site);
  const broken = {
    ...first!, id: 'Broken Case', after: { conversation: 'no-such-conversation', turns: 1, idleMinutes: 0 }, fixtures: [{ from: 'no-such-fixture', set: {} }],
    expect: { calls: [{ tool: 'no_such_tool' }], shows: [{ entity: 'no_such_entity' }], text: { matches: ['('] } },
  };
  const problems = checkCases([broken], { pack, conversations: [], fixtures: [] });
  for (const expected of ['lowercase words', 'no example conversation', 'idleMinutes', 'no fixture', "isn't one of the site's tools", 'unknown entity', 'valid regular expression']) {
    assert.ok(problems.some((problem) => problem.includes(expected)), `expected a problem mentioning "${expected}": ${problems.join(' | ')}`);
  }
});
