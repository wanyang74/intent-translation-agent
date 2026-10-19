// What the brain needs to serve one site: its site pack, the generated tool definitions and validators, the site's
// prompt (brand rules and basic search) and its skills. loadSite reads them from sites/<id>/ the way a deployment
// bundles them; tests can build a SiteBundle directly.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SitePack } from '../../../contract/generated/types.ts';
import { entriesOf, sitesDir } from '../../../contract/src/site-pack.ts';
import type { Validators } from '../../../core/src/shared/validate.ts';
import type { ToolSpec } from '../model/model.ts';

export interface SiteBundle {
  pack: SitePack;
  /** sites/<id>/generated/tools.json, in site-pack order. */
  siteTools: ToolSpec[];
  /** platform/contract/generated/tools.json: the presentation tools, run_script and load_skill. */
  platformTools: ToolSpec[];
  validators: Validators;
  /** sites/<id>/prompt.md as the model sees it; '' if the site has none. */
  prompt: string;
  /** Each skill's guidance as the model sees it, by name: sites/<id>/skills/<name>.md. */
  skills: Record<string, string>;
}

/** Markdown as the model sees it: HTML comments (authoring notes) removed, blank runs collapsed, ends trimmed. */
export function forModel(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

const platformGenerated = new URL('../../../contract/generated/', import.meta.url);

/** Problems that would make the brain serve a site wrongly: a tool or skill the site pack names without its parts. */
export function siteProblems(bundle: SiteBundle): string[] {
  const problems: string[] = [];
  const id = bundle.pack.site.id;
  const defined = new Set(bundle.siteTools.map((tool) => tool.name));
  for (const [name] of entriesOf(bundle.pack.tools)) if (!defined.has(name)) problems.push(`${id}: no tool definition for ${name}; run npm run generate`);
  for (const tool of bundle.siteTools) if (!bundle.pack.tools[tool.name]) problems.push(`${id}: tool definition ${tool.name} isn't in the site pack`);
  for (const [name] of entriesOf(bundle.pack.skills)) if (!bundle.skills[name]) problems.push(`${id}: skill ${name} has no guidance`);
  return problems;
}

export async function loadSite(id: string): Promise<SiteBundle> {
  const dir = path.join(sitesDir, id);
  const read = (...parts: string[]) => readFileSync(path.join(dir, ...parts), 'utf8');
  const pack = JSON.parse(read('generated', 'site.json')) as SitePack;
  const skills: Record<string, string> = {};
  for (const [name] of entriesOf(pack.skills)) {
    const file = path.join(dir, 'skills', `${name}.md`);
    if (existsSync(file)) skills[name] = forModel(readFileSync(file, 'utf8'));
  }
  const bundle: SiteBundle = {
    pack,
    siteTools: JSON.parse(read('generated', 'tools.json')) as ToolSpec[],
    platformTools: JSON.parse(readFileSync(new URL('tools.json', platformGenerated), 'utf8')) as ToolSpec[],
    validators: {
      platform: await import(new URL('validators.js', platformGenerated).href) as Record<string, unknown>,
      site: await import(pathToFileURL(path.join(dir, 'generated', 'validators.js')).href) as Record<string, unknown>,
    },
    prompt: existsSync(path.join(dir, 'prompt.md')) ? forModel(read('prompt.md')) : '',
    skills,
  };
  const problems = siteProblems(bundle);
  if (problems.length) throw new Error(problems.join('\n'));
  return bundle;
}
