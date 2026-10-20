// L5, phase 5: the real core.js and the real brain together, with FakeHost as the site and FakeModel as the model.
// Every site's example conversations are played from the user's side only: core.js gets the user's words and the
// page, and everything else happens for real (Intake, Brain link, the brain's loop and checks, Execute against the
// fixtures, Respond). The traffic on the link, both ways, must equal the saved conversation message for message,
// first with the brain in the same process, then over HTTP the way a page reaches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { ClientMessage } from '../../contract/generated/types.ts';
import { listSites } from '../../contract/src/site-pack.ts';
import { webHost } from '../../core/hosts/web.ts';
import { runTurn, startSession } from '../../core/src/index.ts';
import { loadConversations, type Conversation } from '../../testkit/src/conversations.ts';
import { inProcess, type Send } from '../../testkit/src/fake-client.ts';
import { fakeModelFor } from '../../testkit/src/fake-model.ts';
import { FakeSurface } from '../../testkit/src/fake-surface.ts';
import { hasFixtures, loadFixtures } from '../../testkit/src/fixtures.ts';
import { compareWithConversation, LinkRecorder } from '../../testkit/src/link-recorder.ts';
import { loadSiteRuntime } from '../../testkit/src/site-runtime.ts';
import { testHost } from '../../testkit/src/test-host.ts';
import { Brain } from '../src/agent/brain.ts';
import { loadSite } from '../src/prompt/site.ts';
import { createBrainServer } from '../src/server/server.ts';
import { historyProblems } from './example-brain.ts';

type Transport = 'in process' | 'HTTP';

/** The brain behind the link: called directly, or through its HTTP server and core.js's web host. */
async function connect(brain: Brain, transport: Transport): Promise<{ send: Send; close: () => Promise<void> }> {
  if (transport === 'in process') return { send: inProcess(brain), close: async () => {} };
  const server = createBrainServer({ brain, allowedOrigins: [] });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const brainUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = webHost({ brainUrl }).brain! as (message: ClientMessage) => AsyncIterable<unknown>;
  return { send, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * Plays a conversation's user turns through the whole stack:
 *   1. The brain with a FakeModel that writes what the conversation's model wrote.
 *   2. The link between them, recorded, in process or over HTTP.
 *   3. core.js on a test host: FakeHost for the site, the conversation's clock and page data.
 *   4. Each user turn on its page, through runTurn, to a FakeSurface.
 */
async function playConversation(id: string, conversation: Conversation, transport: Transport) {
  // 1. The brain's side.
  const now = Date.parse(conversation.now!);
  const model = fakeModelFor(conversation);
  const brain = new Brain({ site: await loadSite(id), model, now: () => now });
  // 2. The link.
  const link = await connect(brain, transport);
  const recorder = new LinkRecorder(link.send);
  // 3. core.js's side.
  const runtime = await loadSiteRuntime(id);
  const harness = testHost({ site: id, fixtures: loadFixtures(id), start: now, pageData: conversation.pageData, brain: recorder.send });
  const { session, warnings } = await startSession({ pack: runtime.pack, site: runtime.code, validators: runtime.validators, host: harness.host });
  // 4. The user's turns.
  const surface = new FakeSurface();
  const outcomes = [];
  try {
    for (const message of conversation.messages) {
      if (message.type !== 'turn') continue;
      session.setPage(message.pageContext);
      outcomes.push(await runTurn(session, message.message, surface));
    }
  } finally {
    await link.close();
  }
  return { brain, model, recorder, harness, session, surface, outcomes, warnings };
}

for (const id of listSites().filter(hasFixtures)) {
  for (const conversation of loadConversations(id)) {
    for (const transport of ['in process', 'HTTP'] as const) {
      test(`${id}/${conversation.id}: real core.js and the real brain replay the conversation exactly (${transport})`, async () => {
        const played = await playConversation(id, conversation, transport);
        assert.deepEqual(played.warnings, []);
        assert.ok(played.outcomes.every((outcome) => outcome.ok), JSON.stringify(played.outcomes));

        // The link carried exactly the conversation, and the model's side was used up with no broken request.
        const differences = compareWithConversation(played.recorder.traffic, conversation);
        assert.deepEqual(differences, [], differences.join('\n'));
        assert.equal(played.model.remaining, 0, 'every model step was used');
        assert.deepEqual(played.model.problems, []);
        assert.deepEqual(historyProblems(played.brain.historyOf(played.session.id)!), []);

        // The user saw each answer, filled in from the fixtures, and nothing went wrong on the way.
        const answers = conversation.messages.filter((message) => message.type === 'answer');
        assert.deepEqual(played.surface.errors, []);
        assert.deepEqual(played.surface.answers.map((answer) => answer.text), answers.map((answer) => answer.text));
        played.surface.answers.forEach((answer, i) => {
          assert.equal(answer.components.length, (answers[i]!.present ?? []).length, `answer ${i}: one component per presentation call`);
        });
        assert.deepEqual([...new Set(played.harness.fake.calls.map((call) => call.fixtureId))].sort(), [...conversation.fixtures].sort(), 'calls exactly the fixtures the conversation lists');
      });
    }
  }
}
