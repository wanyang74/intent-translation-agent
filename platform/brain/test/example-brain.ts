// The made-up shop from core.js's tests, as the brain serves it: the same site pack plus two skills and a prompt,
// tool definitions with small schemas, and validators strict enough for the brain's checks. Plus a brain with a
// FakeModel, and a FakeClient talking to it in-process.
import { readFileSync } from 'node:fs';
import type { PageContext, RemoteConfig, SitePack } from '../../contract/generated/types.ts';
import * as platformValidators from '../../contract/generated/validators.js';
import { validatorFor } from '../../core/src/validate.ts';
import { examplePack } from '../../core/test/example-pack.ts';
import { exampleValidators } from '../../core/test/example-site.ts';
import { FakeClient, inProcess, type ResultBody, type ResultFor } from '../../testkit/src/fake-client.ts';
import { FakeModel, type FakeScript } from '../../testkit/src/fake-model.ts';
import { Brain, type BrainLimits, type BrainLogEntry } from '../src/loop.ts';
import type { ChatMessage, ToolSpec } from '../src/model.ts';
import type { QuotaLimits } from '../src/quotas.ts';
import type { SiteBrain } from '../src/site.ts';

export { inProcess } from '../../testkit/src/fake-client.ts';
export { historyProblems } from '../../testkit/src/fake-model.ts';

export const validateMessage = validatorFor(platformValidators as Record<string, unknown>, 'messages.json');

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const SHOP_TOOLS: ToolSpec[] = [
  { name: 'search_products', description: 'Search products', inputSchema: object({ query: { type: 'string' }, colors: { type: 'array', items: { type: 'string' } }, page: { type: 'integer' } }, ['query']) },
  { name: 'get_offer', description: 'One offer', inputSchema: object({ offerId: { type: 'string' } }, ['offerId']) },
  { name: 'compare_products', description: 'Products side by side', inputSchema: object({ productIds: { type: 'array', items: { type: 'integer' } } }, ['productIds']) },
  { name: 'my_orders', description: "The shopper's orders", inputSchema: object({ status: { type: 'string' } }) },
  { name: 'read_product_page', description: "A product's details from its page", inputSchema: object({ productId: { type: 'integer' } }, ['productId']) },
  { name: 'place_order', description: 'Buy an offer', inputSchema: object({ offerId: { type: 'string' } }, ['offerId']) },
];

/** The shop's validators: inputs and the search output are checked; everything else accepts any object. */
const RULES: Record<string, (d: any) => boolean> = {
  'tools/search_products.input.json': (d) => typeof d.query === 'string' && Object.keys(d).every((k) => ['query', 'colors', 'page'].includes(k)),
  'tools/get_offer.input.json': (d) => typeof d.offerId === 'string',
  'tools/compare_products.input.json': (d) => Array.isArray(d.productIds),
  'tools/read_product_page.input.json': (d) => Number.isInteger(d.productId),
  'tools/search_products.output.json': (d) => Array.isArray(d.products),
};

export const SHOP_SKILLS: Record<string, string> = {
  product_research: '# Product research\nCompare products by price and rating; read reviews for what owners say.',
  gift_ideas: '# Gift ideas\nAsk who the gift is for before searching.',
};

export const shopPack: SitePack = {
  ...examplePack,
  skills: {
    product_research: { description: 'Comparing products and reading reviews', load: 'on demand; preloaded on product pages', pageTypes: ['product'] },
    gift_ideas: { description: 'Picking a gift for someone', load: 'when the user shops for someone else' },
  },
};

export function shopSite(over: Partial<SiteBrain> = {}): SiteBrain {
  return {
    pack: shopPack,
    siteTools: SHOP_TOOLS,
    platformTools: JSON.parse(readFileSync(new URL('../../contract/generated/tools.json', import.meta.url), 'utf8')) as ToolSpec[],
    validators: exampleValidators(RULES),
    prompt: '- Example Shop sells shoes. Always say the color.',
    skills: SHOP_SKILLS,
    ...over,
  };
}

export const HOME: PageContext = { url: 'https://www.example.com/', pageType: 'home', locale: 'en-US' };
export const productPage = (id: number): PageContext => ({ url: `https://www.example.com/p/${id}`, pageType: 'product', entity: { kind: 'product', id } });

export const SEARCH_OUTPUT = {
  products: [{ id: 1, name: 'Red Shoe', price: 40, total: 45.5, rating: 4.5 }, { id: 2, name: 'Blue Shoe', price: 1250, total: 1250, rating: 3.9 }],
  offers: [{ id: 'of_ab12', amount: 30, expiresAt: '2026-10-14T13:00:00Z' }],
  coupons: ['SAVEX'],
  token: 'tok_1',
};

/** What a working client answers for the shop's tools. */
export const shopResults: ResultFor = (call): ResultBody => {
  if (call.name === 'search_products') return { ok: true, output: SEARCH_OUTPUT };
  if (call.name === 'get_offer') return { ok: true, output: { offer: { id: (call.args as { offerId: string }).offerId, amount: 30 } } };
  if (call.name === 'run_script') return { ok: true, output: { result: { ids: [1], checked: 2 }, knownIds: { product: [1] } } };
  return { ok: true, output: {} };
};

export interface SetupOptions {
  limits?: Partial<BrainLimits>;
  quotas?: Partial<QuotaLimits>;
  configs?: RemoteConfig[];
  now?: () => number;
  results?: ResultFor;
  site?: SiteBrain;
  sessionId?: string;
}

export const NOW = Date.UTC(2026, 9, 14, 12);

export function setup(script: FakeScript[], o: SetupOptions = {}) {
  const model = new FakeModel(script);
  const log: BrainLogEntry[] = [];
  const brain = new Brain({
    sites: [o.site ?? shopSite()], model, limits: o.limits, quotas: o.quotas, configs: o.configs, now: o.now ?? (() => NOW), log: (e) => log.push(e),
  });
  const client = new FakeClient(inProcess(brain), {
    site: 'example-shop', validate: validateMessage, results: o.results ?? shopResults, ...(o.sessionId ? { sessionId: o.sessionId } : {}),
  });
  return { brain, model, client, log, send: inProcess(brain) };
}

/** The text of a request's messages, for checking what the model was shown. */
export const textOf = (messages: readonly ChatMessage[]) => JSON.stringify(messages);
