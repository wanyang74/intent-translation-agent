// L2 for the brain's end of the link: every site's example conversations, replayed from the client's side exactly as
// they're saved (same session, traces and results), with a FakeModel playing the model's side of the same
// conversation. The brain must stream back exactly the conversation's events: the same calls under the same call
// IDs, the same progress lines, waits and answers. Every request must start with the site's prompt prefix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSites } from '../../contract/src/site-pack.ts';
import { loadConversations } from '../../testkit/src/conversations.ts';
import { replayConversation } from '../../testkit/src/fake-client.ts';
import { fakeModelFor } from '../../testkit/src/fake-model.ts';
import { Brain } from '../src/agent/brain.ts';
import { loadSite } from '../src/prompt/site.ts';
import { historyProblems, inProcess } from './example-brain.ts';

for (const id of listSites()) {
  const bundle = await loadSite(id);
  for (const conversation of loadConversations(id)) {
    test(`${id}/${conversation.id}: the brain streams back exactly the conversation's events`, async () => {
      const model = fakeModelFor(conversation);
      const brain = new Brain({ site: bundle, model, now: () => Date.parse(conversation.now!) });
      const { differences } = await replayConversation(inProcess(brain), conversation);
      assert.deepEqual(differences, []);
      assert.equal(model.remaining, 0, 'every model step was used');
      const promptPrefix = brain.promptPrefix;
      for (const request of model.requests) {
        assert.equal(request.system, promptPrefix.system);
        assert.equal(request.tools, promptPrefix.tools);
      }
      const sessionId = (conversation.messages[0] as { sessionId: string }).sessionId;
      assert.deepEqual(historyProblems(brain.historyOf(sessionId)!), []);
    });
  }
}
