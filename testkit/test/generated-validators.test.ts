// The generated validators give the same verdict as the runtime validator on every fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as generated from '../../contract/generated/validators.js';
import { loadContract } from '../../contract/src/load.ts';
import { validatorName } from '../../contract/src/names.ts';
import { loadFixtures, requestValue } from '../src/fixtures.ts';

const validators = generated as unknown as Record<string, (data: unknown) => boolean>;
const { validator } = loadContract();

test('generated and runtime validators agree on every fixture request and 200 response', () => {
  let compared = 0;
  for (const f of loadFixtures()) {
    const pairs: [string, unknown][] = [[`carvana/${f.endpoint}.request.json`, requestValue(f.request)]];
    if (f.response.status === 200) pairs.push([`carvana/${f.endpoint}.response.json`, f.response.body]);
    for (const [rel, data] of pairs) {
      assert.equal(validators[validatorName(rel)]!(data), validator(rel)(data), `${f.id} ${rel}`);
      compared++;
    }
  }
  assert.ok(compared > 70, `compared ${compared}`);
});
