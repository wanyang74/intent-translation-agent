// LinkRecorder: sits on the link between core.js and the brain and keeps every protocol message that crosses it, both
// ways, in the order they crossed. It wraps the Host's brain function, so either end can be real or fake and the link
// can be in process or HTTP. compareWithConversation checks the recorded traffic against an example conversation:
// the same messages in the same order, with session and trace IDs left out, since each side makes its own.
import type { ClientMessage, Message } from '../../contract/generated/types.ts';
import type { Conversation } from './conversations.ts';
import { stableJson } from './fake-brain.ts';
import type { Send } from './fake-client.ts';

export class LinkRecorder {
  /** Every message on the link: what the client sent, then the events the brain streamed back for it. */
  readonly traffic: unknown[] = [];
  private readonly inner: Send;

  constructor(inner: Send) {
    this.inner = inner;
  }

  /** The Host's brain function, recording as it goes. */
  readonly send = (message: ClientMessage): AsyncIterable<unknown> => this.relay(message);

  private async *relay(message: ClientMessage): AsyncGenerator<unknown> {
    this.traffic.push(message);
    for await (const event of this.inner(message)) {
      this.traffic.push(event);
      yield event;
    }
  }
}

/** A message without the IDs each end makes up for itself: the session ID and the trace ID. */
function withoutRunIds(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;
  const { sessionId: _sessionId, traceId: _traceId, ...rest } = message as Record<string, unknown>;
  return rest;
}

/**
 * Differences between recorded traffic and an example conversation, message by message; none when they match.
 * Each message is compared whole (keys sorted), apart from its session and trace IDs.
 */
export function compareWithConversation(traffic: readonly unknown[], conversation: Conversation): string[] {
  const expected: readonly Message[] = conversation.messages;
  const differences: string[] = [];
  for (let i = 0; i < Math.max(expected.length, traffic.length); i++) {
    const want = i < expected.length ? stableJson(withoutRunIds(expected[i])) : 'nothing';
    const have = i < traffic.length ? stableJson(withoutRunIds(traffic[i])) : 'nothing';
    if (want !== have) differences.push(`${conversation.id} message ${i}:\n  expected ${want.slice(0, 500)}\n  got      ${have.slice(0, 500)}`);
  }
  return differences;
}
