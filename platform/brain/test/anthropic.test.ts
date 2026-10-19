// The Claude adapter through AI SDK Core and the Anthropic provider, with fetch replaced: the request the API would
// get (system prompt and last message marked for caching, tools as defined, tool calls and results paired by the
// model's IDs), and the streamed answer turned into the brain's events (text, a tool call with parsed input, the
// finish with cache usage). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicModel, toModelMessages } from '../src/model/anthropic.ts';
import type { ChatMessage, ModelEvent } from '../src/model/model.ts';
import { buildPromptPrefix } from '../src/prompt/prompt.ts';
import { shopSite } from './example-brain.ts';

const sse = (events: object[]) => events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

const STREAM = sse([
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage: { input_tokens: 40, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 5200 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' the offer…' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01AbC', name: 'get_offer', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"offerId":' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"of_ab12"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 31 } },
  { type: 'message_stop' },
]);

const HISTORY: ChatMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'red shoes' }, { type: 'text', text: '<context>…</context>' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Searching…' }, { type: 'tool-call', id: 'toolu_00XyZ', name: 'search_products', input: { query: 'red' } }, { type: 'tool-call', id: 'toolu_00Skl', name: 'load_skill', input: { name: 'gift_ideas' } }] },
  { role: 'tool', content: [
    { type: 'tool-result', id: 'toolu_00XyZ', name: 'search_products', output: { products: [{ id: 1 }] }, isError: false },
    { type: 'tool-result', id: 'toolu_00Skl', name: 'load_skill', output: '# Gift ideas', isError: false },
  ] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'toolu_00Bad', name: 'get_offer', input: { offerId: 'of_zz99' } }] },
  { role: 'tool', content: [{ type: 'tool-result', id: 'toolu_00Bad', name: 'get_offer', output: { code: 'unknown_id', message: 'offer of_zz99 was never returned.', retryable: true }, isError: true }] },
];

function recordingFetch(body: string, status = 200) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    requests.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) });
    return new Response(body, { status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' } });
  }) as typeof fetch;
  return { fakeFetch, requests };
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

test('the request: cached system prompt, tools as defined, the history paired by call IDs, the last message cached', async () => {
  const { fakeFetch, requests } = recordingFetch(STREAM);
  const model = anthropicModel({ apiKey: 'test-key-not-real', fetch: fakeFetch, maxRetries: 0 });
  const prefix = buildPromptPrefix(shopSite());
  const events = await collect(model.stream({ system: prefix.system, tools: prefix.tools, messages: HISTORY, maxOutputTokens: 4096, signal: new AbortController().signal }));
  assert.equal(requests.length, 1);
  const { url, headers, body } = requests[0]!;
  assert.match(url, /\/messages$/);
  assert.equal(headers['x-api-key'], 'test-key-not-real');
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.stream, true);
  assert.deepEqual(body.output_config, { effort: 'low' }, 'low effort by default, so answers come with their text');
  assert.deepEqual(body.system, [{ type: 'text', text: prefix.system, cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), prefix.tools.map((tool) => tool.name));
  assert.deepEqual(body.tools[0].input_schema, prefix.tools[0]!.inputSchema);
  assert.ok(body.tools.every((tool: object) => !('cache_control' in tool)), 'the system breakpoint covers the tools, which come first');
  assert.deepEqual(body.messages.map((message: { role: string }) => message.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  const [, assistant, results, , last] = body.messages;
  assert.deepEqual(assistant.content.map((block: { type: string; id?: string }) => [block.type, block.id]), [['text', undefined], ['tool_use', 'toolu_00XyZ'], ['tool_use', 'toolu_00Skl']]);
  assert.deepEqual(results.content.map((block: { type: string; tool_use_id: string }) => [block.type, block.tool_use_id]), [['tool_result', 'toolu_00XyZ'], ['tool_result', 'toolu_00Skl']]);
  assert.equal(last.content[0].is_error, true);
  assert.deepEqual(last.content.at(-1).cache_control, { type: 'ephemeral' });
  const cached = JSON.stringify(body.messages).match(/cache_control/g) ?? [];
  assert.equal(cached.length, 1, 'one breakpoint in the messages: at the end');

  assert.deepEqual(events.slice(0, 3), [
    { type: 'text', text: 'Checking' },
    { type: 'text', text: ' the offer…' },
    { type: 'tool-call', id: 'toolu_01AbC', name: 'get_offer', input: { offerId: 'of_ab12' } },
  ]);
  const finish = events[3]!;
  assert.equal(finish.type, 'finish');
  assert.equal(finish.type === 'finish' && finish.reason, 'tool-calls');
  assert.equal(finish.type === 'finish' && finish.usage.cacheReadTokens, 5200);
  assert.equal(finish.type === 'finish' && finish.usage.outputTokens, 31);
  assert.ok(finish.type === 'finish' && finish.usage.inputTokens >= 5240, 'input tokens count the cached ones too');
});

test('a one-hour cache and a higher effort when asked for', async () => {
  const { fakeFetch, requests } = recordingFetch(STREAM);
  await collect(anthropicModel({ apiKey: 'k', fetch: fakeFetch, cacheTtl: '1h', effort: 'medium', maxRetries: 0 }).stream({ system: 'S', tools: [], messages: HISTORY.slice(0, 1), maxOutputTokens: 100, signal: new AbortController().signal }));
  assert.deepEqual(requests[0]!.body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(requests[0]!.body.output_config, { effort: 'medium' });
});

test('an API error is thrown from the stream, for the loop to turn into a plain message', async () => {
  const { fakeFetch } = recordingFetch(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), 529);
  await assert.rejects(collect(anthropicModel({ apiKey: 'k', fetch: fakeFetch, maxRetries: 0 }).stream({ system: 'S', tools: [], messages: HISTORY.slice(0, 1), maxOutputTokens: 100, signal: new AbortController().signal })), /Overloaded/);
});

test('only the last message carries a cache breakpoint', () => {
  const cache = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };
  const messages = toModelMessages(HISTORY, cache);
  assert.deepEqual(messages.map((message) => 'providerOptions' in message), [false, false, false, false, true]);
});
