// Generates contract/generated/ from the schemas:
//   types.ts         TypeScript types for every schema and shared definition
//   validators.js    precompiled validators (Ajv standalone code: no eval or new Function at runtime)
//   validators.d.ts  typed declarations for validators.js
// The output is deterministic, so it's committed and checked.
// Usage: node contract/scripts/generate.ts [--check]
//   --check  exit 1 if the committed files differ from a fresh generation
import { compile } from 'json-schema-to-typescript';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AJV_OPTIONS, listSchemas, type SchemaFile } from '../src/load.ts';
import { defName, typeName, validatorName } from '../src/names.ts';

const outDir = fileURLToPath(new URL('../generated/', import.meta.url));
const check = process.argv.includes('--check');
const BANNER = '// Generated from contract/schemas by contract/scripts/generate.ts. Do not edit; run `npm run generate`.\n';

const schemas = listSchemas();

// ---------------------------------------------------------------- types.ts
// json-schema-to-typescript gets one combined document: every schema and shared definition becomes
// a named $defs entry, and every $ref (across files or local) points into it.
function resolveRef(ref: string, rel: string): string {
  const [file, pointer] = ref.split('#') as [string, string | undefined];
  const target = file ? file.replace(/^\/schemas\//, '') : rel;
  const def = pointer?.match(/^\/\$defs\/(.+)$/)?.[1];
  return `#/$defs/${def ? defName(target, def) : typeName(target)}`;
}

function rewrite(node: unknown, rel: string): unknown {
  if (Array.isArray(node)) return node.map((n) => rewrite(n, rel));
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'examples' || k === '$schema' || k === '$id') continue;
    out[k] = k === '$ref' && typeof v === 'string' ? resolveRef(v, rel) : rewrite(v, rel);
  }
  return out;
}

const defs: Record<string, unknown> = {};
const addDef = (name: string, schema: unknown) => {
  if (defs[name]) throw new Error(`Duplicate type name ${name}`);
  defs[name] = schema;
};
for (const s of schemas) {
  const { $defs, title, description, ...root } = s.doc as Record<string, any>;
  for (const [key, def] of Object.entries($defs ?? {})) addDef(defName(s.rel, key), { ...(rewrite(def, s.rel) as object), title: defName(s.rel, key) });
  if (s.rel === 'common.json') continue;
  addDef(typeName(s.rel), {
    ...(rewrite(root, s.rel) as object),
    title: typeName(s.rel),
    description: [title, description].filter(Boolean).join('. '),
  });
}

const typesTs = (await compile(
  { title: 'ContractTypes', type: 'object', additionalProperties: false, $defs: defs } as never,
  'ContractTypes',
  { bannerComment: '', unreachableDefinitions: true, strictIndexSignatures: true, additionalProperties: false, format: true, style: { singleQuote: true } },
)).replace(/export interface ContractTypes \{\}\n*/, '');

// ---------------------------------------------------------------- validators.js and validators.d.ts
// allErrors is off here: at runtime the first reason is enough, and the code is much smaller.
const ajv = new Ajv2020({ ...AJV_OPTIONS, allErrors: false, code: { source: true, esm: true } });
for (const s of schemas) ajv.addSchema(s.doc);
const exported = schemas.filter((s) => s.rel !== 'common.json').map((s: SchemaFile) => ({ fn: validatorName(s.rel), type: typeName(s.rel), id: s.doc.$id as string, rel: s.rel }));
const validatorsJs = standaloneCode(ajv, Object.fromEntries(exported.map((e) => [e.fn, e.id])));

// The validators must be self-contained: they run inside web pages, JavaScriptCore and QuickJS.
const forbidden = [/\brequire\(/, /^\s*import\s/m, /\bnew Function\b/, /\beval\(/].filter((re) => re.test(validatorsJs));
if (forbidden.length) {
  console.error(`Generated validators must not match ${forbidden.join(', ')}. Change the schemas so Ajv can inline the check.`);
  process.exit(1);
}

const validatorsDts = [
  `import type { ${exported.map((e) => e.type).join(', ')} } from './types.ts';`,
  '',
  'export interface ValidationError {',
  '  instancePath: string;',
  '  schemaPath: string;',
  '  keyword: string;',
  '  params: Record<string, unknown>;',
  '  message?: string;',
  '}',
  '',
  '/** Returns true when data matches the schema, and narrows its type. On false, the reasons are in .errors. */',
  'export interface Validator<T> {',
  '  (data: unknown): data is T;',
  '  errors?: ValidationError[] | null;',
  '}',
  '',
  ...exported.map((e) => `/** contract/schemas/${e.rel} */\nexport declare const ${e.fn}: Validator<${e.type}>;`),
  '',
].join('\n');

// ---------------------------------------------------------------- write or check
const files: Record<string, string> = {
  'types.ts': BANNER + typesTs,
  'validators.js': BANNER + validatorsJs + '\n',
  'validators.d.ts': BANNER + validatorsDts,
};
if (check) {
  const stale = Object.entries(files).filter(([name, text]) => {
    const p = path.join(outDir, name);
    return !existsSync(p) || readFileSync(p, 'utf8') !== text;
  }).map(([name]) => name);
  if (stale.length) {
    console.error(`Generated code is stale: ${stale.join(', ')}. Run \`npm run generate\` and commit the result.`);
    process.exit(1);
  }
  console.log('Generated code is up to date.');
} else {
  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(outDir, name), text);
  const kb = (s: string) => `${Math.round(Buffer.byteLength(s) / 1024)} KB`;
  console.log(`Wrote ${Object.keys(defs).length} types (${kb(files['types.ts']!)}) and ${exported.length} validators (${kb(files['validators.js']!)}) to ${path.relative(process.cwd(), outDir)}`);
}
