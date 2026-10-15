// Cases Demo Flights' schemas must reject. Paths are under sites/demo-flights/schemas.
import type { MustReject } from '../../platform/contract/src/cases.ts';

const search = { origin: 'SFO', destination: 'JFK', departDate: '2026-11-20', adults: 1, cabin: 'economy' };

export const mustReject: MustReject[] = [
  { schema: 'tools/search_flights.input.json', instance: { ...search, adults: 0 }, rule: 'at least one traveler' },
  { schema: 'tools/search_flights.input.json', instance: { ...search, origin: 'sfo' }, rule: 'airport codes are three capital letters' },
  { schema: 'tools/search_flights.input.json', instance: { ...search, cabin: 'luxury' }, rule: 'only the four cabins' },
  { schema: 'tools/search_flights.output.json', instance: { offers: [{ offerId: 'off_7GQ2', expiresAt: '2026-10-12T18:30:00Z', totalPrice: 389.4, carrier: 'Demo Air', flightNumbers: 'DA101', departs: '2026-11-20T15:05:00Z', arrives: '2026-11-20T23:40:00Z', stops: 0, duration: 'PT5H35M', baseFareOnly: 321.86 }] }, rule: 'only the total price, never a base fare without taxes' },
];
