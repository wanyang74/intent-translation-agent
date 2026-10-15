// Carvana's tools: how each tool in site.yaml maps to the requests Carvana's frontend sends, and back to the output the
// model sees. Everything goes through the ToolContext, so the platform's checks, budget, rate limit and cache apply.
// Constant values here are copied from what the frontend sends (boundary rule: only values the frontend produces).
import { groupDigits, unfence, type EntityView, type SiteCode, type ToolContext } from '../../platform/core/src/index.ts';

const PAGE_SIZE = 24;
const SEARCH_FEATURES = ['EarliestAcquisitionBoosting', 'ExcludeFacetData', 'HideImpossibleCombos', 'LoanTermPricing', 'LocationBasedPrefiltering', 'Personalization', 'ConditionalTiles', 'Sprinkles', 'ApplyTradeIn'];
const FACETS_FEATURES = ['ExcludeFacetData', 'HideImpossibleCombos', 'LocationBasedPrefiltering'];
const SUGGEST_FEATURES = ['ExcludeFacetData', 'HideImpossibleCombos', 'LocationBasedPrefiltering', 'ApplyTradeIn'];
/** The client IDs the frontend's search and vehicle pages send (decision D4). */
const SEARCH_CLIENT = 'srp_ui';
const VEHICLE_CLIENT = 'vdp_ui';

interface SearchArgs {
  zip5: string;
  make?: string;
  model?: string;
  trims?: string[];
  year_min?: number;
  year_max?: number;
  mileage_max?: number;
  price_max?: number;
  colors?: string[];
  interior_colors?: string[];
  drive_types?: string[];
  body_styles?: string[];
  tag_ids?: string[];
  features?: string[];
  free_delivery?: boolean;
  sort?: string;
  page?: number;
}

/** A car as Carvana's search results, or the car's own page, describe it. */
interface CarRecord {
  vehicleId: number;
  year: number;
  make: string;
  model: string;
  trim: string;
  kbbTrim?: string;
  mileage?: number;
  color?: string;
  vehicleInventoryType: number;
  locationId: number;
}

/** Search arguments as Carvana's filters, in the order the frontend writes them (the search link encodes them). */
export function filtersFrom(a: SearchArgs): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (a.make) {
    const make: Record<string, unknown> = { name: a.make };
    if (a.model) make.parentModels = [{ name: a.model, ...(a.trims?.length ? { trims: a.trims } : {}) }];
    f.makes = [make];
  }
  if (a.year_min !== undefined || a.year_max !== undefined) {
    f.year = { ...(a.year_min !== undefined ? { min: a.year_min } : {}), ...(a.year_max !== undefined ? { max: a.year_max } : {}) };
  }
  if (a.mileage_max !== undefined) f.mileage = { max: a.mileage_max };
  if (a.price_max !== undefined) f.price = { max: a.price_max };
  if (a.colors?.length) f.colors = a.colors;
  if (a.interior_colors?.length) f.interiorColors = a.interior_colors;
  if (a.drive_types?.length) f.driveTypes = a.drive_types;
  if (a.body_styles?.length) f.bodyStyles = a.body_styles;
  if (a.tag_ids?.length) f.tagIds = a.tag_ids;
  if (a.features?.length) f.cvnaFeatures = a.features;
  if (a.free_delivery) f.isFreeDelivery = true;
  return f;
}

const searchBody = (a: SearchArgs, requestedFeatures: string[]) => ({
  filters: filtersFrom(a),
  pagination: { page: a.page ?? 1, pageSize: PAGE_SIZE },
  requestedFeatures,
  sortBy: a.sort ?? 'MostPopular',
  zip5: a.zip5,
});

/**
 * Facets for the allowed-value check: the valid colors, drive types and so on, given the user's other filters.
 * Leaving out the filters being checked keeps the list the same whichever value is being checked.
 */
const facetsRequest = (a: SearchArgs) => ({
  body: searchBody({ ...a, colors: [], interior_colors: [], drive_types: [], body_styles: [], tag_ids: [], page: 1 }, FACETS_FEATURES),
});

/** The car's record: from a search earlier in this session, or from the page of the car the user is on. */
function carRecord(ctx: ToolContext, vehicleId: number): CarRecord {
  const found = ctx.store.get(`vehicle:${vehicleId}`) as CarRecord | undefined;
  if (found) return found;
  const page = ctx.pageData() as CarRecord | null;
  if (page && page.vehicleId === vehicleId) {
    ctx.keep('vehicle', vehicleId, { year: page.year, make: page.make, model: page.model, trim: page.trim, mileage: page.mileage, color: page.color });
    return page;
  }
  return ctx.fail('car_unknown', { vehicleId });
}

const availabilityCar = (v: CarRecord) => ({
  vehicleId: v.vehicleId,
  vehicleInventoryType: v.vehicleInventoryType === 1 ? 'Core' : 'Unknown',
  vehicleLocationId: v.locationId,
  vehicleSaleStatus: 'Available',
});

interface Soonest {
  status: string;
  content: { asSoonAsText: string; utcSoonestDateTimeIso: string; locationCity: string; locationState: string; routeId: string } | null;
}
const choice = (o: Soonest | undefined) => (o && o.status === 'Succeeded' && o.content
  ? { text: o.content.asSoonAsText, date: o.content.utcSoonestDateTimeIso, location: `${o.content.locationCity}, ${o.content.locationState}`, routeId: o.content.routeId }
  : null);

async function availability(ctx: ToolContext, vehicleIds: number[], zip5: string) {
  const cars = vehicleIds.map((id) => carRecord(ctx, id));
  const res = await ctx.call('availability', { body: { userId: '', vehicles: cars.map(availabilityCar), zipCode: zip5 }, headers: { clientid: SEARCH_CLIENT } });
  return new Map<number, { soonestDelivery?: Soonest; soonestPickup?: Soonest }>(res.content.map((c: { vehicleId: number }) => [c.vehicleId, c]));
}

/** The user's state for the GAP waiver check: from the page they're on, or from Carvana's last search answer. */
const homeState = (ctx: ToolContext): string | undefined => ctx.page?.location?.region ?? (ctx.store.get('userState') as string | undefined);

/** Quotes for one or more cars, as get_vehicle_quote returns them: one bulk availability call, then pricing and GAP. */
async function quotes(ctx: ToolContext, vehicleIds: number[], zip5: string, option: 'delivery' | 'pickup') {
  const soonest = await availability(ctx, vehicleIds, zip5);
  const out = [];
  for (const vehicleId of vehicleIds) {
    const c = soonest.get(vehicleId);
    const route = choice(option === 'pickup' ? c?.soonestPickup : c?.soonestDelivery);
    if (!route) ctx.fail('option_unavailable', { option, vehicleId, zip5, other: option === 'pickup' ? 'delivery' : 'pickup' });
    const pricing = await ctx.call('pricing', { body: { vehicleId, routeId: route!.routeId, zip5, applyTradeIn: true, analyticsData: { clientId: VEHICLE_CLIENT } } });
    if (pricing.price.pricingErrorMessage) ctx.fail('pricing_error', { zip5 });
    const { estimatedTotal } = ctx.derived('vehicle', pricing);
    const state = homeState(ctx);
    let gapWaiver: { available: boolean; price: number | null } | null = null;
    if (state && estimatedTotal !== undefined) {
      const gap = await ctx.call('gap', { query: { amountFinanced: estimatedTotal, homeState: state, institutionName: 'Carvana', paymentType: 'Financing', vehicleId } });
      gapWaiver = { available: gap.isGapWaiverAvailable, price: gap.price ?? null };
    }
    out.push({
      vehicleId, price: pricing.price.total, estimatedTaxesAndFees: pricing.price.estimatedTaxesAndFees, estimatedTotal,
      option, when: route!.text, gapWaiver,
    });
  }
  return out;
}

interface Reviews {
  count: number;
  ratingCounts?: { stars: number; count: number }[];
  reviews: { text: string; rating: number; date: string }[];
}

export const site: SiteCode = {
  tools: {
    async search_vehicles(ctx) {
      const a = ctx.args as SearchArgs;
      const body = searchBody(a, SEARCH_FEATURES);
      const res = await ctx.call('search', { body });
      const inv = res.inventory;
      if (!inv.vehicles.length) ctx.fail('no_results');
      for (const v of inv.vehicles) ctx.store.set(`vehicle:${v.vehicleId}`, v);
      if (res.userDeliveryInfo?.state) ctx.store.set('userState', res.userDeliveryInfo.state);
      return {
        vehicles: inv.vehicles.map((v: any) => ({
          vehicleId: v.vehicleId, stockNumber: v.stockNumber, year: v.year, make: v.make, model: v.model, trim: v.trim,
          mileage: v.mileage, color: v.color, price: v.price.total, estimatedTaxesAndFees: v.price.estimatedTaxesAndFees,
          ...ctx.derived('vehicle', v), locationId: v.locationId, deepLink: ctx.link('vehicle', { vehicleId: v.vehicleId }),
        })),
        totalMatches: inv.pagination.totalMatchedInventory,
        totalPages: inv.pagination.totalMatchedPages,
        page: inv.pagination.currentPage,
        searchLink: ctx.link('search', { cvnaid: { filters: body.filters } }),
      };
    },

    async get_delivery_dates(ctx) {
      const { vehicleIds, zip5 } = ctx.args as { vehicleIds: number[]; zip5: string };
      const soonest = await availability(ctx, vehicleIds, zip5);
      return {
        dates: vehicleIds.map((vehicleId) => ({
          vehicleId, delivery: choice(soonest.get(vehicleId)?.soonestDelivery), pickup: choice(soonest.get(vehicleId)?.soonestPickup),
        })),
      };
    },

    async suggest_refinements(ctx) {
      const { zip5, current } = ctx.args as { zip5: string; current?: SearchArgs };
      const body = { ...searchBody({ ...(current ?? { zip5 }), zip5, page: 1 }, SUGGEST_FEATURES), numberOfSuggestedFilters: 10, analyticsData: { clientId: SEARCH_CLIENT } };
      const res = await ctx.call('suggest', { body });
      return {
        suggestions: res.suggestedFilters.map((s: any) => ({ suggestionId: s.suggestionId, label: s.displayName, matches: s.totalMatchedInventory })),
      };
    },

    async get_vehicle_quote(ctx) {
      const { vehicleId, zip5, option = 'delivery' } = ctx.args as { vehicleId: number; zip5: string; option?: 'delivery' | 'pickup' };
      return (await quotes(ctx, [vehicleId], zip5, option))[0]!;
    },

    async compare_vehicles(ctx) {
      const { vehicleIds, zip5 } = ctx.args as { vehicleIds: number[]; zip5: string };
      return { cars: await quotes(ctx, vehicleIds, zip5, 'delivery') };
    },

    async get_owner_reviews(ctx) {
      const car = carRecord(ctx, (ctx.args as { vehicleId: number }).vehicleId);
      const res = await ctx.call('reviews', { body: { from: 0, make: car.make, model: car.model, size: 20, trim: car.kbbTrim ?? car.trim, year: car.year } });
      return {
        count: res.summary.review_count_total,
        ratingCounts: res.summary.rating_counts.map((c: { key: number; doc_count: number }) => ({ stars: c.key, count: c.doc_count })),
        reviews: res.reviews.map((r: any) => ({ text: ctx.fence(r.review_text, 'carvana-reviews'), rating: r.review_rating, date: r.review_date })),
      };
    },
    // vehicle_details waits for a recording of a vehicle page, to build and test its page reader against.
  },

  valueSources: { facets: facetsRequest },

  sections: {
    reviews(view: EntityView) {
      const r = view.byTool.get_owner_reviews as Reviews | undefined;
      if (!r) return null;
      const counts = r.ratingCounts ?? [];
      const total = counts.reduce((n, c) => n + c.count, 0);
      const high = counts.filter((c) => c.stars >= 4).reduce((n, c) => n + c.count, 0);
      return {
        ...(total ? { summary: `${groupDigits(high)} of ${groupDigits(total)} owner ratings are 4 or 5 stars.` } : {}),
        lines: r.reviews.slice(0, 5).map((x) => ({ text: unfence(x.text), meta: x.date })),
      };
    },
  },
};
