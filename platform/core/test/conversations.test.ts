// core.js's checks accept every site's example conversations: each tool call and each presentation call, with the
// IDs learned from the page context and from earlier tool results, at the conversation's own clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeErrors, loadContract } from '../../contract/src/load.ts';
import { loadConversations } from '../../testkit/src/conversations.ts';
import type { PageContext } from '../../contract/generated/types.ts';
import { checkPresentation, checkToolCall, effectivePolicy, IdSet, missingNotices, type CheckContext } from '../src/index.ts';

const contract = loadContract();

for (const [siteId, site] of Object.entries(contract.sites)) {
  const pack = site.pack;
  for (const c of loadConversations(siteId)) {
    test(`${siteId}/${c.id}: every call passes core.js's checks`, () => {
      assert.ok(c.now, 'the conversation gives its clock');
      const ids = new IdSet(pack.entities);
      const now = Date.parse(c.now!);
      const calls = new Map<string, string>();
      const validateInput = (tool: string, args: unknown) => {
        const v = contract.siteValidator(siteId, pack.tools[tool]!.input);
        return v(args) ? null : describeErrors(v.errors);
      };
      let page: PageContext | undefined;
      let checked = 0;
      for (const m of c.messages) {
        if (m.type === 'turn') {
          page = m.pageContext;
          if (page.entity) ids.learn(page.entity.kind, page.entity.id, { now });
        } else if (m.type === 'tool_call') {
          const ctx: CheckContext = { pack, policy: effectivePolicy(pack).policy, ids, now, page, validateInput };
          assert.equal(checkToolCall(ctx, m.call.name, m.call.args), null, `${m.call.id} ${m.call.name}`);
          calls.set(m.call.id, m.call.name);
          checked++;
        } else if (m.type === 'results') {
          for (const r of m.results) if (r.ok) ids.learnFrom(r.output, pack.tools[calls.get(r.id)!]!.ids?.output, now);
        } else if (m.type === 'answer') {
          const ctx: CheckContext = { pack, policy: effectivePolicy(pack).policy, ids, now, page };
          for (const p of m.present ?? []) {
            assert.equal(checkPresentation(ctx, p), null, `${p.name} ${JSON.stringify(p.args).slice(0, 80)}`);
            checked++;
          }
          assert.deepEqual(missingNotices(pack, m.present ?? []), []);
        }
      }
      assert.ok(checked > 0);
    });
  }
}
