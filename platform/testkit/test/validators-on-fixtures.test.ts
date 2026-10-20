// Tests: the generated validators (contract/generated/ and sites/<id>/generated/) on real data.
// How: runs the generated validator and the runtime validator on every fixture request and 200 response.
// Passes when: the two give the same verdict every time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadContract } from '../../contract/src/load.ts';
import { validatorName } from '../../contract/src/names.ts';
import { requestValue } from '../../contract/src/site-pack.ts';
import { hasFixtures, loadFixtures } from '../src/fixtures.ts';

const contract = loadContract();

for (const site of Object.keys(contract.sites).filter(hasFixtures)) {
  const { pack, dir } = contract.sites[site]!;
  const generated = await import(pathToFileURL(path.join(dir, 'generated', 'validators.js')).href) as Record<string, (data: unknown) => boolean>;

  test(`${site}: generated and runtime validators agree on every fixture request and 200 response`, () => {
    let compared = 0;
    for (const fixture of loadFixtures(site)) {
      const endpoint = pack.endpoints[fixture.endpoint]!;
      const pairs: [string, unknown][] = [[endpoint.request, requestValue(pack, fixture.request)]];
      if (fixture.response.status === 200 && (endpoint.responseFormat ?? 'json') === 'json') pairs.push([endpoint.response, fixture.response.body]);
      for (const [rel, data] of pairs) {
        assert.equal(generated[validatorName(rel)]!(data), contract.siteValidator(site, rel)(data), `${fixture.id} ${rel}`);
        compared++;
      }
    }
    assert.ok(compared > 0);
  });
}
