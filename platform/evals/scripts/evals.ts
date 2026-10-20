// Runs the snapshot evals with the real model and reports pass rates, the way CI would.
//   npm run evals                          every case of every site, once
//   npm run evals -- --quick               high-traffic cases and every safety case (what each change runs)
//   npm run evals -- --site <id> --case <id> --category <name> --trials 3 --concurrency 4 --model <model id>
//   npm run evals -- --gate                exit with 1 when a gate fails
//   npm run evals -- --save-baseline       record each site's summary as its baseline (sites/<id>/evals/baseline.json)
//   npm run evals -- --save-references     keep each passing case's model steps for npm test to replay
// Every trial is written to sites/<id>/evals/runs/ (git-ignored) for reading afterwards. The API key comes from
// ANTHROPIC_API_KEY or .env.local; no site is called (FakeHost answers from the fixtures).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { listSites, repoRoot } from '../../contract/src/site-pack.ts';
import { anthropicModel, DEFAULT_MODEL } from '../../brain/src/model/anthropic.ts';
import { setting } from '../../brain/src/server/env.ts';
import { checkCases, evalsDir, hasEvals, loadCases, type EvalCase } from '../src/cases.ts';
import { grade, type Grade } from '../src/grade.ts';
import { saveReference } from '../src/references.ts';
import { describeSummary, gates, summarize, type SiteSummary } from '../src/report.ts';
import { loadSiteMaterials, runCase, type Trial } from '../src/run.ts';

const { values: options } = parseArgs({
  options: {
    site: { type: 'string', multiple: true },
    case: { type: 'string', multiple: true },
    category: { type: 'string', multiple: true },
    quick: { type: 'boolean', default: false },
    trials: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '4' },
    model: { type: 'string' },
    gate: { type: 'boolean', default: false },
    'save-baseline': { type: 'boolean', default: false },
    'save-references': { type: 'boolean', default: false },
  },
});

const envFile = path.join(repoRoot, '.env.local');
const apiKey = setting('ANTHROPIC_API_KEY', envFile);
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY, or put it in .env.local at the repo root.');
  process.exit(1);
}
const modelId = options.model ?? setting('BRAIN_MODEL', envFile) ?? DEFAULT_MODEL;
const model = anthropicModel({ apiKey, model: modelId });
const trials = Math.max(1, Number(options.trials));
const concurrency = Math.max(1, Number(options.concurrency));

/** The cases this run selects from a site's cases. */
function selected(cases: EvalCase[]): EvalCase[] {
  return cases.filter((evalCase) => (!options.case || options.case.includes(evalCase.id))
    && (!options.category || options.category.includes(evalCase.category))
    && (!options.quick || evalCase.quick || evalCase.category === 'safety'));
}

/** Runs jobs with at most `limit` at a time, keeping their order in the results. */
async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]!();
    }
  }));
  return results;
}

let allPass = true;
for (const site of (options.site ?? listSites()).filter(hasEvals)) {
  // 1. The site's cases must be well formed before anything runs.
  const materials = await loadSiteMaterials(site);
  const cases = selected(loadCases(site));
  const problems = checkCases(loadCases(site), { pack: materials.runtime.pack, conversations: materials.conversations, fixtures: materials.fixtures });
  if (problems.length) {
    console.error(`${site}: the cases have problems:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  if (!cases.length) continue;

  // 2. Every case, `trials` times, a few at a time.
  console.log(`\n${site}: ${cases.length} cases × ${trials} trial(s) with ${model.name}`);
  const jobs = cases.flatMap((evalCase) => Array.from({ length: trials }, (_, i) => async () => {
    const trial = await runCase(materials, evalCase, model).catch((error): Trial => ({
      site, caseId: evalCase.id, category: evalCase.category, outcome: 'none', answer: null, errorMessage: null, calls: [], progress: [],
      fixtureMisses: [], protocolProblems: [], refusals: [], sources: [], userMessages: [], knownIds: [],
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, ms: 0, modelSteps: [], crash: String(error),
    }));
    const result = grade(evalCase, trial);
    const failed = result.checks.filter((check) => !check.pass).map((check) => `${check.name}${check.detail ? ` (${check.detail.slice(0, 160)})` : ''}`);
    console.log(`${result.status === 'pass' ? '✔' : '✖'} ${evalCase.id} #${i + 1} ${result.status} ${(trial.ms / 1000).toFixed(1)}s${failed.length ? `\n    ${failed.join('\n    ')}` : ''}`);
    return { evalCase, trial, grade: result };
  }));
  const graded = await pool(jobs, concurrency);

  // 3. The run, kept for reading; the summary and the gates.
  const runsDir = path.join(evalsDir(site), 'runs');
  mkdirSync(runsDir, { recursive: true });
  const runFile = path.join(runsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(runFile, JSON.stringify(graded.map(({ trial, grade: result }: { trial: Trial; grade: Grade }) => ({ trial, grade: result })), null, 2) + '\n');
  const summary = summarize(site, model.name, graded);
  console.log(`\n${describeSummary(summary)}\n  trials: ${path.relative(repoRoot, runFile)}`);
  const baselineFile = path.join(evalsDir(site), 'baseline.json');
  const baseline = existsSync(baselineFile) ? (JSON.parse(readFileSync(baselineFile, 'utf8')) as SiteSummary) : null;
  const result = gates(summary, baseline);
  console.log(`  gates${baseline ? ` (against the baseline of ${baseline.date.slice(0, 10)})` : ''}:\n    ${result.lines.join('\n    ')}`);
  if (!result.pass) allPass = false;

  // 4. What to keep: the baseline, and the steps of each case's first passing trial.
  if (options['save-baseline']) {
    writeFileSync(baselineFile, JSON.stringify(summary, null, 2) + '\n');
    console.log(`  baseline saved: ${path.relative(repoRoot, baselineFile)}`);
  }
  if (options['save-references']) {
    const saved = new Set<string>();
    for (const { evalCase, trial, grade: result } of graded) {
      if (result.status !== 'pass' || saved.has(evalCase.id)) continue;
      saveReference(site, { caseId: evalCase.id, model: model.name, recorded: new Date().toISOString(), steps: trial.modelSteps });
      saved.add(evalCase.id);
    }
    console.log(`  references saved for ${saved.size} case(s)`);
  }
}
if (options.gate && !allPass) process.exit(1);
