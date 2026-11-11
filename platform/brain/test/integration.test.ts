// Tests: the whole stack except the site and the model (L5, phase 5): the real core.js and the real brain together.
// How: every site's example conversations (sites/<id>/conversations/) are played from the user's side only. core.js
// gets the user's words and the page; everything else runs for real: Intake, the Brain link, the brain's loop and
// checks, Execute against FakeHost's fixtures, and Respond. FakeModel writes what the conversation's model wrote.
// It runs twice: with the brain in the same process, then over HTTP the way a page reaches it.
// Passes when: the traffic on the link, both ways, equals the saved conversation message for message; and, with session
// memory, after a 40-minute gap the brain reopens the conversation and an item shown before can be shown again, by
// its ID, with no new call to the site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { ClientMessage } from '../../contract/generated/types.ts';
import { listSites } from '../../contract/src/site-pack.ts';
import { webHost } from '../../core/hosts/web.ts';
import { runTurn, startSession } from '../../core/src/index.ts';
import { loadConversations, type Conversation } from '../../testkit/src/conversations.ts';
import { inProcess, type Send } from '../../testkit/src/fake-client.ts';
import { FakeModel, fakeModelFor, scriptFromConversation, type FakeStep } from '../../testkit/src/fake-model.ts';
import { FakeSurface } from '../../testkit/src/fake-surface.ts';
import { hasFixtures, loadFixtures } from '../../testkit/src/fixtures.ts';
import { compareWithConversation, LinkRecorder } from '../../testkit/src/link-recorder.ts';
import { loadSiteRuntime } from '../../testkit/src/site-runtime.ts';
import { testHost } from '../../testkit/src/test-host.ts';
import { Brain } from '../src/agent/brain.ts';
import type { BrainLogEntry } from '../src/agent/types.ts';
import { InMemoryMemoryStore } from '../src/memory/store.ts';
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
async function playConversation(id: string, conversation: Conversation, transport: Transport, memory?: { clock: { now: number }; store: InMemoryMemoryStore; extraSteps: FakeStep[]; log: BrainLogEntry[] }) {
  // 1. The brain's side.
  const now = Date.parse(conversation.now!);
  const model = memory ? new FakeModel([...scriptFromConversation(conversation), ...memory.extraSteps]) : fakeModelFor(conversation);
  const brain = memory
    ? new Brain({ site: await loadSite(id), model, now: () => memory.clock.now, memory: memory.store, log: (entry) => memory.log.push(entry) })
    : new Brain({ site: await loadSite(id), model, now: () => now });
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
      test(`${id}/${conversation.id} (${transport}): real core.js and the real brain produce the saved traffic exactly`, async () => {
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

/** The first item an answer showed in the conversation, by kind and ID: what the user might ask about after a gap. */
function firstShown(conversation: Conversation): { entity: string; id: string | number } | null {
  for (const message of conversation.messages) {
    if (message.type !== 'answer') continue;
    for (const presentation of message.present ?? []) {
      const args = presentation.args as { entity?: string; ids?: (string | number)[]; id?: string | number };
      const id = args.ids?.[0] ?? args.id;
      if (args.entity && id !== undefined) return { entity: args.entity, id };
    }
  }
  return null;
}

for (const id of listSites().filter(hasFixtures)) {
  const conversation = loadConversations(id).find((candidate) => firstShown(candidate) !== null);
  if (!conversation) continue;
  test(`${id}/${conversation.id}: after a 40-minute gap the brain reopens the conversation from memory; an item from before shows again with no new site call, unless its ID has expired`, async () => {
    const shown = firstShown(conversation)!;
    const clock = { now: Date.parse(conversation.now!) };
    // An ID that expires within the gap (a fare offer, say) must be refused as expired: the memory keeps each ID's expiry.
    const gapEnd = clock.now + 40 * 60_000;
    let expires = false;
    const log: BrainLogEntry[] = [];
    const store = new InMemoryMemoryStore({ site: id, keepHours: 24 });
    // The step after a refusal is decided once the memory shows whether the ID expires within the gap.
    const again: FakeStep[] = [
      { text: 'Here it is again.', calls: [{ name: 'present_detail', input: { entity: shown.entity, id: shown.id } }] },
      { text: 'That one has expired; I can search again.' },
    ];
    const played = await playConversation(id, conversation, 'in process', { clock, store, extraSteps: again, log });
    assert.ok(played.outcomes.every((outcome) => outcome.ok));
    const before = store.load(played.session.id, clock.now)!.knownIds.find((entry) => entry.kind === shown.entity && entry.id === shown.id)!;
    expires = before.expiresAt !== null && before.expiresAt <= gapEnd;
    const siteCallsBefore = played.harness.fake.calls.length;

    // Forty minutes later, on the same page, the user asks about what they saw. Both clocks move on.
    clock.now = gapEnd;
    played.harness.clock.advance(40 * 60_000);
    const outcome = await runTurn(played.session, 'show me that first one again', played.surface);
    assert.deepEqual(outcome, { ok: true }, JSON.stringify(log.slice(-6)));
    assert.ok(log.some((entry) => entry.kind === 'session_forgotten'), 'the brain forgot the idle session');
    assert.ok(log.some((entry) => entry.kind === 'session_restored'), 'and reopened it from memory');
    const last = played.surface.answers.at(-1)!;
    if (expires) {
      const refused = log.find((entry) => entry.kind === 'presentation_refused')?.detail as { reason: string }[] | undefined;
      assert.deepEqual(refused?.map((refusal) => refusal.reason), ['expired_id']);
      assert.equal(last.text, 'That one has expired; I can search again.');
    } else {
      assert.equal(played.model.remaining, 1, 'the step for an expired ID was not needed');
      assert.equal(last.text, 'Here it is again.');
      // The item's detail card; notices the site requires with it may follow.
      assert.deepEqual(last.components.filter((component) => component.type !== 'notice').map((component) => [component.type, component.type === 'detail' ? component.card.id : null]), [['detail', shown.id]]);
    }
    assert.equal(played.harness.fake.calls.length, siteCallsBefore, 'no new call to the site');
    assert.deepEqual(played.model.problems, []);

    // The memory kept every ID the conversation's tools returned, with the new turn after the others.
    const memory = store.load(played.session.id, clock.now)!;
    const known = new Set(memory.knownIds.map((entry) => `${entry.kind} ${String(entry.id)}`));
    assert.ok(known.has(`${shown.entity} ${String(shown.id)}`));
    assert.equal(memory.turns.length, conversation.messages.filter((message) => message.type === 'turn').length + 1);
  });
}
