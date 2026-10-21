// Tests: the UI fixtures are current, and together with the platform's hand-written states they cover every UI
// component and every surface event.
// How: each site's fixtures are rebuilt in memory from its conversations and references (build/ui-fixtures.ts) and
// compared with the saved files.
// Passes when: nothing differs (otherwise run `npm run ui-fixtures`), and no component type or event type is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { listSites } from '../../contract/src/site-pack.ts';
import { buildUiFixtures, fixtureFiles, loadUiFixtures, uiFixturesDir } from '../build/ui-fixtures.ts';
import { UI_STATES } from './ui-states.ts';

for (const site of listSites()) {
  test(`${site}: UI fixtures match what its conversations and references show today`, async () => {
    const expected = fixtureFiles(await buildUiFixtures(site));
    const saved = new Map(loadUiFixtures(site).map((fixture) => [`${fixture.id}.json`, readFileSync(path.join(uiFixturesDir(site), `${fixture.id}.json`), 'utf8')]));
    assert.deepEqual([...saved.keys()].sort(), [...expected.keys()].sort(), 'run npm run ui-fixtures');
    for (const [file, text] of expected) assert.equal(saved.get(file), text, `${site}/${file} is stale: run npm run ui-fixtures`);
  });
}

test('coverage: every UI component and surface event appears in some UI fixture or platform state', () => {
  const all = [...listSites().flatMap(loadUiFixtures), ...UI_STATES];
  const events = all.flatMap((fixture) => fixture.turns.flatMap((turn) => turn.events));
  const components = events.flatMap((event) => ('components' in event ? event.components : []));
  assert.deepEqual([...new Set(events.map((event) => event.type))].sort(), ['answer', 'early', 'error', 'progress']);
  assert.deepEqual([...new Set(components.map((component) => component.type))].sort(), ['comparison', 'detail', 'form', 'items', 'notice', 'options']);
  assert.deepEqual([...new Set(components.flatMap((component) => (component.type === 'items' ? [component.layout] : [])))].sort(), ['cards', 'carousel', 'list']);
  assert.ok(events.some((event) => event.type === 'answer' && event.budgetReached), 'an answer cut short by the call budget');
});
