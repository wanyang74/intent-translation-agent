// core.js on Carvana's real data: the estimated total, the search and vehicle links, review text, and the checks on
// filter values and car IDs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SitePack } from '../../../platform/contract/generated/types.ts';
import { checkToolCall, computeDerived, deepLink, effectivePolicy, fence, IdSet } from '../../../platform/core/src/index.ts';
import { loadConversations } from '../../../platform/testkit/src/conversations.ts';
import { loadFixtures } from '../../../platform/testkit/src/fixtures.ts';

const pack = JSON.parse(readFileSync(new URL('../generated/site.json', import.meta.url), 'utf8')) as SitePack;
const fixtures = loadFixtures('carvana');
const body = (id: string) => fixtures.find((f) => f.id === id)!;
const conversation = (id: string) => loadConversations('carvana').find((c) => c.id === id)!;
const outputOf = (id: string, call: string): any => {
  for (const m of conversation(id).messages) if (m.type === 'results') for (const r of m.results) if (r.id === call && r.ok) return r.output;
  throw new Error(`no result for ${call} in ${id}`);
};
const NOW = Date.parse('2026-10-08T19:15:00Z');

// The link phase 0 opened live: it showed the 540 AWD Model Y cars.
const PHASE0_LINK = 'https://www.carvana.com/cars/filters?cvnaid=eyJmaWx0ZXJzIjp7Im1ha2VzIjpbeyJuYW1lIjoiVGVzbGEiLCJwYXJlbnRNb2RlbHMiOlt7Im5hbWUiOiJNb2RlbCBZIn1dfV0sImRyaXZlVHlwZXMiOlsiQXdkIl19fQ==';

test('the estimated total is the price plus estimated taxes and fees, for every car in every recorded search', () => {
  let cars = 0;
  for (const f of fixtures.filter((x) => x.endpoint === 'search' && x.kind === 'recorded')) {
    for (const v of (f.response.body as any).inventory.vehicles) {
      assert.deepEqual(computeDerived(pack, 'vehicle', v), { estimatedTotal: v.price.total + v.price.estimatedTaxesAndFees }, String(v.vehicleId));
      cars++;
    }
  }
  assert.ok(cars > 100, `${cars} cars`);
  const car = (body('search-06').response.body as any).inventory.vehicles.find((v: any) => v.vehicleId === 4812031);
  assert.equal(computeDerived(pack, 'vehicle', car).estimatedTotal, 39427);
});

test('search links match the one checked live in phase 0, and the conversations', () => {
  const filters = { makes: [{ name: 'Tesla', parentModels: [{ name: 'Model Y' }] }], driveTypes: ['Awd'] };
  assert.deepEqual(deepLink(pack, 'search', { cvnaid: { filters } }), { ok: true, url: PHASE0_LINK });
  const search = outputOf('goal-to-ranked-list', 'call_1');
  const recorded = (body('search-06').request.body as any).filters;
  assert.deepEqual(deepLink(pack, 'search', { cvnaid: { filters: recorded } }), { ok: true, url: search.searchLink });
  for (const v of search.vehicles) assert.deepEqual(deepLink(pack, 'vehicle', { vehicleId: v.vehicleId }), { ok: true, url: v.deepLink });
});

test('review text in the car-on-screen conversation is what the sanitizer makes of the recorded reviews', () => {
  const recorded = (body('reviews-01').response.body as any).reviews.map((r: any) => fence(r.review_text, 'carvana-reviews'));
  assert.deepEqual(outputOf('car-on-screen', 'call_2').reviews.map((r: any) => r.text), recorded);
});

test("filter values must be ones Carvana's facets offer, and the error uses Carvana's wording", () => {
  const ctx = { pack, policy: effectivePolicy(pack).policy, ids: new IdSet(pack.entities), now: NOW, responses: { facets: body('facets-06').response.body } };
  assert.equal(checkToolCall(ctx, 'search_vehicles', { zip5: '94402', make: 'Tesla', colors: ['Gray'], interior_colors: ['Black'], drive_types: ['Awd'] }), null);
  const e = checkToolCall(ctx, 'search_vehicles', { zip5: '94402', make: 'Tesla', colors: ['Grey'] });
  assert.equal(e?.reason, 'invalid_filter_value');
  assert.match(e!.message, /^'Grey' isn't one of the colors offered here\. Valid options: .*\bGray\b/);
  assert.equal(checkToolCall(ctx, 'search_vehicles', { zip5: '94402', drive_types: ['AWD'] })?.reason, 'invalid_filter_value', 'values are matched exactly');
});

test('a quote needs a car the session has seen, from the page the user is on or from a result', () => {
  const ids = new IdSet(pack.entities);
  const ctx = { pack, policy: effectivePolicy(pack).policy, ids, now: NOW };
  assert.equal(checkToolCall(ctx, 'get_vehicle_quote', { vehicleId: 4812031, zip5: '94402' })?.reason, 'unknown_id');
  ids.learn('vehicle', 4812031);
  assert.equal(checkToolCall(ctx, 'get_vehicle_quote', { vehicleId: 4812031, zip5: '94402' }), null);
});
