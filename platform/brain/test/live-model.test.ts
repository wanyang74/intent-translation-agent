// Tests: the whole stack with the real model (phase 5's last step). Opt-in: LIVE=1 and an API key
// (ANTHROPIC_API_KEY, or .env.local at the repo root).
// How: every user turn of every example conversation goes through real core.js, the real brain and Claude. core.js
// runs the tools against the site's recorded fixtures, so no site is called.
// Passes when: the plumbing works, not when the answers are good (evals judge that). Each turn ends in an answer the
// user sees, every message follows the protocol, and steps after the first read the prompt prefix from the cache.
//   LIVE=1 node --test platform/brain/test/live-model.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { listSites, repoRoot } from '../../contract/src/site-pack.ts';
import { runTurn, startSession } from '../../core/src/index.ts';
import { validatorFor } from '../../core/src/shared/validate.ts';
import { loadConversations } from '../../testkit/src/conversations.ts';
import { inProcess } from '../../testkit/src/fake-client.ts';
import { FakeSurface } from '../../testkit/src/fake-surface.ts';
import { loadFixtures } from '../../testkit/src/fixtures.ts';
import { LinkRecorder } from '../../testkit/src/link-recorder.ts';
import { loadSiteRuntime } from '../../testkit/src/site-runtime.ts';
import { testHost } from '../../testkit/src/test-host.ts';
import { anthropicModel } from '../src/model/anthropic.ts';
import { setting } from '../src/server/env.ts';
import { Brain } from '../src/agent/brain.ts';
import type { BrainLogEntry } from '../src/agent/types.ts';
import { loadSite } from '../src/prompt/site.ts';

const live = process.env.LIVE === '1';
const apiKey = setting('ANTHROPIC_API_KEY', path.join(repoRoot, '.env.local'));
const skip = !live ? 'set LIVE=1 to call the real model' : !apiKey ? 'no API key in ANTHROPIC_API_KEY or .env.local' : false;

/** One line per event on the link, for reading a live run. */
function describe(message: unknown): string {
  const event = message as Record<string, any>;
  const detail = event.type === 'turn' ? event.message
    : event.type === 'tool_call' ? `${event.call.id} ${event.call.name} ${JSON.stringify(event.call.args)}`
    : event.type === 'results' ? event.results.map((result: { id: string; ok: boolean; error?: { reason?: string } }) => `${result.id} ${result.ok ? 'ok' : result.error?.reason}`).join(', ')
    : event.type === 'progress' ? event.text
    : event.type === 'answer' ? `${event.text} | ${JSON.stringify(event.present)}`
    : event.type === 'error' ? `${event.code}: ${event.message}` : '';
  return `  ${event.type}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`;
}

for (const id of listSites()) {
  for (const conversation of loadConversations(id)) {
    test(`${id}/${conversation.id}: every user turn completes through real core.js, the real brain and the real model`, { skip, timeout: 600_000 }, async () => {
      const now = Date.parse(conversation.now!);
      const log: BrainLogEntry[] = [];
      const brain = new Brain({ site: await loadSite(id), model: anthropicModel({ apiKey: apiKey! }), now: () => now, log: (entry) => log.push(entry) });
      const recorder = new LinkRecorder(inProcess(brain));
      const runtime = await loadSiteRuntime(id);
      const harness = testHost({ site: id, fixtures: loadFixtures(id), start: now, pageData: conversation.pageData ?? null, brain: recorder.send });
      const { session } = await startSession({ pack: runtime.pack, site: runtime.code, validators: runtime.validators, host: harness.host });
      const surface = new FakeSurface();
      const validate = validatorFor(runtime.validators.platform, 'messages.json');

      const turns = conversation.messages.filter((message) => message.type === 'turn');
      const outcomes = [];
      for (const turn of turns) {
        session.setPage(turn.pageContext);
        outcomes.push(await runTurn(session, turn.message, surface));
      }

      console.log(`\n${id}/${conversation.id}`);
      for (const message of recorder.traffic) console.log(describe(message));
      for (const entry of log.filter((logged) => logged.kind === 'model_step')) {
        const step = entry.detail as Record<string, number | string>;
        console.log(`  step ${step.step}: ${step.finish}, ${step.ms} ms, input ${step.inputTokens} (cache read ${step.cacheReadTokens}, written ${step.cacheWriteTokens}), output ${step.outputTokens}`);
      }
      for (const entry of log.filter((logged) => logged.kind === 'call_refused' || logged.kind === 'presentation_refused')) console.log(`  refused: ${JSON.stringify(entry.detail)}`);

      assert.deepEqual(recorder.traffic.filter((message) => !validate(message)), [], 'every message follows the protocol');
      assert.deepEqual(outcomes.map((outcome) => outcome.ok), turns.map(() => true), JSON.stringify(outcomes));
      assert.deepEqual(surface.errors, []);
      assert.equal(surface.answers.length, turns.length, 'each turn ends in an answer the user sees');
      const steps = log.filter((entry) => entry.kind === 'model_step').map((entry) => entry.detail as { cacheReadTokens: number });
      assert.ok(steps.slice(1).every((step) => step.cacheReadTokens > 0), 'steps after the first read the cached prefix');
    });
  }
}
