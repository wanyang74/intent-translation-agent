// Loads the platform schemas and the site packs' schemas into one Ajv instance (JSON Schema 2020-12, strict mode),
// and checks each site.yaml against the site-pack schema. Shared by the contract check, the generator and the testkit.
// A tool whose output withholds personal fields from the model also gets its output's model view (privacy.ts), as one
// more site schema, so the generator makes its validator like any other's.
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelViewSchema, propertyNames, schemaResolver } from './model-view.ts';
import { isNeverRead, modelOutputSchema, withheldPaths } from './privacy.ts';
import { entriesOf, listSites, readSite, type Site } from './site-pack.ts';

export const BASE = 'https://intent-agent.invalid/';
export const platformSchemaDir = fileURLToPath(new URL('../schemas/', import.meta.url));

export interface SchemaFile {
  file: string;
  /** Path relative to the schemas folder it lives in. */
  rel: string;
  /** The $id this file must have. */
  id: string;
  doc: { $id?: string; examples?: unknown[] } & Record<string, unknown>;
  /** Made at load time (a model view), not read from a file: no types are generated for it. */
  derived?: boolean;
}

/** Every schema under dir; idPrefix is "schemas/" for the platform and "sites/<id>/schemas/" for a site. */
export function listSchemas(dir: string, idPrefix: string): SchemaFile[] {
  if (!existsSync(dir)) return [];
  const walk = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(folder, entry.name)) : entry.name.endsWith('.json') ? [path.join(folder, entry.name)] : []);
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
  for (const schema of platform) ajv.addSchema(schema.doc);

  const get = (id: string) => {
    const validate = ajv.getSchema(id);
    if (!validate) throw new Error(`No contract schema ${id}`);
    return validate;
  };
  const validatePack = get(BASE + 'schemas/site-pack.json');

  const sites: Record<string, LoadedSite> = {};
  for (const id of options.sites ?? listSites()) {
    const site = readSite(id);
    if (!validatePack(site.pack)) throw new Error(`sites/${id}/site.yaml doesn't match the site-pack format: ${describeErrors(validatePack.errors)}`);
    const schemas = listSchemas(site.schemasDir, `sites/${id}/schemas/`);
    schemas.push(...modelViews(id, site, schemas, platform));
    for (const schema of schemas) ajv.addSchema(schema.doc);
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

/**
 * The model view of each output schema that withholds fields. A privacy path that doesn't fit the schema stops the load,
 * and so does a signed-in tool whose output has a field it must never read (NEVER_READ).
 */
export function modelViews(id: string, site: Site, schemas: SchemaFile[], platform: SchemaFile[]): SchemaFile[] {
  const resolve = schemaResolver([...platform, ...schemas].map((schema) => ({ ...schema.doc, $id: schema.id })));
  return entriesOf(site.pack.tools).flatMap(([name, tool]) => {
    const paths = withheldPaths(site.pack, name);
    const output = schemas.find((schema) => schema.rel === tool.output);
    if (!output) return [];
    // Account and personal paths aren't withheld, but they must lead to a field too, or they'd keep nothing out of the
    // brain's records.
    const kept = [...(tool.privacy?.account ?? []), ...(tool.privacy?.personal ?? [])];
    const walked = kept.length ? modelViewSchema({ ...output.doc, $id: output.id }, output.id, kept, resolve) : null;
    if (walked && 'problem' in walked) throw new Error(`sites/${id}/site.yaml: tools.${name}: an account or personal path doesn't fit the output schema: ${walked.problem}`);
    // A signed-in tool never fetches secrets or identity documents: none may be in its output, at any depth.
    const secret = tool.signIn ? propertyNames({ ...output.doc, $id: output.id }, resolve).find(isNeverRead) : undefined;
    if (secret) throw new Error(`sites/${id}/site.yaml: tools.${name}: its output has ${secret}, which a signed-in tool must never read`);
    if (!paths.length) return [];
    const rel = modelOutputSchema(tool);
    const view = modelViewSchema({ ...output.doc, $id: output.id }, BASE + `sites/${id}/schemas/` + rel, paths, resolve);
    if ('problem' in view) throw new Error(`sites/${id}/site.yaml: tools.${name}: a withheld path doesn't fit the output schema: ${view.problem}`);
    return [{ file: output.file, rel, id: BASE + `sites/${id}/schemas/` + rel, doc: view, derived: true }];
  });
}

/** Short, readable summary of Ajv errors. */
export function describeErrors(errors: ValidateFunction['errors']): string {
  return (errors ?? []).slice(0, 3).map((problem) => `${problem.instancePath || '/'} ${problem.message ?? ''}`).join('; ');
}
