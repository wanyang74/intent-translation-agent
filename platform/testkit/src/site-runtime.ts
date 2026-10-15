// What core.js needs to run one site, loaded the way a bundle would include it: the site pack as JSON, the site's
// code, and the platform's and the site's generated validators.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SitePack } from '../../contract/generated/types.ts';
import { sitesDir } from '../../contract/src/site-pack.ts';
import type { SiteCode } from '../../core/src/site-code.ts';
import type { Validators } from '../../core/src/validate.ts';
import * as platformValidators from '../../contract/generated/validators.js';

export interface SiteRuntime {
  pack: SitePack;
  code: SiteCode;
  validators: Validators;
}

export async function loadSiteRuntime(site: string): Promise<SiteRuntime> {
  const dir = path.join(sitesDir, site);
  const pack = JSON.parse(readFileSync(path.join(dir, 'generated', 'site.json'), 'utf8')) as SitePack;
  const code = (await import(pathToFileURL(path.join(dir, 'tools.ts')).href)).site as SiteCode;
  const siteValidators = await import(pathToFileURL(path.join(dir, 'generated', 'validators.js')).href);
  return { pack, code, validators: { platform: platformValidators as Record<string, unknown>, site: siteValidators as Record<string, unknown> } };
}
