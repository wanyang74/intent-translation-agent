// core.js, the tool runtime. Everything site-specific comes from the site pack and the site's code; everything
// platform-specific comes from the Host.
export { base64, fill, hasPlaceholder, show, utf8 } from './shared/text.ts';
export type { Host, HostRequest, HostResponse, LogEntry, ScriptResult, ScriptRunner } from './runtime/host.ts';
export { describeProblems, problemsWith, validatorFor, type Validator, type Validators } from './shared/validate.ts';
export { ToolFailure, type EndpointRequest, type EntityView, type SectionContent, type SiteCode, type ToolContext, type ToolImpl } from './execute/site-code.ts';
export { Session, type SessionOptions } from './runtime/session.ts';
export { callEndpoint, matchKey } from './execute/endpoints.ts';
export { checkContext, runToolCall, SCRIPT_LIMITS, SCRIPT_TOOL, type CallOutcome } from './execute/execute.ts';
export {
  cardOf, displayText, fieldValue, formatMoney, formatValue, groupDigits, NOT_AVAILABLE, present, presentToolResult, viewOf,
  type CardView, type DetailSection, type FieldView, type FormFieldView, type Presented, type UiComponent,
} from './present/present.ts';
export { amendTurn, makeTurn, runTurn, type AmendOutcome, type Surface, type TurnOutcome } from './link/link.ts';
export { acceptConfig, startSession, type CoreOptions } from './runtime/runtime.ts';
export { computeDerived, derivedFields, FormulaError, parseFormula, type DerivedField, type Formula } from './present/formula.ts';
export { buildLink, deepLink, linkPlaceholders, type LinkResult } from './present/links.ts';
export { cleanText, DEFAULT_MAX_LENGTH, fence, unfence } from './boundary/sanitize.ts';
export { IdSet, idShapeOk, type IdPathSpec, type IdStatus, type IdValue, type IdView } from './boundary/ids.ts';
export { CallBudget, effectivePolicy, RateLimiter, type Acquired, type Budgets, type Policy, type Scope } from './boundary/limits.ts';
export { errorFor, PLATFORM_ERRORS, platformError, siteError, type PlatformReason } from './boundary/errors.ts';
export {
  allowedValueRules, checkPresentation, checkToolCall, fieldsShown, missingNotices, missingValueSources, withRequiredNotices,
  type CheckContext,
} from './boundary/checks.ts';
