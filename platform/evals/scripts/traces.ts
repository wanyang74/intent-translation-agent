// Reads the real-session traces the local brain writes (traces/<site>/<date>/<sessionId>.jsonl) for benchmarks and
// quality evaluation.
//   npm run traces                                   every session: each turn's steps, calls, failures, times, tokens
//   npm run traces -- --site <id> --since 2026-11-01
//   npm run traces -- promote <trace file> [--id <draft id>] [--zip <zip>]
//                                                    a conversation draft and eval case stubs, with personal details
//                                                    removed, in traces/<site>/drafts/ for review before they become tests
// Cost needs prices: TRACE_PRICES in the environment or .env.local, as dollars per million tokens
// "input,output,cacheRead,cacheWrite". There's no default, since prices change. Traces stay on this machine; a draft
// is committed only after a person has read it.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from '../../contract/src/site-pack.ts';
import { setting } from '../../brain/src/server/env.ts';
import { defaultTraceDir, describeTraces, shownPath, listTraces, promoteTrace, readTrace, summarizeTrace, type Prices } from '../src/traces.ts';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    site: { type: 'string', multiple: true },
    since: { type: 'string' },
    dir: { type: 'string' },
    id: { type: 'string' },
    zip: { type: 'string' },
  },
});
const dir = options.dir ? path.resolve(options.dir) : defaultTraceDir;

function prices(): Prices | undefined {
  const value = setting('TRACE_PRICES', path.join(repoRoot, '.env.local'));
  if (!value) return undefined;
  const [input, output, cacheRead, cacheWrite] = value.split(',').map(Number);
  if ([input, output, cacheRead, cacheWrite].some((price) => price === undefined || !Number.isFinite(price))) {
    console.error('TRACE_PRICES needs four numbers: input,output,cacheRead,cacheWrite (dollars per million tokens).');
    process.exit(1);
  }
  return { input: input!, output: output!, cacheRead: cacheRead!, cacheWrite: cacheWrite! };
}

if (positionals[0] === 'promote') {
  const file = positionals[1];
  if (!file) {
    console.error('Usage: npm run traces -- promote <trace file> [--id <draft id>] [--zip <zip>]');
    process.exit(1);
  }
  const trace = readTrace(path.resolve(file));
  const id = options.id ?? `real-${path.basename(path.dirname(trace.file))}-${trace.sessionId.slice(-8)}`;
  const promoted = await promoteTrace(trace, { id, ...(options.zip ? { zip: options.zip } : {}) });
  const draftDir = path.join(dir, trace.site, 'drafts');
  mkdirSync(draftDir, { recursive: true });
  const conversationFile = path.join(draftDir, `${id}.json`);
  const casesFile = path.join(draftDir, `${id}.cases.json`);
  writeFileSync(conversationFile, JSON.stringify(promoted.conversation, null, 2) + '\n');
  writeFileSync(casesFile, JSON.stringify(promoted.caseDrafts, null, 2) + '\n');
  console.log(`conversation draft: ${shownPath(conversationFile)}`);
  console.log(`eval case stubs:    ${shownPath(casesFile)}`);
  console.log(`fixtures that answer: ${promoted.conversation.fixtures.join(', ') || 'none'}`);
  for (const note of promoted.notes) console.log(`note: ${note}`);
  for (const problem of promoted.problems) console.log(`problem: ${problem}`);
} else if (positionals.length) {
  console.error(`Unknown command ${positionals[0]}. Use no command for the report, or promote.`);
  process.exit(1);
} else {
  const files = listTraces(dir, { ...(options.site ? { sites: options.site } : {}), ...(options.since ? { since: options.since } : {}) });
  if (!files.length) {
    console.log(`No traces in ${shownPath(dir)}. The local brain writes them as you use the agent (npm run brain).`);
  } else {
    console.log(describeTraces(files.map((file) => summarizeTrace(readTrace(file))), prices()));
  }
}
