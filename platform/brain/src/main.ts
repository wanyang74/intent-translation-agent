// Runs the brain for local development: every site pack (or the ones in BRAIN_SITES), Claude through AI SDK Core,
// and the HTTP server on PORT (8787 by default). The API key comes from ANTHROPIC_API_KEY or .env.local.
//   npm start -w @intent/brain
import path from 'node:path';
import { listSites, repoRoot } from '../../contract/src/site-pack.ts';
import { anthropicModel, DEFAULT_MODEL } from './anthropic.ts';
import { setting } from './env.ts';
import { Brain } from './loop.ts';
import { createBrainServer } from './server.ts';
import { loadSite } from './site.ts';

const envFile = path.join(repoRoot, '.env.local');
const apiKey = setting('ANTHROPIC_API_KEY', envFile);
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY, or put it in .env.local at the repo root.');
  process.exit(1);
}
const siteIds = (setting('BRAIN_SITES', envFile) ?? listSites().join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const sites = await Promise.all(siteIds.map(loadSite));
const model = anthropicModel({ apiKey, model: setting('BRAIN_MODEL', envFile) ?? DEFAULT_MODEL });
const brain = new Brain({
  sites,
  model,
  log: (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e })),
});
const devOrigins = (setting('BRAIN_DEV_ORIGINS', envFile) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const server = createBrainServer({ brain, allowedOrigins: [...sites.flatMap((s) => s.pack.site.origins), ...devOrigins] });
const port = Number(setting('PORT', envFile) ?? 8787);
server.listen(port, () => console.log(`brain on http://localhost:${port} for ${siteIds.join(', ')} with ${model.name}`));
