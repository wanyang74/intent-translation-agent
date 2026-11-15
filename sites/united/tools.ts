// United's tools: airports for a city, a flight search, the return flights for a chosen outbound fare, what each fare
// on a flight includes, and the cheapest dates around a trip; and the URL of United's results page for a search, for
// the destinations: the search itself, or one flight or fare on it, which page.ts then opens the details of.
// How United's search works, and what the tools keep from it:
//   - A search answers one direction at a time, as a stream that core.js hands over grouped by event type: one meta
//     event (with the search session's ID, United's cartId), then one flightOption per flight option, then filters.
//     A round trip lists the outbound flights, each fare priced as the whole round trip; picking an outbound fare
//     (return_flights) lists the returns, priced as the round trip with it.
//   - Later calls about a search name its session and the flight or fare, so each search keeps, in the session's
//     store, the session behind every flight and fare it returned. The model never sees the session's ID.
//   - A fare's price is United's Fare amount for all travelers, which is the base fare plus the taxes United lists
//     next to it: taxes and fees included, as US fares must be shown.
//   - Economy Plus comes as an extra product: the Economy fare plus seat add-ons (MERCH prices) whose total we can't
//     rebuild from what United sends, so it's left out rather than shown at the wrong price. Seats are bought on
//     United's own pages.
// Times are local at each airport, as United sends them, so they're shown as text, never converted to a time zone.
// The MileagePlus tools (sign-in mode) read the signed-in traveler's balances and activity. core.js signs their calls
// with the token United's page keeps (D7). Signed out, United answers 202 with only Errors, so no data means signed out.
// They pass on only the amounts and the activity lines: the loyalty ID, customer ID, TravelBank account number and the
// travelers' names on tickets, which the same answers carry, never leave this file.
import type { FareTarget, FlightTarget } from './page.ts';
import type { SiteCode, ToolContext } from '../../platform/core/src/index.ts';

interface Segment {
  flightNumber: string;
  marketingCarrier: string;
  marketingCarrierDescription?: string;
  operatingCarrier?: string;
  operatingCarrierDescription?: string;
  origin: string;
  destination: string;
  departDateTime: string;
  destinationDateTime: string;
  connectTimeMinutes?: number;
  equipmentDisclosures?: { equipmentDescription?: string };
}
interface Product {
  productId?: string;
  productType: string;
  cabinType?: string;
  title?: string;
  subTitle?: string;
  prices?: { pricingType: string; amount: number; amountAllPax?: number }[];
  nonRefundableIndicator?: boolean;
  noChangeFeeIndicator?: boolean;
  /** The same cabin's other fares on this flight, such as Standard and Flexible next to Base: named here, listed with their rules by fare_details. */
  nestedProducts?: Product[];
}
interface Flight extends Segment {
  hash: string;
  travelMinutesTotal: number;
  connections: Segment[];
  products: Product[];
}
interface SearchStream {
  meta: { cartId: string }[];
  flightOption?: { flight: Flight }[];
  warning?: { warnings?: { message?: string }[] }[];
}

type Cabin = 'economy' | 'business_or_first';
type SortBy = 'best' | 'price' | 'duration' | 'departure';
type Direction = 'outbound' | 'return' | 'one_way';

/** How each cabin choice reaches United's search: its main cabin, its fare family, and its code on the results page. */
const CABINS: Record<Cabin, { main: string; family: string; pageCode: number }> = {
  economy: { main: 'economy', family: 'ECONOMY', pageCode: 7 },
  business_or_first: { main: 'premium', family: 'FIRST', pageCode: 1 },
};

/** What a search keeps about each flight and fare it returned, so later tools can name them to United. */
interface SearchRef {
  cartId: string;
  flightHash: string;
  direction: Direction;
  filters: Record<string, unknown>;
  /** The flight as each of its fares names it, so a fare's card says which flight it's on. */
  flight: FlightOfFare;
  /** The search whose results page lists it: the outbound search, for a return flight too. */
  search: SearchArgs;
  /** How United's results page shows the flight, for page.ts to find it. */
  target: FlightTarget;
  /** For a return flight: the outbound flight picked before it, which is what the results page lists first. */
  outbound?: { flightNumbers: string; target: FlightTarget };
}

/** A fare as the results page shows it: its cabin's column, its name there, and the prices it may show. */
type FareOnPage = Pick<FareTarget, 'cabin' | 'fare' | 'prices'>;

/** What a search keeps about each fare: its flight's search, its name, how the page shows it, and its total price. */
type FareRef = SearchRef & { name?: string; page?: FareOnPage; total?: number };

/** Which flight a fare is on: its numbers, and its route and times in one line. */
interface FlightOfFare {
  flightNumbers: string;
  schedule: string;
}

// ---------------------------------------------------------------- dates and times

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-12-22 12:55" as "Tue, Dec 22, 12:55 PM": local at the airport. No Intl, which not every engine has. */
export function localTime(value: string): string {
  const [date = '', time = ''] = value.split(' ');
  const [year, month, day] = date.split('-').map(Number);
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  const weekday = DAYS[new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()];
  const clock = `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
  return `${weekday}, ${MONTHS[month! - 1]} ${day}, ${clock}`;
}

export const hoursAndMinutes = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;

/** 2026-12-22 as United's calendar takes it (12222026), and its answer (12/22/2026) back as 2026-12-22. */
const calendarDate = (date: string) => { const [year, month, day] = date.split('-'); return `${month}${day}${year}`; };
const fromCalendar = (date: string) => { const [month, day, year] = date.split('/'); return `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`; };
/** 2026-12-22 as United's recent-search key writes it: 12/22/2026, without leading zeros. */
const shortDate = (date: string) => { const [year, month, day] = date.split('-'); return `${Number(month)}/${Number(day)}/${year}`; };

// ---------------------------------------------------------------- the search request

export interface SearchArgs {
  from: string;
  to: string;
  departDate: string;
  returnDate?: string;
  adults: number;
  cabin: Cabin;
  nonstopOnly?: boolean;
  sortBy?: SortBy;
}

/** A trip's filters: the cabin's fare family, and nonstop when asked. */
function searchFilters(args: { cabin: Cabin; nonstopOnly?: boolean }): Record<string, unknown> {
  return {
    FareFamily: CABINS[args.cabin].family, AirportsStop: null, AirportsStopToAvoid: null,
    ShopIndicators: { IsTravelCreditsApplied: false, IsDoveFlow: true, DisableBasicEconomy: false, DisableBasicPremium: false },
    ...(args.nonstopOnly ? { StopCountMin: 0, StopCountMax: 0 } : {}),
  };
}

/** The body United's own search form sends for these choices. */
export function searchBody(args: SearchArgs): Record<string, unknown> {
  const filters = searchFilters(args);
  const trip = (origin: string, destination: string, date: string, index: number) => ({
    Origin: origin, Destination: destination, DepartDate: date, Index: index, TripIndex: index,
    SearchRadiusMilesOrigin: 0, SearchRadiusMilesDestination: 0, DepartTimeApprox: 0, SearchFiltersIn: filters,
  });
  const trips = [trip(args.from, args.to, args.departDate, 1), ...(args.returnDate ? [trip(args.to, args.from, args.returnDate, 2)] : [])];
  const stayDays = args.returnDate ? Math.round((Date.parse(args.returnDate) - Date.parse(args.departDate)) / 86_400_000) : 0;
  const recentSearchKey = trips.map((one) => `${one.Origin}${one.Destination}${shortDate(one.DepartDate)}`).join('');
  return {
    SearchTypeSelection: args.returnDate ? 2 : 1, SortType: 'bestmatches', SortTypeDescending: false, Trips: trips,
    CabinPreferenceMain: CABINS[args.cabin].main, PaxInfoList: Array.from({ length: args.adults }, () => ({ PaxType: 1 })),
    AwardTravel: false, NGRP: false, CalendarLengthOfStay: stayDays, PetCount: 0, RecentSearchKey: recentSearchKey,
    CalendarFilters: { Filters: { PriceScheduleOptions: { Stops: 1 } } },
    Characteristics: [{ Code: 'SOFT_LOGGED_IN', Value: false }, { Code: 'UsePassedCartId', Value: false }],
    FareType: 'Refundable', BuildHashValue: 'true', EnableBasicPremiumProducts: true,
  };
}

// ---------------------------------------------------------------- flights out

const price = (product: Product) => {
  const fare = product.prices?.find((candidate) => candidate.pricingType === 'Fare');
  return fare ? Math.round((fare.amountAllPax ?? fare.amount) * 100) / 100 : undefined;
};

/**
 * How the results page shows a fare, for page.ts: its cabin's title (its column) and its name, and its price per
 * traveler and for all travelers. None without a title, a name or a price: such a fare can't be found on the page.
 */
function fareOnPage(product: Product): FareOnPage | undefined {
  const fare = product.prices?.find((candidate) => candidate.pricingType === 'Fare');
  if (!product.title || !product.subTitle || !fare) return undefined;
  return { cabin: product.title, fare: product.subTitle, prices: [...new Set([fare.amount, fare.amountAllPax ?? fare.amount])] };
}

/** An amount in dollars as the summary shows it: $1,107, or $327.50. No Intl, which not every engine has. */
const dollars = (amount: number) => `$${(Number.isInteger(amount) ? String(amount) : amount.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/** A fare's name as United's results show it: the cabin's title, and the variant unless it's the standard one. */
const nameOf = (product: Product) => (product.title ? (product.subTitle && product.subTitle !== 'Standard' ? `${product.title}, ${product.subTitle}` : product.title) : product.productType);

/** One fare as the model sees it, or null for a cabin United lists without selling it here, or a seat add-on. */
function fareOf(product: Product) {
  const totalPrice = price(product);
  if (!product.productId || totalPrice === undefined || product.productType.includes('MERCH')) return null;
  const name = nameOf(product);
  return {
    fareId: product.productId, name, totalPrice,
    ...(product.cabinType ? { cabin: product.cabinType } : {}),
    ...(product.nonRefundableIndicator === undefined ? {} : { refundable: !product.nonRefundableIndicator }),
    ...(product.noChangeFeeIndicator === undefined ? {} : { noChangeFees: product.noChangeFeeIndicator }),
  };
}

/** One flight option as the model sees it: its segments told as a route, with its bookable fares. */
export function flightOf(flight: Flight) {
  const segments = [flight, ...flight.connections];
  const last = segments[segments.length - 1]!;
  const fares = flight.products.map(fareOf).filter((fare): fare is NonNullable<ReturnType<typeof fareOf>> => fare !== null);
  const stops = flight.connections.map((connection) => connection.origin);
  const aircraft = [...new Set(segments.map((segment) => segment.equipmentDisclosures?.equipmentDescription).filter(Boolean))].join(', ');
  const operatedBy = [...new Set(segments.filter((segment) => segment.operatingCarrier && segment.operatingCarrier !== segment.marketingCarrier)
    .map((segment) => segment.operatingCarrierDescription ?? segment.operatingCarrier!))].join(', ');
  return {
    flightId: flight.hash,
    carrier: flight.marketingCarrierDescription ?? flight.marketingCarrier,
    flightNumbers: segments.map((segment) => `${segment.marketingCarrier} ${segment.flightNumber}`).join(' / '),
    route: `${flight.origin} to ${last.destination}${stops.length ? ` via ${stops.join(', ')}` : ''}`,
    departs: localTime(flight.departDateTime),
    arrives: localTime(last.destinationDateTime),
    stops: stops.length,
    layovers: flight.connections.map((connection) => `${connection.origin}, ${hoursAndMinutes(connection.connectTimeMinutes ?? 0)}`),
    duration: hoursAndMinutes(flight.travelMinutesTotal),
    ...(aircraft ? { aircraft } : {}),
    ...(operatedBy ? { operatedBy } : {}),
    ...(fares.length ? { lowestFare: Math.min(...fares.map((fare) => fare.totalPrice)) } : {}),
    fares,
    minutes: flight.travelMinutesTotal,
    departsAt: flight.departDateTime,
    target: targetOf(flight),
    variants: flight.products.flatMap((product) => product.nestedProducts ?? []).filter((nested) => nested.productId).map((nested) => ({ fareId: nested.productId!, name: nameOf(nested) })),
    onPage: Object.fromEntries([...flight.products, ...flight.products.flatMap((product) => product.nestedProducts ?? [])]
      .flatMap((product) => {
        const page = fareOnPage(product);
        const total = price(product);
        return product.productId && page && total !== undefined ? [[product.productId, { page, total }] as const] : [];
      })),
  };
}

const SORTS: Record<Exclude<SortBy, 'best'>, (left: ReturnType<typeof flightOf>, right: ReturnType<typeof flightOf>) => number> = {
  price: (left, right) => (left.lowestFare ?? Infinity) - (right.lowestFare ?? Infinity),
  duration: (left, right) => left.minutes - right.minutes,
  departure: (left, right) => left.departsAt.localeCompare(right.departsAt),
};

/**
 * A search's answer as the model sees it:
 *   1. Every flight option with at least one fare United sells, nonstop only when asked (United filters a search
 *      itself; return flights are filtered here).
 *   2. Sorted as asked; United's own order otherwise. Sorting covers every option United sent, not just one page.
 *   3. The first page of them, and for each flight and fare returned, the search it came from, for later tools.
 */
function flightsOut(ctx: ToolContext, answer: SearchStream, direction: Direction, options: { nonstopOnly?: boolean; sortBy?: SortBy; filters: Record<string, unknown>; pageSize: number; search: SearchArgs; outbound?: SearchRef['outbound'] }) {
  // 1. Flights with fares
  const cartId = answer.meta[0]!.cartId;
  let flights = (answer.flightOption ?? []).map((option) => flightOf(option.flight)).filter((flight) => flight.fares.length);
  if (options.nonstopOnly) flights = flights.filter((flight) => flight.stops === 0);
  // 2. Sorted
  if (options.sortBy && options.sortBy !== 'best') flights = [...flights].sort(SORTS[options.sortBy]);
  // 3. One page, and what later tools need to name them
  const shown = flights.slice(0, options.pageSize);
  const flightOfFare = (flight: Pick<ReturnType<typeof flightOf>, 'flightNumbers' | 'route' | 'departs' | 'arrives'>): FlightOfFare => ({ flightNumbers: flight.flightNumbers, schedule: `${flight.route}: ${flight.departs} to ${flight.arrives}` });
  for (const flight of shown) {
    const ref: SearchRef = {
      cartId, flightHash: flight.flightId, direction, filters: options.filters, flight: flightOfFare(flight), search: options.search, target: flight.target,
      ...(options.outbound ? { outbound: options.outbound } : {}),
    };
    ctx.store.set(`flight:${flight.flightId}`, ref);
    for (const fare of [...flight.fares, ...flight.variants]) ctx.store.set(`fare:${fare.fareId}`, { ...ref, name: fare.name, ...flight.onPage[fare.fareId] } satisfies FareRef);
  }
  const warnings = (answer.warning ?? []).flatMap((warning) => warning.warnings ?? []).map((warning) => warning.message?.trim()).filter((message): message is string => !!message);
  return {
    direction,
    pricedAs: direction === 'one_way' ? 'one way, for all travelers, taxes and fees included' : 'the whole round trip, for all travelers, taxes and fees included',
    flights: shown.map(({ minutes: _minutes, departsAt: _departsAt, variants: _variants, target: _target, onPage: _onPage, ...flight }) => ({
      ...flight, fares: flight.fares.map((fare) => ({ ...fare, ...flightOfFare(flight) })),
    })),
    totalFlights: flights.length,
    shown: shown.length,
    ...(warnings.length && !flights.length ? { warnings } : {}),
  };
}

/** United's fare attribute types, as the fare fields they fill. Club and Polaris lounge access share one field. */
const RULES: Record<string, 'checkedBags' | 'carryOn' | 'seat' | 'changes' | 'refunds' | 'upgrades' | 'lounge'> = {
  CHECKEDBAG: 'checkedBags', CARRYONBAG: 'carryOn', SEAT: 'seat', CHANGEFEE: 'changes', FareRule: 'refunds', UPGRADE: 'upgrades', LOUNGE: 'lounge', LOBBY: 'lounge',
};

/**
 * What a fare includes, by field, from United's list of attributes. Miles earned are left out (they depend on the
 * traveler's status, and signed out we don't know it), and so is NOTAPPLICABLE, United's placeholder. Anything of a
 * type not in RULES goes in other, so nothing United lists is lost.
 */
function rulesOf(attributes: { Type: string; Text: string }[]) {
  const rules: Record<string, string> = {};
  const other: string[] = [];
  for (const { Type: type, Text: text } of attributes) {
    if (type === 'Miles' || !text || text === 'NOTAPPLICABLE') continue;
    const field = RULES[type];
    if (field) rules[field] = rules[field] ? `${rules[field]}; ${text}` : text;
    else other.push(text);
  }
  return { ...rules, ...(other.length ? { other } : {}) };
}

const PAGE_SIZE = 12;

/** 2026-12-22 08:45 as United's results page shows the time: 8:45 AM. */
const clockOf = (value: string) => localTime(value).split(', ').at(-1)!;

/** How United's results page shows a flight, for page.ts to find its row. */
function targetOf(flight: Flight): FlightTarget {
  const segments = [flight, ...flight.connections];
  return {
    departs: clockOf(flight.departDateTime), arrives: clockOf(segments[segments.length - 1]!.destinationDateTime),
    origin: flight.origin, destination: segments[segments.length - 1]!.destination,
    stops: flight.connections.map((connection) => connection.origin),
    flightNumbers: segments.map((segment) => `${segment.marketingCarrier} ${segment.flightNumber}`),
  };
}

/** United's results page for a search, as its own search form opens it: round trip or one way. */
function resultsPage(args: SearchArgs, link: (name: string, values: Record<string, unknown>) => string | undefined) {
  const values = { from: args.from, to: args.to, departDate: args.departDate, returnDate: args.returnDate, cabinCode: CABINS[args.cabin].pageCode, adults: args.adults };
  return link(args.returnDate ? 'results_round_trip' : 'results_one_way', values);
}

/**
 * The results page for a flight or fare a search returned, with the flight's details to open there:
 *   1. The search behind it, from the store; none (a search from before this was kept) means no button.
 *   2. The results page lists outbound flights, so a return flight's page opens its outbound flight, the one the
 *      traveler selects first.
 *   3. How the user finds it if page.ts can't: the flight, its time, and the fare.
 */
function flightPage(ref: SearchRef | undefined, link: (name: string, values: Record<string, unknown>) => string | undefined, fareName?: string) {
  // 1. The search.
  if (!ref?.search || !ref.target) return undefined;
  const url = resultsPage(ref.search, link);
  if (!url) return undefined;
  // 2. The flight on that page.
  const onPage = ref.direction === 'return' && ref.outbound ? ref.outbound : { flightNumbers: ref.flight.flightNumbers, target: ref.target };
  // 3. The hint.
  const fare = fareName ? ` (${fareName})` : '';
  const hint = ref.direction === 'return' && ref.outbound
    ? `your outbound flight, ${onPage.flightNumbers}, leaving ${onPage.target.origin} at ${onPage.target.departs}; after you select it, ${ref.flight.flightNumbers}${fare} is among the returns`
    : `${onPage.flightNumbers}, leaving ${onPage.target.origin} at ${onPage.target.departs}${fare}`;
  return { url, focus: { target: onPage.target, hint } };
}

/**
 * The add-to-cart button for a fare a search returned (D6):
 *   1. Only a one-way or outbound fare whose search, page names and price are known. A return fare is listed only
 *      after its outbound is selected on United, so it gets no button.
 *   2. Its target: the flight's row, then the fare's cabin, name and prices, which page.ts checks before pressing.
 *   3. What the user confirms: the flight, its times, the fare and its price, from the search's own answer.
 */
function cartButton(ref: FareRef | undefined, link: (name: string, values: Record<string, unknown>) => string | undefined) {
  // 1. Which fares.
  if (!ref?.search || !ref.target || !ref.page || ref.total === undefined || ref.direction === 'return') return undefined;
  const url = resultsPage(ref.search, link);
  if (!url) return undefined;
  // 2. The target.
  const target: FareTarget = { ...ref.target, ...ref.page };
  // 3. The summary, and the hint for when the user must find it themselves.
  const fare = `${ref.page.cabin} ${ref.page.fare}`;
  const pricedAs = ref.direction === 'one_way' ? 'one way' : 'the whole round trip';
  const summary = [
    ref.flight.flightNumbers, ref.flight.schedule, fare, `${dollars(ref.total)}, ${pricedAs}, for all travelers, taxes and fees included`,
    ...(ref.direction === 'outbound' ? ['The outbound flight: you pick the return on United next.'] : []),
  ];
  return { url, focus: { target, hint: `${ref.flight.flightNumbers} leaving ${ref.target.origin} at ${ref.target.departs}, ${fare}, ${dollars(ref.total)}` }, summary };
}

/** United's program currencies, as its own scripts name them (2026-11-15). */
const CURRENCY = { miles: 'RDM', plusPoints: 'UGC', travelBank: 'UBC' } as const;

interface BalancesAnswer {
  data?: { Balances: { TotalBalance: number; ProgramCurrencyType: string }[]; LifetimeMiles?: number };
}
interface ActivitiesAnswer {
  data?: { activities: { ActivityType?: string; Description: string; PartnerName?: string; TransactionDate: string; BaseMiles?: number; BonusMiles?: number; TotalMiles: number }[] };
}

/**
 * The traveler's balances:
 *   1. No data means United took the traveler as signed out.
 *   2. Each amount by its program currency; a currency United didn't send is left out, except miles, which is 0.
 */
function balancesOf(ctx: ToolContext, answer: BalancesAnswer) {
  // 1. Signed out
  if (!answer.data) return ctx.fail('signed_out');
  // 2. The amounts
  const amount = (currency: string) => answer.data!.Balances.find((balance) => balance.ProgramCurrencyType === currency)?.TotalBalance;
  const plusPoints = amount(CURRENCY.plusPoints);
  const travelBank = amount(CURRENCY.travelBank);
  return {
    miles: Math.max(0, Math.round(amount(CURRENCY.miles) ?? 0)),
    ...(answer.data.LifetimeMiles !== undefined ? { lifetimeMiles: Math.max(0, Math.round(answer.data.LifetimeMiles)) } : {}),
    ...(plusPoints !== undefined ? { plusPoints: Math.max(0, plusPoints) } : {}),
    ...(travelBank !== undefined ? { travelBankDollars: Math.max(0, travelBank) } : {}),
  };
}

/** The traveler's activity lines, without the names on tickets; no data means signed out. */
function activitiesOf(ctx: ToolContext, answer: ActivitiesAnswer) {
  if (!answer.data) return ctx.fail('signed_out');
  return {
    activities: answer.data.activities.map((activity) => ({
      date: activity.TransactionDate,
      description: activity.Description,
      ...(activity.PartnerName ? { partner: activity.PartnerName } : {}),
      ...(activity.ActivityType ? { type: activity.ActivityType } : {}),
      miles: activity.TotalMiles,
      ...(activity.BaseMiles !== undefined ? { baseMiles: activity.BaseMiles } : {}),
      ...(activity.BonusMiles !== undefined ? { bonusMiles: activity.BonusMiles } : {}),
    })),
  };
}

export const site: SiteCode = {
  tools: {
    async get_miles_balance(ctx) {
      return balancesOf(ctx, await ctx.call('balances', {}));
    },

    async get_miles_activity(ctx) {
      const count = (ctx.args as { count?: number }).count ?? 10;
      return activitiesOf(ctx, await ctx.call('activities', { params: { start: 0, count } }));
    },

    async find_airport(ctx) {
      const res = await ctx.call('airports', { query: { airport: ctx.args.query, allAirports: 'true', matches: '5' } });
      return {
        airports: res.data.airports.map((entry: { Airport: { IATACode: string; Name: string; IATACountryCode?: { Name?: string } }; IsAllAirport: string }) => {
          const allAirports = entry.IsAllAirport === '1';
          // A city's all-airports choice is searched by its name, upper case, as United's own form sends it.
          return {
            place: allAirports ? entry.Airport.Name.toUpperCase() : entry.Airport.IATACode,
            code: entry.Airport.IATACode, name: entry.Airport.Name, allAirports,
            ...(entry.Airport.IATACountryCode?.Name ? { country: entry.Airport.IATACountryCode.Name } : {}),
          };
        }),
      };
    },

    async search_flights(ctx) {
      const args = ctx.args as SearchArgs;
      ctx.progress(`Searching United flights for ${shortDate(args.departDate)}${args.returnDate ? `, back ${shortDate(args.returnDate)}` : ''}…`);
      const answer: SearchStream = await ctx.call('flights', { body: searchBody(args) });
      const out = flightsOut(ctx, answer, args.returnDate ? 'outbound' : 'one_way', { ...args, filters: searchFilters(args), pageSize: PAGE_SIZE, search: args });
      if (!out.totalFlights) ctx.fail('no_flights');
      return out;
    },

    async return_flights(ctx) {
      const args = ctx.args as { fareId: string; nonstopOnly?: boolean; sortBy?: SortBy };
      const ref = ctx.store.get(`fare:${args.fareId}`) as SearchRef | undefined;
      if (!ref) ctx.fail('search_again');
      if (ref!.direction !== 'outbound') ctx.fail('not_round_trip');
      ctx.progress('Finding return flights…');
      const answer: SearchStream = await ctx.call('return_flights', {
        body: {
          CartId: ref!.cartId, BBXCellId: args.fareId, MoneyAndMilesOptionId: null, BBXSolutionSetId: null, flightHash: ref!.flightHash,
          RequeryForUpsell: false, SearchFilters: ref!.filters, CalendarFilters: { Filters: { PriceScheduleOptions: { Stops: 1 } } },
          FareType: 'Refundable', BuildHashValue: 'true',
        },
      });
      const out = flightsOut(ctx, answer, 'return', {
        ...args, filters: ref!.filters, pageSize: PAGE_SIZE, search: ref!.search, outbound: { flightNumbers: ref!.flight.flightNumbers, target: ref!.target },
      });
      if (!out.totalFlights) ctx.fail('no_flights');
      return out;
    },

    async fare_details(ctx) {
      const flightId = (ctx.args as { flightId: string }).flightId;
      const ref = ctx.store.get(`flight:${flightId}`) as SearchRef | undefined;
      if (!ref) ctx.fail('search_again');
      const res = await ctx.call('fare_details', { body: { CartId: ref!.cartId, FlightHash: flightId, IncludeLmxQuote: true } });
      return {
        flightId,
        fares: res.CabinEntitlements.map((entitlement: { ProductId: string; Price?: number; Attributes: { Type: string; Text: string }[] }) => {
          // The search named every fare on its flights, the ones it listed and their variants, and remembered their
          // search; one it didn't (United added it since) is remembered now, for return_flights.
          const known = ctx.store.get(`fare:${entitlement.ProductId}`) as { name?: string } | undefined;
          if (!known) ctx.store.set(`fare:${entitlement.ProductId}`, ref);
          return {
            fareId: entitlement.ProductId,
            ...(known?.name ? { name: known.name } : {}),
            ...ref!.flight,
            ...(entitlement.Price === undefined ? {} : { totalPrice: entitlement.Price }),
            ...rulesOf(entitlement.Attributes),
          };
        }),
      };
    },

    async fare_calendar(ctx) {
      const args = ctx.args as { from: string; to: string; departDate: string; returnDate?: string; adults: number; cabin: Cabin };
      const res = await ctx.call('calendar', {
        body: {
          UserSelected: true, Depart: calendarDate(args.departDate), Return: args.returnDate ? calendarDate(args.returnDate) : '',
          Origin: args.from, Destination: args.to, IsAward: false, ClientCurrentDate: '', IsPremium: args.cabin === 'business_or_first',
          IsOneway: !args.returnDate, ExcludeBasicEconomy: false,
          Travelers: { Adult: args.adults, Senior: 0, Infant: 0, InfantOnLap: 0, Children01: 0, Children02: 0, Children03: 0, Children04: 0 },
        },
      });
      return {
        ...(res.data.currency ? { currency: res.data.currency } : {}),
        pricedAs: "United's calendar fare for each date; search_flights gives the bookable fares and exact prices",
        dates: res.data.fareDetails.map((entry: { depart: string; return?: string; fare: number }) => ({
          depart: fromCalendar(entry.depart), ...(entry.return ? { return: fromCalendar(entry.return) } : {}), lowestFare: entry.fare,
        })),
      };
    },
  },

  // United's results page for a search; for one flight, the same page with its details to open; for one fare, with
  // its options open (a return fare: its outbound flight's details); and the fare's add-to-cart button (D6).
  destinations: {
    flight_search: (args: SearchArgs, link) => resultsPage(args, link),
    flight_on_united: (params: { flightId: string }, link, store) => flightPage(store.get(`flight:${params.flightId}`) as SearchRef | undefined, link),
    fare_on_united: (params: { fareId: string }, link, store) => {
      const ref = store.get(`fare:${params.fareId}`) as FareRef | undefined;
      const shown = flightPage(ref, link, ref?.name);
      if (!shown || !ref?.page || ref.direction === 'return') return shown;
      return { ...shown, focus: { ...shown.focus, target: { ...shown.focus.target, ...ref.page } satisfies FareTarget } };
    },
    add_fare_to_cart: (params: { fareId: string }, link, store) => cartButton(store.get(`fare:${params.fareId}`) as FareRef | undefined, link),
    // United's home page, where page.ts presses the header's Sign in.
    sign_in_on_united: (_params: Record<string, never>, link) => {
      const url = link('home', {});
      return url ? { url, focus: { target: {}, hint: "United's sign-in" } } : undefined;
    },
  },
};
