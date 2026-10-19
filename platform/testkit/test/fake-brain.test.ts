// FakeBrain catches what it exists to catch: a result that differs from the conversation's, a missing or extra
// message, and a changed turn. Run on every site's first conversation, with one thing changed at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMessage } from '../../contract/generated/types.ts';
import { listSites } from '../../contract/src/site-pack.ts';
import { loadConversations } from '../src/conversations.ts';
import { FakeBrain, stableJson } from '../src/fake-brain.ts';

const conversations = listSites().flatMap((site) => loadConversations(site).slice(0, 1));

async function play(fakeBrain: FakeBrain, messages: ClientMessage[]): Promise<unknown[]> {
  const events: unknown[] = [];
  for (const message of messages) for await (const event of fakeBrain.brain(message)) events.push(event);
  return events;
}
const clientMessages = (conversation: (typeof conversations)[number]) => conversation.messages.filter((message): message is ClientMessage => message.type === 'turn' || message.type === 'results');

test('stableJson ignores key order but nothing else', () => {
  assert.equal(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), stableJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.notEqual(stableJson({ a: [1, 2] }), stableJson({ a: [2, 1] }));
  assert.notEqual(stableJson({ a: [] }), stableJson({}));
});

for (const conversation of conversations) {
  test(`${conversation.site}/${conversation.id}: the conversation's own messages replay with no differences, and events carry the client's trace ID`, async () => {
    const fakeBrain = new FakeBrain(conversation);
    const msgs = clientMessages(conversation).map((message) => ({ ...message, traceId: 'trace_from_client' }));
    const events = await play(fakeBrain, msgs);
    assert.deepEqual(fakeBrain.differences, []);
    assert.ok(fakeBrain.finished);
    assert.ok(events.length > 0 && events.every((event) => (event as { traceId: string }).traceId === 'trace_from_client'));
  });

  test(`${conversation.site}/${conversation.id}: a changed result, a changed turn and an unexpected message are each reported`, async () => {
    const msgs = structuredClone(clientMessages(conversation));
    const resultsMessage = msgs.find((message) => message.type === 'results');
    if (resultsMessage && resultsMessage.type === 'results' && resultsMessage.results[0]!.ok) (resultsMessage.results[0] as { output: Record<string, unknown> }).output.extra = 1;
    const turn = msgs[0]!;
    if (turn.type === 'turn') turn.message += ' please';
    const fakeBrain = new FakeBrain(conversation);
    await play(fakeBrain, [...msgs, msgs[0]!]);
    assert.ok(fakeBrain.differences.some((difference) => /turn message differs/.test(difference)), fakeBrain.differences.join('\n'));
    if (resultsMessage) assert.ok(fakeBrain.differences.some((difference) => /result call_\d+ differs/.test(difference)), fakeBrain.differences.join('\n'));
    assert.ok(fakeBrain.differences.some((difference) => /expects no turn message here/.test(difference)), fakeBrain.differences.join('\n'));
  });
}
