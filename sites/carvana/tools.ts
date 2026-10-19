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
export function filtersFrom(args: SearchArgs): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (args.make) {
    const make: Record<string, unknown> = { name: args.make };
    if (args.model) make.parentModels = [{ name: args.model, ...(args.trims?.length ? { trims: args.trims } : {}) }];
    filters.makes = [make];
  }
  if (args.year_min !== undefined || args.year_max !== undefined) {
    filters.year = { ...(args.year_min !== undefined ? { min: args.year_min } : {}), ...(args.year_max !== undefined ? { max: args.year_max } : {}) };
  }
  if (args.mileage_max !== undefined) filters.mileage = { max: args.mileage_max };
  if (args.price_max !== undefined) filters.price = { max: args.price_max };
  if (args.colors?.length) filters.colors = args.colors;
  if (args.interior_colors?.length) filters.interiorColors = args.interior_colors;
  if (args.drive_types?.length) filters.driveTypes = args.drive_types;
  if (args.body_styles?.length) filters.bodyStyles = args.body_styles;
  if (args.tag_ids?.length) filters.tagIds = args.tag_ids;
  if (args.features?.length) filters.cvnaFeatures = args.features;
  if (args.free_delivery) filters.isFreeDelivery = true;
  return filters;
}

const searchBody = (args: SearchArgs, requestedFeatures: string[]) => ({
  filters: filtersFrom(args),
  pagination: { page: args.page ?? 1, pageSize: PAGE_SIZE },
  requestedFeatures,
  sortBy: args.sort ?? 'MostPopular',
  zip5: args.zip5,
});

/**
 * Facets for the allowed-value check: the valid colors, drive types and so on, given the user's other filters.
 * Leaving out the filters being checked keeps the list the same whichever value is being checked.
 */
const facetsRequest = (args: SearchArgs) => ({
  body: searchBody({ ...args, colors: [], interior_colors: [], drive_types: [], body_styles: [], tag_ids: [], page: 1 }, FACETS_FEATURES),
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

const availabilityCar = (car: CarRecord) => ({
  vehicleId: car.vehicleId,
  vehicleInventoryType: car.vehicleInventoryType === 1 ? 'Core' : 'Unknown',
  vehicleLocationId: car.locationId,
  vehicleSaleStatus: 'Available',
});

interface Soonest {
  status: string;
  content: { asSoonAsText: string; utcSoonestDateTimeIso: string; locationCity: string; locationState: string; routeId: string } | null;
}
const choice = (soonest: Soonest | undefined) => (soonest && soonest.status === 'Succeeded' && soonest.content
  ? { text: soonest.content.asSoonAsText, date: soonest.content.utcSoonestDateTimeIso, location: `${soonest.content.locationCity}, ${soonest.content.locationState}`, routeId: soonest.content.routeId }
  : null);

async function availability(ctx: ToolContext, vehicleIds: number[], zip5: string) {
  const cars = vehicleIds.map((id) => carRecord(ctx, id));
  const res = await ctx.call('availability', { body: { userId: '', vehicles: cars.map(availabilityCar), zipCode: zip5 }, headers: { clientid: SEARCH_CLIENT } });
  return new Map<number, { soonestDelivery?: Soonest; soonestPickup?: Soonest }>(res.content.map((entry: { vehicleId: number }) => [entry.vehicleId, entry]));
}

/** The user's state for the GAP waiver check: from the page they're on, or from Carvana's last search answer. */
const homeState = (ctx: ToolContext): string | undefined => ctx.page?.location?.region ?? (ctx.store.get('userState') as string | undefined);

/** Quotes for one or more cars, as get_vehicle_quote returns them: one bulk availability call, then pricing and GAP. */
async function quotes(ctx: ToolContext, vehicleIds: number[], zip5: string, option: 'delivery' | 'pickup') {
  const soonest = await availability(ctx, vehicleIds, zip5);
  const out = [];
  for (const vehicleId of vehicleIds) {
    const found = soonest.get(vehicleId);
    const route = choice(option === 'pickup' ? found?.soonestPickup : found?.soonestDelivery);
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
      const args = ctx.args as SearchArgs;
      const body = searchBody(args, SEARCH_FEATURES);
      const res = await ctx.call('search', { body });
      const inv = res.inventory;
      if (!inv.vehicles.length) ctx.fail('no_results');
      for (const vehicle of inv.vehicles) ctx.store.set(`vehicle:${vehicle.vehicleId}`, vehicle);
      if (res.userDeliveryInfo?.state) ctx.store.set('userState', res.userDeliveryInfo.state);
      return {
        vehicles: inv.vehicles.map((vehicle: any) => ({
          vehicleId: vehicle.vehicleId, stockNumber: vehicle.stockNumber, year: vehicle.year, make: vehicle.make, model: vehicle.model, trim: vehicle.trim,
          mileage: vehicle.mileage, color: vehicle.color, price: vehicle.price.total, estimatedTaxesAndFees: vehicle.price.estimatedTaxesAndFees,
          ...ctx.derived('vehicle', vehicle), locationId: vehicle.locationId, deepLink: ctx.link('vehicle', { vehicleId: vehicle.vehicleId }),
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
        suggestions: res.suggestedFilters.map((suggestion: any) => ({ suggestionId: suggestion.suggestionId, label: suggestion.displayName, matches: suggestion.totalMatchedInventory })),
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
        ratingCounts: res.summary.rating_counts.map((bucket: { key: number; doc_count: number }) => ({ stars: bucket.key, count: bucket.doc_count })),
        reviews: res.reviews.map((review: any) => ({ text: ctx.fence(review.review_text, 'carvana-reviews'), rating: review.review_rating, date: review.review_date })),
      };
    },
    // vehicle_details waits for a recording of a vehicle page, to build and test its page reader against.
  },

  valueSources: { facets: facetsRequest },

  sections: {
    reviews(view: EntityView) {
      const ownerReviews = view.byTool.get_owner_reviews as Reviews | undefined;
      if (!ownerReviews) return null;
      const counts = ownerReviews.ratingCounts ?? [];
      const total = counts.reduce((sum, bucket) => sum + bucket.count, 0);
      const high = counts.filter((bucket) => bucket.stars >= 4).reduce((sum, bucket) => sum + bucket.count, 0);
      return {
        ...(total ? { summary: `${groupDigits(high)} of ${groupDigits(total)} owner ratings are 4 or 5 stars.` } : {}),
        lines: ownerReviews.reviews.slice(0, 5).map((review) => ({ text: unfence(review.text), meta: review.date })),
      };
    },
  },
};
