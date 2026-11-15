// The model view of a tool's output schema (sign-in mode, privacy.ts): the schema the brain checks the model's copy of
// a result against, where each withheld value may be a stand-in instead. Made by the contract loader (load.ts) for
// every tool that withholds something, and compiled by the generator like any site schema. Contract tooling only: it
// uses URL to resolve $refs, which core.js's engines don't all have. Platform code: nothing here names a site.
import { WITHHELD_PATTERN } from './privacy.ts';


/** Finds the schema a $ref points to, given the URL of the document it appears in. */
export type SchemaResolver = (ref: string, base: string) => { schema: Record<string, unknown>; base: string } | undefined;

/** A resolver over these schema documents, by their $id, with JSON pointers into them. */
export function schemaResolver(docs: readonly Record<string, unknown>[]): SchemaResolver {
  const byId = new Map(docs.map((doc) => [String(doc.$id), doc]));
  return (ref, base) => {
    const url = new URL(ref, base);
    const pointer = decodeURIComponent(url.hash.slice(1));
    url.hash = '';
    let node: unknown = byId.get(url.href);
    for (const part of pointer.split('/').slice(1)) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    return node && typeof node === 'object' ? { schema: node as Record<string, unknown>, base: url.href } : undefined;
  };
}

/** A schema node taken from the document at `base`, with its local refs (#/...) made absolute so it can move. */
function portable(node: unknown, base: string): unknown {
  if (Array.isArray(node)) return node.map((item) => portable(item, base));
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, key === '$ref' && typeof child === 'string' && child.startsWith('#') ? base + child : portable(child, base)]));
}

/**
 * The model view of an output schema: the same schema with the value at each withheld path allowed to be a stand-in
 * instead. Returns the problem instead when a path doesn't lead through the schema's properties and items.
 *   1. Walk the path one part at a time; at each node, follow $refs (each target copied in, made portable), then step
 *      into properties[part], and into items for a part ending in [].
 *   2. Replace the leaf with a string matching WITHHELD_PATTERN.
 * Nodes off the path are left as they are, refs and all.
 */
export function modelViewSchema(doc: Record<string, unknown>, id: string, paths: readonly string[], resolve: SchemaResolver): Record<string, unknown> | { problem: string } {
  const base = String(doc.$id);
  let root: Record<string, unknown> = { ...doc, $id: id, title: `${String(doc.title ?? 'output')} (as the model sees it)` };
  delete root.examples;
  // A node with any $ref chain followed and copied in.
  const inline = (node: Record<string, unknown>, nodeBase: string): Record<string, unknown> | undefined => {
    let current = node;
    let currentBase = nodeBase;
    for (let hops = 0; typeof current.$ref === 'string'; hops++) {
      if (hops > 10) return undefined;
      const target = resolve(current.$ref, currentBase);
      if (!target) return undefined;
      const { $ref: _followed, ...rest } = current;
      current = { ...(portable(target.schema, target.base) as Record<string, unknown>), ...rest };
      currentBase = target.base;
    }
    return current;
  };
  for (const path of paths) {
    // 1. The walk, rebuilding each node on the way down.
    const rebuild = (node: Record<string, unknown>, parts: string[]): Record<string, unknown> | string => {
      if (!parts.length) return { type: 'string', pattern: WITHHELD_PATTERN };
      const [part = '', ...rest] = parts;
      const isArray = part.endsWith('[]');
      const key = isArray ? part.slice(0, -2) : part;
      const object = inline(node, base);
      const property = object && (object.properties as Record<string, Record<string, unknown>> | undefined)?.[key];
      if (!object || !property) return `${path}: no property ${key}`;
      let replacement: Record<string, unknown> | string;
      if (isArray) {
        const array = inline(property, base);
        const items = array?.items as Record<string, unknown> | undefined;
        if (!array || !items) return `${path}: ${key} isn't an array`;
        const inner = rebuild(items, rest);
        if (typeof inner === 'string') return inner;
        replacement = { ...array, items: inner };
      } else {
        const inner = rebuild(property, rest);
        if (typeof inner === 'string') return inner;
        replacement = inner;
      }
      return { ...object, properties: { ...(object.properties as object), [key]: replacement } };
    };
    // 2. The leaf is replaced inside rebuild, once the parts run out.
    const rebuilt = rebuild(root, path.split('.'));
    if (typeof rebuilt === 'string') return { problem: rebuilt };
    root = rebuilt;
  }
  return root;
}

/** Every property name in a schema, at any depth, following $refs (each target once). */
export function propertyNames(doc: Record<string, unknown>, resolve: SchemaResolver): string[] {
  const names = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (node: unknown, base: string): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach((child) => visit(child, base));
    const record = node as Record<string, unknown>;
    if (typeof record.$ref === 'string') {
      const target = resolve(record.$ref, base);
      if (target) visit(target.schema, target.base);
    }
    if (record.properties && typeof record.properties === 'object') for (const name of Object.keys(record.properties)) names.add(name);
    for (const child of Object.values(record)) visit(child, base);
  };
  visit(doc, String(doc.$id));
  return [...names];
}
