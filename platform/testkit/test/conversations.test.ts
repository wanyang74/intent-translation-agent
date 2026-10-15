// Every site's example conversations are well formed against the platform protocol and the site pack, and the
// checker catches the mistakes it exists for: tools the site doesn't have, invented IDs, missing notices,
// presentation tools called as tools, and results that don't line up with what was awaited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContract } from '../../contract/src/load.ts';
import { type Conversation, checkConversation, loadConversations } from '../src/conversations.ts';

const contract = loadContract();
const all = Object.keys(contract.sites).flatMap((site) => loadConversations(site));

test('at least two sites have example conversations', () => {
  assert.ok(new Set(all.map((c) => c.site)).size >= 2, `sites with conversations: ${[...new Set(all.map((c) => c.site))].join(', ')}`);
});

for (const c of all) {
  test(`${c.site}/${c.id}: well formed against the protocol and the site pack`, () => {
    assert.deepEqual(checkConversation(contract, c), []);
  });

  // Each mutation breaks one rule; the checker must report it.
  const mutate = (change: (c: Conversation) => boolean | void) => {
    const copy = structuredClone(c);
    return change(copy) === false ? null : checkConversation(contract, copy);
  };
  const messages = (c: Conversation) => c.messages as any[];
  const firstPresent = (c: Conversation) => messages(c).flatMap((m) => (m.type === 'answer' ? m.present ?? [] : []))
    .find((p: any) => p.name === 'present_items' || p.name === 'present_options' || p.name === 'present_detail');

  test(`${c.site}/${c.id}: the checker reports a tool the site doesn't have`, () => {
    const problems = mutate((x) => { messages(x).find((m) => m.type === 'tool_call').call.name = 'place_order'; });
    assert.ok(problems?.some((p) => /place_order isn't a .* tool/.test(p)), String(problems));
  });

  test(`${c.site}/${c.id}: the checker reports an ID no result gave`, () => {
    const problems = mutate((x) => {
      const p = firstPresent(x);
      if (!p) return false;
      const ids: unknown[] = p.name === 'present_detail' ? [p.args.id] : p.args.ids;
      const invented = typeof ids[0] === 'number' ? 999999999 : `${String(ids[0]).slice(0, -1)}${String(ids[0]).endsWith('Z') ? 'Y' : 'Z'}`;
      if (p.name === 'present_detail') p.args.id = invented; else p.args.ids[0] = invented;
    });
    if (problems) assert.ok(problems.some((p) => /no earlier tool result or page context gave|isn't a valid/.test(p)), String(problems));
  });

  test(`${c.site}/${c.id}: the checker reports a missing notice`, () => {
    const problems = mutate((x) => {
      const answer = messages(x).find((m) => m.type === 'answer' && m.present?.some((p: any) => p.name === 'present_notice'));
      if (!answer) return false;
      answer.present = answer.present.filter((p: any) => p.name !== 'present_notice');
    });
    if (problems) assert.ok(problems.some((p) => /without the .* notice/.test(p)), String(problems));
  });

  test(`${c.site}/${c.id}: the checker reports a presentation tool called as a tool`, () => {
    const problems = mutate((x) => { messages(x).find((m) => m.type === 'tool_call').call.name = 'present_items'; });
    assert.ok(problems?.some((p) => /presentation tool; it belongs in an answer/.test(p)), String(problems));
  });

  test(`${c.site}/${c.id}: the checker reports results that don't match what was awaited`, () => {
    const problems = mutate((x) => { messages(x).find((m) => m.type === 'results').results[0].id = 'call_never'; });
    assert.ok(problems?.some((p) => /but the server awaited/.test(p)), String(problems));
  });

  test(`${c.site}/${c.id}: the checker reports an answer before the results arrive`, () => {
    const problems = mutate((x) => {
      const i = messages(x).findLastIndex((m) => m.type === 'results');
      const [results] = messages(x).splice(i, 1);
      messages(x).push(results);
    });
    assert.ok(problems?.some((p) => /pending|comes after the turn was answered/.test(p)), String(problems));
  });
}
