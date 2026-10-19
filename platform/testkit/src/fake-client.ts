// FakeClient: stands in for core.js, seen from the brain. It sends a turn, starts each tool call the moment it
// arrives, answers it from a script (results, errors, delays), sends the awaited results back, and keeps every event.
// Every event is checked against the protocol. replayConversation plays an example conversation's client messages
// exactly and compares what the brain streams back with the conversation's own events.
import type {
  AnswerEvent, ClientMessage, ErrorEvent, PageContext, ServerEvent, ToolCall, ToolError, ToolResult,
} from '../../contract/generated/types.ts';
import type { Conversation } from './conversations.ts';
import { stableJson } from './fake-brain.ts';

/** Sends one message to the brain and yields the events it streams back. */
export type Send = (message: ClientMessage) => AsyncIterable<unknown>;

/** A brain in the same process, called the way the HTTP server calls it. A refusal (400, 409) throws. */
export function inProcess(brain: { accept(message: unknown): { ok: true; events: AsyncIterable<unknown> } | { ok: false; status: number; error: string } }): Send {
  return (message) => {
    const accepted = brain.accept(message);
    if (!accepted.ok) throw new Error(`refused with ${accepted.status}: ${accepted.error}`);
    return accepted.events;
  };
}

export type ResultBody = { ok: true; output: Record<string, unknown> } | { ok: false; error: ToolError };

/** How a call is answered. DROP means the client never sends results, as when it goes away. */
export type ResultFor = (call: ToolCall) => ResultBody | typeof DROP | Promise<ResultBody | typeof DROP>;
export const DROP = Symbol('drop');

export interface TurnRecord {
  traceId: string;
  events: ServerEvent[];
  answer: AnswerEvent | null;
  error: ErrorEvent | null;
  /** Calls in the order they arrived. */
  calls: ToolCall[];
  /** What the brain did wrong, from the client's side: protocol breaks, waits for calls never sent. */
  problems: string[];
}

export interface FakeClientOptions {
  site: string;
  sessionId?: string;
  /** messages.json's validator; every event must pass it. */
  validate: (event: unknown) => boolean;
  results?: ResultFor;
  /** Changes the results before they're sent, to test what the brain accepts. */
  tamper?: (results: ToolResult[]) => ToolResult[];
}

const MAX_ROUNDS = 30;

export class FakeClient {
  readonly sessionId: string;
  readonly sent: ClientMessage[] = [];
  private send: Send;
  private options: FakeClientOptions;
  private turns = 0;
  /** The trace of the turn in progress, for amend. */
  current: string | undefined;

  constructor(send: Send, options: FakeClientOptions) {
    this.send = send;
    this.options = options;
    this.sessionId = options.sessionId ?? `sess_fake_${Math.random().toString(36).slice(2, 10)}`;
  }

  /** Sends a message to the turn in progress, as a user typing while the agent works; returns the brain's reply. */
  async amend(message: string): Promise<unknown[]> {
    const amendMessage: ClientMessage = { type: 'amend', sessionId: this.sessionId, traceId: this.current ?? 'trace_none_yet', message };
    this.sent.push(amendMessage);
    const events: unknown[] = [];
    for await (const event of this.send(amendMessage)) events.push(event);
    return events;
  }

  async turn(message: string, page: PageContext, results: ResultFor | undefined = this.options.results): Promise<TurnRecord> {
    const traceId = `trace_${this.sessionId}_${++this.turns}`;
    this.current = traceId;
    const record: TurnRecord = { traceId, events: [], answer: null, error: null, calls: [], problems: [] };
    let outgoing: ClientMessage = { type: 'turn', site: this.options.site, sessionId: this.sessionId, traceId, message, pageContext: page };
    const running = new Map<string, Promise<ResultBody | typeof DROP>>();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      this.sent.push(outgoing);
      let awaited: string[] | null = null;
      for await (const raw of this.send(outgoing)) {
        if (!this.options.validate(raw)) record.problems.push(`breaks the protocol: ${JSON.stringify(raw).slice(0, 200)}`);
        const ev = raw as ServerEvent;
        record.events.push(ev);
        if (ev.traceId !== traceId) record.problems.push(`event for trace ${ev.traceId}`);
        if (ev.type === 'tool_call') {
          if (running.has(ev.call.id)) record.problems.push(`call ${ev.call.id} arrived twice`);
          record.calls.push(ev.call);
          const answer = results ?? (() => ({ ok: true as const, output: {} }));
          running.set(ev.call.id, Promise.resolve().then(() => answer(ev.call)));
        } else if (ev.type === 'await_results') {
          awaited = ev.callIds;
        } else if (ev.type === 'answer') {
          record.answer = ev;
        } else if (ev.type === 'error') {
          record.error = ev;
        }
      }
      if (record.answer || record.error) return record;
      if (!awaited) {
        record.problems.push('the stream ended with no answer, error or wait');
        return record;
      }
      const missing = awaited.filter((id) => !running.has(id));
      if (missing.length) {
        record.problems.push(`awaits calls never sent: ${missing.join(', ')}`);
        return record;
      }
      const bodies = await Promise.all(awaited.map((id) => running.get(id)!));
      if (bodies.includes(DROP)) return record;
      let sent = awaited.map((id, i) => ({ id, ...(bodies[i] as ResultBody) }) as ToolResult);
      if (this.options.tamper) sent = this.options.tamper(sent);
      for (const id of awaited) running.delete(id);
      outgoing = { type: 'results', sessionId: this.sessionId, traceId, results: sent as [ToolResult, ...ToolResult[]] };
    }
    record.problems.push('too many round trips');
    return record;
  }
}

/**
 * Plays an example conversation from the client's side, message by message, as the conversation has them (same
 * session, traces and results), and compares the brain's events with the conversation's.
 */
export async function replayConversation(send: Send, conversation: Conversation): Promise<{ differences: string[]; events: unknown[] }> {
  const differences: string[] = [];
  const events: unknown[] = [];
  const messages = conversation.messages;
  for (let i = 0; i < messages.length;) {
    const message = messages[i]!;
    if (message.type !== 'turn' && message.type !== 'results') {
      differences.push(`${conversation.id} message ${i}: a ${message.type} event with no client message before it`);
      i++;
      continue;
    }
    const expected: unknown[] = [];
    let j = i + 1;
    for (; j < messages.length && messages[j]!.type !== 'turn' && messages[j]!.type !== 'results'; j++) expected.push(messages[j]);
    const got: unknown[] = [];
    for await (const ev of send(message)) got.push(ev);
    events.push(...got);
    for (let offset = 0; offset < Math.max(expected.length, got.length); offset++) {
      const want = expected[offset] === undefined ? 'nothing' : stableJson(expected[offset]);
      const have = got[offset] === undefined ? 'nothing' : stableJson(got[offset]);
      if (want !== have) differences.push(`${conversation.id} message ${i + 1 + offset}:\n  expected ${want.slice(0, 500)}\n  got      ${have.slice(0, 500)}`);
    }
    i = j;
  }
  return { differences, events };
}
