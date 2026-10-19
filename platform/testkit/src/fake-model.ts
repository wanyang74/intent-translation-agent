// FakeModel: stands in for the LLM, so the brain's loop and checks are tested without randomness or cost. Each model
// call plays the next scripted step: text, tool calls (deliberately bad ones too: made-up tools, wrong arguments,
// unknown IDs), a failure, a hang, or a pause at a chosen point. It keeps every request, so tests can check exactly
// what the brain sent, and like a real model API it refuses a request whose history is broken. fakeModelFor builds
// one from an example conversation.
import type { ChatMessage, FinishReason, ModelAdapter, ModelEvent, ModelRequest, Usage } from '../../brain/src/model/model.ts';
import type { Conversation } from './conversations.ts';

export interface FakeCall {
  name: string;
  input: unknown;
  /** The model's own call ID; one is made up if not given. */
  id?: string;
}

export interface FakeStep {
  text?: string;
  calls?: FakeCall[];
  /** Waits before the call at this index is emitted: lets a test see what happened to the calls before it. */
  beforeCall?: (index: number) => Promise<void> | void;
  /** Waits before the step finishes, after its text and calls. */
  beforeFinish?: () => Promise<void> | void;
  /** Throws this error after the text and calls, as a failed API call would. */
  fail?: string;
  /** Never finishes. With 'abortable' it ends when the request is aborted; with 'deaf' it ignores the abort too. */
  hang?: 'abortable' | 'deaf';
  finish?: FinishReason;
  usage?: Partial<Usage>;
}

/** A step, or a function of the request that makes one (to answer with IDs the brain just sent, for example). */
export type FakeScript = FakeStep | ((request: ModelRequest, index: number) => FakeStep);

const USAGE: Usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * What a model API would refuse in a history: it must start with the user; every tool call must be answered, exactly
 * once, in the very next message; call IDs are unique; no message is empty; no two assistant messages in a row.
 */
export function historyProblems(messages: readonly ChatMessage[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  if (messages[0]?.role !== 'user') problems.push(`starts with ${messages[0]?.role ?? 'nothing'}`);
  messages.forEach((message, i) => {
    const prev = messages[i - 1];
    if (!message.content.length) problems.push(`message ${i}: empty`);
    if (message.role === 'assistant') {
      if (prev?.role === 'assistant') problems.push(`message ${i}: two assistant messages in a row`);
      const calls = message.content.filter((part) => part.type === 'tool-call').map((part) => part.id);
      for (const id of calls) {
        if (ids.has(id)) problems.push(`message ${i}: call ID ${id} used twice`);
        ids.add(id);
      }
      if (calls.length) {
        const next = messages[i + 1];
        const answered = next?.role === 'tool' ? next.content.map((result) => result.id) : [];
        if ([...answered].sort().join() !== [...calls].sort().join()) problems.push(`message ${i}: calls [${calls}] answered by [${answered}]`);
      }
    }
    if (message.role === 'tool' && (prev?.role !== 'assistant' || !prev.content.some((part) => part.type === 'tool-call'))) {
      problems.push(`message ${i}: tool results with no tool calls before them`);
    }
  });
  return problems;
}

export class FakeModel implements ModelAdapter {
  readonly name = 'fake';
  readonly requests: ModelRequest[] = [];
  /** Requests a model API would have refused. */
  readonly problems: string[] = [];
  private script: FakeScript[];
  private ids = 0;

  constructor(script: FakeScript[]) {
    this.script = script;
  }

  /** Steps not played yet. */
  get remaining(): number {
    return this.script.length - this.requests.length;
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const index = this.requests.length;
    this.requests.push(request);
    const broken = historyProblems(request.messages);
    if (broken.length) {
      this.problems.push(...broken.map((problem) => `request ${index + 1}: ${problem}`));
      throw new Error(`the model API would refuse this request: ${broken.join('; ')}`);
    }
    const entry = this.script[index];
    if (!entry) throw new Error(`FakeModel has no step ${index + 1}`);
    const step = typeof entry === 'function' ? entry(request, index) : entry;
    if (step.text) {
      // In two pieces, as a stream would deliver it.
      const half = Math.ceil(step.text.length / 2);
      yield { type: 'text', text: step.text.slice(0, half) };
      if (step.text.length > half) yield { type: 'text', text: step.text.slice(half) };
    }
    for (const [i, call] of (step.calls ?? []).entries()) {
      await step.beforeCall?.(i);
      yield { type: 'tool-call', id: call.id ?? `toolu_fake_${++this.ids}`, name: call.name, input: call.input };
    }
    if (step.fail) throw new Error(step.fail);
    if (step.hang === 'deaf') await new Promise(() => {});
    if (step.hang === 'abortable') {
      await new Promise((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      });
    }
    await step.beforeFinish?.();
    yield { type: 'finish', reason: step.finish ?? (step.calls?.length ? 'tool-calls' : 'stop'), usage: { ...USAGE, ...step.usage } };
  }
}

/**
 * The model's side of an example conversation, step by step: each step's progress line as the text it wrote before
 * its tool calls, then the calls; the last step of a turn is the answer text with its presentation calls.
 */
export function scriptFromConversation(conversation: Conversation): FakeStep[] {
  const steps: FakeStep[] = [];
  let current: FakeStep | null = null;
  for (const message of conversation.messages) {
    if (message.type === 'turn' || message.type === 'results') {
      current = { text: '', calls: [] };
    } else if (message.type === 'tool_call') {
      current?.calls!.push({ name: message.call.name, input: message.call.args });
    } else if (message.type === 'progress') {
      if (current) current.text += message.text;
    } else if (message.type === 'await_results') {
      if (current) steps.push(current);
      current = null;
    } else if (message.type === 'answer') {
      steps.push({ text: message.text, calls: (message.present ?? []).map((presentation) => ({ name: presentation.name, input: presentation.args })) });
      current = null;
    }
  }
  return steps;
}

export const fakeModelFor = (conversation: Conversation) => new FakeModel(scriptFromConversation(conversation));
