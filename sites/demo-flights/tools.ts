// Demo Flights' tools: offers from a search form's fields, and the signed-in traveler's trips; and the URL of the
// results page for a search, for the flight_search destination. The search answers as a stream, which core.js hands
// over grouped by event name: one search event, an offer event per offer (none when nothing matches), one done.
import type { SiteCode } from '../../platform/core/src/index.ts';

interface Segment { carrier: string; flightNumber: string; from: string; to: string; departs: string; arrives: string }

export const site: SiteCode = {
  tools: {
    async search_flights(ctx) {
      const args = ctx.args as { origin: string; destination: string; departDate: string; returnDate?: string; adults: number; cabin: string };
      const res = await ctx.call('offers', {
        body: { origin: args.origin, destination: args.destination, departDate: args.departDate, ...(args.returnDate ? { returnDate: args.returnDate } : {}), adults: args.adults, cabin: args.cabin },
      });
      return {
        offers: (res.offer ?? []).map((offer: { offerId: string; expiresAt: string; price: { total: number }; segments: Segment[]; duration: string }) => ({
          offerId: offer.offerId,
          expiresAt: offer.expiresAt,
          totalPrice: offer.price.total,
          carrier: offer.segments[0]!.carrier,
          flightNumbers: offer.segments.map((segment) => segment.flightNumber).join(' / '),
          departs: offer.segments[0]!.departs,
          arrives: offer.segments[offer.segments.length - 1]!.arrives,
          stops: offer.segments.length - 1,
          duration: offer.duration,
        })),
      };
    },

    async get_trips(ctx) {
      const res = await ctx.call('trips', { query: { status: (ctx.args as { status?: string }).status ?? 'upcoming' } });
      return {
        trips: res.trips.map((trip: { recordLocator: string; status: string; segments: Segment[]; leadTraveler?: string }) => ({
          recordLocator: trip.recordLocator,
          route: `${trip.segments[0]!.from} to ${trip.segments[trip.segments.length - 1]!.to}`,
          departs: trip.segments[0]!.departs,
          status: trip.status,
          ...(trip.leadTraveler ? { traveler: trip.leadTraveler } : {}),
        })),
      };
    },
  },
  // The results page takes the whole search, as base64 JSON.
  destinations: { flight_search: (args, link) => link('search', { search: args }) },
};
