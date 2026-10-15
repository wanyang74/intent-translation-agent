// Dotted paths into JSON values, as used in site packs:
//   "pagination.page"              one value
//   "inventory.vehicles[].id"      [] maps over an array: all values
//   "vehicles[].vehicleId:sorted"  :sorted sorts the result (used in match keys)
// Pure functions: no Node or browser APIs, so core.js can use them too.

export function hasArray(path: string): boolean {
  return path.includes('[]');
}

/** Every value at the path. Missing or null values along the way are skipped. */
export function valuesAt(value: unknown, path: string): unknown[] {
  const [body = '', modifier] = path.split(':');
  let current: unknown[] = [value];
  for (const part of body.split('.')) {
    const isArray = part.endsWith('[]');
    const key = isArray ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const v of current) {
      if (v === null || typeof v !== 'object') continue;
      const child = (v as Record<string, unknown>)[key];
      if (child === undefined || child === null) continue;
      if (!isArray) next.push(child);
      else if (Array.isArray(child)) next.push(...child.filter((x) => x !== undefined && x !== null));
    }
    current = next;
  }
  return modifier === 'sorted' ? [...current].sort(compare) : current;
}

/** The value at the path: an array for paths with [], otherwise the single value (or undefined). */
export function select(value: unknown, path: string): unknown {
  const values = valuesAt(value, path);
  return hasArray(path) ? values : values[0];
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** JSON with sorted keys, dropping undefined values and empty arrays, so equal requests give equal keys. */
export function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined && !(Array.isArray(x) && x.length === 0))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, norm(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value));
}
