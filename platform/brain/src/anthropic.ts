// The model adapter for Claude, through AI SDK Core, which keeps models swappable: another provider is another
// adapter of the same shape. One streamText call per step, with no tool execution (the client runs the tools), so
// text and each finished tool call stream straight back. Two prompt-cache breakpoints: the end of the system prompt,
// which covers the global segment (tools, then system), and the end of the messages, which covers the session so far.
// Effort is low by default, for latency: a thinking model often sends tool calls with no text before them (seen live,
// 2026-10-14), which costs time and leaves steps without a progress line. Evals settle the level (phase 6).
import { createAnthropic } from '@ai-sdk/anthropic';
import { jsonSchema, streamText, tool, type JSONValue, type ModelMessage, type ToolSet } from 'ai';
import type { ChatMessage, FinishReason, ModelAdapter, ModelEvent, ToolResultPart, ToolSpec, Usage } from './model.ts';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  /** How long cached segments live: 5 minutes (the default) or 1 hour, which costs more to write. */
  cacheTtl?: '5m' | '1h';
  /** How much the model thinks before it acts; low by default (see above). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxRetries?: number;
  /** For tests: requests go to this fetch instead of the network. */
  fetch?: typeof fetch;
  baseURL?: string;
}

type CacheOptions = { anthropic: { cacheControl: { type: 'ephemeral'; ttl?: '5m' | '1h' } } };

function toolResultOutput(p: ToolResultPart) {
  if (typeof p.output === 'string') return { type: p.isError ? 'error-text' as const : 'text' as const, value: p.output };
  return { type: p.isError ? 'error-json' as const : 'json' as const, value: p.output as JSONValue };
}

/** The brain's messages as AI SDK messages, with a cache breakpoint on the last one. */
export function toModelMessages(messages: readonly ChatMessage[], cache: CacheOptions): ModelMessage[] {
  return messages.map((m, i): ModelMessage => {
    const options = i === messages.length - 1 ? { providerOptions: cache } : {};
    switch (m.role) {
      case 'user':
        return { role: 'user', content: m.content.map((p) => ({ type: 'text' as const, text: p.text })), ...options };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content.map((p) => (p.type === 'text'
            ? { type: 'text' as const, text: p.text }
            : { type: 'tool-call' as const, toolCallId: p.id, toolName: p.name, input: p.input })),
          ...options,
        };
      case 'tool':
        return {
          role: 'tool',
          content: m.content.map((p) => ({ type: 'tool-result' as const, toolCallId: p.id, toolName: p.name, output: toolResultOutput(p) })),
          ...options,
        };
    }
  });
}

/** Tool definitions without execute functions: the model calls them, the client runs them. */
export function toToolSet(specs: readonly ToolSpec[]): ToolSet {
  return Object.fromEntries(specs.map((s) => [s.name, tool({ description: s.description, inputSchema: jsonSchema(s.inputSchema as Parameters<typeof jsonSchema>[0]) })]));
}

const FINISH: Record<string, FinishReason> = { stop: 'stop', 'tool-calls': 'tool-calls', length: 'length' };

function usageOf(u: { inputTokens: number | undefined; outputTokens: number | undefined; inputTokenDetails?: { cacheReadTokens: number | undefined; cacheWriteTokens: number | undefined } }): Usage {
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

export function anthropicModel(o: AnthropicOptions): ModelAdapter {
  const modelId = o.model ?? DEFAULT_MODEL;
  const provider = createAnthropic({ apiKey: o.apiKey, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.baseURL ? { baseURL: o.baseURL } : {}) });
  const model = provider(modelId);
  const cache: CacheOptions = { anthropic: { cacheControl: { type: 'ephemeral', ...(o.cacheTtl === '1h' ? { ttl: '1h' as const } : {}) } } };
  // The global segment's tools are one array per site; convert each array once.
  const toolSets = new WeakMap<readonly ToolSpec[], ToolSet>();
  return {
    name: `anthropic:${modelId}`,
    async *stream(request): AsyncGenerator<ModelEvent> {
      let tools = toolSets.get(request.tools);
      if (!tools) {
        tools = toToolSet(request.tools);
        toolSets.set(request.tools, tools);
      }
      const result = streamText({
        model,
        instructions: { role: 'system', content: request.system, providerOptions: cache },
        messages: toModelMessages(request.messages, cache),
        tools,
        toolChoice: 'auto',
        maxOutputTokens: request.maxOutputTokens,
        maxRetries: o.maxRetries ?? 2,
        abortSignal: request.signal,
        providerOptions: { anthropic: { effort: o.effort ?? 'low' } },
        onError: () => {}, // errors arrive as stream parts and are thrown below
      });
      for await (const part of result.stream) {
        switch (part.type) {
          case 'text-delta':
            if (part.text) yield { type: 'text', text: part.text };
            break;
          case 'tool-call':
            yield { type: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input };
            break;
          case 'finish':
            yield { type: 'finish', reason: FINISH[part.finishReason] ?? 'other', usage: usageOf(part.totalUsage) };
            break;
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          case 'abort':
            throw new Error(`the model call was aborted${part.reason ? `: ${part.reason}` : ''}`);
          default:
            break;
        }
      }
    },
  };
}
