// Cases United's schemas must reject. Paths are under sites/united/schemas.
import type { MustReject } from '../../platform/contract/src/cases.ts';

const search = { from: 'SFO', to: 'SHANGHAI (ALL AIRPORTS)', departDate: '2026-12-22', returnDate: '2027-01-10', adults: 1, cabin: 'economy' };

export const mustReject: MustReject[] = [
  { schema: 'tools/search_flights.input.json', instance: { ...search, from: 'sfo' }, rule: 'airport codes are three capital letters' },
  { schema: 'tools/search_flights.input.json', instance: { ...search, to: 'Shanghai' }, rule: "a city goes by its all-airports place from find_airport, not a name the model makes up" },
  { schema: 'tools/search_flights.input.json', instance: { ...search, adults: 0 }, rule: 'at least one traveler' },
  { schema: 'tools/search_flights.input.json', instance: { ...search, cabin: 'first' }, rule: "only United's two search cabins" },
  { schema: 'tools/search_flights.output.json', instance: { direction: 'outbound', pricedAs: 'x', totalFlights: 1, shown: 1, flights: [{ flightId: '356-857-UA', carrier: 'United Airlines', flightNumbers: 'UA 857', route: 'SFO to PVG', departs: 'Tue', arrives: 'Wed', stops: 0, duration: '13h 50m', fares: [{ fareId: 'GtAoefqhwB8LqKaFeruQbJ001', name: 'United Economy', totalPrice: 3078, baseFare: 2178 }] }] }, rule: 'only the total price with taxes, never a base fare without them' },
  { schema: 'tools/return_flights.input.json', instance: { fareId: 'cheapest one' }, rule: 'a fare by its ID only' },
];
