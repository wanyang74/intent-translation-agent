// Boundary checks, always on. They guard against the model's mistakes and against prompt injection (decision D3):
// a tool call must name a tool the site has, that isn't switched off, isn't a write when writes are off, has the
// sign-in it needs, has valid arguments, uses only known and current IDs, and uses only values the site offers.
// A presentation call must name things the site pack declares, show only known IDs, and never show internal kinds.
// Each check returns the first problem as an error the model can act on, or null.
import type { PageContext, PresentationCall, SitePack, ToolError } from '../../../contract/generated/types.ts';
import { select, valuesAt } from '../../../contract/src/paths.ts';
import { errorFor, platformError } from './errors.ts';
import { type IdSet, idShapeOk } from './ids.ts';
import type { Policy } from './limits.ts';
import { show } from '../shared/text.ts';

export interface CheckContext {
  pack: SitePack;
  policy: Policy;
  ids: IdSet;
  /** Milliseconds since the epoch, for ID expiry. */
  now: number;
  page?: PageContext | undefined;
  /** Checks a tool's arguments against its input schema: a short description of the problem, or null. */
  validateInput?: ((tool: string, args: unknown) => string | null) | undefined;
  /** The latest response of each endpoint, by endpoint name, for the allowed-value rules. */
  responses?: Record<string, unknown> | undefined;
}

const MAX_OPTIONS = 20;

function idProblem(ctx: CheckContext, tool: string | null, kind: string, id: unknown): ToolError | null {
  const entity = ctx.pack.entities[kind];
  if (!entity) return platformError('unknown_kind', { kind });
  if (!idShapeOk(entity, id)) return platformError('bad_id', { kind, id: JSON.stringify(id), idType: entity.id.type === 'integer' ? 'numbers' : 'text' });
  const status = ctx.ids.status(kind, id, ctx.now);
  if (status === 'unknown') return platformError('unknown_id', { kind, id });
  if (status === 'expired') return tool ? errorFor(ctx.pack, tool, 'expired_id', { kind, id }) : platformError('expired_id', { kind, id });
  return null;
}

const flat = (value: unknown): unknown[] => (Array.isArray(value) ? value.flatMap(flat) : value === undefined || value === null ? [] : [value]);

/** The allowed-value rules that apply to a tool: argument path, source endpoint and response path. */
export function allowedValueRules(pack: SitePack, tool: string): { arg: string; endpoint: string; path: string }[] {
  return Object.entries(pack.policies.allowedValues ?? {}).flatMap(([key, source]) => {
    const dot = key.indexOf('.');
    const sdot = source === undefined ? -1 : source.indexOf('.');
    if (dot < 0 || sdot < 0 || key.slice(0, dot) !== tool) return [];
    return [{ arg: key.slice(dot + 1), endpoint: source!.slice(0, sdot), path: source!.slice(sdot + 1) }];
  });
}

/** Endpoints whose responses a call's allowed-value rules need and that the session doesn't have yet. */
export function missingValueSources(ctx: CheckContext, tool: string, args: unknown): string[] {
  return [...new Set(allowedValueRules(ctx.pack, tool)
    .filter((rule) => flat(select(args, rule.arg)).length > 0 && ctx.responses?.[rule.endpoint] === undefined)
    .map((rule) => rule.endpoint))];
}

function allowedValueProblem(ctx: CheckContext, tool: string, args: unknown): ToolError | null {
  for (const rule of allowedValueRules(ctx.pack, tool)) {
    const response = ctx.responses?.[rule.endpoint];
    if (response === undefined) continue;
    const allowed = [...new Set(valuesAt(response, rule.path).map(show))];
    for (const value of flat(select(args, rule.arg))) {
      if (!allowed.includes(show(value))) {
        const options = allowed.length > MAX_OPTIONS ? [...allowed.slice(0, MAX_OPTIONS), '…'] : allowed;
        return errorFor(ctx.pack, tool, 'not_allowed_value', { tool, value: show(value), field: rule.arg, options });
      }
    }
  }
  return null;
}

export function checkToolCall(ctx: CheckContext, name: string, args: unknown): ToolError | null {
  const tool = ctx.pack.tools[name];
  if (!tool) return platformError('unknown_tool', { tool: name });
  if (ctx.policy.disabledTools.includes(name)) return platformError('tool_disabled', { tool: name });
  if (tool.sideEffect === 'write' && ctx.policy.writes === 'none') return platformError('writes_off', { tool: name });
  if (tool.signIn && ctx.page?.signedIn !== true) return errorFor(ctx.pack, name, 'needs_sign_in', { tool: name, what: name });
  const bad = ctx.validateInput?.(name, args) ?? null;
  if (bad) return platformError('bad_arguments', { tool: name, details: bad });
  for (const idPath of tool.ids?.input ?? []) {
    for (const id of valuesAt(args, idPath.path)) {
      const problem = idProblem(ctx, name, idPath.kind, id);
      if (problem) return problem;
    }
  }
  return allowedValueProblem(ctx, name, args);
}

/** The entity fields a presentation call puts on screen: the card's fields, or the compared attributes. */
export function fieldsShown(pack: SitePack, call: PresentationCall): string[] {
  if (call.name === 'present_comparison') return call.args.attributes;
  if (call.name === 'present_items' || call.name === 'present_options' || call.name === 'present_detail') {
    return pack.entities[call.args.entity]?.card?.fields ?? [];
  }
  return [];
}

function formProblem(ctx: CheckContext, form: string, prefill: Record<string, unknown>): ToolError | null {
  const definition = ctx.pack.forms?.[form];
  if (!definition) return platformError('unknown_form', { form });
  for (const [field, value] of Object.entries(prefill)) {
    const spec = definition.fields[field];
    const bad = (details: string) => platformError('bad_prefill', { form, field, value: show(value), details });
    if (!spec) return bad(`the form has no such field; its fields are ${Object.keys(definition.fields).join(', ')}`);
    if (spec.type === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) return bad('it takes a whole number');
      if (spec.min !== undefined && value < spec.min) return bad(`the minimum is ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) return bad(`the maximum is ${spec.max}`);
    } else if (typeof value !== 'string') {
      return bad('it takes text');
    } else if (spec.type === 'select' && spec.options && !spec.options.includes(value)) {
      return bad(`the options are ${spec.options.join(', ')}`);
    } else if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
      return bad('it has the wrong format');
    }
  }
  return null;
}

/**
 * A destination's params:
 *   1. The destination must be one the site pack lists.
 *   2. Params that are a tool's arguments are checked as a call to that tool would be, allowed values included.
 *   3. Otherwise each declared param must be there, of its type, and an item ID must be one this session knows;
 *      nothing undeclared is accepted.
 */
function destinationProblem(ctx: CheckContext, name: string, params: Record<string, unknown>): ToolError | null {
  // 1. Listed.
  const destination = ctx.pack.destinations?.[name];
  if (!destination) return platformError('unknown_destination', { destination: name, destinations: Object.keys(ctx.pack.destinations ?? {}).join(', ') || 'none' });
  // 2. A tool's arguments.
  if (destination.argsOf) {
    const problem = checkToolCall(ctx, destination.argsOf, params);
    return problem ? platformError('bad_destination_params', { destination: name, details: problem.message }) : null;
  }
  // 3. Its own params.
  const declared = destination.params ?? {};
  const bad = (details: string) => platformError('bad_destination_params', { destination: name, details });
  for (const key of Object.keys(params)) if (!declared[key]) return bad(`it has no param ${key}`);
  for (const [key, spec] of Object.entries(declared)) {
    const value = params[key];
    if (value === undefined || value === null || value === '') return bad(`${key} is missing`);
    if (spec!.type === 'integer' ? !Number.isInteger(value) : typeof value !== 'string') return bad(`${key} must be ${spec!.type === 'integer' ? 'a whole number' : 'text'}`);
    if (spec!.entity) {
      const problem = idProblem(ctx, null, spec!.entity, value);
      if (problem) return problem;
    }
  }
  return null;
}

export function checkPresentation(ctx: CheckContext, call: PresentationCall): ToolError | null {
  if (call.name === 'present_destination') return destinationProblem(ctx, call.args.destination, (call.args.params ?? {}) as Record<string, unknown>);
  if (call.name === 'present_notice') {
    return ctx.pack.notices?.[call.args.notice] ? null : platformError('unknown_notice', { notice: call.args.notice });
  }
  if (call.name === 'present_form') return formProblem(ctx, call.args.form, (call.args.prefill ?? {}) as Record<string, unknown>);

  const kind = call.args.entity;
  const entity = ctx.pack.entities[kind];
  if (!entity) return platformError('unknown_kind', { kind });
  if (entity.internal) return platformError('internal_kind', { kind });
  if (entity.requiresSignIn && ctx.page?.signedIn !== true) return platformError('needs_sign_in', { what: `${kind} items` });
  const ids: unknown[] = call.name === 'present_detail' ? [call.args.id] : call.args.ids;
  for (const id of ids) {
    const problem = idProblem(ctx, null, kind, id);
    if (problem) return problem;
  }
  if (call.name === 'present_comparison') {
    for (const field of call.args.attributes) {
      if (!entity.fields?.[field]) return platformError('unknown_field', { field, kind, fields: Object.keys(entity.fields ?? {}) });
    }
  }
  if (call.name === 'present_detail') {
    for (const section of call.args.sections ?? []) {
      if (!entity.sections?.includes(section)) return platformError('unknown_section', { section, kind, sections: entity.sections ?? [] });
    }
  }
  return null;
}

/** Notices that must appear with these calls, because a field they explain is on screen, and that are missing. */
export function missingNotices(pack: SitePack, calls: readonly PresentationCall[]): string[] {
  const shown = new Set(calls.flatMap((presentation) => fieldsShown(pack, presentation)));
  const present = new Set(calls.flatMap((presentation) => (presentation.name === 'present_notice' ? [presentation.args.notice] : [])));
  return Object.entries(pack.notices ?? {})
    .filter(([name, notice]) => notice && !present.has(name) && (notice.showWith ?? []).some((field) => shown.has(field)))
    .map(([name]) => name);
}

/** The calls with any missing notices added at the end: core.js shows required wording even if the model forgot it. */
export function withRequiredNotices(pack: SitePack, calls: readonly PresentationCall[]): PresentationCall[] {
  return [...calls, ...missingNotices(pack, calls).map((notice): PresentationCall => ({ name: 'present_notice', args: { notice } }))];
}
