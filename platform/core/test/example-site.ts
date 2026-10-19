// The made-up shop as a running site, for core.js's I/O tests: its code, simple validators, and a host whose network
// is a function the test writes. Time is virtual: sleeping moves the clock at once.
import * as platformValidators from '../../contract/generated/validators.js';
import { validatorName } from '../../contract/src/names.ts';
import { VirtualClock } from '../../testkit/src/virtual-clock.ts';
import type { Host, HostRequest, HostResponse, LogEntry } from '../src/runtime/host.ts';
import { Session, startSession, type SiteCode, type Validators } from '../src/index.ts';
import { examplePack } from './example-pack.ts';

export const START = Date.UTC(2026, 9, 14, 12);

/** Validators for the shop's schemas: each accepts any object, unless a test supplies its own rule. */
export function exampleValidators(rules: Record<string, (data: any) => boolean> = {}): Validators {
  const paths = new Set<string>();
  for (const endpoint of Object.values(examplePack.endpoints)) paths.add(endpoint!.request).add(endpoint!.response);
  for (const tool of Object.values(examplePack.tools)) paths.add(tool!.input).add(tool!.output);
  const site: Record<string, unknown> = {};
  for (const rel of paths) {
    const rule = rules[rel] ?? ((data: unknown) => data !== null && typeof data === 'object' && !Array.isArray(data));
    const validator = (data: unknown) => {
      const ok = rule(data);
      validator.errors = ok ? null : [{ instancePath: '', message: `does not match ${rel}` }];
      return ok;
    };
    validator.errors = null as null | { instancePath: string; message: string }[];
    site[validatorName(rel)] = validator;
  }
  return { platform: platformValidators as Record<string, unknown>, site };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): HostResponse =>
  ({ status, headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

export interface ExampleHost {
  host: Host;
  clock: VirtualClock;
  requests: HostRequest[];
  log: LogEntry[];
}

export function exampleHost(network: (req: HostRequest) => HostResponse | Promise<HostResponse>, extra: Partial<Host> = {}): ExampleHost {
  const clock = new VirtualClock(START);
  const requests: HostRequest[] = [];
  const log: LogEntry[] = [];
  let ids = 0;
  const host: Host = {
    request: async (req) => {
      requests.push(req);
      return network(req);
    },
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
    randomId: () => `00000000-0000-4000-9000-${String(++ids).padStart(12, '0')}`,
    log: (entry) => log.push(entry),
    ...extra,
  };
  return { host, clock, requests, log };
}

/** What the shop's API answers, by URL path. */
export const SEARCH_RESPONSE = {
  items: [
    { id: 1, name: 'Red Shoe', price: 40, shipping: { cost: 5.5 }, rating: 4.5 },
    { id: 2, name: 'Blue Shoe', price: 1250, shipping: { cost: 0 }, rating: 3.9 },
  ],
  offers: [{ id: 'of_ab12', amount: 30, expiresAt: '2026-10-14T13:00:00Z' }],
  coupons: ['SAVEX'],
  token: 'tok_1',
};

export function shopNetwork(req: HostRequest): HostResponse {
  const url = new URL(req.url);
  if (url.pathname === '/search') return json(SEARCH_RESPONSE);
  if (url.pathname === '/filters') return json({ colors: [{ key: 'Red' }, { key: 'Blue' }] });
  if (url.pathname === '/orders') return json({ orders: [{ id: 'ABC123', status: 'open' }] });
  if (url.pathname.startsWith('/p/')) return { status: 200, headers: { 'content-type': 'text/html' }, body: `<html><h1 data-name="Product ${url.pathname.slice(3)}"></h1></html>` };
  return json({ error: 'no such path' }, 404);
}

export const exampleCode: SiteCode = {
  tools: {
    async search_products(ctx) {
      const res = await ctx.call('search', { body: { query: ctx.args.query ?? '', colors: ctx.args.colors ?? [] } });
      return {
        products: res.items.map((i: any) => ({ id: i.id, name: i.name, price: i.price, ...ctx.derived('product', i), rating: i.rating })),
        offers: res.offers,
        coupons: res.coupons,
        token: res.token,
      };
    },
    async get_offer(ctx) {
      return { offer: { id: ctx.args.offerId, amount: 30 } };
    },
    async compare_products(ctx) {
      return { products: ctx.args.productIds.map((id: number) => ({ id })) };
    },
    async my_orders(ctx) {
      const res = await ctx.call('orders', { query: { status: 'open' } });
      return { orders: res.orders };
    },
    async read_product_page(ctx) {
      const page = await ctx.call('page', { params: { productId: ctx.args.productId } });
      return { name: page.name };
    },
  },
  valueSources: { filters: (args) => ({ query: { query: args.query ?? '' } }) },
  parsers: { page: (html) => ({ name: /data-name="([^"]*)"/.exec(html)?.[1] ?? null }) },
  sections: {
    reviews: (view) => (view.values.rating === undefined ? null : { summary: `Rated ${String(view.values.rating)} of 5.` }),
  },
};

export async function exampleSession(options: { network?: (req: HostRequest) => HostResponse | Promise<HostResponse>; code?: SiteCode; validators?: Validators; host?: Partial<Host>; config?: unknown } = {}): Promise<ExampleHost & { session: Session }> {
  const shop = exampleHost(options.network ?? shopNetwork, options.host);
  const { session } = await startSession({ pack: examplePack, site: options.code ?? exampleCode, validators: options.validators ?? exampleValidators(), host: shop.host, config: options.config });
  session.setPage({ url: 'https://www.example.com/', pageType: 'home' });
  return { ...shop, session };
}
