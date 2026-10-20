// Tests: core.js's boundary checks (checkToolCall, checkPresentation, missingNotices), on real traffic: every saved
// call and card in every site's example conversations must be accepted.
// How: nothing runs. The test walks each conversation's messages in order and keeps the known IDs the way core.js
// would: the item on the page when a turn starts, then the IDs in each tool result. At every tool call and every
// card in an answer, it asks the checks "would you refuse this?", at the conversation's own clock.
// Passes when: every check returns null (no refusal) and no answer is missing a required notice. It fails when a
// check becomes too strict for real traffic, or when a saved conversation is wrong (an ID no result gave, a section
// that doesn't exist, a missing notice). The refusal side is tested in boundary-checks.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeErrors, loadContract } from '../../contract/src/load.ts';
import { loadConversations } from '../../testkit/src/conversations.ts';
import type { PageContext } from '../../contract/generated/types.ts';
import { checkPresentation, checkToolCall, effectivePolicy, IdSet, missingNotices, type CheckContext } from '../src/index.ts';

const contract = loadContract();

for (const [siteId, site] of Object.entries(contract.sites)) {
  const pack = site.pack;
  for (const conversation of loadConversations(siteId)) {
    test(`${siteId}/${conversation.id}: core.js's checks accept every saved tool call and card`, () => {
      assert.ok(conversation.now, 'the conversation gives its clock');
      const ids = new IdSet(pack.entities);
      const now = Date.parse(conversation.now!);
      const calls = new Map<string, string>();
      const validateInput = (tool: string, args: unknown) => {
        const validate = contract.siteValidator(siteId, pack.tools[tool]!.input);
        return validate(args) ? null : describeErrors(validate.errors);
      };
      let page: PageContext | undefined;
      let checked = 0;
      for (const message of conversation.messages) {
        if (message.type === 'turn') {
          page = message.pageContext;
          if (page.entity) ids.learn(page.entity.kind, page.entity.id, { now });
        } else if (message.type === 'tool_call') {
          const ctx: CheckContext = { pack, policy: effectivePolicy(pack).policy, ids, now, page, validateInput };
          assert.equal(checkToolCall(ctx, message.call.name, message.call.args), null, `${message.call.id} ${message.call.name}`);
          calls.set(message.call.id, message.call.name);
          checked++;
        } else if (message.type === 'results') {
          for (const result of message.results) if (result.ok) ids.learnFrom(result.output, pack.tools[calls.get(result.id)!]!.ids?.output, now);
        } else if (message.type === 'answer') {
          const ctx: CheckContext = { pack, policy: effectivePolicy(pack).policy, ids, now, page };
          for (const presentation of message.present ?? []) {
            assert.equal(checkPresentation(ctx, presentation), null, `${presentation.name} ${JSON.stringify(presentation.args).slice(0, 80)}`);
            checked++;
          }
          assert.deepEqual(missingNotices(pack, message.present ?? []), []);
        }
      }
      assert.ok(checked > 0);
    });
  }
}
