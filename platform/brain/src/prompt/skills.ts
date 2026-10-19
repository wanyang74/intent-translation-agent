// The skills loader. A skill is guidance only some conversations need, so it stays out of the system prompt and loads
// as a tool result: when the model calls load_skill, or before the first model call when the page calls for it (a
// skill whose page types include the page the user is on). Each skill loads once per session; the remote config can
// switch one off.
import type { ToolError } from '../../../contract/generated/types.ts';
import { entriesOf } from '../../../contract/src/site-pack.ts';
import { platformError } from '../../../core/src/boundary/errors.ts';
import type { SiteBundle } from './site.ts';

export type SkillOutcome = { ok: true; text: string } | { ok: false; error: ToolError };

export function loadSkill(bundle: SiteBundle, name: unknown, loaded: Set<string>, disabled: readonly string[]): SkillOutcome {
  if (typeof name !== 'string' || bundle.skills[name] === undefined) {
    return { ok: false, error: platformError('unknown_skill', { skill: String(name), skills: Object.keys(bundle.skills) }) };
  }
  if (disabled.includes(name)) return { ok: false, error: platformError('skill_disabled', { skill: name }) };
  if (loaded.has(name)) return { ok: true, text: `The ${name} skill is already loaded earlier in this conversation.` };
  loaded.add(name);
  return { ok: true, text: bundle.skills[name]! };
}

/** The skills to load before the first model call of a turn on this page type, in site-pack order. */
export function skillsForPage(bundle: SiteBundle, pageType: string, loaded: Set<string>, disabled: readonly string[]): string[] {
  return entriesOf(bundle.pack.skills)
    .filter(([name, skill]) => skill.pageTypes?.includes(pageType) && !loaded.has(name) && !disabled.includes(name) && bundle.skills[name] !== undefined)
    .map(([name]) => name);
}
