// Demo Flights' tools: offers from a search form's fields, and the signed-in traveler's trips.
import type { SiteCode } from '../../platform/core/src/index.ts';

interface Segment { carrier: string; flightNumber: string; from: string; to: string; departs: string; arrives: string }

export const site: SiteCode = {
  tools: {
    async search_flights(ctx) {
      const a = ctx.args as { origin: string; destination: string; departDate: string; returnDate?: string; adults: number; cabin: string };
      const res = await ctx.call('offers', {
        body: { origin: a.origin, destination: a.destination, departDate: a.departDate, ...(a.returnDate ? { returnDate: a.returnDate } : {}), adults: a.adults, cabin: a.cabin },
      });
      return {
        offers: res.offers.map((o: { offerId: string; expiresAt: string; price: { total: number }; segments: Segment[]; duration: string }) => ({
          offerId: o.offerId,
          expiresAt: o.expiresAt,
          totalPrice: o.price.total,
          carrier: o.segments[0]!.carrier,
          flightNumbers: o.segments.map((s) => s.flightNumber).join(' / '),
          departs: o.segments[0]!.departs,
          arrives: o.segments[o.segments.length - 1]!.arrives,
          stops: o.segments.length - 1,
          duration: o.duration,
        })),
      };
    },

    async get_trips(ctx) {
      const res = await ctx.call('trips', { query: { status: (ctx.args as { status?: string }).status ?? 'upcoming' } });
      return {
        trips: res.trips.map((t: { recordLocator: string; status: string; segments: Segment[] }) => ({
          recordLocator: t.recordLocator,
          route: `${t.segments[0]!.from} to ${t.segments[t.segments.length - 1]!.to}`,
          departs: t.segments[0]!.departs,
          status: t.status,
        })),
      };
    },
  },
};
