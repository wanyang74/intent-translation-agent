// United's additions to the fixture builder (platform/testkit/scripts/build-fixtures.ts):
//   describe: one line per recorded request, in United's terms
//   stream:   a recorded search streams every flight option it found (35 to 61 seen, about 10 KB each), so a search's
//             fixture keeps the first FLIGHTS_KEPT in United's order and every other event (the search's meta, the
//             filters, warnings), which is enough for each tool and conversation
// The token endpoint's fixture comes from the builder itself (the site pack's token section): United's page keeps
// its token, so no recording has a token call.
import type { StreamEvent } from '../../platform/contract/src/events.ts';

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
