// Tests: LinkRecorder and compareWithConversation (testkit/src/link-recorder.ts), which the integration test uses to
// compare live link traffic with a saved conversation.
// How: records a short exchange, then compares any site's first example conversation with itself and with changed
// copies.
// Passes when: both directions are kept in order, only the IDs each end makes up (session and trace) are ignored,
// and any other change is reported as a difference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMessage } from '../../contract/generated/types.ts';
import { listSites } from '../../contract/src/site-pack.ts';
import { loadConversations } from '../src/conversations.ts';
import { compareWithConversation, LinkRecorder } from '../src/link-recorder.ts';

// Any site's first example conversation will do.
const conversation = listSites().flatMap(loadConversations)[0]!;

test('recording: keeps what the client sent, then what the brain streamed back, in order', async () => {
  const recorder = new LinkRecorder(async function* (message: ClientMessage) {
    yield { type: 'progress', traceId: message.traceId, text: 'one' };
    yield { type: 'progress', traceId: message.traceId, text: 'two' };
  });
  const turn = conversation.messages[0] as ClientMessage;
  const seen: unknown[] = [];
  for await (const event of recorder.send(turn)) seen.push(event);
  assert.equal(seen.length, 2);
  assert.deepEqual(recorder.traffic.map((message) => (message as { type: string }).type), ['turn', 'progress', 'progress']);
});

test('comparison: a conversation matches itself, whatever session and trace IDs each end used', () => {
  const renamed = conversation.messages.map((message) => ({ ...message, ...('sessionId' in message ? { sessionId: 'sess_other' } : {}), traceId: 'trace_other' }));
  assert.deepEqual(compareWithConversation(renamed, conversation), []);
});

test('comparison: any other change is a difference: a changed argument, a missing message, an extra one', () => {
  const messages = structuredClone(conversation.messages) as unknown as Record<string, any>[];
  const callAt = messages.findIndex((message) => message.type === 'tool_call');
  messages[callAt]!.call.args = { ...messages[callAt]!.call.args, extra: true };
  assert.equal(compareWithConversation(messages, conversation).length, 1);
  assert.equal(compareWithConversation(conversation.messages.slice(0, -1), conversation).length, 1);
  assert.equal(compareWithConversation([...conversation.messages, { type: 'progress', traceId: 'x', text: 'more' }], conversation).length, 1);
});
