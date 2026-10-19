// Server checks. core.js checks every call on the device, guarding against the model's mistakes; the brain checks
// too, with core.js's own rules on its own copy of the session's known IDs (decision D3: what protects us runs on a
// server). A call the brain refuses is answered here, without a round trip to the client. Presentation calls are
// checked before they're sent, and results are accepted only for calls the brain issued, in the tool's format.
import type { PresentationCall, ToolError } from '../../../contract/generated/types.ts';
import { PRESENTATION_TOOLS } from '../../../contract/src/site-pack.ts';
import { checkPresentation, checkToolCall, type CheckContext } from '../../../core/src/boundary/checks.ts';
import { platformError } from '../../../core/src/boundary/errors.ts';
import type { IdSet } from '../../../core/src/boundary/ids.ts';
import type { Policy } from '../../../core/src/boundary/limits.ts';
import { problemsWith } from '../../../core/src/shared/validate.ts';
import { SCRIPT_TOOL } from '../prompt/prompt.ts';
import type { SiteBundle } from '../prompt/site.ts';

export interface ServerContext {
  bundle: SiteBundle;
  policy: Policy;
  ids: IdSet;
  now: number;
  page: CheckContext['page'];
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function coreContext(ctx: ServerContext): CheckContext {
  const { pack, validators } = ctx.bundle;
  return {
    pack, policy: ctx.policy, ids: ctx.ids, now: ctx.now, page: ctx.page,
    validateInput: (tool, args) => problemsWith(validators.site, pack.tools[tool]!.input, args),
  };
}

/** A call the client would run: a site tool or a script. The allowed-value rules need site responses, so core.js keeps those. */
export function checkClientCall(ctx: ServerContext, name: string, args: unknown): ToolError | null {
  if (name === SCRIPT_TOOL) {
    const bad = problemsWith(ctx.bundle.validators.platform, 'platform-tools/run_script.json', args);
    return bad ? platformError('bad_arguments', { tool: name, details: bad }) : null;
  }
  return checkToolCall(coreContext(ctx), name, args);
}

export const isPresentation = (name: string) => PRESENTATION_TOOLS.includes(name);

export function checkPresentationCall(ctx: ServerContext, name: string, args: unknown): ToolError | null {
  const bad = problemsWith(ctx.bundle.validators.platform, `presentation/${name}.json`, args);
  if (bad) return platformError('bad_arguments', { tool: name, details: bad });
  return checkPresentation(coreContext(ctx), { name, args } as PresentationCall);
}

/** The longest result the brain passes to the model, as JSON. A page of search results is a few thousand. */
export const MAX_RESULT_CHARS = 100_000;

/** Why a result the client sent can't be used, or null: it must have the tool's output format, and a sane size. */
export function outputProblem(bundle: SiteBundle, name: string, output: Record<string, unknown>): string | null {
  if (JSON.stringify(output).length > MAX_RESULT_CHARS) return `it is longer than ${MAX_RESULT_CHARS} characters`;
  if (name === SCRIPT_TOOL) {
    if (!isObject(output.result)) return 'a script result needs a result object';
    if (!isObject(output.knownIds) || !Object.values(output.knownIds).every((ids) => Array.isArray(ids))) return 'a script result needs knownIds, lists by kind';
    return Object.keys(output).every((key) => key === 'result' || key === 'knownIds') ? null : 'a script result has only result and knownIds';
  }
  const tool = bundle.pack.tools[name];
  return tool ? problemsWith(bundle.validators.site, tool.output, output) : `${name} isn't a tool here`;
}

/** Learns the IDs in a result the brain accepted: the tool's output ID paths, or the known IDs a script listed. */
export function learnIds(ctx: ServerContext, name: string, output: Record<string, unknown>): number {
  if (name !== SCRIPT_TOOL) return ctx.ids.learnFrom(output, ctx.bundle.pack.tools[name]?.ids?.output, ctx.now);
  let count = 0;
  for (const [kind, ids] of Object.entries(output.knownIds as Record<string, unknown[]>)) {
    for (const id of ids) if (ctx.ids.learn(kind, id, { now: ctx.now })) count++;
  }
  return count;
}
