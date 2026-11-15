// Tests: personal data in tool results (src/privacy.ts and src/model-view.ts, sign-in mode): which output paths stay on the device, the
// model view of an output schema the brain checks the model's copy against, and what the brain may keep.
// How: small hand-written schemas and outputs, and every site pack with a tool that needs sign-in.
// Passes when: card-only fields and private IDs are withheld; the model view accepts a stand-in only where a value is
// withheld, following $refs across documents; a path that doesn't fit the schema is reported; personal values are
// replaced for logs and nothing else is; and the pack checks require privacy on every signed-in tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { AJV_OPTIONS, loadContract } from '../src/load.ts';
import { modelViewSchema, schemaResolver } from '../src/model-view.ts';
import { PERSONAL_PLACEHOLDER, isWithheld, mapAt, modelOutputSchema, outputSchemaForModel, redactPersonal, withheldPaths } from '../src/privacy.ts';
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
  test(`${site}/${name}: personal values are replaced for logs, withheld paths have a model view, and the rest is kept`, () => {
    const contract = loadContract({ sites: [site] });
    const { pack } = contract.sites[site]!;
    const tool = pack.tools[name]!;
    const withheld = withheldPaths(pack, name);
    assert.equal(outputSchemaForModel(pack, name), withheld.length ? modelOutputSchema(tool) : tool.output);
    if (withheld.length) assert.ok(contract.siteValidator(site, modelOutputSchema(tool)), 'the model view is loaded');
    const example = (contract.sites[site]!.schemas.find((schema) => schema.rel === tool.output)!.doc.examples ?? [])[0];
    assert.ok(example, `${tool.output} has an example`);
    const redacted = JSON.stringify(redactPersonal(pack, name, example));
    for (const path of tool.privacy?.personal ?? []) {
      const before: string = JSON.stringify(mapAt(example, path, () => PERSONAL_PLACEHOLDER));
      assert.equal(redacted.includes(PERSONAL_PLACEHOLDER), before.includes(PERSONAL_PLACEHOLDER), `${path} is replaced`);
    }
  });
}

test('the pack checks: a signed-in tool must declare its privacy, and a field is personal or card-only, not both', () => {
  const { site, name } = signedIn[0]!;
  const loaded = readSite(site);
  const withTool = (tool: object) => crossCheck({ ...loaded, pack: { ...loaded.pack, tools: { ...loaded.pack.tools, [name]: tool as never } } }).map((problem) => problem.slice(problem.indexOf(': ') + 2));
  const { privacy: _privacy, ...bare } = loaded.pack.tools[name]!;
  assert.deepEqual(withTool(bare), [`tools.${name}: needs sign-in, so it needs privacy (personal and cardOnly fields; {} if none)`]);
  assert.deepEqual(withTool({ ...bare, privacy: {} }), []);
  assert.deepEqual(withTool({ ...bare, privacy: { personal: ['a.b'], cardOnly: ['a.b'] } }), [`tools.${name}.privacy: a.b is both personal and cardOnly; cardOnly already keeps it from the brain`]);
});
