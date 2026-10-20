// Tests: core.js's rules on Carvana's real data, with no tools running: the estimated-total formula, the search and
// vehicle links, review text after the sanitizer, and the checks on filter values and car IDs.
// How: direct calls on Carvana's site pack, its fixtures and its saved conversations.
// Passes when: each value equals what Carvana's own site shows or what the saved conversation holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SitePack } from '../../../platform/contract/generated/types.ts';
import { checkToolCall, computeDerived, deepLink, effectivePolicy, fence, IdSet } from '../../../platform/core/src/index.ts';
import { loadConversations } from '../../../platform/testkit/src/conversations.ts';
import { loadFixtures } from '../../../platform/testkit/src/fixtures.ts';

const pack = JSON.parse(readFileSync(new URL('../generated/site.json', import.meta.url), 'utf8')) as SitePack;
const fixtures = loadFixtures('carvana');
const fixtureById = (id: string) => fixtures.find((fixture) => fixture.id === id)!;
const conversation = (id: string) => loadConversations('carvana').find((example) => example.id === id)!;
const outputOf = (id: string, call: string): any => {
  for (const message of conversation(id).messages) if (message.type === 'results') for (const result of message.results) if (result.id === call && result.ok) return result.output;
  throw new Error(`no result for ${call} in ${id}`);
};
const NOW = Date.parse('2026-10-08T19:15:00Z');

// The link phase 0 opened live: it showed the 540 AWD Model Y cars.
const PHASE0_LINK = 'https://www.carvana.com/cars/filters?cvnaid=eyJmaWx0ZXJzIjp7Im1ha2VzIjpbeyJuYW1lIjoiVGVzbGEiLCJwYXJlbnRNb2RlbHMiOlt7Im5hbWUiOiJNb2RlbCBZIn1dfV0sImRyaXZlVHlwZXMiOlsiQXdkIl19fQ==';

test('estimated total: price plus estimated taxes and fees, for every car in every recorded search', () => {
  let cars = 0;
  for (const fixture of fixtures.filter((candidate) => candidate.endpoint === 'search' && candidate.kind === 'recorded')) {
    for (const vehicle of (fixture.response.body as any).inventory.vehicles) {
      assert.deepEqual(computeDerived(pack, 'vehicle', vehicle), { estimatedTotal: vehicle.price.total + vehicle.price.estimatedTaxesAndFees }, String(vehicle.vehicleId));
      cars++;
    }
  }
  assert.ok(cars > 100, `${cars} cars`);
  const car = (fixtureById('search-06').response.body as any).inventory.vehicles.find((vehicle: any) => vehicle.vehicleId === 4812031);
  assert.equal(computeDerived(pack, 'vehicle', car).estimatedTotal, 39427);
});

test('search links: match the one checked live in phase 0, and the conversations', () => {
  const filters = { makes: [{ name: 'Tesla', parentModels: [{ name: 'Model Y' }] }], driveTypes: ['Awd'] };
  assert.deepEqual(deepLink(pack, 'search', { cvnaid: { filters } }), { ok: true, url: PHASE0_LINK });
  const search = outputOf('goal-to-ranked-list', 'call_1');
  const recorded = (fixtureById('search-06').request.body as any).filters;
  assert.deepEqual(deepLink(pack, 'search', { cvnaid: { filters: recorded } }), { ok: true, url: search.searchLink });
  for (const vehicle of search.vehicles) assert.deepEqual(deepLink(pack, 'vehicle', { vehicleId: vehicle.vehicleId }), { ok: true, url: vehicle.deepLink });
});

test('review text: what the sanitizer makes of the recorded reviews, as in the car-on-screen conversation', () => {
  const recorded = (fixtureById('reviews-01').response.body as any).reviews.map((review: any) => fence(review.review_text, 'carvana-reviews'));
  assert.deepEqual(outputOf('car-on-screen', 'call_2').reviews.map((review: any) => review.text), recorded);
});

test("filter check: values must be ones Carvana's facets offer, in Carvana's wording", () => {
  const ctx = { pack, policy: effectivePolicy(pack).policy, ids: new IdSet(pack.entities), now: NOW, responses: { facets: fixtureById('facets-06').response.body } };
  assert.equal(checkToolCall(ctx, 'search_vehicles', { zip5: '94402', make: 'Tesla', colors: ['Gray'], interior_colors: ['Black'], drive_types: ['Awd'] }), null);
  const error = checkToolCall(ctx, 'search_vehicles', { zip5: '94402', make: 'Tesla', colors: ['Grey'] });
  assert.equal(error?.reason, 'invalid_filter_value');
  assert.match(error!.message, /^'Grey' isn't one of the colors offered here\. Valid options: .*\bGray\b/);
  assert.equal(checkToolCall(ctx, 'search_vehicles', { zip5: '94402', drive_types: ['AWD'] })?.reason, 'invalid_filter_value', 'values are matched exactly');
});

test('quote IDs: the car must be one the session has seen, from the page or from a result', () => {
  const ids = new IdSet(pack.entities);
  const ctx = { pack, policy: effectivePolicy(pack).policy, ids, now: NOW };
  assert.equal(checkToolCall(ctx, 'get_vehicle_quote', { vehicleId: 4812031, zip5: '94402' })?.reason, 'unknown_id');
  ids.learn('vehicle', 4812031);
  assert.equal(checkToolCall(ctx, 'get_vehicle_quote', { vehicleId: 4812031, zip5: '94402' }), null);
});
