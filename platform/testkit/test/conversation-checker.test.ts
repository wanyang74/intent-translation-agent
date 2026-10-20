// Tests: the conversation checker (testkit/src/conversations.ts), which says whether a saved example conversation is
// well formed.
// How: runs the checker on every site's conversations as saved, then on copies with one mistake planted at a time.
// Passes when: every saved conversation is well formed against the protocol and the site pack, and each planted
// mistake is reported: a tool the site doesn't have, an invented ID, a missing notice, a presentation tool called as a
// tool, results that don't match what was awaited, and an answer before the results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContract } from '../../contract/src/load.ts';
import { type Conversation, checkConversation, loadConversations } from '../src/conversations.ts';

const contract = loadContract();
const all = Object.keys(contract.sites).flatMap((site) => loadConversations(site));

test('coverage: at least two sites have example conversations', () => {
  assert.ok(new Set(all.map((conversation) => conversation.site)).size >= 2, `sites with conversations: ${[...new Set(all.map((conversation) => conversation.site))].join(', ')}`);
});

for (const conversation of all) {
  test(`${conversation.site}/${conversation.id}: as saved: well formed against the protocol and the site pack`, () => {
    assert.deepEqual(checkConversation(contract, conversation), []);
  });

  // Each mutation breaks one rule; the checker must report it.
  const mutate = (change: (example: Conversation) => boolean | void) => {
    const copy = structuredClone(conversation);
    return change(copy) === false ? null : checkConversation(contract, copy);
  };
  const messages = (copy: Conversation) => copy.messages as any[];
  const firstPresent = (copy: Conversation) => messages(copy).flatMap((message) => (message.type === 'answer' ? message.present ?? [] : []))
    .find((presentation: any) => presentation.name === 'present_items' || presentation.name === 'present_options' || presentation.name === 'present_detail');

  test(`${conversation.site}/${conversation.id}: planted mistake: a tool the site doesn't have`, () => {
    const problems = mutate((copy) => { messages(copy).find((message) => message.type === 'tool_call').call.name = 'place_order'; });
    assert.ok(problems?.some((problem) => /place_order isn't a .* tool/.test(problem)), String(problems));
  });

  test(`${conversation.site}/${conversation.id}: planted mistake: an ID no result gave`, () => {
    const problems = mutate((copy) => {
      const presentation = firstPresent(copy);
      if (!presentation) return false;
      const ids: unknown[] = presentation.name === 'present_detail' ? [presentation.args.id] : presentation.args.ids;
      const invented = typeof ids[0] === 'number' ? 999999999 : `${String(ids[0]).slice(0, -1)}${String(ids[0]).endsWith('Z') ? 'Y' : 'Z'}`;
      if (presentation.name === 'present_detail') presentation.args.id = invented; else presentation.args.ids[0] = invented;
    });
    if (problems) assert.ok(problems.some((problem) => /no earlier tool result or page context gave|isn't a valid/.test(problem)), String(problems));
  });

  test(`${conversation.site}/${conversation.id}: planted mistake: a missing notice`, () => {
    const problems = mutate((copy) => {
      const answer = messages(copy).find((message) => message.type === 'answer' && message.present?.some((presentation: any) => presentation.name === 'present_notice'));
      if (!answer) return false;
      answer.present = answer.present.filter((presentation: any) => presentation.name !== 'present_notice');
    });
    if (problems) assert.ok(problems.some((problem) => /without the .* notice/.test(problem)), String(problems));
  });

  test(`${conversation.site}/${conversation.id}: planted mistake: a presentation tool called as a tool`, () => {
    const problems = mutate((copy) => { messages(copy).find((message) => message.type === 'tool_call').call.name = 'present_items'; });
    assert.ok(problems?.some((problem) => /presentation tool; it belongs in an answer/.test(problem)), String(problems));
  });

  test(`${conversation.site}/${conversation.id}: planted mistake: results that don't match what was awaited`, () => {
    const problems = mutate((copy) => { messages(copy).find((message) => message.type === 'results').results[0].id = 'call_never'; });
    assert.ok(problems?.some((problem) => /but the server awaited/.test(problem)), String(problems));
  });

  test(`${conversation.site}/${conversation.id}: planted mistake: an answer before the results arrive`, () => {
    const problems = mutate((copy) => {
      const i = messages(copy).findLastIndex((message) => message.type === 'results');
      const [results] = messages(copy).splice(i, 1);
      messages(copy).push(results);
    });
    assert.ok(problems?.some((problem) => /pending|comes after the turn was answered/.test(problem)), String(problems));
  });
}
