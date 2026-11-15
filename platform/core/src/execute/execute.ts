// Execute (phase 3 on the flow chart): runs tool calls. Each call is checked at the boundary, run by the site's code
// through a ToolContext, and its output is checked against the tool's output schema before anyone sees it. The
// output's IDs join the session's known IDs, and its records are kept for Respond. run_script runs a model-written
// script in the platform's sandbox, where the only way out is these same tool calls, on the same budget. Card-only
// values (sign-in mode) leave only as stand-ins: modelCopy makes what the brain gets, and a call's arguments have
// their stand-ins swapped back before anything checks them.
import type { ToolError } from '../../../contract/generated/types.ts';
import { valuesAt } from '../../../contract/src/paths.ts';
import { isWithheld, mapAt, withheldPaths } from '../../../contract/src/privacy.ts';
import { checkToolCall, missingValueSources, type CheckContext } from '../boundary/checks.ts';
import { callEndpoint } from './endpoints.ts';
import { platformError, siteError } from '../boundary/errors.ts';
import { computeDerived } from '../present/formula.ts';
import { deepLink } from '../present/links.ts';
import { fence } from '../boundary/sanitize.ts';
import type { Session } from '../runtime/session.ts';
import { type ToolContext, ToolFailure } from './site-code.ts';
import { problemsWith } from '../shared/validate.ts';

export type CallOutcome = { ok: true; output: Record<string, unknown> } | { ok: false; error: ToolError };

/** The platform's own tool for batches: the model sends a script instead of many separate calls. */
export const SCRIPT_TOOL = 'run_script';
export const SCRIPT_LIMITS = { timeoutMs: 10_000, memoryBytes: 32 * 1024 * 1024 };
const MAX_SCRIPT = 20_000;
const MAX_SCRIPT_RESULT = 10_000;

const refuse = (error: ToolError): CallOutcome => ({ ok: false, error });

export function checkContext(session: Session): CheckContext {
  return {
    pack: session.pack,
    policy: session.policy,
    ids: session.ids,
    now: session.host.now(),
    page: session.page,
    validateInput: (tool, args) => problemsWith(session.validators.site, session.pack.tools[tool]!.input, args),
    responses: session.responses,
    accountAllowed: session.accountAllowed,
  };
}

function toolContext(session: Session, tool: string, args: unknown): ToolContext {
  return {
    tool,
    args,
    page: session.page,
    ids: session.ids.view(),
    now: session.host.now(),
    call: (endpoint, request) => callEndpoint(session, tool, endpoint, request),
    derived: (kind, item) => computeDerived(session.pack, kind, item),
    link: (name, params) => {
      const link = deepLink(session.pack, name, params);
      return link.ok ? link.url : undefined;
    },
    fence: (text, source, maxLength) => fence(text, source, maxLength),
    fail: (reason, values = {}) => {
      throw new ToolFailure(siteError(session.pack, tool, reason, values)
        ?? platformError('site_code_error', { tool, details: `it raised ${reason}, an error it doesn't declare` }));
    },
    store: session.store,
    pageData: () => session.host.pageData?.() ?? null,
    progress: (text) => session.onProgress?.(text),
    keep: (kind, id, record) => session.putRecord(kind, id, `${tool}:kept`, record),
  };
}

/** Keeps what a tool returned about each item, for Respond: by the tool's output ID paths, or for its input IDs. */
function keepRecords(session: Session, tool: string, args: unknown, output: Record<string, unknown>): void {
  const ids = session.pack.tools[tool]!.ids;
  const outputKinds = new Set((ids?.output ?? []).map((idPath) => idPath.kind));
  for (const idPath of ids?.output ?? []) {
    const cut = idPath.path.lastIndexOf('.');
    const field = idPath.path.slice(cut + 1);
    if (field.endsWith('[]')) continue;
    const records = cut < 0 ? [output] : valuesAt(output, idPath.path.slice(0, cut));
    for (const record of records) if (record && typeof record === 'object') session.putRecord(idPath.kind, (record as Record<string, unknown>)[field], tool, record);
  }
  for (const idPath of ids?.input ?? []) {
    if (outputKinds.has(idPath.kind)) continue;
    for (const id of valuesAt(args, idPath.path)) session.putRecord(idPath.kind, id, tool, output);
  }
}

/** What the brain gets of a tool's output: the same, with each card-only value replaced by its stand-in. */
export function modelCopy(session: Session, name: string, output: Record<string, unknown>): Record<string, unknown> {
  return withheldPaths(session.pack, name).reduce(
    (copy, path) => mapAt(copy, path, (found) => (typeof found === 'string' || typeof found === 'number' ? session.withheld.alias(found) : found)),
    output as unknown,
  ) as Record<string, unknown>;
}

/** Runs one tool call and returns its full output, for the device; the brain gets modelCopy of it. */
export async function runToolCall(session: Session, name: string, givenArgs: unknown, options: { fromScript?: boolean } = {}): Promise<CallOutcome> {
  // The model passes stand-ins for card-only values (an ID it was given); the tool gets the real ones.
  const args = session.withheld.resolve(givenArgs);
  if (name === SCRIPT_TOOL) {
    return options.fromScript ? refuse(platformError('bad_script', { details: "a script can't start another script" })) : runScript(session, args);
  }
  let problem = checkToolCall(checkContext(session), name, args);
  if (!problem) {
    // Values that must come from a site response the session doesn't have yet: fetch it as the site says, check again.
    const missing = missingValueSources(checkContext(session), name, args);
    for (const endpoint of missing) {
      const source = session.site.valueSources?.[endpoint];
      if (!source) continue;
      try {
        await callEndpoint(session, name, endpoint, source(args));
      } catch (thrown) {
        if (thrown instanceof ToolFailure) return refuse(thrown.error);
        throw thrown;
      }
    }
    if (missing.length) problem = checkToolCall(checkContext(session), name, args);
  }
  if (problem) return refuse(problem);

  const impl = session.site.tools[name];
  if (!impl) return refuse(platformError('not_built', { tool: name }));
  const tool = session.pack.tools[name]!;
  let output: Record<string, unknown>;
  try {
    output = await impl(toolContext(session, name, args));
  } catch (thrown) {
    if (thrown instanceof ToolFailure) return refuse(thrown.error);
    session.log('tool_crashed', { tool: name, error: String(thrown) });
    return refuse(platformError('site_code_error', { tool: name, details: 'an unexpected thrown' }));
  }
  if (tool.nextStep && output.nextStep === undefined) output = { ...output, nextStep: tool.nextStep };
  const bad = problemsWith(session.validators.site, tool.output, output);
  if (bad) {
    session.log('output_check', { tool: name, problem: bad });
    return refuse(platformError('response_changed', { tool: name }));
  }
  session.ids.learnFrom(output, tool.ids?.output, session.host.now());
  keepRecords(session, name, args, output);
  return { ok: true, output };
}

/** The known IDs among the values a script returned, by kind, so the brain can check what the model shows next. */
function knownIdsIn(session: Session, value: unknown): Record<string, (string | number)[]> {
  const found: Record<string, Set<string | number>> = {};
  const now = session.host.now();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') Object.values(node).forEach(visit);
    else if (typeof node === 'string' || typeof node === 'number') {
      // A stand-in counts as known when its value is; the brain gets the stand-in, as the script did.
      const real = isWithheld(node) ? session.withheld.resolve(node) : node;
      for (const kind of Object.keys(session.pack.entities)) {
        if (session.ids.status(kind, real, now) === 'known') (found[kind] ??= new Set()).add(node);
      }
    }
  };
  visit(value);
  return Object.fromEntries(Object.entries(found).map(([kind, ids]) => [kind, [...ids]]));
}

async function runScript(session: Session, args: unknown): Promise<CallOutcome> {
  const runner = session.host.scripts;
  if (!runner) return refuse(platformError('scripts_off'));
  const source = (args as { source?: unknown } | null)?.source;
  if (typeof source !== 'string' || !source.trim() || source.length > MAX_SCRIPT) {
    return refuse(platformError('bad_script', { details: `the source must be text of at most ${MAX_SCRIPT} characters` }));
  }
  // Whether the script read anything personal: then its result says so, and the brain keeps it out of its records.
  let personal = false;
  const result = await runner.run(source, async (tool, toolArgs) => {
    const outcome = await runToolCall(session, tool, toolArgs, { fromScript: true });
    if (outcome.ok && session.pack.tools[tool]?.privacy) personal = true;
    // The script was written by the model and its result goes back to it, so it sees what the model would.
    if (outcome.ok) return modelCopy(session, tool, outcome.output);
    throw new Error(outcome.error.message);
  }, SCRIPT_LIMITS);
  if (!result.ok) return refuse(platformError('bad_script', { details: result.error }));
  const value = result.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return refuse(platformError('bad_script', { details: 'it must return an object, such as { ids, summary }' }));
  }
  const size = JSON.stringify(value).length;
  if (size > MAX_SCRIPT_RESULT) {
    return refuse(platformError('bad_script', { details: `it returned ${size} characters; return IDs and a short summary, at most ${MAX_SCRIPT_RESULT}` }));
  }
  return { ok: true, output: { result: value, knownIds: knownIdsIn(session, value), ...(personal ? { personal: true } : {}) } };
}
