// Tests: Carvana's tools (sites/carvana/tools.ts) run by core.js, end to end on the client: the requests they send
// and how their results read on screen.
// How: core.js's Execute and Respond with FakeHost answering from Carvana's fixtures; some tests inject faults.
// Passes when: each request carries what Carvana needs and nothing more (decision D4); each failure the fixtures
// cover becomes the right error; bad filters and sorts are refused before any request; the rate limit holds; and
// cards and the detail view read the way Carvana shows cars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostRequest } from '../../../platform/core/src/runtime/host.ts';
import { present, runToolCall, startSession } from '../../../platform/core/src/index.ts';
import { loadConversations } from '../../../platform/testkit/src/conversations.ts';
import { loadFixtures, type Fixture } from '../../../platform/testkit/src/fixtures.ts';
import { loadSiteRuntime } from '../../../platform/testkit/src/site-runtime.ts';
import { testHost } from '../../../platform/testkit/src/test-host.ts';

const rt = await loadSiteRuntime('carvana');
const fixtures = loadFixtures('carvana');
const carPage = loadConversations('carvana').find((conversation) => conversation.id === 'car-on-screen')!.pageData;
const NOW = '2026-10-08T19:15:00Z';
const PAGE = { url: 'https://www.carvana.com/cars', pageType: 'search', location: { postalCode: '94402' } };

async function session(options: { extra?: Fixture[]; page?: object; pageData?: unknown } = {}) {
  const harness = testHost({ site: 'carvana', fixtures: [...fixtures, ...(options.extra ?? [])], start: NOW, pageData: options.pageData ?? null });
  const sent: HostRequest[] = [];
  const request = harness.host.request;
  harness.host.request = (req) => { sent.push(req); return request(req); };
  const { session: coreSession } = await startSession({ pack: rt.pack, site: rt.code, validators: rt.validators, host: harness.host });
  coreSession.setPage((options.page ?? PAGE) as never);
  return { ...harness, coreSession, sent };
}
const goalSearch = { zip5: '94402', make: 'Tesla', year_min: 2023, mileage_max: 42100, colors: ['Gray'], interior_colors: ['Black'], drive_types: ['Awd'] };
const bodyOf = (sent: HostRequest[], path: string) => JSON.parse(sent.find((request) => request.url.includes(path))!.body!);

test('tracking fields (D4): only what each endpoint needs, with one fresh visitor ID for the session', async () => {
  const { coreSession, sent } = await session();
  assert.ok((await runToolCall(coreSession, 'search_vehicles', { zip5: '94402', make: 'Tesla' })).ok);
  assert.ok((await runToolCall(coreSession, 'suggest_refinements', { zip5: '94402', current: { zip5: '94402', make: 'Tesla' } })).ok);
  assert.ok((await runToolCall(coreSession, 'get_delivery_dates', { vehicleIds: [4811903], zip5: '94402' })).ok);
  const search = bodyOf(sent, '/v2/search');
  assert.equal(search.browserCookieId, undefined);
  assert.equal(search.analyticsData, undefined);
  const suggest = bodyOf(sent, '/suggest/filters');
  assert.match(suggest.browserCookieId, /^00000000-0000-4000-9000-\d{12}$/);
  assert.deepEqual(Object.keys(suggest.analyticsData), ['clientId']);
  assert.equal(suggest.analyticsData.clientId, 'srp_ui');
  const availability = sent.find((request) => request.url.includes('soonestavailabilitybulk'))!;
  assert.equal(availability.headers.clientid, 'srp_ui');
  assert.equal(availability.headers.browsercookieid, suggest.browserCookieId, 'the same visitor ID wherever Carvana expects it');
  assert.match(availability.headers.correlationid!, /^00000000-0000-4000-9000-/);
});

test('get_vehicle_quote: sends the client ID, no visitor ID; checks GAP with the estimated total and the state', async () => {
  const { coreSession, sent } = await session({ page: { url: 'https://www.carvana.com/vehicle/4812031', pageType: 'vehicle', entity: { kind: 'vehicle', id: 4812031 }, location: { postalCode: '94402', region: 'CA' } }, pageData: carPage });
  const quote = await runToolCall(coreSession, 'get_vehicle_quote', { vehicleId: 4812031, zip5: '94402' });
  assert.ok(quote.ok);
  const pricing = bodyOf(sent, '/pricing/vehicle');
  assert.deepEqual(pricing.analyticsData, { clientId: 'vdp_ui' });
  assert.equal(pricing.browserCookieId, undefined);
  assert.equal(new URL(sent.find((request) => request.url.includes('GapWaiver'))!.url).search, '?amountFinanced=39427&homeState=CA&institutionName=Carvana&paymentType=Financing&vehicleId=4812031');
});

test('get_vehicle_quote: without a state, the GAP waiver is left out rather than guessed', async () => {
  const { coreSession, sent } = await session({ page: { url: 'https://www.carvana.com/vehicle/4812031', pageType: 'vehicle', entity: { kind: 'vehicle', id: 4812031 }, location: { postalCode: '94402' } }, pageData: carPage });
  const quote = await runToolCall(coreSession, 'get_vehicle_quote', { vehicleId: 4812031, zip5: '94402' });
  assert.deepEqual(quote.ok && quote.output.gapWaiver, null);
  assert.ok(!sent.some((request) => request.url.includes('GapWaiver')));
});

test("search errors: no matches, and a changed response shape, come back as Carvana's and the platform's errors", async () => {
  const { coreSession, log } = await session();
  const none = await runToolCall(coreSession, 'search_vehicles', { zip5: '94402', make: 'Tesla', year_min: 2026, mileage_max: 100 });
  assert.deepEqual(!none.ok && [none.error.code, none.error.reason], ['no_results', 'no_results']);
  const changed = await runToolCall(coreSession, 'search_vehicles', { zip5: '94402', make: 'Tesla', page: 30 });
  assert.deepEqual(!changed.ok && [changed.error.code, changed.error.reason], ['format_changed', 'response_changed']);
  assert.ok(log.some((entry) => entry.kind === 'response_check'), 'the change monitor will read this');
});

test('delivery failed: the dates show pickup only, and a delivery quote says to try pickup', async () => {
  const { coreSession } = await session();
  assert.ok((await runToolCall(coreSession, 'search_vehicles', { zip5: '94402', make: 'Tesla' })).ok);
  const datesOutcome = await runToolCall(coreSession, 'get_delivery_dates', { vehicleIds: [4811903], zip5: '94402' });
  assert.ok(datesOutcome.ok);
  const firstDate = (datesOutcome.output.dates as { delivery: unknown; pickup: { text: string } | null }[])[0]!;
  assert.equal(firstDate.delivery, null);
  assert.ok(firstDate.pickup);
  const quote = await runToolCall(coreSession, 'get_vehicle_quote', { vehicleId: 4811903, zip5: '94402' });
  assert.deepEqual(!quote.ok && [quote.error.reason, quote.error.message], ['option_unavailable', "delivery isn't available for car 4811903 at 94402. Try pickup instead."]);
});

test("pricing error: a car Carvana can't price at a zip code gets Carvana's error", async () => {
  const seven = fixtures.find((fixture) => fixture.id === 'availability-07')!;
  const at99701: Fixture = { ...structuredClone(seven), id: 'availability-07-at-99701', kind: 'synthetic', request: { ...structuredClone(seven.request), body: { ...(seven.request.body as object), zipCode: '99701' } } };
  const { coreSession } = await session({ extra: [at99701], page: { url: 'https://www.carvana.com/vehicle/4812031', pageType: 'vehicle', entity: { kind: 'vehicle', id: 4812031 }, location: { postalCode: '99701', region: 'AK' } }, pageData: carPage });
  const quote = await runToolCall(coreSession, 'get_vehicle_quote', { vehicleId: 4812031, zip5: '99701' });
  assert.deepEqual(!quote.ok && [quote.error.code, quote.error.reason, quote.error.message], ['upstream_error', 'pricing_error', "Carvana couldn't price this car for zip 99701. Tell the user and offer the car's page link."]);
});

test("get_vehicle_quote: a car the session has no details for can't be quoted", async () => {
  const { coreSession } = await session();
  coreSession.ids.learn('vehicle', 4812031);
  const quote = await runToolCall(coreSession, 'get_vehicle_quote', { vehicleId: 4812031, zip5: '94402' });
  assert.deepEqual(!quote.ok && quote.error.reason, 'car_unknown');
});

test('faults: network faults and status errors become retryable errors', async () => {
  for (const [fault, expected] of [[{ networkError: 'ECONNRESET' }, 'network_error'], [{ status: 429 }, 'site_rate_limited'], [{ status: 503 }, 'site_unavailable']] as const) {
    const { coreSession, fake } = await session();
    fake.inject({ endpoint: 'search', ...fault });
    const outcome = await runToolCall(coreSession, 'search_vehicles', { zip5: '94402', make: 'Tesla' });
    assert.deepEqual(!outcome.ok && [outcome.error.reason, outcome.error.retryable], [expected, true]);
  }
});

test("filter check: a value Carvana doesn't offer is refused before any search, listing the valid ones", async () => {
  const { coreSession, fake } = await session();
  const outcome = await runToolCall(coreSession, 'search_vehicles', { ...goalSearch, colors: ['Grey'] });
  assert.equal(!outcome.ok && outcome.error.reason, 'invalid_filter_value');
  assert.match(!outcome.ok ? outcome.error.message : '', /^'Grey' isn't one of the colors offered here\. Valid options: .*\bGray\b/);
  assert.deepEqual(fake.calls.map((call) => call.endpoint), ['facets'], 'only the facts needed for the check');
});

test("sort check: an order Carvana doesn't have is refused before any request, listing the ones it does", async () => {
  const { coreSession, fake } = await session();
  const outcome = await runToolCall(coreSession, 'search_vehicles', { zip5: '94085', make: 'Tesla', sort: 'PriceLow' });
  assert.equal(!outcome.ok && outcome.error.reason, 'bad_arguments');
  assert.match(!outcome.ok ? outcome.error.message : '', /\/sort must be equal to one of the allowed values: MostPopular, LowestPrice, HighestPrice, LowestMileage, NewestYear/);
  assert.deepEqual(fake.calls, [], 'nothing reached Carvana');
});

test('sorts and pages: each of Carvana\'s sort orders, and pages 2 to 4, come back as recorded', async () => {
  const totals = async (args: Record<string, unknown>) => {
    const { coreSession } = await session();
    const outcome = await runToolCall(coreSession, 'search_vehicles', { zip5: '94085', make: 'Tesla', ...args });
    assert.ok(outcome.ok, JSON.stringify(!outcome.ok && outcome.error));
    return (outcome.output as { vehicles: { year: number; mileage: number; price: number }[] }).vehicles;
  };
  const cheapest = await totals({ sort: 'LowestPrice' });
  assert.deepEqual(cheapest.map((car) => car.price), [...cheapest.map((car) => car.price)].sort((left, right) => left - right), 'cheapest first');
  const newest = await totals({ sort: 'NewestYear' });
  assert.equal(newest[0]!.year, 2026);
  const lowMileage = await totals({ sort: 'LowestMileage' });
  assert.ok(lowMileage[0]!.mileage < 5000);
  for (const page of [2, 3, 4]) assert.ok((await totals({ sort: 'NewestYear', page })).length > 0, `page ${page}`);
});

test('reviews: one written without stars has no rating, not a rating of 0', async () => {
  const { coreSession } = await session({ page: { ...PAGE, location: { postalCode: '94085' } } });
  assert.ok((await runToolCall(coreSession, 'search_vehicles', { zip5: '94085', make: 'Tesla', year_min: 2022, sort: 'LowestPrice' })).ok);
  const outcome = await runToolCall(coreSession, 'get_owner_reviews', { vehicleId: 4812262 });
  assert.ok(outcome.ok, JSON.stringify(!outcome.ok && outcome.error));
  const ratings = (outcome.output as { reviews: { rating: number | null }[] }).reviews.map((review) => review.rating);
  assert.ok(ratings.includes(null), 'the recording has reviews without stars');
  assert.ok(ratings.every((rating) => rating === null || (rating >= 1 && rating <= 5)));
});

test("rate limit: requests keep to Carvana's one per second", async () => {
  const { coreSession, slept, fake } = await session();
  assert.ok((await runToolCall(coreSession, 'search_vehicles', goalSearch)).ok);
  assert.equal(fake.calls.length, 2);
  assert.equal(slept(), 1000);
});

test('vehicle cards: read the way Carvana shows cars, with the estimated-total notice added', async () => {
  const { coreSession } = await session();
  const search = await runToolCall(coreSession, 'search_vehicles', goalSearch);
  assert.ok(search.ok);
  await runToolCall(coreSession, 'get_delivery_dates', { vehicleIds: (search.output.vehicles as { vehicleId: number }[]).map((vehicle) => vehicle.vehicleId), zip5: '94402' });
  const { components } = present(coreSession, [{ name: 'present_items', args: { entity: 'vehicle', ids: [4812031] } }]);
  assert.deepEqual(components.map((component) => component.type), ['items', 'notice']);
  const card = components[0]!.type === 'items' ? components[0]!.items[0]! : null;
  assert.deepEqual(card && [card.title, card.subtitle, card.link], ['2023 Tesla Model Y', 'Long Range · 27,689 mi', 'https://www.carvana.com/vehicle/4812031']);
  assert.deepEqual(card?.fields.map((field) => [field.label, field.text, field.estimate === true]), [['Price', '$35,590', false], ['Estimated total', '$39,427', true], ['Delivery', 'Saturday', false]]);
  assert.deepEqual(components[1], { type: 'notice', notice: 'estimated_total', text: 'Estimated total adds Carvana\'s estimated taxes and fees to the price. Final amounts are set at checkout.', version: '2026-10-12' });
});

test("detail view: the car's page details, the quote, and what owners say", async () => {
  const { coreSession } = await session({ page: { url: 'https://www.carvana.com/vehicle/4812031', pageType: 'vehicle', entity: { kind: 'vehicle', id: 4812031 }, location: { postalCode: '94402', region: 'CA' } }, pageData: carPage });
  assert.ok((await runToolCall(coreSession, 'get_vehicle_quote', { vehicleId: 4812031, zip5: '94402' })).ok);
  assert.ok((await runToolCall(coreSession, 'get_owner_reviews', { vehicleId: 4812031 })).ok);
  const [detail] = present(coreSession, [{ name: 'present_detail', args: { entity: 'vehicle', id: 4812031, sections: ['overview', 'reviews'] } }]).components;
  assert.ok(detail?.type === 'detail');
  assert.deepEqual([detail.card.title, detail.card.subtitle], ['2023 Tesla Model Y', 'Long Range · 27,689 mi']);
  const overview = Object.fromEntries(detail.sections[0]!.fields!.map((field) => [field.key, field.text]));
  assert.deepEqual(overview, { price: '$35,590', estimatedTaxesAndFees: '$3,837', estimatedTotal: '$39,427', year: '2023', trim: 'Long Range', mileage: '27,689 mi', color: 'Gray', gapWaiver: '$1,195' });
  assert.equal(detail.sections[1]!.summary, '1,221 of 1,518 owner ratings are 4 or 5 stars.');
  assert.equal(detail.sections[1]!.lines!.length, 5);
  assert.ok(!detail.sections[1]!.lines!.some((line) => line.text.includes('<untrusted')), 'the fence is for the model only');
});
