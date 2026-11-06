// Finding API addresses in a site's JavaScript, for scan-api (platform/web/scripts/scan-api.ts): which string
// literals are API addresses, the HTTP methods written near them, ID masking for addresses seen in recordings, and the
// script files a bundler can load later. Pure functions over text; nothing here reads files or calls a site.

/** Static files: scripts, styles, images, fonts, media, source maps and module manifests. */
export const ASSET = /(\.(js|mjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|map)|manifest\.json)$/i;
/** Path segments that mark an API, for relative addresses (a relative path could as well be a page). */
export const API_PATH = /(^|\/)(api|apis|graphql|gql|v\d+|rest|svc|service|services|gateway)(\/|$)/i;
/** Words in an address that suggest it changes something or needs an account. */
export const FLAG_WORDS = ['create', 'submit', 'update', 'delete', 'remove', 'save', 'cancel', 'purchase', 'checkout', 'order', 'reserve', 'apply', 'upload',
  'signup', 'register', 'login', 'logout', 'signin', 'auth', 'token', 'password', 'payment', 'account', 'profile', 'favorite', 'user', 'customer', 'document', 'sign'];
/** A path with numbers and long hex IDs as {id}: the code's own IDs, or a visitor's in a recorded call. */
export const maskIds = (urlPath: string) => urlPath.replace(/\/\d{3,}(?=\/|$)/g, '/{id}').replace(/\/[0-9a-f-]{32,36}(?=\/|$)/gi, '/{id}').replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, '/{id}');
/** Static files and bare base URLs (an API's base joined to a path elsewhere) aren't endpoints. */
export const isStatic = (urlPath: string) => ASSET.test(urlPath) || urlPath.includes('/_next/') || urlPath === '/';
/** String literals: "…", '…' and `…` with ${…} parts kept as {…}. */
const LITERAL = /"((?:[^"\\\n]|\\.){2,300})"|'((?:[^'\\\n]|\\.){2,300})'|`((?:[^`\\]|\\.){2,300})`/g;

/** An address in a literal, normalized: placeholders and IDs as {name}, no query values. Null when it isn't an API. */
export function apiAddress(literal: string): { host: string; path: string; queryNames: string[] } | null {
  const text = literal.replace(/\$\{([^}]*)\}/g, (_whole, inner: string) => `{${(inner.match(/[A-Za-z_$][\w$]*(?=\s*\)?\s*$)/)?.[0] ?? 'value').replace(/\$/g, '')}}`);
  const absolute = /^https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(:\d+)?(\/[^\s"'`<>]*)?$/i.exec(text);
  const relative = /^\/[A-Za-z0-9_{}.~%-][^\s"'`<>]*$/.test(text) ? text : null;
  if (!absolute && !relative) return null;
  const host = absolute ? absolute[1]!.toLowerCase() : '(relative)';
  const [rawPath = '/', query = ''] = (absolute ? absolute[3] ?? '/' : relative!).split('?');
  const cleanPath = maskIds(rawPath);
  if (isStatic(cleanPath)) return null;
  // A relative address counts only when it looks like an API; an absolute one is kept for its host either way.
  if (!absolute && !API_PATH.test(cleanPath)) return null;
  const queryNames = [...new Set(query.split('&').map((pair) => pair.split('=')[0]!).filter((name) => /^[A-Za-z_][\w.[\]-]*$/.test(name)))].sort();
  return { host, path: cleanPath, queryNames };
}

/** HTTP methods written near an address (method: "POST", .post( and the like). */
export function methodsNear(code: string, at: number): string[] {
  const near = code.slice(Math.max(0, at - 250), at + 400);
  const found = new Set<string>();
  for (const match of near.matchAll(/method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]|\.(get|post|put|patch|delete)\s*\(/gi)) found.add((match[1] ?? match[2]!).toUpperCase());
  return [...found].sort();
}

/** An API address found in code: where it is, the methods written near it, and a short stretch of code around it. */
export interface CodeAddress {
  address: { host: string; path: string; queryNames: string[] };
  methods: string[];
  context: string;
}

/** Every API address written in a script, in order. */
export function addressesIn(code: string): CodeAddress[] {
  const out: CodeAddress[] = [];
  for (const match of code.matchAll(LITERAL)) {
    const address = apiAddress(match[1] ?? match[2] ?? match[3]!);
    if (!address) continue;
    const context = code.slice(Math.max(0, match.index - 120), match.index + match[0].length + 160).replace(/\s+/g, ' ');
    out.push({ address, methods: methodsNear(code, match.index), context });
  }
  return out;
}

/**
 * Script URLs the bundler can load later (a webpack runtime names each chunk's file by number and hash). Only the
 * common shape is read: "static/chunks/" + optional names map + "." + hash map + ".js".
 */
export function laterChunks(runtimeUrl: string, runtime: string): string[] {
  const at = runtime.indexOf('"static/chunks/"');
  if (at < 0) return [];
  const tail = runtime.slice(at, at + 200_000);
  const maps = [...tail.matchAll(/\{((?:\d+:"[^"]+",?)+)\}/g)].slice(0, 2).map((match) => Object.fromEntries([...match[1]!.matchAll(/(\d+):"([^"]+)"/g)].map((pair) => [pair[1]!, pair[2]!])));
  const hashes = maps.find((map) => Object.values(map).every((value) => /^[0-9a-f]{8,}$/.test(value)));
  if (!hashes) return [];
  const names = maps.find((map) => map !== hashes) ?? {};
  const base = runtimeUrl.slice(0, runtimeUrl.indexOf('static/chunks/'));
  return Object.entries(hashes).map(([id, hash]) => `${base}static/chunks/${names[id] ?? id}.${hash}.js`);
}
