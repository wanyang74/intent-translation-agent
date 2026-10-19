// Runs the brain for local development: one site pack (BRAIN_SITE, or the only one there is), Claude through AI SDK
// Core, and the HTTP server on PORT (8787 by default). The API key comes from ANTHROPIC_API_KEY or .env.local.
// A brain serves one site; to try another, run a second brain on another port.
//   BRAIN_SITE=<site id> npm start -w @intent/brain
import path from 'node:path';
import { listSites, repoRoot } from '../../../contract/src/site-pack.ts';
import { anthropicModel, DEFAULT_MODEL } from '../model/anthropic.ts';
import { setting } from './env.ts';
import { Brain } from '../agent/brain.ts';
import { createBrainServer } from './server.ts';
import { loadSite } from '../prompt/site.ts';

const envFile = path.join(repoRoot, '.env.local');
const apiKey = setting('ANTHROPIC_API_KEY', envFile);
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY, or put it in .env.local at the repo root.');
  process.exit(1);
}
const available = listSites();
const siteId = setting('BRAIN_SITE', envFile)?.trim() ?? (available.length === 1 ? available[0] : undefined);
if (!siteId || !available.includes(siteId)) {
  console.error(`Set BRAIN_SITE to one of: ${available.join(', ')}.`);
  process.exit(1);
}
const site = await loadSite(siteId);
const model = anthropicModel({ apiKey, model: setting('BRAIN_MODEL', envFile) ?? DEFAULT_MODEL });
const brain = new Brain({
  site,
  model,
  log: (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })),
});
const devOrigins = (setting('BRAIN_DEV_ORIGINS', envFile) ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
const server = createBrainServer({ brain, allowedOrigins: [...site.pack.site.origins, ...devOrigins] });
const port = Number(setting('PORT', envFile) ?? 8787);
server.listen(port, () => console.log(`brain on http://localhost:${port} for ${siteId} with ${model.name}`));
