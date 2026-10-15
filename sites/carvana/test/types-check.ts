// Compile-time checks on Carvana's generated types, run by `npm run typecheck` (never executed).
// Every @ts-expect-error line must fail to compile: if the types stop enforcing a rule, typecheck fails.
import type { GetVehicleQuoteOutput, PricingRequest, SearchVehiclesInput } from '../generated/types.ts';
import { validateGetVehicleQuoteOutput } from '../generated/validators.js';

const quote: GetVehicleQuoteOutput = { vehicleId: 4812031, price: 35590, estimatedTaxesAndFees: 3837, estimatedTotal: 39427, option: 'delivery', gapWaiver: { available: true, price: 1195 } };

// @ts-expect-error financing figures are hidden in the mini version
const withPayment: GetVehicleQuoteOutput = { ...quote, monthlyPayment: 651 };

// @ts-expect-error no filtering by monthly payment
const search: SearchVehiclesInput = { zip5: '94402', monthly_payment_max: 600 };

// @ts-expect-error a quote request needs a client ID in analyticsData
const pricing: PricingRequest = { vehicleId: 4812031, routeId: 'H4sI', zip5: '94402', applyTradeIn: true, analyticsData: {} };

/** A passing validator narrows unknown data to the generated type. */
export function estimatedTotalOf(data: unknown): number | null {
  return validateGetVehicleQuoteOutput(data) ? data.estimatedTotal : null;
}

void [quote, withPayment, search, pricing];
