// Carvana's additions to the fixture builder (platform/testkit/scripts/build-fixtures.ts):
//   describe: one line per recorded request, in Carvana's terms
//   derive:   errors seen live in phase 0 (observed) and failures expected but not seen yet (synthetic)
import type { DeriveContext, Fixture } from '../../platform/testkit/src/fixtures.ts';

type Derived = Omit<Fixture, 'site'>;

function describeFilters(f: Record<string, any> = {}): string {
  const parts: string[] = [];
  for (const m of f.makes ?? []) parts.push([m.name, ...(m.parentModels ?? []).map((p: { name: string }) => p.name)].join(' '));
  if (f.year?.min) parts.push(`${f.year.min} or newer`);
  if (f.mileage?.max) parts.push(`under ${f.mileage.max} mi`);
  if (f.price?.max) parts.push(`under $${f.price.max}`);
  if (f.colors?.length) parts.push(f.colors.join('/'));
  if (f.interiorColors?.length) parts.push(`${f.interiorColors.join('/')} interior`);
  if (f.driveTypes?.length) parts.push(f.driveTypes.join('/'));
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

const without = (body: unknown, ...keys: string[]) => Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => !keys.includes(k)));
const PHASE0 = 'phase 0 live check, 2026-10-11';

export function derive({ first, placeholder }: DeriveContext): Derived[] {
  const out: Derived[] = [];
  {
    const f = first('pricing');
    out.push({
      ...f, id: 'pricing-err-no-client-id', kind: 'observed', source: PHASE0, trigger: { fields: ['analyticsData.clientId'] },
      description: 'quote request without analyticsData.clientId: 400 "ClientId cannot be null"',
      request: { ...f.request, body: without(f.request.body, 'analyticsData', 'browserCookieId') },
      response: { status: 400, headers: { 'content-type': 'text/plain' }, body: 'ClientId cannot be null' },
    });
  }
  {
    const f = first('suggest');
    out.push({
      ...f, id: 'suggest-err-no-ids', kind: 'observed', source: PHASE0, trigger: { fields: ['browserCookieId', 'analyticsData.clientId'] },
      description: 'suggestions request without a visitor ID and client ID: 400 "Invalid Request"',
      request: { ...f.request, body: without(f.request.body, 'analyticsData', 'browserCookieId') },
      response: { status: 400, headers: { 'content-type': 'text/plain' }, body: 'Invalid Request' },
    });
  }
  {
    const f = first('gap');
    const url = new URL(f.request.url);
    url.searchParams.set('amountFinanced', 'null');
    out.push({
      ...f, id: 'gap-err-null-amount', kind: 'observed', source: PHASE0, trigger: { fields: ['amountFinanced'] },
      description: 'GAP waiver request with amountFinanced=null: 400 validation problem',
      request: { ...f.request, url: url.toString() },
      response: {
        status: 400, headers: { 'content-type': 'application/problem+json' },
        body: { type: 'https://tools.ietf.org/html/rfc7231#section-6.5.1', title: 'One or more validation errors occurred.', status: 400, traceId: placeholder('|8bf72f0f-48ab2b42fd05a20c.'), errors: { AmountFinanced: ["The value 'null' is not valid for AmountFinanced."] } },
      },
    });
  }
  {
    const f = first('search');
    const body = structuredClone(f.request.body) as Record<string, any>;
    body.filters = { makes: [{ name: 'Tesla' }], year: { min: 2026 }, mileage: { max: 100 } };
    const res = structuredClone(f.response.body) as Record<string, any>;
    res.inventory.vehicles = [];
    res.inventory.conditionalTiles = [];
    Object.assign(res.inventory.pagination, { totalMatchedInventory: 0, totalMatchedPages: 0 });
    out.push({
      ...f, id: 'search-no-results', kind: 'synthetic', source: `edited copy of ${f.id}`,
      description: `${describeFilters(body.filters)}, page 1: no matching cars`,
      request: { ...f.request, body }, response: { ...f.response, body: res },
    });
  }
  {
    const f = first('availability');
    const body = structuredClone(f.request.body) as Record<string, any>;
    body.vehicles = body.vehicles.slice(0, 1);
    const res = structuredClone(f.response.body) as Record<string, any>;
    res.content = res.content.filter((c: { vehicleId: number }) => c.vehicleId === body.vehicles[0].vehicleId);
    res.content[0].soonestDelivery = { content: null, status: 'Failed', errorMessage: 'No delivery route available' };
    out.push({
      ...f, id: 'availability-no-delivery', kind: 'synthetic', source: `edited copy of ${f.id}`,
      description: `1 car whose delivery option failed (pickup still available); the failure shape is a guess`,
      request: { ...f.request, body }, response: { ...f.response, body: res },
    });
  }
  {
    const f = first('pricing');
    const body = structuredClone(f.request.body) as Record<string, any>;
    body.zip5 = '99701';
    const res = structuredClone(f.response.body) as Record<string, any>;
    res.price.pricingErrorMessage = 'Unable to price vehicle for this location';
    res.errors = ['Unable to price vehicle for this location'];
    out.push({
      ...f, id: 'pricing-error', kind: 'synthetic', source: `edited copy of ${f.id}`,
      description: `car ${body.vehicleId} at zip ${body.zip5}: Carvana couldn't price it; the error shape is a guess`,
      request: { ...f.request, body }, response: { ...f.response, body: res },
    });
  }
  {
    const f = first('search');
    const body = structuredClone(f.request.body) as Record<string, any>;
    body.pagination = { ...body.pagination, page: 30 };
    const res = structuredClone(f.response.body) as Record<string, any>;
    for (const v of res.inventory.vehicles) delete v.price.estimatedTaxesAndFees;
    out.push({
      ...f, id: 'search-shape-changed', kind: 'synthetic', source: `edited copy of ${f.id}`, expect: 'contract_violation',
      description: 'search response missing price.estimatedTaxesAndFees on every car: a shape change the change monitor must catch',
      request: { ...f.request, body }, response: { ...f.response, body: res },
    });
  }
  return out;
}
