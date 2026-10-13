// Names of the generated types and validators, by schema path.

const pascal = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
const SPECIAL: Record<string, string> = { 'errors.json': 'ToolError', 'messages.json': 'Message', 'config.json': 'RemoteConfig' };

/** "carvana/search.request.json" -> "CarvanaSearchRequest", "tools/search_vehicles.input.json" -> "SearchVehiclesInput". */
export function typeName(rel: string): string {
  const special = SPECIAL[rel];
  if (special) return special;
  const [dir, file] = rel.split('/') as [string, string];
  const base = file.replace(/\.json$/, '');
  if (dir === 'carvana') return 'Carvana' + pascal(base);
  if (dir === 'tools') return pascal(base);
  if (dir === 'presentation') return pascal(base) + 'Args';
  throw new Error(`No type name rule for ${rel}`);
}

/** Name of a shared definition ($defs entry). */
export const defName = (rel: string, key: string) => (rel === 'carvana/availability.request.json' ? 'CarvanaAvailability' + key : key);

/** "carvana/search.request.json" -> "validateCarvanaSearchRequest". */
export const validatorName = (rel: string) => 'validate' + typeName(rel);
