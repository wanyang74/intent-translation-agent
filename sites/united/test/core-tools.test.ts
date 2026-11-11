// Tests: United's tools run by core.js, end to end on the client, on the recorded searches: SFO to Shanghai (all
// airports) and back, Dec 22 to Jan 10, in economy, and in business or first, nonstop.
// How: core.js's Execute and Respond with FakeHost answering from United's fixtures, which need United's token on every
// call and stream the searches as United does.
// Passes when: a city's all-airports place is what the search sends; a search's flights come with fares that include
// taxes (seat add-ons left out), sorted over every flight United found; a round trip goes outbound, fare details, an
// upgraded fare, then the returns priced with it; the cheapest-dates calendar reads as dates; the token is fetched
// once; cards and notices show as the site pack says; and a fare or flight from no search on this page is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { present, runToolCall, startSession } from '../../../platform/core/src/index.ts';
import { loadFixtures } from '../../../platform/testkit/src/fixtures.ts';
import { loadSiteRuntime } from '../../../platform/testkit/src/site-runtime.ts';
import { testHost } from '../../../platform/testkit/src/test-host.ts';
import { localTime } from '../tools.ts';

const rt = await loadSiteRuntime('united');
const START = '2026-11-06T22:00:00Z';
const SHANGHAI = 'SHANGHAI (ALL AIRPORTS)';
const roundTrip = { from: 'SFO', to: SHANGHAI, departDate: '2026-12-22', returnDate: '2027-01-10', adults: 1 };
const economy = { ...roundTrip, cabin: 'economy' };
const premiumNonstop = { ...roundTrip, cabin: 'business_or_first', nonstopOnly: true };
/** The Polaris fare the recording picked on UA 857: an upgrade of the basic one, so only fare_details lists it. */
const POLARIS = '0bSXrUfWdPSSBENS4M91V800a';

async function session() {
  const harness = testHost({ site: 'united', fixtures: loadFixtures('united'), start: START });
  const { session: coreSession } = await startSession({ pack: rt.pack, site: rt.code, validators: rt.validators, host: harness.host });
  coreSession.setPage({ url: 'https://www.united.com/en/us/', pageType: 'home', locale: 'en-US' });
  return { ...harness, coreSession };
}

const output = (outcome: { ok: boolean; output?: unknown }) => {
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return outcome.output as any;
};

test("airports: a city's all-airports choice is its place for a search, by United's own name for it", async () => {
  const { coreSession } = await session();
  const { airports } = output(await runToolCall(coreSession, 'find_airport', { query: 'shanghai' }));
  assert.deepEqual(airports.map((airport: { place: string; allAirports: boolean }) => [airport.place, airport.allAirports]), [[SHANGHAI, true], ['PVG', false], ['SHA', false]]);
});

test('search: flights priced as the whole round trip with taxes, seat add-ons left out, sorted over every flight found', async () => {
  const { coreSession } = await session();
  const best = output(await runToolCall(coreSession, 'search_flights', economy));
  assert.equal(best.direction, 'outbound');
  assert.match(best.pricedAs, /whole round trip.*taxes and fees included/);
  assert.equal(best.flights[0].flightNumbers, 'UA 857', "United's own order puts the nonstop first");
  const nonstop = best.flights[0];
  assert.deepEqual([nonstop.route, nonstop.departs, nonstop.arrives, nonstop.stops, nonstop.duration], ['SFO to PVG', 'Tue, Dec 22, 12:55 PM', 'Wed, Dec 23, 6:45 PM', 0, '13h 50m']);
  // UA 857's Economy fare: $2,178 base + $900 taxes, as United lists them.
  assert.deepEqual(nonstop.fares[0], { fareId: 'GtAoefqhwB8LqKaFeruQbJ001', name: 'United Economy', totalPrice: 3078, cabin: 'Coach', refundable: false, noChangeFees: true });
  assert.ok(best.flights.every((flight: { fares: { name: string }[] }) => flight.fares.every((fare) => fare.name !== 'Economy Plus')), 'Economy Plus is a seat add-on, not a fare');

  const cheapest = output(await runToolCall(coreSession, 'search_flights', { ...economy, sortBy: 'price' }));
  const prices = cheapest.flights.map((flight: { lowestFare: number }) => flight.lowestFare);
  assert.deepEqual(prices, [...prices].sort((left, right) => left - right));
  assert.deepEqual([cheapest.flights[0].flightNumbers, cheapest.flights[0].layovers], ['UA 2409 / UA 198', ['LAX, 15h 16m']]);
  assert.equal(cheapest.totalFlights, best.totalFlights);
});

test('round trip: outbound, fare details, an upgraded fare, then the returns priced as the round trip with it', async () => {
  const { coreSession, fake } = await session();
  const outbound = output(await runToolCall(coreSession, 'search_flights', premiumNonstop));
  assert.deepEqual(outbound.flights.map((flight: { flightId: string }) => flight.flightId), ['356-857-UA']);

  const details = output(await runToolCall(coreSession, 'fare_details', { flightId: '356-857-UA' }));
  const polaris = details.fares.find((fare: { fareId: string }) => fare.fareId === POLARIS);
  assert.deepEqual(polaris, {
    fareId: POLARIS, name: 'United Polaris', totalPrice: 11640, refunds: 'Non-refundable', changes: 'No change fees', seat: 'Choose your lie-flat seat',
    lounge: 'United Polaris lounge access; United Club access', checkedBags: '2 checked bags included', carryOn: '1 carry-on bag included',
  }, "United's placeholder (NOTAPPLICABLE for upgrades) and miles earned are left out");

  const returns = output(await runToolCall(coreSession, 'return_flights', { fareId: POLARIS }));
  assert.equal(returns.direction, 'return');
  assert.deepEqual([returns.flights[0].flightNumbers, returns.flights[0].route, returns.flights[0].departs, returns.flights[0].arrives], ['UA 858', 'PVG to SFO', 'Sun, Jan 10, 1:10 PM', 'Sun, Jan 10, 8:25 AM']);
  assert.deepEqual(fake.calls.map((call) => call.fixtureId), ['token-01', 'flights-02', 'fare_details-01', 'return_flights-01'], 'one token for the whole session');
});

test("round trip: a return fare, or a fare no search on this page returned, can't list returns", async () => {
  const { coreSession, fake } = await session();
  await runToolCall(coreSession, 'search_flights', premiumNonstop);
  await runToolCall(coreSession, 'fare_details', { flightId: '356-857-UA' });
  const returns = output(await runToolCall(coreSession, 'return_flights', { fareId: POLARIS }));
  const returnFare = returns.flights[0].fares[0].fareId;
  const again = await runToolCall(coreSession, 'return_flights', { fareId: returnFare });
  assert.equal(!again.ok && again.error.reason, 'not_round_trip');

  // Known to the session (say, from a conversation reopened from memory), but this page has no search behind it.
  coreSession.ids.learn('fare', 'ZZZZZZZZZZZZZZZZZZZZZZ001');
  const orphan = await runToolCall(coreSession, 'return_flights', { fareId: 'ZZZZZZZZZZZZZZZZZZZZZZ001' });
  assert.deepEqual(!orphan.ok && [orphan.error.code, orphan.error.reason], ['expired', 'search_again']);
  assert.equal(fake.calls.length, 4, 'neither refusal reached United');
});

test('calendar: the lowest fare for each pair of dates, as dates', async () => {
  const { coreSession } = await session();
  const calendar = output(await runToolCall(coreSession, 'fare_calendar', { from: 'SFO', to: 'SHA', departDate: '2026-12-22', returnDate: '2027-01-10', adults: 1, cabin: 'economy' }));
  assert.equal(calendar.dates.length, 30);
  assert.deepEqual(calendar.dates[3], { depart: '2026-12-22', return: '2026-12-26', lowestFare: 1846.51 });
});

test('cards: a flight shows by its numbers and route, with its lowest fare and both fare notices', async () => {
  const { coreSession, clock } = await session();
  await runToolCall(coreSession, 'search_flights', economy);
  const call = { name: 'present_items' as const, args: { entity: 'flight', ids: ['356-857-UA'] as [string] } };
  const shown = present(coreSession, [call]);
  const [items, ...notices] = shown.components;
  assert.ok(items?.type === 'items');
  assert.deepEqual([items.items[0]!.title, items.items[0]!.subtitle], ['UA 857', 'SFO to PVG: Tue, Dec 22, 12:55 PM to Wed, Dec 23, 6:45 PM']);
  assert.equal(items.items[0]!.fields[0]!.text, '$3,078');
  assert.deepEqual(notices.map((notice) => notice.type === 'notice' && notice.notice), ['fares_include_taxes', 'signed_out_fares']);
  clock.advance(31 * 60_000);
  assert.deepEqual(present(coreSession, [call]).refused.map((refusal) => refusal.error.code), ['expired'], 'flights expire with their search');
});

test("destination: Take me there opens United's results page for the same search", async () => {
  const { coreSession } = await session();
  const shown = present(coreSession, [{ name: 'present_destination', args: { destination: 'flight_search', params: economy } } as never]);
  const destination = shown.components[0];
  assert.ok(destination?.type === 'destination', JSON.stringify(shown));
  assert.equal(destination.url, 'https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=SHANGHAI%20(ALL%20AIRPORTS)&d=2026-12-22&r=2027-01-10&sc=7,7&px=1&taxng=1&clm=7&st=bestmatches&tqp=R');
});

test('times: local at the airport, with the weekday, never moved to another time zone', () => {
  assert.equal(localTime('2026-12-22 00:05'), 'Tue, Dec 22, 12:05 AM');
  assert.equal(localTime('2027-01-10 13:10'), 'Sun, Jan 10, 1:10 PM');
});
