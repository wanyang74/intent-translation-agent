// Personal data in tool results (sign-in mode). A site pack marks it per tool (tool.privacy) and per kind of item
// (entity.id.cardOnly):
//   personal   sent to the model, which needs it to answer, but replaced in what the brain keeps: logs, traces,
//              session memory, saved references (redactPersonal)
//   cardOnly   never sent to the brain at all: core.js shows it on cards from the record on the device, and the model's
//              copy of the result holds a stand-in, withheld:<n>, that core.js swaps back when the model passes it
//              (an ID the model shows a card for, say)
// The brain checks the model's copy against a "model view" of the tool's output schema, made at load time with each
// card-only field allowed to be a stand-in (model-view.ts). Pure functions with no Node or browser APIs, not even URL:
// core.js, the brain and the contract tools all use them. Platform code: nothing here names a site.
import type { SitePack } from '../generated/types.ts';

type Tool = NonNullable<SitePack['tools'][string]>;

/** A stand-in for a card-only value: the same value always gets the same one within a session. */
export const WITHHELD_PATTERN = '^withheld:[0-9]{1,9}$';
const withheldRe = new RegExp(WITHHELD_PATTERN);

export const isWithheld = (value: unknown): value is string => typeof value === 'string' && withheldRe.test(value);

/** What a personal value becomes in the brain's logs, traces, memory and references. */
export const PERSONAL_PLACEHOLDER = '[personal]';

/** The output paths of a tool whose values stay on the device: its cardOnly fields, and its IDs of kinds with private IDs. */
export function withheldPaths(pack: SitePack, toolName: string): string[] {
  const tool = pack.tools[toolName];
  if (!tool) return [];
  const privateIds = (tool.ids?.output ?? []).filter((idPath) => pack.entities[idPath.kind]?.id.cardOnly).map((idPath) => idPath.path);
  return [...new Set([...(tool.privacy?.cardOnly ?? []), ...privateIds])];
}

/** The schema the brain checks the model's copy of a tool's output against, next to the tool's own output schema. */
export function modelOutputSchema(tool: Pick<Tool, 'output'>): string {
  return tool.output.replace(/\.json$/, '.model.json');
}

/** The schema to check the model's copy of a tool's output against: the model view if anything is withheld. */
export function outputSchemaForModel(pack: SitePack, toolName: string): string | undefined {
  const tool = pack.tools[toolName];
  if (!tool) return undefined;
  return withheldPaths(pack, toolName).length ? modelOutputSchema(tool) : tool.output;
}

/**
 * A copy of value with fn applied to every value at the path ("trips[].recordLocator"); missing parts are skipped,
 * and the original is left as it was.
 */
export function mapAt(value: unknown, path: string, fn: (found: unknown) => unknown): unknown {
  const [head = '', ...rest] = path.split('.');
  const isArray = head.endsWith('[]');
  const key = isArray ? head.slice(0, -2) : head;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const child = record[key];
  if (child === undefined || child === null) return value;
  const apply = (node: unknown) => (rest.length ? mapAt(node, rest.join('.'), fn) : fn(node));
  return { ...record, [key]: isArray ? (Array.isArray(child) ? child.map(apply) : child) : apply(child) };
}

/** The output with every personal value replaced by PERSONAL_PLACEHOLDER, for anything the brain keeps. */
export function redactPersonal(pack: SitePack, toolName: string, output: unknown): unknown {
  const paths = pack.tools[toolName]?.privacy?.personal ?? [];
  return paths.reduce((redacted, path) => mapAt(redacted, path, (found) => (found === undefined || found === null ? found : PERSONAL_PLACEHOLDER)), output);
}
