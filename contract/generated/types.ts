// Generated from contract/schemas by contract/scripts/generate.ts. Do not edit; run `npm run generate`.
/**
 * Carvana's vehicle ID. Tools and presentation calls accept only IDs a tool returned in this session.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "VehicleId".
 */
export type VehicleId = number;
/**
 * Always passed explicitly: from the page context or the user, never the browser's location.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "Zip5".
 */
export type Zip5 = string;
/**
 * Carvana bulk availability request (POST /merch/buffering/api/v1/soonestavailabilitybulk). The frontend sends two shapes. We send only the search-page shape, which phase 0 verified live; the vehicle-page shape is documented so recorded traffic still validates. Headers clientid, browsercookieid and correlationid are sent as the frontend does, with fresh IDs (not tested without them).
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaAvailabilityRequest".
 */
export type CarvanaAvailabilityRequest = CarvanaAvailabilitySearchPageShape | CarvanaAvailabilityVehiclePageShape;
/**
 * ISO 8601 date and time with a time zone, e.g. 2026-10-11T00:15:00Z. A pattern rather than format: date-time, so validators need no format library at runtime.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "DateTime".
 */
export type DateTime = string;
/**
 * Opaque and server-issued. Gzip-compressed, base64url-encoded JSON of servicing location and zip code. Never built by us.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "RouteId".
 */
export type RouteId = string;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "UsState".
 */
export type UsState = string;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "Money".
 */
export type Money = number;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "StockNumber".
 */
export type StockNumber = number;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "SuggestionId".
 */
export type SuggestionId = string;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CallId".
 */
export type CallId = string;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "TraceId".
 */
export type TraceId = string;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "SessionId".
 */
export type SessionId = string;
/**
 * Third-party text after the sanitizer: control characters removed, length capped, wrapped in a labeled fence.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "Fenced".
 */
export type Fenced = string;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "ToolResult".
 */
export type ToolResult =
  | {
      id: CallId;
      ok: true;
      output: {};
    }
  | {
      id: CallId;
      ok: false;
      error: ToolError;
    };
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "PresentationCall".
 */
export type PresentationCall =
  | {
      name: 'present_vehicles';
      args: PresentVehiclesArgs;
    }
  | {
      name: 'present_comparison';
      args: PresentComparisonArgs;
    }
  | {
      name: 'present_quote';
      args: PresentQuoteArgs;
    }
  | {
      name: 'present_filter_suggestions';
      args: PresentFilterSuggestionsArgs;
    };
/**
 * Carvana's vehicle ID. Tools and presentation calls accept only IDs a tool returned in this session.
 */
export type VehicleId1 = number;
/**
 * Carvana's vehicle ID. Tools and presentation calls accept only IDs a tool returned in this session.
 */
export type VehicleId2 = number;
export type SuggestionId1 = string;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "ClientMessage".
 */
export type ClientMessage = ClientTurn | ClientResults;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "ServerEvent".
 */
export type ServerEvent = ToolCallEvent | ProgressEvent | AwaitResultsEvent | AnswerEvent | ErrorEvent;
/**
 * Messages between the client (core.js) and the agentic brain. Client messages are POSTed; server events stream back as newline-delimited JSON. Every message carries a trace ID.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "Message".
 */
export type Message = ClientMessage | ServerEvent;
/**
 * Carvana's vehicle ID. Tools and presentation calls accept only IDs a tool returned in this session.
 */
export type VehicleId3 = number;
/**
 * Carvana's vehicle ID. Tools and presentation calls accept only IDs a tool returned in this session.
 */
export type VehicleId4 = number;

/**
 * Sent with header clientid: srp_ui. The only shape we send.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaAvailabilitySearchPageShape".
 */
export interface CarvanaAvailabilitySearchPageShape {
  userId: string;
  /**
   * @minItems 1
   * @maxItems 100
   */
  vehicles: [
    {
      vehicleId: VehicleId;
      vehicleLocationId: number;
      /**
       * Mapped from the search response's vehicleInventoryType: 1 -> Core, 2 -> Unknown (seen on an on-demand car).
       */
      vehicleInventoryType: 'Core' | 'Unknown';
      vehicleSaleStatus: 'Available';
    },
    ...{
      vehicleId: VehicleId;
      vehicleLocationId: number;
      /**
       * Mapped from the search response's vehicleInventoryType: 1 -> Core, 2 -> Unknown (seen on an on-demand car).
       */
      vehicleInventoryType: 'Core' | 'Unknown';
      vehicleSaleStatus: 'Available';
    }[]
  ];
  zipCode: Zip5;
}
/**
 * Sent by the vehicle page with header clientid: vdp_ui: no userId, no sale status, and once a capitalized VehicleLocationId. Documented only; we don't send it.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaAvailabilityVehiclePageShape".
 */
export interface CarvanaAvailabilityVehiclePageShape {
  /**
   * @minItems 1
   * @maxItems 100
   */
  vehicles: [
    {
      vehicleId: VehicleId;
      vehicleLocationId?: number;
      VehicleLocationId?: number;
      /**
       * Mapped from the search response's vehicleInventoryType: 1 -> Core, 2 -> Unknown (seen on an on-demand car).
       */
      vehicleInventoryType: 'Core' | 'Unknown';
    },
    ...{
      vehicleId: VehicleId;
      vehicleLocationId?: number;
      VehicleLocationId?: number;
      /**
       * Mapped from the search response's vehicleInventoryType: 1 -> Core, 2 -> Unknown (seen on an on-demand car).
       */
      vehicleInventoryType: 'Core' | 'Unknown';
    }[]
  ];
  zipCode: Zip5;
}
/**
 * Carvana bulk availability response
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaAvailabilityResponse".
 */
export interface CarvanaAvailabilityResponse {
  content: {
    vehicleId: VehicleId;
    closestLocationId?: {
      content: number | null;
      status: string;
      [k: string]: unknown | undefined;
    };
    soonestDelivery: {
      status: string;
      errorMessage?: string;
      content: null | {
        activityType: string;
        asSoonAsText: string;
        daysToAvailability: number;
        utcSoonestDateTimeIso: DateTime;
        drivingMiles?: number;
        servicingLocationId: number;
        locationCity: string;
        locationState: string;
        routeId: RouteId;
        [k: string]: unknown | undefined;
      };
      [k: string]: unknown | undefined;
    };
    soonestPickup: {
      status: string;
      errorMessage?: string;
      content: null | {
        activityType: string;
        asSoonAsText: string;
        daysToAvailability: number;
        utcSoonestDateTimeIso: DateTime;
        drivingMiles?: number;
        servicingLocationId: number;
        locationCity: string;
        locationState: string;
        routeId: RouteId;
        [k: string]: unknown | undefined;
      };
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  }[];
  status: string;
  errorMessage?: string;
  [k: string]: unknown | undefined;
}
/**
 * Carvana facets request (POST /merch/search/api/v2/search/facets)
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaFacetsRequest".
 */
export interface CarvanaFacetsRequest {
  dealershipId?: null;
  filters: Filters;
  pagination: {
    page: number;
    pageSize: 24;
  };
  /**
   * @minItems 1
   */
  requestedFeatures: [string, ...string[]];
  sortBy: string;
  zip5: Zip5;
  browserCookieId?: string;
  analyticsData?: AnalyticsData;
}
/**
 * Carvana search filters. Only keys the frontend produces: seen in requests or in Carvana's own filter suggestions, plus facet groups. Values come from the facets response.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "Filters".
 */
export interface Filters {
  makes?: Make[];
  year?: Range;
  mileage?: Range;
  price?: Range;
  colors?: string[];
  interiorColors?: string[];
  driveTypes?: string[];
  bodyStyles?: string[];
  transmissions?: string[];
  fuelTypes?: string[];
  tagIds?: string[];
  cvnaFeatures?: string[];
  isFreeDelivery?: boolean;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "Make".
 */
export interface Make {
  name: string;
  parentModels?: {
    name: string;
    trims?: string[];
  }[];
  models?: string[];
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "Range".
 */
export interface Range {
  min?: number;
  max?: number;
}
/**
 * The frontend's tracking block. We send only the fields an endpoint requires, with fresh IDs (decision D4).
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "AnalyticsData".
 */
export interface AnalyticsData {
  clientId?: string;
  [k: string]: unknown | undefined;
}
/**
 * Carvana facets response. The valid values for each filter. Boundary checks only accept filter values that appear here.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaFacetsResponse".
 */
export interface CarvanaFacetsResponse {
  pagination: {
    currentPage: number;
    pageSize: number;
    totalMatchedInventory: number;
    totalMatchedPages: number;
    [k: string]: unknown | undefined;
  };
  colors?: {
    type: string;
    buckets: {
      key: string;
      count: number;
      isApplied: boolean;
      displayName: string;
      [k: string]: unknown | undefined;
    }[];
    [k: string]: unknown | undefined;
  };
  interiorColors?: {
    type: string;
    buckets: {
      key: string;
      count: number;
      isApplied: boolean;
      displayName: string;
      [k: string]: unknown | undefined;
    }[];
    [k: string]: unknown | undefined;
  };
  driveTypes?: {
    type: string;
    buckets: {
      key: string;
      count: number;
      isApplied: boolean;
      displayName: string;
      [k: string]: unknown | undefined;
    }[];
    [k: string]: unknown | undefined;
  };
  bodyStyles?: {
    type: string;
    buckets: {
      key: string;
      count: number;
      isApplied: boolean;
      displayName: string;
      [k: string]: unknown | undefined;
    }[];
    [k: string]: unknown | undefined;
  };
  transmissions?: {
    type: string;
    buckets: {
      key: string;
      count: number;
      isApplied: boolean;
      displayName: string;
      [k: string]: unknown | undefined;
    }[];
    [k: string]: unknown | undefined;
  };
  fuelTypes?: {
    type: string;
    buckets: {
      key: string;
      count: number;
      isApplied: boolean;
      displayName: string;
      [k: string]: unknown | undefined;
    }[];
    [k: string]: unknown | undefined;
  };
  tagIds?: {
    type: string;
    buckets: {
      key: string;
      count: number;
      isApplied: boolean;
      displayName: string;
      [k: string]: unknown | undefined;
    }[];
    [k: string]: unknown | undefined;
  };
  price?: {
    type: string;
    key: string;
    min: number;
    max: number;
    [k: string]: unknown | undefined;
  };
  year?: {
    type: string;
    key: string;
    min: number;
    max: number;
    [k: string]: unknown | undefined;
  };
  mileage?: {
    type: string;
    key: string;
    min: number;
    max: number;
    [k: string]: unknown | undefined;
  };
  makes?: {
    [k: string]:
      | {
          key: string;
          count: number;
          isApplied: boolean;
          models?: {
            key: string;
            parentModel?: string;
            count: number;
            isApplied?: boolean;
            [k: string]: unknown | undefined;
          }[];
          [k: string]: unknown | undefined;
        }
      | undefined;
  };
  [k: string]: unknown | undefined;
}
/**
 * Carvana GAP waiver request (GET /ancillary-products-api/api/v2/GapWaiver/availability, query string). amountFinanced is price + estimated taxes and fees, as the frontend computes it.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaGapRequest".
 */
export interface CarvanaGapRequest {
  amountFinanced: string;
  homeState: UsState;
  institutionName: 'Carvana';
  paymentType: 'Financing';
  vehicleId: string;
}
/**
 * Carvana GAP waiver response
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaGapResponse".
 */
export interface CarvanaGapResponse {
  isGapWaiverAvailable: boolean;
  price: number | null;
  [k: string]: unknown | undefined;
}
/**
 * Carvana quote request (POST /merch/search/api/v2/pricing/vehicle). Fails with 'ClientId cannot be null' without analyticsData.clientId (phase 0).
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaPricingRequest".
 */
export interface CarvanaPricingRequest {
  vehicleId: VehicleId;
  routeId: RouteId;
  zip5: Zip5;
  applyTradeIn: boolean;
  applyVerboseLogging?: boolean;
  preferredAcquisitionName?: string;
  browserCookieId?: string;
  analyticsData: AnalyticsData & {
    clientId: 'vdp_ui';
  };
}
/**
 * Carvana quote response
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaPricingResponse".
 */
export interface CarvanaPricingResponse {
  vehicleId: VehicleId;
  price: {
    total: Money;
    estimatedTaxesAndFees: Money;
    monthlyPayment?: number;
    apr?: number;
    term?: number;
    transportCost?: number;
    pricingErrorMessage?: string;
    [k: string]: unknown | undefined;
  };
  errors: unknown[];
  offering?: string;
  financeInfo?: {
    isUsingSampleTerms?: boolean;
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
/**
 * Carvana owner reviews request (POST /merch/reviews/api/review/sv)
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaReviewsRequest".
 */
export interface CarvanaReviewsRequest {
  from: number;
  size: number;
  make: string;
  model: string;
  trim: string;
  year: number;
}
/**
 * Carvana owner reviews response. review_text is third-party text: it always passes through the sanitizer before the model sees it.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaReviewsResponse".
 */
export interface CarvanaReviewsResponse {
  summary: {
    review_count_total: number;
    rating_counts?: {
      key: number;
      doc_count: number;
      [k: string]: unknown | undefined;
    }[];
    [k: string]: unknown | undefined;
  };
  reviews: {
    review_id: number;
    review_text: string;
    review_date: string;
    review_rating: number;
    customer?: {
      name?: string;
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  }[];
  [k: string]: unknown | undefined;
}
/**
 * Carvana search request (POST /merch/search/api/v2/search). Also needs headers x-cvna-ncc-disabled: false and x-cvna-sebs-srp: true, as the frontend sends them.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaSearchRequest".
 */
export interface CarvanaSearchRequest {
  dealershipId?: null;
  filters: Filters;
  pagination: {
    page: number;
    pageSize: 24;
  };
  /**
   * @minItems 1
   */
  requestedFeatures: [string, ...string[]];
  sortBy: string;
  zip5: Zip5;
  browserCookieId?: string;
  analyticsData?: AnalyticsData;
  preferredAcquisitionName?: string;
}
/**
 * Carvana search response
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaSearchResponse".
 */
export interface CarvanaSearchResponse {
  inventory: {
    vehicles: {
      vehicleId: VehicleId;
      stockNumber: StockNumber;
      year: number;
      make: string;
      model: string;
      parentModel?: string;
      trim: string;
      kbbTrim?: string;
      mileage: number;
      color?: string;
      interiorColor?: string;
      locationId: number;
      vehicleInventoryType?: number;
      vdpSlug: string;
      isPurchasePending?: boolean;
      price: {
        total: Money;
        estimatedTaxesAndFees: Money;
        monthlyPayment?: number;
        apr?: number;
        term?: number;
        transportCost?: number;
        pricingErrorMessage?: string;
        [k: string]: unknown | undefined;
      };
      [k: string]: unknown | undefined;
    }[];
    pagination: {
      currentPage: number;
      pageSize: number;
      totalMatchedInventory: number;
      totalMatchedPages: number;
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  };
  searchRequestId: string;
  [k: string]: unknown | undefined;
}
/**
 * Carvana filter suggestions request (POST /merch/search/api/v1/suggest/filters). Fails with 'Invalid Request' without browserCookieId and analyticsData.clientId (phase 0).
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaSuggestRequest".
 */
export interface CarvanaSuggestRequest {
  dealershipId?: null;
  filters: Filters;
  pagination: {
    page: number;
    pageSize: 24;
  };
  /**
   * @minItems 1
   */
  requestedFeatures: [string, ...string[]];
  sortBy: string;
  zip5: Zip5;
  browserCookieId: string;
  analyticsData: AnalyticsData & {
    clientId: 'srp_ui';
  };
  numberOfSuggestedFilters?: number;
}
/**
 * Carvana filter suggestions response
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaSuggestResponse".
 */
export interface CarvanaSuggestResponse {
  suggestedFiltersRequestId: string;
  suggestedFilters: {
    suggestionId: SuggestionId;
    displayName: string;
    facetKey: string;
    suggestionKey?: string;
    totalMatchedInventory: number;
    searchFilters: Filters;
    [k: string]: unknown | undefined;
  }[];
  [k: string]: unknown | undefined;
}
/**
 * What our parser extracts from a vehicle page (GET /vehicle/{vehicleId}). Read from the Next.js data embedded in the page's HTML. The format is the site framework's own, so this is validated on every read and watched by the change monitor.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CarvanaVehiclePage".
 */
export interface CarvanaVehiclePage {
  vehicleId: VehicleId;
  vin: string;
  features: {
    category: string;
    /**
     * @minItems 1
     */
    names: [string, ...string[]];
  }[];
  imperfections: {
    title: string;
    description: string;
    location: string;
  }[];
  options: string[];
  packages: string[];
  highlights: string[];
}
/**
 * Remote config: off switches and budgets. Signed; core.js checks the signature before using it (signing scheme to be decided in phase 9).
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "RemoteConfig".
 */
export interface RemoteConfig {
  version: string;
  issuedAt: DateTime;
  disabledTools: (
    | 'search_vehicles'
    | 'get_delivery_dates'
    | 'suggest_refinements'
    | 'get_vehicle_quote'
    | 'compare_vehicles'
    | 'get_owner_reviews'
    | 'vehicle_details'
    | 'find_similar'
  )[];
  disabledSkills: string[];
  budgets: {
    perTask: number;
    perSession: number | null;
    perDay: number | null;
  };
  rateLimitPerSecond: number;
  signature: string;
}
/**
 * Tool error, as the model receives it. Errors are instructions the model can act on, never bare codes.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "ToolError".
 */
export interface ToolError {
  code:
    | 'unknown_id'
    | 'invalid_filter_value'
    | 'no_results'
    | 'route_other_zip'
    | 'route_missing'
    | 'pricing_error'
    | 'not_found'
    | 'format_changed'
    | 'budget_reached'
    | 'rate_limited'
    | 'tool_disabled'
    | 'upstream_error';
  message: string;
  retryable: boolean;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "PageContext".
 */
export interface PageContext {
  url: string;
  pageType: 'search' | 'vehicle' | 'other';
  zip5?: Zip5;
  vehicleId?: VehicleId;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "ClientTurn".
 */
export interface ClientTurn {
  type: 'turn';
  sessionId: SessionId;
  traceId: TraceId;
  message: string;
  pageContext: PageContext;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "ToolCall".
 */
export interface ToolCall {
  id: CallId;
  name:
    | 'search_vehicles'
    | 'get_delivery_dates'
    | 'suggest_refinements'
    | 'get_vehicle_quote'
    | 'compare_vehicles'
    | 'get_owner_reviews'
    | 'vehicle_details'
    | 'find_similar'
    | 'present_vehicles'
    | 'present_comparison'
    | 'present_quote'
    | 'present_filter_suggestions';
  args: {};
  /**
   * direct: Execute hands the result straight to Respond (fast path).
   */
  render?: 'direct' | 'after_brain';
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "ClientResults".
 */
export interface ClientResults {
  type: 'results';
  sessionId: SessionId;
  traceId: TraceId;
  /**
   * @minItems 1
   */
  results: [ToolResult, ...ToolResult[]];
}
/**
 * present_vehicles: an ordered list of vehicle cards. IDs and layout only. Execute fills in every displayed field from this session's tool results.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "PresentVehiclesArgs".
 */
export interface PresentVehiclesArgs {
  heading?: string;
  /**
   * @minItems 1
   * @maxItems 24
   */
  rows: [VehicleId1, ...VehicleId1[]];
}
/**
 * present_comparison: cars side by side
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "PresentComparisonArgs".
 */
export interface PresentComparisonArgs {
  /**
   * @minItems 2
   * @maxItems 4
   */
  vehicleIds:
    [VehicleId2, VehicleId2] | [VehicleId2, VehicleId2, VehicleId2] | [VehicleId2, VehicleId2, VehicleId2, VehicleId2];
  /**
   * @minItems 1
   * @maxItems 9
   */
  attributes:
    | ['price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating']
    | [
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating'
      ]
    | [
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating'
      ]
    | [
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating'
      ]
    | [
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating'
      ]
    | [
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating'
      ]
    | [
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating'
      ]
    | [
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating'
      ]
    | [
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating',
        'price' | 'estimatedTotal' | 'mileage' | 'year' | 'trim' | 'color' | 'delivery' | 'gapWaiver' | 'ownerRating'
      ];
}
/**
 * present_quote: one car's quote card
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "PresentQuoteArgs".
 */
export interface PresentQuoteArgs {
  vehicleId: VehicleId;
}
/**
 * present_filter_suggestions: filter chips
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "PresentFilterSuggestionsArgs".
 */
export interface PresentFilterSuggestionsArgs {
  /**
   * @minItems 1
   * @maxItems 10
   */
  suggestionIds:
    | [SuggestionId1]
    | [SuggestionId1, SuggestionId1]
    | [SuggestionId1, SuggestionId1, SuggestionId1]
    | [SuggestionId1, SuggestionId1, SuggestionId1, SuggestionId1]
    | [SuggestionId1, SuggestionId1, SuggestionId1, SuggestionId1, SuggestionId1]
    | [SuggestionId1, SuggestionId1, SuggestionId1, SuggestionId1, SuggestionId1, SuggestionId1]
    | [SuggestionId1, SuggestionId1, SuggestionId1, SuggestionId1, SuggestionId1, SuggestionId1, SuggestionId1]
    | [
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1
      ]
    | [
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1
      ]
    | [
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1,
        SuggestionId1
      ];
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "ToolCallEvent".
 */
export interface ToolCallEvent {
  type: 'tool_call';
  traceId: TraceId;
  call: ToolCall;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "ProgressEvent".
 */
export interface ProgressEvent {
  type: 'progress';
  traceId: TraceId;
  text: string;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "AwaitResultsEvent".
 */
export interface AwaitResultsEvent {
  type: 'await_results';
  traceId: TraceId;
  /**
   * @minItems 1
   */
  callIds: [CallId, ...CallId[]];
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "AnswerEvent".
 */
export interface AnswerEvent {
  type: 'answer';
  traceId: TraceId;
  text: string;
  present?: PresentationCall[];
  budgetReached?: boolean;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "ErrorEvent".
 */
export interface ErrorEvent {
  type: 'error';
  traceId: TraceId;
  code: 'timeout' | 'budget_reached' | 'unauthorized' | 'internal';
  message: string;
}
/**
 * compare_vehicles: input
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CompareVehiclesInput".
 */
export interface CompareVehiclesInput {
  /**
   * @minItems 2
   * @maxItems 4
   */
  vehicleIds:
    [VehicleId3, VehicleId3] | [VehicleId3, VehicleId3, VehicleId3] | [VehicleId3, VehicleId3, VehicleId3, VehicleId3];
  zip5: Zip5;
}
/**
 * compare_vehicles: output
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "CompareVehiclesOutput".
 */
export interface CompareVehiclesOutput {
  /**
   * @minItems 2
   * @maxItems 4
   */
  cars:
    | [GetVehicleQuoteOutput, GetVehicleQuoteOutput]
    | [GetVehicleQuoteOutput, GetVehicleQuoteOutput, GetVehicleQuoteOutput]
    | [GetVehicleQuoteOutput, GetVehicleQuoteOutput, GetVehicleQuoteOutput, GetVehicleQuoteOutput];
}
/**
 * get_vehicle_quote: output. No monthly payment or APR in the mini version: the output schema doesn't allow them.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "GetVehicleQuoteOutput".
 */
export interface GetVehicleQuoteOutput {
  vehicleId: VehicleId;
  price: Money;
  estimatedTaxesAndFees: Money;
  estimatedTotal: Money;
  option: 'delivery' | 'pickup';
  when?: string;
  gapWaiver: null | {
    available: boolean;
    price: number | null;
  };
}
/**
 * find_similar: input
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "FindSimilarInput".
 */
export interface FindSimilarInput {
  vehicleId: VehicleId;
  zip5: Zip5;
}
/**
 * find_similar: output
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "FindSimilarOutput".
 */
export interface FindSimilarOutput {
  /**
   * Items: No monthly payment or APR in the mini version: the output schema doesn't allow them.
   */
  vehicles: {
    vehicleId: VehicleId;
    stockNumber?: StockNumber;
    year: number;
    make: string;
    model: string;
    trim: string;
    mileage: number;
    color?: string;
    price: Money;
    estimatedTaxesAndFees: Money;
    estimatedTotal: Money;
    locationId: number;
    deepLink: string;
  }[];
  totalMatches: number;
  totalPages: number;
  page: number;
  searchLink: string;
  nextStep?: string;
}
/**
 * get_delivery_dates: input
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "GetDeliveryDatesInput".
 */
export interface GetDeliveryDatesInput {
  /**
   * @minItems 1
   * @maxItems 24
   */
  vehicleIds: [VehicleId4, ...VehicleId4[]];
  zip5: Zip5;
}
/**
 * get_delivery_dates: output
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "GetDeliveryDatesOutput".
 */
export interface GetDeliveryDatesOutput {
  dates: {
    vehicleId: VehicleId;
    delivery: null | {
      text: string;
      date: DateTime;
      location: string;
      routeId: RouteId;
    };
    pickup: null | {
      text: string;
      date: DateTime;
      location: string;
      routeId: RouteId;
    };
  }[];
  nextStep?: string;
}
/**
 * get_owner_reviews: input
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "GetOwnerReviewsInput".
 */
export interface GetOwnerReviewsInput {
  vehicleId: VehicleId;
}
/**
 * get_owner_reviews: output
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "GetOwnerReviewsOutput".
 */
export interface GetOwnerReviewsOutput {
  count: number;
  ratingCounts?: {
    stars: number;
    count: number;
  }[];
  /**
   * @maxItems 20
   */
  reviews:
    | []
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ]
    | [
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        },
        {
          text: Fenced;
          rating: number;
          date: string;
        }
      ];
}
/**
 * get_vehicle_quote: input
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "GetVehicleQuoteInput".
 */
export interface GetVehicleQuoteInput {
  vehicleId: VehicleId;
  zip5: Zip5;
  option?: 'delivery' | 'pickup';
}
/**
 * search_vehicles: input. Filter values must come from the facets response; the boundary checks refuse anything else.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "SearchVehiclesInput".
 */
export interface SearchVehiclesInput {
  zip5: Zip5;
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
/**
 * search_vehicles: output
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "SearchVehiclesOutput".
 */
export interface SearchVehiclesOutput {
  /**
   * Items: No monthly payment or APR in the mini version: the output schema doesn't allow them.
   */
  vehicles: {
    vehicleId: VehicleId;
    stockNumber?: StockNumber;
    year: number;
    make: string;
    model: string;
    trim: string;
    mileage: number;
    color?: string;
    price: Money;
    estimatedTaxesAndFees: Money;
    estimatedTotal: Money;
    locationId: number;
    deepLink: string;
  }[];
  totalMatches: number;
  totalPages: number;
  page: number;
  searchLink: string;
  nextStep?: string;
}
/**
 * suggest_refinements: input
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "SuggestRefinementsInput".
 */
export interface SuggestRefinementsInput {
  zip5: Zip5;
  current?: SearchVehiclesInput;
}
/**
 * suggest_refinements: output
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "SuggestRefinementsOutput".
 */
export interface SuggestRefinementsOutput {
  suggestions: {
    suggestionId: SuggestionId;
    label: string;
    matches: number;
  }[];
}
/**
 * vehicle_details: input
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "VehicleDetailsInput".
 */
export interface VehicleDetailsInput {
  vehicleId: VehicleId;
}
/**
 * vehicle_details: output
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "VehicleDetailsOutput".
 */
export interface VehicleDetailsOutput {
  vin: string;
  features: {
    category: string;
    /**
     * @minItems 1
     */
    names: [string, ...string[]];
  }[];
  imperfections: {
    title: string;
    description: Fenced;
    location: string;
  }[];
  options: string[];
  packages: string[];
  highlights: string[];
}
