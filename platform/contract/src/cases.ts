// Cases the platform contract must reject: a negative for every rule that matters.
// Each site pack adds its own in sites/<id>/cases.ts. Used by the contract check and the generated-code tests.

export interface MustReject {
  /** Schema path under the schemas folder of the platform or the site. */
  schema: string;
  instance: unknown;
  rule: string;
}

const turn = { type: 'turn', site: 'example-site', sessionId: 'sess_0001abcd', traceId: 'trace_0001abcd', message: 'hello', pageContext: { url: 'https://www.example.com/', pageType: 'home' } };
const config = { site: 'example-site', version: '1', issuedAt: '2026-10-12T00:00:00Z', disabledTools: [], disabledSkills: [], budgets: { perTask: 40, perSession: null, perDay: null }, rateLimitPerSecond: 1, signature: 'x' };

export const mustReject: MustReject[] = [
  { schema: 'presentation/present_items.json', instance: { entity: 'product', ids: [{ id: 'p-1', price: 10 }] }, rule: 'presentation calls carry IDs, not content' },
  { schema: 'presentation/present_items.json', instance: { entity: 'product', ids: ['p-1', 'p-1'] }, rule: 'no duplicate cards' },
  { schema: 'presentation/present_items.json', instance: { ids: ['p-1'] }, rule: 'presentation calls name the entity kind' },
  { schema: 'presentation/present_comparison.json', instance: { entity: 'product', ids: ['p-1'], attributes: ['price'] }, rule: 'a comparison needs at least two items' },
  { schema: 'presentation/present_notice.json', instance: { notice: 'disclosure', text: 'Our own wording' }, rule: 'notice text comes from the site pack, never from the model' },
  { schema: 'platform-tools/run_script.json', instance: { source: '' }, rule: 'a script has a body' },
  { schema: 'platform-tools/run_script.json', instance: { source: 'return {};', network: true }, rule: 'a script takes only its source' },
  { schema: 'platform-tools/load_skill.json', instance: { name: 'Vehicle Research' }, rule: 'skills are named by their identifier' },
  { schema: 'messages.json', instance: { type: 'tool_call', traceId: 'trace_0001abcd', call: { id: 'call_1', name: 'Place Order!', args: {} } }, rule: 'tool names are plain identifiers' },
  { schema: 'messages.json', instance: { type: 'answer', traceId: 'trace_0001abcd', text: 'ok', present: [{ name: 'render_html', args: {} }] }, rule: 'only platform presentation tools can render' },
  { schema: 'messages.json', instance: { ...turn, message: 'x'.repeat(2001) }, rule: 'a user message is at most 2,000 characters' },
  { schema: 'messages.json', instance: { ...turn, site: undefined }, rule: 'every turn names its site' },
  { schema: 'messages.json', instance: { type: 'amend', sessionId: 'sess_0001abcd', traceId: 'trace_0001abcd', message: '' }, rule: 'an amendment has words' },
  { schema: 'messages.json', instance: { type: 'amended', traceId: 'trace_0001abcd', status: 'maybe' }, rule: 'an amendment is queued or too late' },
  { schema: 'errors.json', instance: { code: 'route_other_zip', message: 'x', retryable: true }, rule: 'error codes are generic; site detail goes in reason' },
  { schema: 'config.json', instance: { ...config, issuedAt: 'yesterday' }, rule: 'dates are ISO 8601 with a time zone' },
  { schema: 'config.json', instance: { ...config, rateLimitPerSecond: 0 }, rule: 'a rate limit is above zero' },
  { schema: 'site-pack.json', instance: { site: { id: 'x', name: 'X', origins: ['http://insecure.example'] }, entities: {}, endpoints: {}, tools: {}, policies: { rateLimitPerSecond: 1, callBudget: { perTask: 1, perSession: null, perDay: null }, writes: 'none' }, recording: { scrubFields: [], scrubHeaders: [], keepHeaders: [] } }, rule: 'site origins use https' },
  { schema: 'site-pack.json', instance: { site: { id: 'x', name: 'X', origins: ['https://x.example'] }, entities: {}, endpoints: {}, tools: {}, policies: { rateLimitPerSecond: 1, callBudget: { perTask: 1, perSession: null, perDay: null }, writes: 'always' }, recording: { scrubFields: [], scrubHeaders: [], keepHeaders: [] } }, rule: 'writes are none or with_approval' },
];
