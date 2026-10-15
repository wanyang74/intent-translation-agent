// The generated validators give the same verdict as the runtime validator on every site's fixtures.
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
    for (const f of loadFixtures(site)) {
      const endpoint = pack.endpoints[f.endpoint]!;
      const pairs: [string, unknown][] = [[endpoint.request, requestValue(pack, f.request)]];
      if (f.response.status === 200 && (endpoint.responseFormat ?? 'json') === 'json') pairs.push([endpoint.response, f.response.body]);
      for (const [rel, data] of pairs) {
        assert.equal(generated[validatorName(rel)]!(data), contract.siteValidator(site, rel)(data), `${f.id} ${rel}`);
        compared++;
      }
    }
    assert.ok(compared > 0);
  });
}
