// L2 and L3: core.js plays the client's side of every site's example conversations, against FakeHost (the site) and
// FakeBrain (the brain's side of the same conversation). Every result core.js sends must equal the conversation's,
// it must call exactly the fixtures the conversation lists, and each answer must reach the surface filled in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSites } from '../../contract/src/site-pack.ts';
import { loadConversations } from '../../testkit/src/conversations.ts';
import { FakeBrain } from '../../testkit/src/fake-brain.ts';
import { FakeSurface } from '../../testkit/src/fake-surface.ts';
import { hasFixtures, loadFixtures } from '../../testkit/src/fixtures.ts';
import { loadSiteRuntime } from '../../testkit/src/site-runtime.ts';
import { testHost } from '../../testkit/src/test-host.ts';
import { runTurn, startSession } from '../src/index.ts';

for (const site of listSites().filter(hasFixtures)) {
  const rt = await loadSiteRuntime(site);
  const fixtures = loadFixtures(site);
  for (const c of loadConversations(site)) {
    test(`${site}/${c.id}: core.js replays the client's side exactly`, async () => {
      const brain = new FakeBrain(c);
      const { host, fake } = testHost({ site, fixtures, start: c.now!, pageData: c.pageData, brain: brain.brain });
      const { session, warnings } = await startSession({ pack: rt.pack, site: rt.code, validators: rt.validators, host });
      assert.deepEqual(warnings, []);
      const surface = new FakeSurface();
      const turns = c.messages.filter((m) => m.type === 'turn');
      for (const turn of turns) {
        session.setPage(turn.pageContext);
        const outcome = await runTurn(session, turn.message, surface);
        assert.deepEqual(outcome, { ok: true }, JSON.stringify(surface.errors));
      }
      assert.deepEqual(brain.differences, [], brain.differences.join('\n'));
      assert.ok(brain.finished, 'every client message the conversation expects was sent');
      assert.deepEqual(surface.errors, []);
      assert.equal(surface.answers.length, turns.length);
      const answers = c.messages.filter((m) => m.type === 'answer');
      surface.answers.forEach((a, i) => {
        assert.equal(a.text, answers[i]!.text);
        assert.equal(a.components.length, (answers[i]!.present ?? []).length, 'one component per presentation call; required notices were already there');
      });
      assert.deepEqual([...new Set(fake.calls.map((call) => call.fixtureId))].sort(), [...c.fixtures].sort(), 'calls exactly the fixtures the conversation lists');
    });
  }
}
