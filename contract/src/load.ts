// Loads every contract schema into one Ajv instance (JSON Schema 2020-12, strict mode).
// Shared by the contract check and the testkit's FakeHost.
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = 'https://intent-agent.invalid/schemas/';
export const schemaDir = fileURLToPath(new URL('../schemas/', import.meta.url));

export interface SchemaFile {
  file: string;
  rel: string;
  doc: { $id?: string; examples?: unknown[] } & Record<string, unknown>;
}

export function listSchemas(dir: string = schemaDir): SchemaFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const file = path.join(dir, d.name);
    if (d.isDirectory()) return listSchemas(file);
    if (!d.name.endsWith('.json')) return [];
    return [{ file, rel: path.relative(schemaDir, file).split(path.sep).join('/'), doc: JSON.parse(readFileSync(file, 'utf8')) }];
  });
}

export interface Contract {
  ajv: Ajv2020;
  schemas: SchemaFile[];
  /** The validator for a schema, by its path under contract/schemas, e.g. "carvana/search.request.json". */
  validator(rel: string): ValidateFunction;
}

export function loadContract(): Contract {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const schemas = listSchemas();
  for (const s of schemas) ajv.addSchema(s.doc);
  return {
    ajv,
    schemas,
    validator(rel) {
      const v = ajv.getSchema(BASE + rel);
      if (!v) throw new Error(`No contract schema at ${rel}`);
      return v;
    },
  };
}

/** Short, readable summary of Ajv errors. */
export function describeErrors(errors: ValidateFunction['errors']): string {
  return (errors ?? []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ');
}
