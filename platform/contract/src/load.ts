// Loads the platform schemas and the site packs' schemas into one Ajv instance (JSON Schema 2020-12, strict mode),
// and checks each site.yaml against the site-pack schema. Shared by the contract check, the generator and the testkit.
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSites, readSite, type Site } from './site-pack.ts';

export const BASE = 'https://intent-agent.invalid/';
export const platformSchemaDir = fileURLToPath(new URL('../schemas/', import.meta.url));

export interface SchemaFile {
  file: string;
  /** Path relative to the schemas folder it lives in. */
  rel: string;
  /** The $id this file must have. */
  id: string;
  doc: { $id?: string; examples?: unknown[] } & Record<string, unknown>;
}

/** Every schema under dir; idPrefix is "schemas/" for the platform and "sites/<id>/schemas/" for a site. */
export function listSchemas(dir: string, idPrefix: string): SchemaFile[] {
  if (!existsSync(dir)) return [];
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') ? [path.join(d, e.name)] : []);
  return walk(dir).sort().map((file) => {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    return { file, rel, id: BASE + idPrefix + rel, doc: JSON.parse(readFileSync(file, 'utf8')) };
  });
}

/**
 * Ajv options shared by this loader and the generated validators, so both give the same verdicts.
 * The schemas avoid format, minLength and maxLength (length limits are patterns) so the generated
 * validators need no runtime helper.
 */
export const AJV_OPTIONS = { strict: true, allowUnionTypes: true } as const;

export interface LoadedSite extends Site {
  schemas: SchemaFile[];
}

export interface Contract {
  ajv: Ajv2020;
  platform: SchemaFile[];
  sites: Record<string, LoadedSite>;
  /** A platform schema's validator, by its path under platform/contract/schemas. */
  validator(rel: string): ValidateFunction;
  /** A site schema's validator, by its path under sites/<id>/schemas. */
  siteValidator(site: string, rel: string): ValidateFunction;
}

export function loadContract(options: { sites?: string[] } = {}): Contract {
  const ajv = new Ajv2020({ ...AJV_OPTIONS, allErrors: true });
  const platform = listSchemas(platformSchemaDir, 'schemas/');
  for (const s of platform) ajv.addSchema(s.doc);

  const get = (id: string) => {
    const v = ajv.getSchema(id);
    if (!v) throw new Error(`No contract schema ${id}`);
    return v;
  };
  const validatePack = get(BASE + 'schemas/site-pack.json');

  const sites: Record<string, LoadedSite> = {};
  for (const id of options.sites ?? listSites()) {
    const site = readSite(id);
    if (!validatePack(site.pack)) throw new Error(`sites/${id}/site.yaml doesn't match the site-pack format: ${describeErrors(validatePack.errors)}`);
    const schemas = listSchemas(site.schemasDir, `sites/${id}/schemas/`);
    for (const s of schemas) ajv.addSchema(s.doc);
    sites[id] = { ...site, schemas };
  }

  return {
    ajv,
    platform,
    sites,
    validator: (rel) => get(BASE + 'schemas/' + rel),
    siteValidator: (site, rel) => get(`${BASE}sites/${site}/schemas/${rel}`),
  };
}

/** Short, readable summary of Ajv errors. */
export function describeErrors(errors: ValidateFunction['errors']): string {
  return (errors ?? []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ');
}
