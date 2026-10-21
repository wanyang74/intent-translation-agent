// Builds the Chrome extension for a site into dist/extension/<site>/.
//   npm run extension -- --site <id> [--brain http://localhost:8787]
import path from 'node:path';
import { parseArgs } from 'node:util';
import { listSites, repoRoot } from '../../contract/src/site-pack.ts';
import { buildExtension } from '../build/extension.ts';

const { values: options } = parseArgs({ options: { site: { type: 'string' }, brain: { type: 'string', default: 'http://localhost:8787' } } });
if (!options.site || !listSites().includes(options.site)) {
  console.error(`Pass --site, one of: ${listSites().join(', ')}.`);
  process.exit(1);
}
const outDir = path.join(repoRoot, 'dist', 'extension', options.site);
await buildExtension({ site: options.site, brainUrl: options.brain!, outDir });
console.log(`${path.relative(repoRoot, outDir)}: load it unpacked in chrome://extensions; it talks to the brain at ${options.brain}`);
