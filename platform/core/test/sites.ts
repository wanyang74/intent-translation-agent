// Every site pack, as core.js receives it at run time (the generated site.json), for tests that run on all of them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SitePack } from '../../contract/generated/types.ts';
import { listSites, sitesDir } from '../../contract/src/site-pack.ts';

export const sitePacks = (): SitePack[] =>
  listSites().map((id) => JSON.parse(readFileSync(path.join(sitesDir, id, 'generated', 'site.json'), 'utf8')) as SitePack);
