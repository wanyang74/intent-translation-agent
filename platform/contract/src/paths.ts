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
    for (const node of current) {
      if (node === null || typeof node !== 'object') continue;
      const child = (node as Record<string, unknown>)[key];
      if (child === undefined || child === null) continue;
      if (!isArray) next.push(child);
      else if (Array.isArray(child)) next.push(...child.filter((item) => item !== undefined && item !== null));
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

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const leftText = String(left), rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

/** JSON with sorted keys, dropping undefined values and empty arrays, so equal requests give equal keys. */
export function canonical(value: unknown): string {
  const norm = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(norm);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .filter(([, child]) => child !== undefined && !(Array.isArray(child) && child.length === 0))
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, norm(child)]),
      );
    }
    return node;
  };
  return JSON.stringify(norm(value));
}
