// United's additions to the fixture builder (platform/testkit/scripts/build-fixtures.ts):
//   describe: one line per recorded request, in United's terms
//   stream:   a recorded search streams every flight option it found (35 to 61 seen, about 10 KB each), so a search's
//             fixture keeps the first FLIGHTS_KEPT in United's order and every other event (the search's meta, the
//             filters, warnings), which is enough for each tool and conversation
//   derive:   the MileagePlus account's answers (sign-in mode), written by hand from the signed-in recording's shapes
//             (field names and types only, read with har-shapes.ts) with every value made up: no value from the
//             traveler's account is ever in a fixture. The identifiers the site pack scrubs get placeholders as usual.
// The token endpoint's fixture comes from the builder itself (the site pack's token section): United's page keeps
// its token, so no recording has a token call.
import type { StreamEvent } from '../../platform/contract/src/events.ts';
import { FAKE_PAGE_TOKEN } from '../../platform/testkit/src/fake-host.ts';
import type { DeriveContext, Fixture } from '../../platform/testkit/src/fixtures.ts';

const FLIGHTS_KEPT = 10;

const isFlightOption = (streamEvent: StreamEvent) => (streamEvent.data as { type?: string } | null)?.type === 'flightOption';

export function stream(_endpoint: string, events: StreamEvent[]): StreamEvent[] {
  let kept = 0;
  return events.filter((streamEvent) => !isFlightOption(streamEvent) || kept++ < FLIGHTS_KEPT);
}

const flightCount = (events: StreamEvent[]) => events.filter(isFlightOption).length;

export function describe(endpoint: string, req: Record<string, any>, res: any): string {
  switch (endpoint) {
    case 'airports': return `"${req.airport}": ${res.data?.airports?.length ?? 0} airports`;
    case 'flights': {
      const trips = (req.Trips ?? []).map((trip: Record<string, any>) => `${trip.Origin} to ${trip.Destination} ${trip.DepartDate}`).join(', back ');
      const nonstop = req.Trips?.[0]?.SearchFiltersIn?.StopCountMax === 0 ? ', nonstop' : '';
      return `${trips}, ${req.PaxInfoList?.length} adult, ${req.CabinPreferenceMain}${nonstop}: ${flightCount(res)} flight options kept`;
    }
    case 'return_flights': return `returns for outbound fare ${req.BBXCellId} on ${req.flightHash}: ${flightCount(res)} flight options kept`;
    case 'fare_details': return `fares on ${req.FlightHash}: ${res.CabinEntitlements?.length ?? 0}`;
    case 'calendar': return `${req.Origin} to ${req.Destination}, ${req.IsOneway ? 'one way' : 'round trip'} around ${req.Depart}: ${res.data?.fareDetails?.length ?? 0} dates`;
    default: return endpoint;
  }
}

const ACCOUNT_SOURCE = 'hand-written from the shapes of the signed-in recording of 2026-11-15 (names and types only); every value is made up';

/** A made-up answer from one of the account's endpoints, signed with the test page's token, as core.js sends it. */
function accountAnswer(id: string, endpoint: string, url: string, description: string, body: unknown): Omit<Fixture, 'site'> {
  return {
    id, endpoint, kind: 'synthetic', source: ACCOUNT_SOURCE, description,
    request: { method: 'GET', url, headers: { accept: 'application/json', 'x-authorization-api': `bearer ${FAKE_PAGE_TOKEN}` }, body: null },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body },
  };
}

export function derive({ placeholder }: DeriveContext): Omit<Fixture, 'site'>[] {
  const balance = (amount: number, currency: string) => ({ TotalBalance: amount, ProgramCurrencyType: currency, SubBalances: [], BalancesBySubAccount: [] });
  return [
    accountAnswer('balances-01', 'balances', 'https://www.united.com/api/myunited/user/balances', 'a made-up member: 25,000 miles, 61,000 lifetime miles, TravelBank $120.50', {
      data: {
        ServerName: 'fixture', AccountStatus: 'Active', CanRedeemFromPool: false,
        Balances: [balance(25000, 'RDM'), balance(0, 'UGC'), balance(120.5, 'UBC'), balance(1, 'RPU')],
        LifetimeMiles: 61000, LoyaltyID: placeholder('fixture-loyalty-id'), CustomerId: 100000001,
        TravelBankAccountNumber: placeholder('fixture-travel-bank-account'), Errors: [], Status: 1,
      },
    }),
    accountAnswer('activities-01', 'activities', 'https://www.united.com/api/myunited/account/Activities/0/10', 'a made-up member: 3 recent activities', {
      data: {
        activities: [
          { ActivityType: 'Flight', Description: 'UA 1554 SFO to EWR', PartnerCode: 'UA', PartnerName: 'United Airlines', PartnerType: 'Airline', TransactionDate: '2026-10-02T00:00:00', BaseMiles: 1000, BonusMiles: 200, CobrandedBonusMiles: 0, PremierBonusMiles: 0, TotalMiles: 1200, IsRedeposit: false, TicketNames: ['FIXTURE TRAVELER'], ActivityDetailsData: [] },
          { ActivityType: 'Partner', Description: 'Card purchases', PartnerName: 'Fixture Bank', TransactionDate: '2026-09-15T00:00:00', BaseMiles: 800, BonusMiles: 0, TotalMiles: 800, TicketNames: [] },
          { ActivityType: 'Redemption', Description: 'Award travel', PartnerName: 'United Airlines', TransactionDate: '2026-08-20T00:00:00', BaseMiles: -12500, BonusMiles: 0, TotalMiles: -12500, TicketNames: ['FIXTURE TRAVELER'] },
        ],
      },
    }),
  ];
}
