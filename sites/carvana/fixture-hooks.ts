// Carvana's additions to the fixture builder (platform/testkit/scripts/build-fixtures.ts):
//   describe: one line per recorded request, in Carvana's terms
//   derive:   errors seen live in phase 0 (observed) and failures expected but not seen yet (synthetic)
import { readFileSync } from 'node:fs';
import type { DeriveContext, Fixture } from '../../platform/testkit/src/fixtures.ts';

type Derived = Omit<Fixture, 'site'>;

function describeFilters(filters: Record<string, any> = {}): string {
  const parts: string[] = [];
  for (const make of filters.makes ?? []) parts.push([make.name, ...(make.parentModels ?? []).map((model: { name: string }) => model.name)].join(' '));
  if (filters.year?.min) parts.push(`${filters.year.min} or newer`);
  if (filters.mileage?.max) parts.push(`under ${filters.mileage.max} mi`);
  if (filters.price?.max) parts.push(`under $${filters.price.max}`);
  if (filters.colors?.length) parts.push(filters.colors.join('/'));
  if (filters.interiorColors?.length) parts.push(`${filters.interiorColors.join('/')} interior`);
  if (filters.driveTypes?.length) parts.push(filters.driveTypes.join('/'));
  return parts.join(' · ') || 'no filters';
}

export function describe(endpoint: string, req: Record<string, any>, res: Record<string, any>): string {
  switch (endpoint) {
    case 'search': return `${describeFilters(req.filters)}, page ${req.pagination?.page}: ${res.inventory?.vehicles?.length} cars of ${res.inventory?.pagination?.totalMatchedInventory}`;
    case 'facets': return `${describeFilters(req.filters)}: valid filter values`;
    case 'suggest': return `${describeFilters(req.filters)}: ${res.suggestedFilters?.length} suggestions`;
    case 'availability': return `${req.vehicles?.length} car${req.vehicles?.length === 1 ? '' : 's'}, ${'userId' in req ? 'search-page' : 'vehicle-page'} shape`;
    case 'pricing': return `car ${req.vehicleId}, delivery route, zip ${req.zip5}`;
    case 'reviews': return `${req.year} ${req.make} ${req.model} ${req.trim}`;
    case 'gap': return `car ${req.vehicleId}, ${req.amountFinanced} financed`;
    default: return endpoint;
  }
}

const without = (body: unknown, ...keys: string[]) => Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([key]) => !keys.includes(key)));
const PHASE0 = 'phase 0 live check, 2026-10-11';
/** Carvana's sort orders, from search_vehicles' own schema, so a new one gets its fixtures too. */
const SORTS: string[] = JSON.parse(readFileSync(new URL('./schemas/tools/search_vehicles.input.json', import.meta.url), 'utf8')).properties.sort.enum;

export function derive({ first, placeholder }: DeriveContext): Derived[] {
  const out: Derived[] = [];
  {
    const fixture = first('pricing');
    out.push({
      ...fixture, id: 'pricing-err-no-client-id', kind: 'observed', source: PHASE0, trigger: { fields: ['analyticsData.clientId'] },
      description: 'quote request without analyticsData.clientId: 400 "ClientId cannot be null"',
      request: { ...fixture.request, body: without(fixture.request.body, 'analyticsData', 'browserCookieId') },
      response: { status: 400, headers: { 'content-type': 'text/plain' }, body: 'ClientId cannot be null' },
    });
  }
  {
    const fixture = first('suggest');
    out.push({
      ...fixture, id: 'suggest-err-no-ids', kind: 'observed', source: PHASE0, trigger: { fields: ['browserCookieId', 'analyticsData.clientId'] },
      description: 'suggestions request without a visitor ID and client ID: 400 "Invalid Request"',
      request: { ...fixture.request, body: without(fixture.request.body, 'analyticsData', 'browserCookieId') },
      response: { status: 400, headers: { 'content-type': 'text/plain' }, body: 'Invalid Request' },
    });
  }
  {
    const fixture = first('gap');
    const url = new URL(fixture.request.url);
    url.searchParams.set('amountFinanced', 'null');
    out.push({
      ...fixture, id: 'gap-err-null-amount', kind: 'observed', source: PHASE0, trigger: { fields: ['amountFinanced'] },
      description: 'GAP waiver request with amountFinanced=null: 400 validation problem',
      request: { ...fixture.request, url: url.toString() },
      response: {
        status: 400, headers: { 'content-type': 'application/problem+json' },
        body: { type: 'https://tools.ietf.org/html/rfc7231#section-6.5.1', title: 'One or more validation errors occurred.', status: 400, traceId: placeholder('|8bf72f0f-48ab2b42fd05a20c.'), errors: { AmountFinanced: ["The value 'null' is not valid for AmountFinanced."] } },
      },
    });
  }
  // A search with no matches, once per sort order: an empty list is empty in any order, so the model's choice of
  // sort shouldn't make the request unrecorded. The recorded sort keeps the original ID.
  {
    const fixture = first('search');
    const res = structuredClone(fixture.response.body) as Record<string, any>;
    res.inventory.vehicles = [];
    res.inventory.conditionalTiles = [];
    Object.assign(res.inventory.pagination, { totalMatchedInventory: 0, totalMatchedPages: 0 });
    const recordedSort = (fixture.request.body as Record<string, any>).sortBy;
    for (const sort of [recordedSort, ...SORTS.filter((candidate) => candidate !== recordedSort)]) {
      const body = structuredClone(fixture.request.body) as Record<string, any>;
      body.filters = { makes: [{ name: 'Tesla' }], year: { min: 2026 }, mileage: { max: 100 } };
      body.sortBy = sort;
      // As Carvana's own pages send it: Sprinkles only with MostPopular (any other sort with it gets a 400).
      if (sort !== 'MostPopular') body.requestedFeatures = body.requestedFeatures.filter((feature: string) => feature !== 'Sprinkles');
      out.push({
        ...fixture, id: sort === recordedSort ? 'search-no-results' : `search-no-results-${sort.toLowerCase()}`, kind: 'synthetic',
        source: `edited copy of ${fixture.id}`,
        description: `${describeFilters(body.filters)}, page 1${sort === recordedSort ? '' : `, ${sort}`}: no matching cars`,
        request: { ...fixture.request, body }, response: { ...fixture.response, body: structuredClone(res) },
      });
    }
  }
  {
    const fixture = first('availability');
    const body = structuredClone(fixture.request.body) as Record<string, any>;
    body.vehicles = body.vehicles.slice(0, 1);
    const res = structuredClone(fixture.response.body) as Record<string, any>;
    res.content = res.content.filter((item: { vehicleId: number }) => item.vehicleId === body.vehicles[0].vehicleId);
    res.content[0].soonestDelivery = { content: null, status: 'Failed', errorMessage: 'No delivery route available' };
    out.push({
      ...fixture, id: 'availability-no-delivery', kind: 'synthetic', source: `edited copy of ${fixture.id}`,
      description: `1 car whose delivery option failed (pickup still available); the failure shape is a guess`,
      request: { ...fixture.request, body }, response: { ...fixture.response, body: res },
    });
  }
  {
    const fixture = first('pricing');
    const body = structuredClone(fixture.request.body) as Record<string, any>;
    body.zip5 = '99701';
    const res = structuredClone(fixture.response.body) as Record<string, any>;
    res.price.pricingErrorMessage = 'Unable to price vehicle for this location';
    res.errors = ['Unable to price vehicle for this location'];
    out.push({
      ...fixture, id: 'pricing-error', kind: 'synthetic', source: `edited copy of ${fixture.id}`,
      description: `car ${body.vehicleId} at zip ${body.zip5}: Carvana couldn't price it; the error shape is a guess`,
      request: { ...fixture.request, body }, response: { ...fixture.response, body: res },
    });
  }
  {
    const fixture = first('search');
    const body = structuredClone(fixture.request.body) as Record<string, any>;
    body.pagination = { ...body.pagination, page: 30 };
    const res = structuredClone(fixture.response.body) as Record<string, any>;
    for (const vehicle of res.inventory.vehicles) delete vehicle.price.estimatedTaxesAndFees;
    out.push({
      ...fixture, id: 'search-shape-changed', kind: 'synthetic', source: `edited copy of ${fixture.id}`, expect: 'contract_violation',
      description: 'search response missing price.estimatedTaxesAndFees on every car: a shape change the change monitor must catch',
      request: { ...fixture.request, body }, response: { ...fixture.response, body: res },
    });
  }
  return out;
}
