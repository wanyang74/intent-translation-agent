// A few live model calls, opt-in: LIVE=1 and an API key (ANTHROPIC_API_KEY, or .env.local at the repo root). For each
// site, the first user message of its first example conversation goes through the real brain with Claude; the client
// side runs the tools with core.js against the site's recorded fixtures, so no site is called. This checks the
// plumbing, not the quality of the answer (evals judge that): the turn ends in an answer, every event follows the
// protocol, and steps after the first read the prompt prefix from the prompt cache.
//   LIVE=1 node --test platform/brain/test/live.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { ClientTurn } from '../../contract/generated/types.ts';
import { listSites, repoRoot } from '../../contract/src/site-pack.ts';
import { runToolCall, startSession } from '../../core/src/index.ts';
import { validatorFor } from '../../core/src/shared/validate.ts';
import { loadConversations } from '../../testkit/src/conversations.ts';
import { FakeClient, inProcess } from '../../testkit/src/fake-client.ts';
import { loadFixtures } from '../../testkit/src/fixtures.ts';
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

for (const id of listSites()) {
  test(`${id}: a live turn through the real brain and the real model`, { skip, timeout: 240_000 }, async () => {
    const conversation = loadConversations(id)[0]!;
    const turn = conversation.messages.find((message) => message.type === 'turn') as ClientTurn;
    const now = Date.parse(conversation.now!);
    const bundle = await loadSite(id);
    const rt = await loadSiteRuntime(id);
    const harness = testHost({ site: id, fixtures: loadFixtures(id), start: now, pageData: conversation.pageData ?? null });
    const { session } = await startSession({ pack: rt.pack, site: rt.code, validators: rt.validators, host: harness.host });
    session.setPage(turn.pageContext);

    const log: BrainLogEntry[] = [];
    const brain = new Brain({ site: bundle, model: anthropicModel({ apiKey: apiKey! }), now: () => now, log: (entry) => log.push(entry) });
    const client = new FakeClient(inProcess(brain), {
      site: id,
      validate: validatorFor(bundle.validators.platform, 'messages.json'),
      results: async (call) => {
        const outcome = await runToolCall(session, call.name, call.args);
        return outcome.ok ? { ok: true, output: outcome.output } : { ok: false, error: outcome.error };
      },
    });
    const record = await client.turn(turn.message, turn.pageContext);

    const stepLogs = log.filter((entry) => entry.kind === 'model_step').map((entry) => entry.detail as Record<string, unknown>);
    console.log(`\n${id}: "${turn.message}"`);
    for (const event of record.events) {
      const detail = event.type === 'tool_call' ? `${event.call.id} ${event.call.name} ${JSON.stringify(event.call.args)}`
        : event.type === 'progress' ? event.text : event.type === 'answer' ? `${event.text} | ${JSON.stringify(event.present)}` : event.type === 'error' ? `${event.code}: ${event.message}` : '';
      console.log(`  ${event.type}${detail ? `: ${detail.slice(0, 400)}` : ''}`);
    }
    for (const stepLog of stepLogs) console.log(`  step ${stepLog.step}: ${stepLog.finish}, ${stepLog.ms} ms, input ${stepLog.inputTokens} (cache read ${stepLog.cacheReadTokens}, written ${stepLog.cacheWriteTokens}), output ${stepLog.outputTokens}`);
    for (const entry of log.filter((logged) => logged.kind === 'call_refused' || logged.kind === 'presentation_refused')) console.log(`  refused: ${JSON.stringify(entry.detail)}`);

    assert.deepEqual(record.problems, []);
    assert.equal(record.error, null, `the turn failed: ${JSON.stringify(record.error)}`);
    assert.ok(record.answer, 'the turn ended in an answer');
    if (stepLogs.length > 1) {
      assert.ok(stepLogs.slice(1).every((stepLog) => (stepLog.cacheReadTokens as number) > 0), 'steps after the first read the cached prefix');
    }
  });
}
