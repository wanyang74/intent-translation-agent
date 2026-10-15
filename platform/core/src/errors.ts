// Errors the model can act on. Codes are the platform's (errors.json); each error also has a reason and a message.
// Site errors come from the site pack (each tool's errors); platform errors are problems core.js finds itself,
// worded the same on every site.
import type { SitePack, ToolError } from '../../contract/generated/types.ts';
import { fill, hasPlaceholder } from './text.ts';

type Code = ToolError['code'];
interface Template { code: Code; message: string; retryable: boolean }

/**
 * Platform reasons and their messages. The values each one is filled with are the standard names a site's own
 * message can use too: tool, details, value, field, options, kind, id, idType, what, scope, limit, section,
 * sections, fields, notice, form.
 */
export const PLATFORM_ERRORS = {
  unknown_tool: { code: 'invalid_value', message: "{tool} isn't a tool on this site. Use one of the tools you were given.", retryable: false },
  bad_arguments: { code: 'invalid_value', message: 'The arguments for {tool} are invalid: {details}. Fix them and call {tool} again.', retryable: true },
  not_allowed_value: { code: 'invalid_value', message: "'{value}' isn't one of the {field} offered here. Valid options: {options}.", retryable: true },
  unknown_id: { code: 'unknown_id', message: "{kind} {id} wasn't returned in this session. Use an ID from an earlier result.", retryable: true },
  bad_id: { code: 'invalid_value', message: '{id} isn\'t a valid {kind} ID: {kind} IDs are {idType}.', retryable: true },
  expired_id: { code: 'expired', message: '{kind} {id} has expired. Get a fresh one before using it.', retryable: true },
  needs_sign_in: { code: 'auth_required', message: 'The user needs to be signed in for {what}. Ask them to sign in on the site, then try again.', retryable: true },
  writes_off: { code: 'policy_blocked', message: "{tool} would change something on the site, which this version doesn't do. Give the user a link to do it on the site.", retryable: false },
  tool_disabled: { code: 'tool_disabled', message: '{tool} is unavailable right now. Answer without it and say so.', retryable: false },
  budget_reached: { code: 'budget_reached', message: 'This {scope} reached its limit of {limit} calls. Summarize what you have and offer to continue.', retryable: false },
  unknown_kind: { code: 'invalid_value', message: "{kind} isn't something this site shows.", retryable: false },
  internal_kind: { code: 'invalid_value', message: '{kind} items are never shown to the user.', retryable: false },
  unknown_field: { code: 'invalid_value', message: "{field} isn't a field of {kind}. Fields: {fields}.", retryable: true },
  unknown_section: { code: 'invalid_value', message: "{section} isn't a section of {kind}. Sections: {sections}.", retryable: true },
  unknown_notice: { code: 'invalid_value', message: "{notice} isn't a notice on this site.", retryable: false },
  unknown_form: { code: 'invalid_value', message: "{form} isn't a form on this site.", retryable: false },
  bad_prefill: { code: 'invalid_value', message: "{field} in {form} can't be prefilled with '{value}': {details}.", retryable: true },
} satisfies Record<string, Template>;

export type PlatformReason = keyof typeof PLATFORM_ERRORS;

export function platformError(reason: PlatformReason, values: Record<string, unknown> = {}): ToolError {
  const t: Template = PLATFORM_ERRORS[reason];
  return { code: t.code, reason, message: fill(t.message, values), retryable: t.retryable };
}

/** A site error by the reason a tool declares in the site pack, or null if the tool has no such error. */
export function siteError(pack: SitePack, tool: string, reason: string, values: Record<string, unknown> = {}): ToolError | null {
  const e = pack.tools[tool]?.errors?.[reason];
  if (!e) return null;
  return { code: e.code, reason, message: fill(e.message, values), retryable: e.retryable ?? false };
}

/**
 * For a problem core.js finds in a call to a tool: the tool's own wording when it declares exactly one error with
 * the same code and that message can be filled from the standard values; otherwise the platform's wording.
 */
export function errorFor(pack: SitePack, tool: string, reason: PlatformReason, values: Record<string, unknown>): ToolError {
  const own = Object.entries(pack.tools[tool]?.errors ?? {}).filter(([, e]) => e?.code === PLATFORM_ERRORS[reason].code);
  if (own.length === 1) {
    const [name, e] = own[0]!;
    const message = fill(e!.message, values);
    if (!hasPlaceholder(message)) return { code: e!.code, reason: name, message, retryable: e!.retryable ?? false };
  }
  return platformError(reason, values);
}
