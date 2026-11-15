// Tests: personal data in tool results (src/privacy.ts and src/model-view.ts, sign-in mode): which output paths stay on the device, the
// model view of an output schema the brain checks the model's copy against, and what the brain may keep.
// How: small hand-written schemas and outputs, and every site pack with a tool that needs sign-in.
// Passes when: card-only fields and private IDs are withheld; the model view accepts a stand-in only where a value is
// withheld, following $refs across documents; a path that doesn't fit the schema is reported; memory replaces personal
// values and keeps account ones, traces replace both, and nothing else is touched; the pack checks require privacy on
// every signed-in tool and one level per field; and a signed-in tool's output can't have a field it must never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { AJV_OPTIONS, loadContract, modelViews } from '../src/load.ts';
import { modelViewSchema, schemaResolver } from '../src/model-view.ts';
import { valuesAt } from '../src/paths.ts';
import { PERSONAL_PLACEHOLDER, isNeverRead, isWithheld, mapAt, modelOutputSchema, outputSchemaForModel, redact, REDACTED_IN, withheldPaths } from '../src/privacy.ts';
import { crossCheck, entriesOf, listSites, readSite } from '../src/site-pack.ts';

const BASE = 'https://schemas.example/';
const common = {
  $id: `${BASE}common.json`,
  $defs: { Locator: { type: 'string', pattern: '^[A-Z0-9]{6}$' }, Trip: { $ref: '#/$defs/TripBody' }, TripBody: { type: 'object', properties: { locator: { $ref: '#/$defs/Locator' }, route: { type: 'string' } }, required: ['locator', 'route'], additionalProperties: false } },
};
const output = {
  $id: `${BASE}trips.output.json`, type: 'object',
  properties: { trips: { type: 'array', items: { $ref: '/common.json#/$defs/Trip' } }, ticket: { type: 'string', pattern: '^[0-9]{13}$' } },
  required: ['trips'], additionalProperties: false, examples: [{ trips: [] }],
};

test('the model view lets a withheld value be a stand-in, follows $refs across documents, and checks everything else as before', () => {
  const view = modelViewSchema(output, `${BASE}trips.output.model.json`, ['trips[].locator', 'ticket'], schemaResolver([common, output]));
  assert.ok(!('problem' in view));
  const ajv = new Ajv2020({ ...AJV_OPTIONS });
  ajv.addSchema(common);
  const validate = ajv.compile(view);
  assert.equal(validate({ trips: [{ locator: 'withheld:1', route: 'SFO to SEA' }], ticket: 'withheld:2' }), true);
  assert.equal(validate({ trips: [{ locator: 'Q7K2LM', route: 'SFO to SEA' }] }), false, 'a real value is refused where the model gets a stand-in');
  assert.equal(validate({ trips: [{ locator: 'withheld:1' }] }), false, 'the rest of the schema still applies');
  assert.equal(validate({ trips: [{ locator: 'withheld:1', route: 'x' }], ticket: '1234567890123' }), false);
  assert.equal('examples' in view, false, 'examples with real-looking values are left out');
});

test("a withheld path that doesn't fit the schema is reported, not ignored", () => {
  const resolve = schemaResolver([common, output]);
  assert.deepEqual(modelViewSchema(output, 'x', ['trips[].pnr'], resolve), { problem: 'trips[].pnr: no property pnr' });
  assert.deepEqual(modelViewSchema(output, 'x', ['ticket[].number'], resolve), { problem: "ticket[].number: ticket isn't an array" });
});

test('mapAt changes only the values at the path, in a copy', () => {
  const value = { trips: [{ locator: 'A', route: 'r' }, { locator: 'B' }], other: 1 };
  const changed = mapAt(value, 'trips[].locator', (found) => `<${String(found)}>`);
  assert.deepEqual(changed, { trips: [{ locator: '<A>', route: 'r' }, { locator: '<B>' }], other: 1 });
  assert.deepEqual(value.trips[0], { locator: 'A', route: 'r' }, 'the original is untouched');
  assert.deepEqual(mapAt(value, 'missing[].x', () => 'y'), value);
  assert.ok(isWithheld('withheld:12') && !isWithheld('withheld:') && !isWithheld('Q7K2LM'));
});

// Every pack with a tool that needs sign-in: the platform's rules run on each.
const signedIn = listSites().flatMap((site) => entriesOf(readSite(site).pack.tools).filter(([, tool]) => tool.signIn).map(([name]) => ({ site, name })));

test('there is a site pack with a signed-in tool, so the privacy rules run on at least one', () => {
  assert.ok(signedIn.length > 0);
});

for (const { site, name } of signedIn) {
  test(`${site}/${name}: memory replaces personal values, traces replace account ones too, and withheld paths have a model view`, () => {
    const contract = loadContract({ sites: [site] });
    const { pack } = contract.sites[site]!;
    const tool = pack.tools[name]!;
    const withheld = withheldPaths(pack, name);
    assert.equal(outputSchemaForModel(pack, name), withheld.length ? modelOutputSchema(tool) : tool.output);
    if (withheld.length) assert.ok(contract.siteValidator(site, modelOutputSchema(tool)), 'the model view is loaded');
    const example = (contract.sites[site]!.schemas.find((schema) => schema.rel === tool.output)!.doc.examples ?? [])[0];
    assert.ok(example, `${tool.output} has an example`);
    for (const [record, levels] of Object.entries(REDACTED_IN)) {
      const redacted = redact(pack, name, example, levels);
      for (const level of ['account', 'personal'] as const) {
        for (const path of tool.privacy?.[level] ?? []) {
          const expected: unknown[] = (levels as readonly string[]).includes(level) ? valuesAt(example, path).map(() => PERSONAL_PLACEHOLDER) : valuesAt(example, path);
          assert.deepEqual(valuesAt(redacted, path), expected, `${record}: ${level} ${path}`);
        }
      }
    }
    assert.deepEqual(REDACTED_IN, { memory: ['personal'], traces: ['personal', 'account'] }, "memory keeps account data so the user needn't repeat themselves");
  });
}

test('the pack checks: a signed-in tool must declare its privacy, and a field has one level', () => {
  const { site, name } = signedIn[0]!;
  const loaded = readSite(site);
  const withTool = (tool: object) => crossCheck({ ...loaded, pack: { ...loaded.pack, tools: { ...loaded.pack.tools, [name]: tool as never } } }).map((problem) => problem.slice(problem.indexOf(': ') + 2));
  const { privacy: _privacy, ...bare } = loaded.pack.tools[name]!;
  assert.deepEqual(withTool(bare), [`tools.${name}: needs sign-in, so it needs privacy (account, personal and cardOnly fields; {} if none)`]);
  assert.deepEqual(withTool({ ...bare, privacy: {} }), []);
  assert.deepEqual(withTool({ ...bare, privacy: { personal: ['a.b'], cardOnly: ['a.b'] } }), [`tools.${name}.privacy: a.b is both personal and cardOnly; give it one level, the stricter`]);
  assert.deepEqual(withTool({ ...bare, privacy: { account: ['a.b'], personal: ['a.b'] } }), [`tools.${name}.privacy: a.b is both account and personal; give it one level, the stricter`]);
});

test('never read: secrets and identity documents are recognized however they are spelled, and ordinary names are not', () => {
  for (const name of ['password', 'dateOfBirth', 'date_of_birth', 'DOB', 'passportNumber', 'known-traveler-number', 'cvv', 'securityAnswers']) assert.ok(isNeverRead(name), name);
  for (const name of ['route', 'departs', 'balance', 'pinned', 'passengers', 'cardTitle']) assert.ok(!isNeverRead(name), name);
});

test("a signed-in tool whose output has a field it must never read stops the load, at any depth; a signed-out tool's output isn't checked", () => {
  const { site, name } = signedIn[0]!;
  const contract = loadContract({ sites: [site] });
  const loaded = readSite(site);
  const own = contract.sites[site]!.schemas.filter((schema) => !schema.derived);
  const tool = loaded.pack.tools[name]!;
  const withSecret = own.map((schema) => (schema.rel !== tool.output ? schema : {
    ...schema, doc: { ...schema.doc, properties: { ...(schema.doc.properties as object), holder: { type: 'object', properties: { date_of_birth: { type: 'string' } } } } },
  }));
  assert.doesNotThrow(() => modelViews(site, loaded, own, contract.platform));
  assert.throws(() => modelViews(site, loaded, withSecret, contract.platform), new RegExp(`tools\\.${name}: its output has date_of_birth, which a signed-in tool must never read`));
  const signedOut = { ...loaded, pack: { ...loaded.pack, tools: { ...loaded.pack.tools, [name]: { ...tool, signIn: false } } } };
  assert.doesNotThrow(() => modelViews(site, signedOut, withSecret, contract.platform));
});
