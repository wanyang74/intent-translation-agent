// Reading site packs (sites/<id>/site.yaml) and the generic operations the platform needs from them.
// The platform never names a site: everything site-specific comes from here.
import { parse } from 'yaml';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SitePack } from '../generated/types.ts';
import { canonical, select, valuesAt } from './paths.ts';

export type { SitePack };
export type Endpoint = NonNullable<SitePack['endpoints'][string]>;
export type Tool = NonNullable<SitePack['tools'][string]>;

/** Object.entries for the site pack's maps (their generated types allow undefined values). */
export const entriesOf = <T>(map: Record<string, T | undefined> | undefined): [string, T][] =>
  Object.entries(map ?? {}).filter((e): e is [string, T] => e[1] !== undefined);

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const sitesDir = path.join(repoRoot, 'sites');

export interface Site {
  id: string;
  dir: string;
  schemasDir: string;
  pack: SitePack;
}

/** Site ids: folders under sites/ that contain a site.yaml. */
export function listSites(): string[] {
  if (!existsSync(sitesDir)) return [];
  return readdirSync(sitesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(sitesDir, d.name, 'site.yaml')))
    .map((d) => d.name)
    .sort();
}

/** Parses a site pack. Validation against the site-pack schema happens in loadContract. */
export function readSite(id: string): Site {
  const dir = path.join(sitesDir, id);
  const pack = parse(readFileSync(path.join(dir, 'site.yaml'), 'utf8')) as SitePack;
  return { id, dir, schemasDir: path.join(dir, 'schemas'), pack };
}

// ---------------------------------------------------------------- endpoints and requests

function templateToRegExp(url: string): RegExp {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '{' || c === '}' ? c : '\\' + c));
  return new RegExp('^' + escaped.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '(?<$1>[^/]+)') + '$');
}

/** The endpoint a URL belongs to, and its path parameters. Query strings are ignored for matching. */
export function endpointOf(pack: SitePack, url: string): { name: string; endpoint: Endpoint; params: Record<string, string> } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const target = u.origin + u.pathname;
  for (const [name, endpoint] of entriesOf(pack.endpoints)) {
    const m = templateToRegExp(endpoint.url).exec(target);
    if (m) return { name, endpoint, params: { ...(m.groups ?? {}) } };
  }
  return null;
}

/** The request as a value: path and query parameters for GET, the JSON body for POST. */
export function requestValue(pack: SitePack, req: { method: string; url: string; body?: unknown }): unknown {
  if (req.method === 'GET') {
    const match = endpointOf(pack, req.url);
    return { ...(match?.params ?? {}), ...Object.fromEntries(new URL(req.url).searchParams) };
  }
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? null;
}

/** The fields that decide the response (the endpoint's matchKey), as a canonical string. */
export function matchKey(endpoint: Endpoint, value: unknown): string {
  return canonical(Object.fromEntries(endpoint.matchKey.map((p) => [p, select(value, p)])));
}

/** IDs a response or tool output carries, by entity kind, from the declared id paths. */
export function idsIn(value: unknown, idPaths: { kind: string; path: string }[] | undefined): { kind: string; id: string | number }[] {
  return (idPaths ?? []).flatMap(({ kind, path: p }) =>
    valuesAt(value, p).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map((id) => ({ kind, id })));
}

// ---------------------------------------------------------------- cross-checks the schema can't express

export const PRESENTATION_TOOLS = ['present_items', 'present_comparison', 'present_detail', 'present_options', 'present_form', 'present_notice'];
/** The platform's own tools: scripts (run on the client) and skills (loaded by the brain). */
export const PLATFORM_TOOLS = ['run_script', 'load_skill'];
/** Tool names the platform keeps for itself. */
export const RESERVED_TOOLS = [...PRESENTATION_TOOLS, ...PLATFORM_TOOLS];

/** Problems with a site pack beyond its schema: references to things that don't exist. */
export function crossCheck(site: Site): string[] {
  const { pack } = site;
  const problems: string[] = [];
  const add = (where: string, msg: string) => problems.push(`${site.id}: ${where}: ${msg}`);
  const kinds = new Set(Object.keys(pack.entities));
  const schemaExists = (rel: string) => existsSync(path.join(site.schemasDir, rel));

  if (pack.site.id !== site.id) add('site.id', `should be the folder name "${site.id}"`);
  for (const [name, e] of entriesOf(pack.endpoints)) {
    for (const rel of [e.request, e.response]) if (!schemaExists(rel)) add(`endpoints.${name}`, `schema ${rel} not found`);
    for (const id of e.ids ?? []) if (!kinds.has(id.kind)) add(`endpoints.${name}.ids`, `unknown entity kind ${id.kind}`);
    if (!pack.site.origins.some((o) => e.url.startsWith(o))) add(`endpoints.${name}.url`, 'not under any of site.origins');
  }
  for (const [name, t] of entriesOf(pack.tools)) {
    if (RESERVED_TOOLS.includes(name)) add(`tools.${name}`, 'name is reserved for a platform tool');
    for (const rel of [t.input, t.output]) if (!schemaExists(rel)) add(`tools.${name}`, `schema ${rel} not found`);
    for (const u of t.uses) if (!pack.endpoints[u]) add(`tools.${name}.uses`, `unknown endpoint ${u}`);
    for (const id of [...(t.ids?.input ?? []), ...(t.ids?.output ?? [])]) if (!kinds.has(id.kind)) add(`tools.${name}.ids`, `unknown entity kind ${id.kind}`);
  }
  const fieldKeys = new Set(entriesOf(pack.entities).flatMap(([, e]) => Object.keys(e.fields ?? {})));
  for (const [kind, e] of entriesOf(pack.entities)) {
    for (const f of e.card?.fields ?? []) if (!e.fields?.[f]) add(`entities.${kind}.card`, `unknown field ${f}`);
    if (e.card?.link && !pack.deepLinks?.[e.card.link]) add(`entities.${kind}.card.link`, `unknown deep link ${e.card.link}`);
  }
  for (const [name, n] of entriesOf(pack.notices)) {
    for (const f of n.showWith ?? []) if (!fieldKeys.has(f)) add(`notices.${name}.showWith`, `unknown field ${f}`);
  }
  for (const [name, f] of entriesOf(pack.forms)) {
    if (f.submitTool && !pack.tools[f.submitTool]) add(`forms.${name}.submitTool`, `unknown tool ${f.submitTool}`);
  }
  for (const key of Object.keys(pack.policies.allowedValues ?? {})) {
    if (!pack.tools[key.split('.')[0]!]) add(`policies.allowedValues.${key}`, 'unknown tool');
  }
  for (const [name, d] of entriesOf(pack.policies.derivedFields)) {
    if (d.appliesTo && !kinds.has(d.appliesTo)) add(`policies.derivedFields.${name}`, `unknown entity kind ${d.appliesTo}`);
  }
  // Each skill's guidance is a Markdown file the brain loads: sites/<id>/skills/<name>.md.
  const skillFiles = existsSync(path.join(site.dir, 'skills'))
    ? readdirSync(path.join(site.dir, 'skills')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
    : [];
  for (const [name, skill] of entriesOf(pack.skills)) {
    if (!skillFiles.includes(name)) add(`skills.${name}`, `no guidance file skills/${name}.md`);
    for (const t of skill.pageTypes ?? []) if (!pack.site.pageTypes?.includes(t)) add(`skills.${name}.pageTypes`, `unknown page type ${t}`);
  }
  for (const name of skillFiles) if (!pack.skills?.[name]) add(`skills/${name}.md`, 'not declared under skills in site.yaml');
  return problems;
}
