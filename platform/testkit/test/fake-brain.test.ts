// FakeBrain catches what it exists to catch: a result that differs from the conversation's, a missing or extra
// message, and a changed turn. Run on every site's first conversation, with one thing changed at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMessage } from '../../contract/generated/types.ts';
import { listSites } from '../../contract/src/site-pack.ts';
import { loadConversations } from '../src/conversations.ts';
import { FakeBrain, stableJson } from '../src/fake-brain.ts';

const conversations = listSites().flatMap((s) => loadConversations(s).slice(0, 1));

async function play(brain: FakeBrain, messages: ClientMessage[]): Promise<unknown[]> {
  const events: unknown[] = [];
  for (const m of messages) for await (const e of brain.brain(m)) events.push(e);
  return events;
}
const clientMessages = (c: (typeof conversations)[number]) => c.messages.filter((m): m is ClientMessage => m.type === 'turn' || m.type === 'results');

test('stableJson ignores key order but nothing else', () => {
  assert.equal(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), stableJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.notEqual(stableJson({ a: [1, 2] }), stableJson({ a: [2, 1] }));
  assert.notEqual(stableJson({ a: [] }), stableJson({}));
});

for (const c of conversations) {
  test(`${c.site}/${c.id}: the conversation's own messages replay with no differences, and events carry the client's trace ID`, async () => {
    const brain = new FakeBrain(c);
    const msgs = clientMessages(c).map((m) => ({ ...m, traceId: 'trace_from_client' }));
    const events = await play(brain, msgs);
    assert.deepEqual(brain.differences, []);
    assert.ok(brain.finished);
    assert.ok(events.length > 0 && events.every((e) => (e as { traceId: string }).traceId === 'trace_from_client'));
  });

  test(`${c.site}/${c.id}: a changed result, a changed turn and an unexpected message are each reported`, async () => {
    const msgs = structuredClone(clientMessages(c));
    const results = msgs.find((m) => m.type === 'results');
    if (results && results.type === 'results' && results.results[0]!.ok) (results.results[0] as { output: Record<string, unknown> }).output.extra = 1;
    const turn = msgs[0]!;
    if (turn.type === 'turn') turn.message += ' please';
    const brain = new FakeBrain(c);
    await play(brain, [...msgs, msgs[0]!]);
    assert.ok(brain.differences.some((d) => /turn message differs/.test(d)), brain.differences.join('\n'));
    if (results) assert.ok(brain.differences.some((d) => /result call_\d+ differs/.test(d)), brain.differences.join('\n'));
    assert.ok(brain.differences.some((d) => /expects no turn message here/.test(d)), brain.differences.join('\n'));
  });
}
