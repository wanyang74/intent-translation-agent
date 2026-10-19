// Names of the generated types and validators, by schema path (platform or site; the same rules apply).

const pascal = (text: string) => text.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join('');
const SPECIAL: Record<string, string> = { 'messages.json': 'Message', 'errors.json': 'ToolError', 'config.json': 'RemoteConfig', 'site-pack.json': 'SitePack' };
/** Files whose shared definitions keep their own names; definitions elsewhere get the file's type name as a prefix. */
const UNPREFIXED = new Set(['common.json', 'messages.json', 'site-pack.json']);

/** Folders whose schemas are a tool's arguments: their types are named "...Args". */
const TOOL_ARGS = new Set(['presentation', 'platform-tools']);

/** "endpoints/search.request.json" -> "SearchRequest", "presentation/present_items.json" -> "PresentItemsArgs". */
export function typeName(rel: string): string {
  const special = SPECIAL[rel];
  if (special) return special;
  const parts = rel.split('/');
  const base = parts[parts.length - 1]!.replace(/\.json$/, '');
  return pascal(base) + (TOOL_ARGS.has(parts[0]!) ? 'Args' : '');
}

/** Name of a shared definition ($defs entry) in a file. */
export const defName = (rel: string, key: string) => (UNPREFIXED.has(rel) ? key : typeName(rel) + key);

/** "endpoints/search.request.json" -> "validateSearchRequest". */
export const validatorName = (rel: string) => 'validate' + typeName(rel);
