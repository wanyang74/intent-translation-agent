// Runs the brain for local development: one site pack (BRAIN_SITE, or the only one there is), Claude through AI SDK
// Core, and the HTTP server on PORT (8787 by default). The API key comes from ANTHROPIC_API_KEY or .env.local.
// A brain serves one site; to try another, run a second brain on another port.
// Every session is traced to traces/<site>/<date>/<sessionId>.jsonl (traces.ts) and kept 30 days: BRAIN_TRACE_DIR
// picks another folder, or "off" turns tracing off; BRAIN_TRACE_DAYS changes how long traces are kept.
// Each session's condensed memory is saved to sites/<site>/session_log/<sessionId>.json at the end of every turn, so
// a session the brain forgot (30 minutes idle, or a restart) picks up where it left off when its ID comes back.
// Memories are kept 24 hours after the conversation's last activity: BRAIN_MEMORY_HOURS changes that, and "off"
// turns memory off.
//   BRAIN_SITE=<site id> npm start -w @intent/brain
import path from 'node:path';
import { listSites, repoRoot, sitesDir } from '../../../contract/src/site-pack.ts';
import { FileMemoryStore } from '../memory/store.ts';
import { anthropicModel, DEFAULT_MODEL } from '../model/anthropic.ts';
import { setting } from './env.ts';
import { Brain } from '../agent/brain.ts';
import { createBrainServer } from './server.ts';
import { TraceWriter } from './traces.ts';
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
const traceDir = setting('BRAIN_TRACE_DIR', envFile)?.trim();
const keepDays = Number(setting('BRAIN_TRACE_DAYS', envFile) ?? 30);
if (!(keepDays > 0)) {
  console.error('Set BRAIN_TRACE_DAYS to a number of days greater than 0.');
  process.exit(1);
}
const traces = traceDir === 'off' ? undefined : new TraceWriter({
  dir: path.resolve(repoRoot, traceDir || 'traces'),
  site: siteId,
  pack: site.pack,
  keepDays,
});
const memoryHours = setting('BRAIN_MEMORY_HOURS', envFile)?.trim();
if (memoryHours !== undefined && memoryHours !== 'off' && !(Number(memoryHours) > 0)) {
  console.error('Set BRAIN_MEMORY_HOURS to a number of hours greater than 0, or to off.');
  process.exit(1);
}
const memory = memoryHours === 'off' ? undefined : new FileMemoryStore({
  dir: path.join(sitesDir, siteId, 'session_log'),
  site: siteId,
  keepHours: Number(memoryHours ?? 24),
});
const brain = new Brain({
  site,
  model,
  memory,
  log: (entry) => {
    console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));
    traces?.log(entry);
  },
});
const devOrigins = (setting('BRAIN_DEV_ORIGINS', envFile) ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
const server = createBrainServer({ brain, allowedOrigins: [...site.pack.site.origins, ...devOrigins], ...(traces ? { tap: traces } : {}) });
const port = Number(setting('PORT', envFile) ?? 8787);
const where = [traces ? `traces in ${path.relative(repoRoot, traces.siteDir)}` : 'no traces', memory ? `memory in ${path.relative(repoRoot, memory.dir)}` : 'no memory'];
server.listen(port, () => console.log(`brain on http://localhost:${port} for ${siteId} with ${model.name}; ${where.join('; ')}`));
