// Calling the site: Fetch (phase 5 on the flow chart). Every request a tool makes goes through here, in this order:
//   build it from the site pack (URL, method, fixed headers, tracking fields with fresh IDs) and check it against the
//   endpoint's request schema → answer from the cache if the same request (by match key) was made this session →
//   add the site token, if the site uses one → take one call from the shared budget → wait for a rate-limit slot →
//   send it with the page's or app's session → if the token was refused, get a new one and send it once more →
//   map statuses to errors → read the response by its format (JSON, a page through the site's reader, or a stream of
//   events) and check it against its schema → learn its IDs → cache it.
// The site token is fetched here too, from the site's own token endpoint, and kept on the session; it goes only into
// requests to the site, never into the log or a message to the brain. A tool that needs sign-in, on a site whose token
// rule says signedIn: page, sends the token the page keeps instead (Host.pageToken, D7): read for each call and never
// kept, since the page renews it and signing out replaces it.
import type { SitePack } from '../../../contract/generated/types.ts';
import { groupEvents, parseEventStream } from '../../../contract/src/events.ts';
import { canonical, select } from '../../../contract/src/paths.ts';
import { errorFor, platformError } from '../boundary/errors.ts';
import type { HostRequest, HostResponse } from '../runtime/host.ts';
import type { Session } from '../runtime/session.ts';
import { type EndpointRequest, ToolFailure } from './site-code.ts';
import { problemsWith } from '../shared/validate.ts';

type Endpoint = NonNullable<SitePack['endpoints'][string]>;
type TokenRule = NonNullable<SitePack['token']>;

/** Fetch a new token this long before the old one expires, unless the site pack says otherwise. */
const REFRESH_BEFORE_SECONDS = 300;

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

const ACCEPT: Record<string, string> = { json: 'application/json, text/plain, */*', html: 'text/html', sse: 'text/event-stream' };

export async function callEndpoint(session: Session, tool: string, name: string, req: EndpointRequest): Promise<unknown> {
  const { pack } = session;
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
  const headers: Record<string, string> = { accept: ACCEPT[ep.responseFormat ?? 'json']!, ...(ep.headers ?? {}), ...(req.headers ?? {}) };
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

  const res = await sendWithToken(session, tool, name, ep, { method: ep.method, url, headers, body });
  checkStatus(session, tool, res);

  let data: unknown;
  try {
    if (ep.responseFormat === 'html') {
      const parse = session.site.parsers?.[name];
      if (!parse) return fail('site_code_error', { tool, details: `there is no reader for the ${name} page` });
      data = parse(res.body);
    } else if (ep.responseFormat === 'sse') {
      data = groupEvents(parseEventStream(res.body), ep.eventKind);
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

  session.ids.learnFrom(data, ep.ids, session.host.now());
  session.cache.set(key, data);
  session.responses[name] = data;
  return data;
}

/**
 * One call to the site, as every call goes:
 *   1. Take one call from the shared budget; refuse the tool call when it's used up.
 *   2. Wait for a rate-limit slot.
 *   3. Send it with the endpoint's time limit; no response at all is a network error.
 *   4. Log it. A refused call keeps what was sent and the start of what came back, so the development log shows why.
 */
async function send(session: Session, tool: string, name: string, ep: Endpoint, request: HostRequest): Promise<HostResponse> {
  const { host } = session;
  // 1. The budget
  const acquired = session.budget.tryAcquire();
  if (!acquired.ok) throw new ToolFailure(platformError('budget_reached', { scope: acquired.scope, limit: acquired.limit }));
  // 2. The rate limit
  const start = session.limiter.reserve(host.now());
  const wait = start - host.now();
  if (wait > 0) await host.sleep(wait);
  // 3. Send
  let res: HostResponse;
  try {
    res = await host.request(ep.timeoutSeconds ? { ...request, timeoutMs: ep.timeoutSeconds * 1000 } : request);
  } catch (error) {
    session.log('network_error', { endpoint: name, error: String(error) });
    return fail('network_error', { tool });
  }
  // 4. Log
  const refused = res.status >= 400 ? { request: (request.body ?? request.url).slice(0, 1500), response: res.body.slice(0, 500) } : {};
  session.log('call', { endpoint: name, status: res.status, ...refused });
  return res;
}

/**
 * A call with the site token, for sites that use one:
 *   1. No token rule, or this is the token endpoint itself: send as it is.
 *   2. A tool that needs sign-in, where the page keeps the signed-in token: send with the page's token. None, or a
 *      refusal, means the user isn't signed in: a new anonymous token wouldn't help, so there's no retry.
 *   3. Send with the token in its header.
 *   4. Refused for the token (one of the site's refusedStatuses): drop it, get a new one and send once more. A second
 *      refusal goes on to the usual status errors, so a site that keeps refusing costs two calls, not a loop.
 */
async function sendWithToken(session: Session, tool: string, name: string, ep: Endpoint, request: HostRequest): Promise<HostResponse> {
  const rule = session.pack.token;
  // 1. No token
  if (!rule || name === rule.endpoint) return send(session, tool, name, ep, request);
  const withToken = (token: string): HostRequest => ({ ...request, headers: { ...request.headers, [rule.header]: (rule.format ?? '{token}').replace('{token}', token) } });
  // 2. The page's signed-in token
  if (rule.signedIn?.from === 'page' && session.pack.tools[tool]?.signIn) {
    const pageToken = await session.host.pageToken?.();
    if (!pageToken) throw new ToolFailure(errorFor(session.pack, tool, 'needs_sign_in', { tool, what: tool }));
    const answer = await send(session, tool, name, ep, withToken(pageToken));
    if (rule.refusedStatuses.includes(answer.status)) throw new ToolFailure(errorFor(session.pack, tool, 'needs_sign_in', { tool, what: tool }));
    return answer;
  }
  // 3. With the token
  const first = await send(session, tool, name, ep, withToken(await siteToken(session, tool, rule)));
  if (!rule.refusedStatuses.includes(first.status)) return first;
  // 4. Refused: once more with a new token
  session.log('token_refused', { endpoint: name, status: first.status });
  session.siteToken = null;
  return send(session, tool, name, ep, withToken(await siteToken(session, tool, rule)));
}

/**
 * The token to send, fetching a new one when none is held or the one held is about to expire.
 *   1. A token held that's good for longer than the refresh margin: use it.
 *   2. A token request already on its way (another tool call started it): wait for it, so side-by-side calls fetch one
 *      token, not one each. The first caller's await gives the event loop to the others, which find the request here.
 *   3. Otherwise fetch one, and share the request until it settles.
 */
async function siteToken(session: Session, tool: string, rule: TokenRule): Promise<string> {
  const now = session.host.now();
  // 1. Held
  const held = session.siteToken;
  if (held && held.expiresAt - (rule.refreshBeforeSeconds ?? REFRESH_BEFORE_SECONDS) * 1000 > now) return held.value;
  // 2. On its way
  if (session.tokenRequest) return session.tokenRequest;
  // 3. Fetch, shared
  const request = fetchToken(session, tool, rule);
  session.tokenRequest = request;
  try {
    return await request;
  } finally {
    session.tokenRequest = null;
  }
}

/**
 * One call to the site's token endpoint:
 *   1. Send it as the site's frontend does: no token, no body beyond an empty one for a POST.
 *   2. Map its status like any call, and check the answer against the endpoint's response schema.
 *   3. Take the token and its expiry from where the site pack says; keep them on the session. The log gets how long
 *      the token lasts, never the token.
 */
async function fetchToken(session: Session, tool: string, rule: TokenRule): Promise<string> {
  const ep = session.pack.endpoints[rule.endpoint]!;
  // 1. Send
  const headers = { accept: ACCEPT.json!, ...(ep.headers ?? {}), ...(ep.method === 'POST' ? { 'content-type': 'application/json' } : {}) };
  const res = await send(session, tool, rule.endpoint, ep, { method: ep.method, url: ep.url, headers, body: ep.method === 'POST' ? '{}' : null });
  // 2. Status and shape
  checkStatus(session, tool, res);
  let data: unknown;
  try {
    data = JSON.parse(res.body);
  } catch {
    session.log('response_check', { endpoint: rule.endpoint, problem: 'unreadable' });
    return fail('response_changed', { tool });
  }
  const badResponse = problemsWith(session.validators.site, ep.response, data);
  // 3. The token and its expiry
  const value = select(data, rule.value);
  if (badResponse || typeof value !== 'string' || !value) {
    session.log('response_check', { endpoint: rule.endpoint, problem: badResponse ?? 'no token in the answer' });
    return fail('response_changed', { tool });
  }
  const now = session.host.now();
  const stated = rule.expiresAt ? Date.parse(String(select(data, rule.expiresAt))) : NaN;
  const expiresAt = Number.isFinite(stated) ? stated : now + (rule.lifetimeSeconds ?? 0) * 1000;
  session.siteToken = { value, expiresAt };
  session.log('token', { endpoint: rule.endpoint, lastsSeconds: Math.round((expiresAt - now) / 1000) });
  return value;
}

/** Statuses as platform errors. 401 means signing in, since a site token refused with 401 has already been renewed once. */
function checkStatus(session: Session, tool: string, res: HostResponse): void {
  if (res.status === 401) throw new ToolFailure(errorFor(session.pack, tool, 'needs_sign_in', { tool, what: tool }));
  if (res.status === 404) fail('site_not_found', { tool });
  if (res.status === 429) fail('site_rate_limited', { tool });
  if (res.status >= 500) fail('site_unavailable', { tool, status: res.status });
  if (res.status < 200 || res.status >= 300) fail('site_refused', { tool, status: res.status });
}
