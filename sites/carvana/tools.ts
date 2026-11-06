// Carvana's tools: how each tool in site.yaml maps to the requests Carvana's frontend sends, and back to the output the
// model sees. Everything goes through the ToolContext, so the platform's checks, budget, rate limit and cache apply.
// Constant values here are copied from what the frontend sends (boundary rule: only values the frontend produces).
import { groupDigits, unfence, type EntityView, type SiteCode, type ToolContext } from '../../platform/core/src/index.ts';
import { flightData, namedObjectText, scriptsIn } from './flight.ts';

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
  /** The listed price, when the car came from its own page. */
  price?: number;
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

/** The car on the user's screen, if it's this one; kept for display, so its card shows what its page shows. */
function carOnScreen(ctx: ToolContext, vehicleId: number): CarRecord | null {
  const page = ctx.pageData() as CarRecord | null;
  if (!page || page.vehicleId !== vehicleId) return null;
  ctx.keep('vehicle', vehicleId, { year: page.year, make: page.make, model: page.model, trim: page.trim, mileage: page.mileage, color: page.color, ...(page.price !== undefined ? { price: page.price } : {}) });
  return page;
}

/** The car's record: from a search earlier in this session, or from the page of the car the user is on. */
function carRecord(ctx: ToolContext, vehicleId: number): CarRecord {
  const found = ctx.store.get(`vehicle:${vehicleId}`) as CarRecord | undefined;
  if (found) return found;
  return carOnScreen(ctx, vehicleId) ?? ctx.fail('car_unknown', { vehicleId });
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
  reviews: { text: string; rating: number | null; date: string }[];
}

/** Manufacturer warranty left on one coverage; null where Carvana doesn't say. */
interface Remaining { months: number | null; miles: number | null }

/** A car's own page, as its parser reads it (endpoints/vehicle-page.response.json). */
interface VehiclePage {
  vehicleId: number;
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  mileage: number;
  saleStatus: string;
  highlights: { name: string; description: string }[];
  accidentReported: boolean;
  priorUse: string[];
  keys: number | null;
  recalls: number;
  warranty: { basic: Remaining; drivetrain: Remaining; battery: Remaining };
  features: { category: string; names: string[] }[];
  options: string[];
  packages: string[];
  imperfections: { title: string; description: string; location: string; area: string }[];
  inspection: { date: string; points: number; notPassed: { category: string; point: string; status: string }[] } | null;
}

/** vehicle_details' output: the page, with the inspectors' notes fenced and a link to the page. */
type VehicleDetails = VehiclePage & { deepLink: string };

const remaining = (months: unknown, miles: unknown): Remaining => ({ months: (months ?? null) as number | null, miles: (miles ?? null) as number | null });

/**
 * Reads a car's page (vehicle_page). The page streams its data as Next.js chunks; the car is the vehicleDetails object
 * in them (recorded 2026-11-05):
 *   1. Find the object; without one there's nothing to read, and null fails the response check.
 *   2. Copy the fields vehicle_details returns, under our names. Nothing is filled in for a field Carvana drops or
 *      reshapes: it comes out missing or mistyped, and the response check fails rather than showing wrong data.
 *      Only fields Carvana may leave out by design (warranty a car doesn't have, a highlight without an explanation)
 *      get a null or empty value.
 */
export function parseVehiclePage(html: string): VehiclePage | null {
  // 1. The object.
  const text = namedObjectText(flightData(scriptsIn(html)), 'vehicleDetails');
  if (!text) return null;
  const car = JSON.parse(text);
  // 2. The fields.
  const inspection = car.inspectionReport;
  const points = inspection?.inspectionCategories?.flatMap((category: any) => category.inspectionPoints.map((point: any) => ({ category: category.description, point: point.description, status: point.status })));
  return {
    vehicleId: car.vehicleId, vin: car.vin, year: car.year, make: car.make, model: car.model, trim: car.trim, mileage: car.mileage, saleStatus: car.saleStatus,
    // The tags the page shows, in its order. Some repeat their name as their explanation; that says nothing more.
    highlights: car.highlights?.filter((tag: any) => tag.isVdpDisplayable).sort((left: any, right: any) => left.sortOrder - right.sortOrder)
      .map((tag: any) => ({ name: tag.tagName, description: tag.tagDescription && tag.tagDescription !== tag.tagName ? tag.tagDescription : '' })),
    accidentReported: car.isAutocheckReportAccidentVehicle,
    priorUse: car.priorUseTypes,
    keys: car.numberOfKeys ?? null,
    recalls: car.recalls?.length,
    warranty: {
      basic: remaining(car.remainingWarrantyMonths, car.remainingWarrantyMiles),
      drivetrain: remaining(car.remainingDriveTrainWarrantyMonths, car.remainingDriveTrainWarrantyMiles),
      battery: remaining(car.remainingBatteryWarrantyMonths, car.remainingBatteryWarrantyMiles),
    },
    features: car.cvnaCategories?.map((category: any) => ({ category: category.name, names: category.cvnaFeatures.map((feature: any) => feature.name) }))
      .filter((category: { names: string[] }) => category.names.length),
    options: car.catalogFeatures?.options?.map((option: any) => option.name),
    packages: car.catalogFeatures?.packages?.map((option: any) => (typeof option === 'string' ? option : option.name)),
    imperfections: car.vexVdpImageData?.imperfections?.map((imperfection: any) => ({ title: imperfection.title, description: imperfection.description, location: imperfection.location, area: imperfection.zoneDescription })),
    inspection: inspection ? { date: inspection.inspectedOn, points: points.length, notPassed: points.filter((point: { status: string }) => point.status !== 'Passed') } : null,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Oct 21, 2026", without Intl, which not every engine core.js runs in has. */
const dayOf = (iso: string) => {
  const date = new Date(iso);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
};
/** "FixedOrReplaced" as "fixed or replaced". */
const statusText = (status: string) => status.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const warrantyText = (name: string, left: Remaining) => (left.months === null && left.miles === null ? null
  : `${name} ${[left.months !== null ? `${left.months} mo` : '', left.miles !== null ? `${groupDigits(left.miles)} mi` : ''].filter(Boolean).join(' or ')}`);

export const site: SiteCode = {
  tools: {
    async search_vehicles(ctx) {
      const args = ctx.args as SearchArgs;
      // Carvana refuses Sprinkles with any sort but MostPopular (400, seen live); its own pages leave it out then.
      const body = searchBody(args, (args.sort ?? 'MostPopular') === 'MostPopular' ? SEARCH_FEATURES : SEARCH_FEATURES.filter((feature) => feature !== 'Sprinkles'));
      const res = await ctx.call('search', { body });
      const inv = res.inventory;
      if (!inv.vehicles.length) ctx.fail('no_results');
      for (const vehicle of inv.vehicles) ctx.store.set(`vehicle:${vehicle.vehicleId}`, vehicle);
      if (res.userDeliveryInfo?.state) ctx.store.set('userState', res.userDeliveryInfo.state);
      return {
        vehicles: inv.vehicles.map((vehicle: any) => ({
          vehicleId: vehicle.vehicleId, stockNumber: vehicle.stockNumber, vin: vehicle.vin, year: vehicle.year, make: vehicle.make, model: vehicle.model, trim: vehicle.trim,
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
        // Carvana sends 0 for a review written without stars; 0 stars would misreport it.
        reviews: res.reviews.map((review: any) => ({ text: ctx.fence(review.review_text, 'carvana-reviews'), rating: review.review_rating >= 1 ? review.review_rating : null, date: review.review_date })),
      };
    },

    async vehicle_details(ctx) {
      const { vehicleId } = ctx.args as { vehicleId: number };
      const page = await ctx.call('vehicle_page', { params: { vehicleId } }) as VehiclePage;
      carOnScreen(ctx, vehicleId);
      return {
        ...page,
        vehicleId,
        // Carvana's inspectors wrote these notes, not us; fenced like any text the model should report on, not follow.
        imperfections: page.imperfections.map((imperfection) => ({ ...imperfection, description: ctx.fence(imperfection.description, 'carvana-vehicle') })),
        deepLink: ctx.link('vehicle', { vehicleId }),
      };
    },
  },

  parsers: { vehicle_page: parseVehiclePage },

  valueSources: { facets: facetsRequest },
  // The results page carries its filters as base64 JSON, in the same shape the search request sends them.
  destinations: { search_results: (args: SearchArgs, link) => link('search', { cvnaid: { filters: filtersFrom(args) } }) },

  sections: {
    /** What Carvana knows of the car's past and state: the accident report, prior use, inspection, recalls, keys, warranty. */
    condition(view: EntityView) {
      const details = view.byTool.vehicle_details as VehicleDetails | undefined;
      if (!details) return null;
      const { inspection, warranty } = details;
      const warrantyLeft = [warrantyText('basic', warranty.basic), warrantyText('drivetrain', warranty.drivetrain), warrantyText('battery', warranty.battery)].filter(Boolean);
      // Inspection points not simply passed, one line per category and status, so 11 items read as a few lines.
      const groups = new Map<string, string[]>();
      for (const point of inspection?.notPassed ?? []) {
        const key = `${point.category}\u0000${point.status}`;
        groups.set(key, [...(groups.get(key) ?? []), point.point]);
      }
      const lines = [
        { text: `Prior use: ${details.priorUse.join(', ') || 'not listed'}` },
        // Only the tags Carvana explains (Single Owner, from the CARFAX report); bare tags such as Luxury Vehicle say nothing of the car's past.
        ...details.highlights.filter((highlight) => highlight.description).map((highlight) => ({ text: highlight.name, meta: highlight.description })),
        ...(inspection ? [{ text: `Inspected ${dayOf(inspection.date)}: ${inspection.points} points`, meta: inspection.notPassed.length ? `${inspection.notPassed.length} fixed or replaced` : 'all passed' }] : []),
        ...[...groups].map(([key, points]) => {
          const [category, status] = key.split('\u0000') as [string, string];
          return { text: `${category}: ${points.join('; ')}`, meta: statusText(status) };
        }),
        { text: `Recalls listed: ${details.recalls || 'none'}` },
        ...(details.keys !== null ? [{ text: `Keys: ${details.keys}` }] : []),
        ...(warrantyLeft.length ? [{ text: `Warranty left: ${warrantyLeft.join('; ')}` }] : []),
      ];
      return { summary: details.accidentReported ? 'The AutoCheck report Carvana uses shows an accident.' : 'No accident on the AutoCheck report Carvana uses.', lines };
    },
    imperfections(view: EntityView) {
      const details = view.byTool.vehicle_details as VehicleDetails | undefined;
      if (!details) return null;
      const count = details.imperfections.length;
      return {
        summary: count ? `Carvana's inspectors photographed ${count} imperfection${count === 1 ? '' : 's'}.` : "Carvana's inspectors list no imperfections.",
        lines: details.imperfections.map((imperfection) => ({ text: `${imperfection.title}, ${imperfection.area.toLowerCase()}`, meta: unfence(imperfection.description) })),
      };
    },
    features(view: EntityView) {
      const details = view.byTool.vehicle_details as VehicleDetails | undefined;
      if (!details) return null;
      return {
        lines: [
          ...details.features.map((category) => ({ text: `${category.category}: ${category.names.join(', ')}` })),
          ...(details.options.length ? [{ text: `Factory options: ${details.options.join(', ')}` }] : []),
          ...(details.packages.length ? [{ text: `Packages: ${details.packages.join(', ')}` }] : []),
        ],
      };
    },
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
