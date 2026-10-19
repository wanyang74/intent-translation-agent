// Calling the site: Fetch (phase 5 on the flow chart). Every request a tool makes goes through here, in this order:
//   build it from the site pack (URL, method, fixed headers, tracking fields with fresh IDs) and check it against the
//   endpoint's request schema → answer from the cache if the same request (by match key) was made this session →
//   take one call from the shared budget → wait for a rate-limit slot → send it with the page's or app's session →
//   map statuses to errors → read and check the response against its schema → learn its IDs → cache it.
import type { SitePack } from '../../../contract/generated/types.ts';
import { canonical, select } from '../../../contract/src/paths.ts';
import { errorFor, platformError } from '../boundary/errors.ts';
import type { HostResponse } from '../runtime/host.ts';
import type { Session } from '../runtime/session.ts';
import { type EndpointRequest, ToolFailure } from './site-code.ts';
import { problemsWith } from '../shared/validate.ts';

type Endpoint = NonNullable<SitePack['endpoints'][string]>;

const fail = (reason: Parameters<typeof platformError>[0], values: Record<string, unknown>): never => {
  throw new ToolFailure(platformError(reason, values));
};

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** The fields that decide the response, as one string: the cache key, and what FakeHost matches fixtures on. */
export function matchKey(endpoint: Endpoint, value: unknown): string {
  return canonical(Object.fromEntries(endpoint.matchKey.map((field) => [field, select(value, field)])));
}

const enc = encodeURIComponent;

export async function callEndpoint(session: Session, tool: string, name: string, req: EndpointRequest): Promise<unknown> {
  const { pack, host } = session;
  const endpoint = pack.endpoints[name];
  if (!endpoint || !pack.tools[tool]?.uses.includes(name)) fail('site_code_error', { tool, details: `it called ${name}, which it doesn't declare in uses` });
  const ep = endpoint!;

  // Build the request. GET values are what the URL carries (text); POST values are the JSON body.
  let url = ep.url.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, param: string) => {
    const paramValue = req.params?.[param];
    if (paramValue === undefined) fail('site_code_error', { tool, details: `the URL needs ${param}` });
    return enc(String(paramValue));
  });
  let value: Record<string, unknown>;
  let body: string | null = null;
  const headers: Record<string, string> = { accept: ep.responseFormat === 'html' ? 'text/html' : 'application/json, text/plain, */*', ...(ep.headers ?? {}), ...(req.headers ?? {}) };
  if (ep.method === 'GET') {
    const query = Object.entries(req.query ?? {});
    if (query.length) url += (url.includes('?') ? '&' : '?') + query.map(([queryKey, queryValue]) => `${enc(queryKey)}=${enc(String(queryValue))}`).join('&');
    value = { ...Object.fromEntries(Object.entries(req.params ?? {}).map(([paramKey, paramValue]) => [paramKey, String(paramValue)])), ...Object.fromEntries(query.map(([queryKey, queryValue]) => [queryKey, String(queryValue)])) };
  } else {
    value = JSON.parse(JSON.stringify(req.body ?? {})) as Record<string, unknown>;
    for (const field of ep.tracking?.fields ?? []) if (select(value, field) === undefined) setPath(value, field, session.trackingId(field));
    body = JSON.stringify(value);
    headers['content-type'] = 'application/json';
  }
  for (const header of ep.tracking?.headers ?? []) if (headers[header] === undefined) headers[header] = session.trackingId(header);
  const badRequest = problemsWith(session.validators.site, ep.request, value);
  if (badRequest) fail('site_code_error', { tool, details: `its ${name} request is invalid: ${badRequest}` });

  const key = `${name} ${matchKey(ep, value)}`;
  if (session.cache.has(key)) {
    session.log('cache_hit', { endpoint: name });
    return session.cache.get(key);
  }

  const acquired = session.budget.tryAcquire();
  if (!acquired.ok) throw new ToolFailure(platformError('budget_reached', { scope: acquired.scope, limit: acquired.limit }));
  const start = session.limiter.reserve(host.now());
  const wait = start - host.now();
  if (wait > 0) await host.sleep(wait);

  let res: HostResponse;
  try {
    res = await host.request({ method: ep.method, url, headers, body });
  } catch (error) {
    session.log('network_error', { endpoint: name, error: String(error) });
    return fail('network_error', { tool });
  }
  session.log('call', { endpoint: name, status: res.status });

  if (res.status === 401) throw new ToolFailure(errorFor(pack, tool, 'needs_sign_in', { tool, what: tool }));
  if (res.status === 404) fail('site_not_found', { tool });
  if (res.status === 429) fail('site_rate_limited', { tool });
  if (res.status >= 500) fail('site_unavailable', { tool, status: res.status });
  if (res.status < 200 || res.status >= 300) fail('site_refused', { tool, status: res.status });

  let data: unknown;
  try {
    if (ep.responseFormat === 'html') {
      const parse = session.site.parsers?.[name];
      if (!parse) return fail('site_code_error', { tool, details: `there is no reader for the ${name} page` });
      data = parse(res.body);
    } else {
      data = JSON.parse(res.body);
    }
  } catch (error) {
    if (error instanceof ToolFailure) throw error;
    session.log('response_check', { endpoint: name, problem: 'unreadable' });
    return fail('response_changed', { tool });
  }
  const badResponse = problemsWith(session.validators.site, ep.response, data);
  if (badResponse) {
    session.log('response_check', { endpoint: name, problem: badResponse });
    fail('response_changed', { tool });
  }

  session.ids.learnFrom(data, ep.ids, host.now());
  session.cache.set(key, data);
  session.responses[name] = data;
  return data;
}
