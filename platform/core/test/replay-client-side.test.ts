// Tests: core.js's side of every example conversation (L2 and L3). core.js is real; everything around it is played.
// How: FakeBrain plays the brain's side of the conversation, FakeHost answers the site's requests from the fixtures
// the conversation lists, and FakeSurface stands in for the screen.
// Passes when: every result core.js sends equals the conversation's, it calls exactly the listed fixtures, and each
// answer reaches the surface filled in. The brain's side is tested in platform/brain/test/replay-brain-side.test.ts.
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
  for (const conversation of loadConversations(site)) {
    test(`${site}/${conversation.id}: core.js sends the saved results, using exactly the listed fixtures`, async () => {
      const fakeBrain = new FakeBrain(conversation);
      const { host, fake } = testHost({ site, fixtures, start: conversation.now!, pageData: conversation.pageData, brain: fakeBrain.brain });
      const { session, warnings } = await startSession({ pack: rt.pack, site: rt.code, validators: rt.validators, host });
      assert.deepEqual(warnings, []);
      const surface = new FakeSurface();
      const turns = conversation.messages.filter((message) => message.type === 'turn');
      for (const turn of turns) {
        session.setPage(turn.pageContext);
        const outcome = await runTurn(session, turn.message, surface);
        assert.deepEqual(outcome, { ok: true }, JSON.stringify(surface.errors));
      }
      assert.deepEqual(fakeBrain.differences, [], fakeBrain.differences.join('\n'));
      assert.ok(fakeBrain.finished, 'every client message the conversation expects was sent');
      assert.deepEqual(surface.errors, []);
      assert.equal(surface.answers.length, turns.length);
      const answers = conversation.messages.filter((message) => message.type === 'answer');
      surface.answers.forEach((answer, i) => {
        assert.equal(answer.text, answers[i]!.text);
        assert.equal(answer.components.length, (answers[i]!.present ?? []).length, 'one component per presentation call; required notices were already there');
      });
      assert.deepEqual([...new Set(fake.calls.map((call) => call.fixtureId))].sort(), [...conversation.fixtures].sort(), 'calls exactly the fixtures the conversation lists');
    });
  }
}
