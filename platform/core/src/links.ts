// Deep links back to the site's own pages, from the templates in the site pack.
// Template syntax:
//   {name}             params.name, URL-encoded (text or a number)
//   {base64json:name}  params.name as JSON, base64-encoded (any JSON value)
import type { SitePack } from '../../contract/generated/types.ts';
import { base64 } from './text.ts';

const PLACEHOLDER = /\{(?:(base64json):)?([A-Za-z_][A-Za-z0-9_]*)\}/g;

export type LinkResult = { ok: true; url: string } | { ok: false; problems: string[] };

/** The placeholders in a template, in order: their names and how each is encoded. */
export function linkPlaceholders(template: string): { name: string; encoding: 'text' | 'base64json' }[] {
  const out: { name: string; encoding: 'text' | 'base64json' }[] = [];
  template.replace(PLACEHOLDER, (whole, enc: string | undefined, name: string) => {
    out.push({ name, encoding: enc ? 'base64json' : 'text' });
    return whole;
  });
  return out;
}

export function buildLink(template: string, params: Record<string, unknown>): LinkResult {
  const problems: string[] = [];
  const url = template.replace(PLACEHOLDER, (_whole, enc: string | undefined, name: string) => {
    const v = params[name];
    if (v === undefined || v === null || v === '') {
      problems.push(`${name} is missing`);
      return '';
    }
    if (enc) return base64(JSON.stringify(v));
    if (typeof v !== 'string' && typeof v !== 'number') {
      problems.push(`${name} must be text or a number`);
      return '';
    }
    return encodeURIComponent(String(v));
  });
  if (/[{}]/.test(url) && !problems.length) problems.push('the template has a malformed placeholder');
  return problems.length ? { ok: false, problems } : { ok: true, url };
}

/** A deep link by its name in the site pack. */
export function deepLink(pack: SitePack, name: string, params: Record<string, unknown>): LinkResult {
  const link = pack.deepLinks?.[name];
  if (!link) return { ok: false, problems: [`the site has no deep link named ${name}`] };
  return buildLink(link.template, params);
}
