// Generated from contract/schemas by contract/scripts/generate.ts. Do not edit; run `npm run generate`.
import type { CarvanaAvailabilityRequest, CarvanaAvailabilityResponse, CarvanaFacetsRequest, CarvanaFacetsResponse, CarvanaGapRequest, CarvanaGapResponse, CarvanaPricingRequest, CarvanaPricingResponse, CarvanaReviewsRequest, CarvanaReviewsResponse, CarvanaSearchRequest, CarvanaSearchResponse, CarvanaSuggestRequest, CarvanaSuggestResponse, CarvanaVehiclePage, RemoteConfig, ToolError, Message, PresentComparisonArgs, PresentFilterSuggestionsArgs, PresentQuoteArgs, PresentVehiclesArgs, CompareVehiclesInput, CompareVehiclesOutput, FindSimilarInput, FindSimilarOutput, GetDeliveryDatesInput, GetDeliveryDatesOutput, GetOwnerReviewsInput, GetOwnerReviewsOutput, GetVehicleQuoteInput, GetVehicleQuoteOutput, SearchVehiclesInput, SearchVehiclesOutput, SuggestRefinementsInput, SuggestRefinementsOutput, VehicleDetailsInput, VehicleDetailsOutput } from './types.ts';

export interface ValidationError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

/** Returns true when data matches the schema, and narrows its type. On false, the reasons are in .errors. */
export interface Validator<T> {
  (data: unknown): data is T;
  errors?: ValidationError[] | null;
}

/** contract/schemas/carvana/availability.request.json */
export declare const validateCarvanaAvailabilityRequest: Validator<CarvanaAvailabilityRequest>;
/** contract/schemas/carvana/availability.response.json */
export declare const validateCarvanaAvailabilityResponse: Validator<CarvanaAvailabilityResponse>;
/** contract/schemas/carvana/facets.request.json */
export declare const validateCarvanaFacetsRequest: Validator<CarvanaFacetsRequest>;
/** contract/schemas/carvana/facets.response.json */
export declare const validateCarvanaFacetsResponse: Validator<CarvanaFacetsResponse>;
/** contract/schemas/carvana/gap.request.json */
export declare const validateCarvanaGapRequest: Validator<CarvanaGapRequest>;
/** contract/schemas/carvana/gap.response.json */
export declare const validateCarvanaGapResponse: Validator<CarvanaGapResponse>;
/** contract/schemas/carvana/pricing.request.json */
export declare const validateCarvanaPricingRequest: Validator<CarvanaPricingRequest>;
/** contract/schemas/carvana/pricing.response.json */
export declare const validateCarvanaPricingResponse: Validator<CarvanaPricingResponse>;
/** contract/schemas/carvana/reviews.request.json */
export declare const validateCarvanaReviewsRequest: Validator<CarvanaReviewsRequest>;
/** contract/schemas/carvana/reviews.response.json */
export declare const validateCarvanaReviewsResponse: Validator<CarvanaReviewsResponse>;
/** contract/schemas/carvana/search.request.json */
export declare const validateCarvanaSearchRequest: Validator<CarvanaSearchRequest>;
/** contract/schemas/carvana/search.response.json */
export declare const validateCarvanaSearchResponse: Validator<CarvanaSearchResponse>;
/** contract/schemas/carvana/suggest.request.json */
export declare const validateCarvanaSuggestRequest: Validator<CarvanaSuggestRequest>;
/** contract/schemas/carvana/suggest.response.json */
export declare const validateCarvanaSuggestResponse: Validator<CarvanaSuggestResponse>;
/** contract/schemas/carvana/vehicle-page.json */
export declare const validateCarvanaVehiclePage: Validator<CarvanaVehiclePage>;
/** contract/schemas/config.json */
export declare const validateRemoteConfig: Validator<RemoteConfig>;
/** contract/schemas/errors.json */
export declare const validateToolError: Validator<ToolError>;
/** contract/schemas/messages.json */
export declare const validateMessage: Validator<Message>;
/** contract/schemas/presentation/present_comparison.json */
export declare const validatePresentComparisonArgs: Validator<PresentComparisonArgs>;
/** contract/schemas/presentation/present_filter_suggestions.json */
export declare const validatePresentFilterSuggestionsArgs: Validator<PresentFilterSuggestionsArgs>;
/** contract/schemas/presentation/present_quote.json */
export declare const validatePresentQuoteArgs: Validator<PresentQuoteArgs>;
/** contract/schemas/presentation/present_vehicles.json */
export declare const validatePresentVehiclesArgs: Validator<PresentVehiclesArgs>;
/** contract/schemas/tools/compare_vehicles.input.json */
export declare const validateCompareVehiclesInput: Validator<CompareVehiclesInput>;
/** contract/schemas/tools/compare_vehicles.output.json */
export declare const validateCompareVehiclesOutput: Validator<CompareVehiclesOutput>;
/** contract/schemas/tools/find_similar.input.json */
export declare const validateFindSimilarInput: Validator<FindSimilarInput>;
/** contract/schemas/tools/find_similar.output.json */
export declare const validateFindSimilarOutput: Validator<FindSimilarOutput>;
/** contract/schemas/tools/get_delivery_dates.input.json */
export declare const validateGetDeliveryDatesInput: Validator<GetDeliveryDatesInput>;
/** contract/schemas/tools/get_delivery_dates.output.json */
export declare const validateGetDeliveryDatesOutput: Validator<GetDeliveryDatesOutput>;
/** contract/schemas/tools/get_owner_reviews.input.json */
export declare const validateGetOwnerReviewsInput: Validator<GetOwnerReviewsInput>;
/** contract/schemas/tools/get_owner_reviews.output.json */
export declare const validateGetOwnerReviewsOutput: Validator<GetOwnerReviewsOutput>;
/** contract/schemas/tools/get_vehicle_quote.input.json */
export declare const validateGetVehicleQuoteInput: Validator<GetVehicleQuoteInput>;
/** contract/schemas/tools/get_vehicle_quote.output.json */
export declare const validateGetVehicleQuoteOutput: Validator<GetVehicleQuoteOutput>;
/** contract/schemas/tools/search_vehicles.input.json */
export declare const validateSearchVehiclesInput: Validator<SearchVehiclesInput>;
/** contract/schemas/tools/search_vehicles.output.json */
export declare const validateSearchVehiclesOutput: Validator<SearchVehiclesOutput>;
/** contract/schemas/tools/suggest_refinements.input.json */
export declare const validateSuggestRefinementsInput: Validator<SuggestRefinementsInput>;
/** contract/schemas/tools/suggest_refinements.output.json */
export declare const validateSuggestRefinementsOutput: Validator<SuggestRefinementsOutput>;
/** contract/schemas/tools/vehicle_details.input.json */
export declare const validateVehicleDetailsInput: Validator<VehicleDetailsInput>;
/** contract/schemas/tools/vehicle_details.output.json */
export declare const validateVehicleDetailsOutput: Validator<VehicleDetailsOutput>;
