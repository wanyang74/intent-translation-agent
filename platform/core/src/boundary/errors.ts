// Errors the model can act on. Codes are the platform's (errors.json); each error also has a reason and a message.
// Site errors come from the site pack (each tool's errors); platform errors are problems core.js finds itself,
// worded the same on every site.
import type { SitePack, ToolError } from '../../../contract/generated/types.ts';
import { fill, hasPlaceholder } from '../shared/text.ts';

type Code = ToolError['code'];
interface Template { code: Code; message: string; retryable: boolean }

/**
 * Platform reasons and their messages, for core.js and the brain alike. The values each one is filled with are the
 * standard names a site's own message can use too: tool, details, value, field, options, kind, id, idType, what,
 * scope, limit, section, sections, fields, notice, form, status, skill, skills, destination, destinations.
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
  unknown_destination: { code: 'invalid_value', message: "{destination} isn't a page you can send the user to. The pages are: {destinations}.", retryable: true },
  bad_destination_params: { code: 'invalid_value', message: 'The params for {destination} are invalid: {details}. Fix them and call present_destination again.', retryable: true },
  destination_unavailable: { code: 'invalid_value', message: "The link to {destination} couldn't be built from these params. Answer without the button.", retryable: false },
  // Problems reaching the site or reading its answer.
  network_error: { code: 'upstream_error', message: "The site didn't respond to {tool}. Try again in a moment, or answer without it.", retryable: true },
  site_unavailable: { code: 'upstream_error', message: 'The site had a problem answering {tool} (status {status}). Try again in a moment, or answer without it.', retryable: true },
  site_refused: { code: 'upstream_error', message: 'The site refused the request from {tool} (status {status}). Answer without it and say so.', retryable: false },
  site_not_found: { code: 'not_found', message: "The site doesn't have what {tool} asked for. It may be gone.", retryable: false },
  site_rate_limited: { code: 'rate_limited', message: 'The site asked us to slow down. Wait before calling {tool} again.', retryable: true },
  response_changed: { code: 'format_changed', message: "{tool} got an answer from the site in a format it doesn't recognize. Answer without it and say so.", retryable: false },
  // Problems in our own code or setup, never the model's.
  not_built: { code: 'tool_disabled', message: "{tool} isn't available yet. Answer without it and say so.", retryable: false },
  site_code_error: { code: 'upstream_error', message: '{tool} failed: {details}. Answer without it and say so.', retryable: false },
  // Scripts.
  bad_script: { code: 'invalid_value', message: 'The script failed: {details}. Fix it, or call the tools one at a time.', retryable: true },
  scripts_off: { code: 'tool_disabled', message: "Scripts can't run here. Call the tools one at a time instead.", retryable: false },
  // Problems the brain finds in the model's calls, before anything reaches the client.
  unknown_skill: { code: 'invalid_value', message: "{skill} isn't a skill here. Skills: {skills}.", retryable: true },
  skill_disabled: { code: 'tool_disabled', message: 'The {skill} skill is unavailable right now. Answer without it.', retryable: false },
  present_too_early: { code: 'invalid_value', message: "{tool} goes with your final answer, after the results you're waiting for. Call it again then.", retryable: true },
  not_shown: { code: 'invalid_value', message: 'Nothing was shown, because another presentation call in this step was refused. Fix that call and send your whole answer again.', retryable: true },
  out_of_steps: { code: 'budget_reached', message: "{tool} didn't run: this request is out of steps. Answer with what you have.", retryable: false },
  // A call whose result never came back from the client.
  no_result: { code: 'upstream_error', message: "{tool} didn't return a result: {details}.", retryable: true },
} satisfies Record<string, Template>;

export type PlatformReason = keyof typeof PLATFORM_ERRORS;

export function platformError(reason: PlatformReason, values: Record<string, unknown> = {}): ToolError {
  const template: Template = PLATFORM_ERRORS[reason];
  return { code: template.code, reason, message: fill(template.message, values), retryable: template.retryable };
}

/** A site error by the reason a tool declares in the site pack, or null if the tool has no such error. */
export function siteError(pack: SitePack, tool: string, reason: string, values: Record<string, unknown> = {}): ToolError | null {
  const declared = pack.tools[tool]?.errors?.[reason];
  if (!declared) return null;
  return { code: declared.code, reason, message: fill(declared.message, values), retryable: declared.retryable ?? false };
}

/**
 * For a problem core.js finds in a call to a tool: the tool's own wording when it declares exactly one error with
 * the same code and that message can be filled from the standard values; otherwise the platform's wording.
 */
export function errorFor(pack: SitePack, tool: string, reason: PlatformReason, values: Record<string, unknown>): ToolError {
  const own = Object.entries(pack.tools[tool]?.errors ?? {}).filter(([, declared]) => declared?.code === PLATFORM_ERRORS[reason].code);
  if (own.length === 1) {
    const [name, declared] = own[0]!;
    const message = fill(declared!.message, values);
    if (!hasPlaceholder(message)) return { code: declared!.code, reason: name, message, retryable: declared!.retryable ?? false };
  }
  return platformError(reason, values);
}
