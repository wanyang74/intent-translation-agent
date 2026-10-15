// FakeBrain: plays the agentic brain's side of an example conversation, so core.js can be tested with no model.
// Each message core.js sends is compared with the conversation's own (session and trace IDs aside, since they're
// random); then the brain's events are streamed back as the conversation has them. Differences are kept, so a
// test can show exactly where core.js and the conversation part ways.
import type { ClientMessage, Message } from '../../contract/generated/types.ts';
import type { Conversation } from './conversations.ts';

/** JSON with object keys sorted, so two values compare equal whatever their key order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
    : v));
}

const isClient = (m: Message) => m.type === 'turn' || m.type === 'results';

export class FakeBrain {
  readonly received: ClientMessage[] = [];
  readonly differences: string[] = [];
  private conversation: Conversation;
  private cursor = 0;

  constructor(conversation: Conversation) {
    this.conversation = conversation;
  }

  /** Whether every message the conversation expects from the client has arrived. */
  get finished(): boolean {
    return !this.conversation.messages.slice(this.cursor).some(isClient);
  }

  /** The Host's brain function. */
  readonly brain = (message: ClientMessage): AsyncIterable<unknown> => this.stream(message);

  private compare(expected: Message, got: ClientMessage, where: string): void {
    if (expected.type !== got.type) {
      this.differences.push(`${where}: expected a ${expected.type} message, got ${got.type}`);
      return;
    }
    if (expected.type === 'turn' && got.type === 'turn') {
      for (const field of ['site', 'message', 'pageContext'] as const) {
        if (stableJson(expected[field]) !== stableJson(got[field])) this.differences.push(`${where}: turn ${field} differs: ${stableJson(got[field]).slice(0, 200)}`);
      }
    } else if (expected.type === 'results' && got.type === 'results') {
      const want = new Map(expected.results.map((r) => [r.id, r]));
      if (stableJson([...want.keys()].sort()) !== stableJson(got.results.map((r) => r.id).sort())) {
        this.differences.push(`${where}: results for [${got.results.map((r) => r.id)}], expected [${[...want.keys()]}]`);
      }
      for (const r of got.results) {
        const w = want.get(r.id);
        if (w && stableJson(w) !== stableJson(r)) {
          this.differences.push(`${where}: result ${r.id} differs.\n  expected ${stableJson(w).slice(0, 400)}\n  got      ${stableJson(r).slice(0, 400)}`);
        }
      }
    }
  }

  private async *stream(message: ClientMessage): AsyncGenerator<unknown> {
    this.received.push(message);
    const messages = this.conversation.messages;
    const expected = messages[this.cursor];
    const where = `${this.conversation.id} message ${this.cursor}`;
    if (!expected || !isClient(expected)) {
      this.differences.push(`${where}: the conversation expects no ${message.type} message here`);
      return;
    }
    this.compare(expected, message, where);
    this.cursor++;
    while (this.cursor < messages.length && !isClient(messages[this.cursor]!)) {
      const event = { ...messages[this.cursor]!, traceId: message.traceId };
      this.cursor++;
      yield event;
      await Promise.resolve();
    }
  }
}
