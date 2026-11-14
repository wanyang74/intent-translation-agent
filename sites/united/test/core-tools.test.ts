// Tests: United's tools run by core.js, end to end on the client, on the recorded searches: SFO to Shanghai (all
// airports) and back, Dec 22 to Jan 10, in economy, and in business or first, nonstop.
// How: core.js's Execute and Respond with FakeHost answering from United's fixtures, which need United's token on every
// call and stream the searches as United does.
// Passes when: a city's all-airports place is what the search sends; a search's flights come with fares that include
// taxes (seat add-ons left out), sorted over every flight United found; a round trip goes outbound, fare details, an
// upgraded fare, then the returns priced with it; a fare's card names its flight; a search's one-way or outbound fare
// gets an add-to-cart button with what the page must show, and a return fare none; the cheapest-dates calendar reads as dates; the token is fetched
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
  assert.deepEqual(nonstop.fares[0], {
    fareId: 'GtAoefqhwB8LqKaFeruQbJ001', name: 'United Economy', totalPrice: 3078, cabin: 'Coach', refundable: false, noChangeFees: true,
    flightNumbers: 'UA 857', schedule: 'SFO to PVG: Tue, Dec 22, 12:55 PM to Wed, Dec 23, 6:45 PM',
  });
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
    fareId: POLARIS, name: 'United Polaris', flightNumbers: 'UA 857', schedule: 'SFO to PVG: Tue, Dec 22, 12:55 PM to Wed, Dec 23, 6:45 PM', totalPrice: 11640, refunds: 'Non-refundable', changes: 'No change fees', seat: 'Choose your lie-flat seat',
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

test('cards: fares on different flights share a name, so a fare card leads with its flight; bags and refunds wait for fare_details', async () => {
  const { coreSession } = await session();
  const { flights } = output(await runToolCall(coreSession, 'search_flights', economy));
  const [first, second] = flights.filter((flight: { fares: { name: string }[] }) => flight.fares.some((fare) => fare.name === 'United Economy'));
  const fareIds = [first, second].map((flight) => flight.fares.find((fare: { name: string }) => fare.name === 'United Economy').fareId) as [string, string];
  const shown = present(coreSession, [{ name: 'present_items' as const, args: { entity: 'fare', ids: fareIds } }]);
  const items = shown.components[0];
  assert.ok(items?.type === 'items', JSON.stringify(shown));
  assert.deepEqual(items.items.map((item) => item.title), [`${first.flightNumbers}, United Economy`, `${second.flightNumbers}, United Economy`]);
  assert.equal(items.items[0]!.subtitle, `${first.route}: ${first.departs} to ${first.arrives}`);
  assert.deepEqual(items.items[0]!.fields.map((field) => [field.label, field.text]), [['Total price', '$3,078'], ['Carry-on', 'not checked'], ['Refunds', 'not checked']]);

  // The Polaris fare is named by the business search, as a variant of the fare it lists.
  await runToolCall(coreSession, 'search_flights', premiumNonstop);
  await runToolCall(coreSession, 'fare_details', { flightId: '356-857-UA' });
  const checked = present(coreSession, [{ name: 'present_items' as const, args: { entity: 'fare', ids: [POLARIS] as [string] } }]).components[0];
  assert.ok(checked?.type === 'items');
  assert.deepEqual([checked.items[0]!.title, checked.items[0]!.fields.map((field) => field.text)], ['UA 857, United Polaris', ['$11,640', '1 carry-on bag included', 'Non-refundable']]);
});

test("destination: Take me there opens United's results page for the same search", async () => {
  const { coreSession } = await session();
  const shown = present(coreSession, [{ name: 'present_destination', args: { destination: 'flight_search', params: economy } } as never]);
  const destination = shown.components[0];
  assert.ok(destination?.type === 'destination', JSON.stringify(shown));
  assert.equal(destination.url, 'https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=SHANGHAI%20(ALL%20AIRPORTS)&d=2026-12-22&r=2027-01-10&sc=7,7&px=1&taxng=1&clm=7&st=bestmatches&tqp=R');
});

test("flight and fare buttons: the search's results page, with that flight's details to open; a return flight opens its outbound", async () => {
  const { coreSession } = await session();
  const { flights } = output(await runToolCall(coreSession, 'search_flights', premiumNonstop));
  const shown = present(coreSession, [{ name: 'present_items' as const, args: { entity: 'flight', ids: ['356-857-UA'] as [string] } }]).components[0];
  assert.ok(shown?.type === 'items');
  const resultsUrl = 'https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=SHANGHAI%20(ALL%20AIRPORTS)&d=2026-12-22&r=2027-01-10&sc=1,1&px=1&taxng=1&clm=7&st=bestmatches&tqp=R';
  const outboundTarget = { departs: '12:55 PM', arrives: '6:45 PM', origin: 'SFO', destination: 'PVG', stops: [], flightNumbers: ['UA 857'] };
  assert.deepEqual(shown.items[0]!.go, { url: resultsUrl, focus: { action: 'open_flight_details', target: outboundTarget, hint: 'UA 857, leaving SFO at 12:55 PM' } });

  // Booking a chosen fare: its own destination, named in the hint.
  await runToolCall(coreSession, 'fare_details', { flightId: flights[0].flightId });
  const handoff = present(coreSession, [{ name: 'present_destination', args: { destination: 'fare_on_united', params: { fareId: POLARIS } } } as never]).components[0];
  assert.ok(handoff?.type === 'destination', JSON.stringify(handoff));
  assert.deepEqual([handoff.url, handoff.focus?.hint], [resultsUrl, 'UA 857, leaving SFO at 12:55 PM (United Polaris)']);

  // A return flight isn't on the results page until its outbound is selected, so its button opens the outbound.
  const returns = output(await runToolCall(coreSession, 'return_flights', { fareId: POLARIS }));
  const back = present(coreSession, [{ name: 'present_items' as const, args: { entity: 'flight', ids: [returns.flights[0].flightId] as [string] } }]).components[0];
  assert.ok(back?.type === 'items');
  assert.deepEqual(back.items[0]!.go?.focus?.target, outboundTarget);
  assert.match(back.items[0]!.go!.focus!.hint, /^your outbound flight, UA 857, leaving SFO at 12:55 PM; after you select it, UA 858 is among the returns$/);
});

test("add to cart: a search's one-way or outbound fare gets a confirming button with its flight, fare and price; a return fare, or one with no search behind it, gets none", async () => {
  const { coreSession } = await session();
  const { flights } = output(await runToolCall(coreSession, 'search_flights', premiumNonstop));
  const fareId = flights[0].fares[0].fareId;
  const button = (destination: string, id: string) => present(coreSession, [{ name: 'present_destination', args: { destination, params: { fareId: id } } } as never]);
  const resultsUrl = 'https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=SHANGHAI%20(ALL%20AIRPORTS)&d=2026-12-22&r=2027-01-10&sc=1,1&px=1&taxng=1&clm=7&st=bestmatches&tqp=R';
  const fareTarget = { departs: '12:55 PM', arrives: '6:45 PM', origin: 'SFO', destination: 'PVG', stops: [], flightNumbers: ['UA 857'], cabin: 'United Economy', fare: 'Standard', prices: [3078] };
  const added = button('add_fare_to_cart', fareId);
  assert.deepEqual(added.refused, []);
  assert.deepEqual(added.components[0], {
    type: 'destination', destination: 'add_fare_to_cart', title: 'Add this fare to your United cart', url: resultsUrl,
    focus: { action: 'add_fare_to_cart', target: fareTarget, hint: 'UA 857 leaving SFO at 12:55 PM, United Economy Standard, $3,078' },
    confirm: {
      summary: ['UA 857', 'SFO to PVG: Tue, Dec 22, 12:55 PM to Wed, Dec 23, 6:45 PM', 'United Economy Standard', '$3,078, the whole round trip, for all travelers, taxes and fees included', 'The outbound flight: you pick the return on United next.'],
      consent: rt.pack.pageActions!.add_fare_to_cart!.consent!, button: 'Add to cart on United',
    },
    item: { kind: 'fare', id: fareId },
  }, 'every line from the search: the flight, its times, the fare as the page names it, and the price the page must show');

  // Showing the same fare opens its options, with the same target, and never as a write.
  const shown = button('fare_on_united', fareId).components[0];
  assert.ok(shown?.type === 'destination');
  assert.deepEqual([shown.focus?.action, shown.focus?.target, shown.confirm], ['open_fare_options', fareTarget, undefined]);

  // An upgrade the search named as a variant of another fare has its own card on the page, so once fare_details has
  // returned it, it gets a button too.
  await runToolCall(coreSession, 'fare_details', { flightId: flights[0].flightId });
  const upgrade = button('add_fare_to_cart', POLARIS).components[0];
  assert.ok(upgrade?.type === 'destination');
  assert.deepEqual(upgrade.focus?.target, { ...fareTarget, cabin: 'United Polaris', fare: 'Standard', prices: [11640] });
  // Known to the session, but with no search behind it on this page: nothing to find, so no button.
  coreSession.ids.learn('fare', 'ZZZZZZZZZZZZZZZZZZZZZZ001');
  assert.equal(button('add_fare_to_cart', 'ZZZZZZZZZZZZZZZZZZZZZZ001').refused[0]?.error.reason, 'destination_unavailable');
  const returns = output(await runToolCall(coreSession, 'return_flights', { fareId: POLARIS }));
  const returnFare = button('add_fare_to_cart', returns.flights[0].fares[0].fareId);
  assert.equal(returnFare.refused[0]?.error.reason, 'destination_unavailable', 'a return is listed only after its outbound is selected on United');
});

test('times: local at the airport, with the weekday, never moved to another time zone', () => {
  assert.equal(localTime('2026-12-22 00:05'), 'Tue, Dec 22, 12:05 AM');
  assert.equal(localTime('2027-01-10 13:10'), 'Sun, Jan 10, 1:10 PM');
});
