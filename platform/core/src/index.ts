// core.js, the tool runtime. Phase 2: the pure logic, with no I/O. Everything site-specific comes from the site pack.
export { base64, fill, hasPlaceholder, show, utf8 } from './text.ts';
export { computeDerived, derivedFields, FormulaError, parseFormula, type DerivedField, type Formula } from './formula.ts';
export { buildLink, deepLink, linkPlaceholders, type LinkResult } from './links.ts';
export { cleanText, DEFAULT_MAX_LENGTH, fence } from './sanitize.ts';
export { IdSet, idShapeOk, type IdPathSpec, type IdStatus, type IdValue, type IdView } from './ids.ts';
export { CallBudget, effectivePolicy, RateLimiter, type Acquired, type Budgets, type Policy, type Scope } from './limits.ts';
export { errorFor, PLATFORM_ERRORS, platformError, siteError, type PlatformReason } from './errors.ts';
export {
  allowedValueRules, checkPresentation, checkToolCall, fieldsShown, missingNotices, missingValueSources, withRequiredNotices,
  type CheckContext,
} from './checks.ts';
