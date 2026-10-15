// The brain's view of a language model: one streaming call per agent step. It is provider-neutral, so the loop and
// its tests depend on no SDK. anthropic.ts adapts AI SDK Core to it; the testkit's FakeModel scripts it.

/** What a model is shown for one tool: the generated definition from the contract. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface TextPart {
  type: 'text';
  text: string;
}

/** A tool call as the model made it. `id` is the model's own ID, which its result must carry back. */
export interface ToolCallPart {
  type: 'tool-call';
  id: string;
  name: string;
  input: unknown;
}

/** A tool's result for the model: the tool's output (an object, or text for a skill) or its error. */
export interface ToolResultPart {
  type: 'tool-result';
  id: string;
  name: string;
  output: unknown;
  isError: boolean;
}

export type ChatMessage =
  | { role: 'user'; content: TextPart[] }
  | { role: 'assistant'; content: (TextPart | ToolCallPart)[] }
  | { role: 'tool'; content: ToolResultPart[] };

/**
 * One model call, laid out for prompt caching: the global segment first (system prompt and tools, the same for every
 * session of a site), then the session (the conversation so far), ending with the newest turn's volatile context or
 * the latest tool results. The adapter puts cache breakpoints at the end of the system prompt and at the end of the
 * messages.
 */
export interface ModelRequest {
  system: string;
  tools: readonly ToolSpec[];
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens read from the prompt cache. */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache. */
  cacheWriteTokens: number;
}

export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'other';

/**
 * What a model call streams: text as it's written, each tool call as soon as its input is complete, and one finish
 * at the end. A failed call throws from the iterator instead.
 */
export type ModelEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'finish'; reason: FinishReason; usage: Usage };

export interface ModelAdapter {
  /** For logs, such as "anthropic:claude-sonnet-5-5". */
  readonly name: string;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
