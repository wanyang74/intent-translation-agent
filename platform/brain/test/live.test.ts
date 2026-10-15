// A few live model calls, opt-in: LIVE=1 and an API key (ANTHROPIC_API_KEY, or .env.local at the repo root). For each
// site, the first user message of its first example conversation goes through the real brain with Claude; the client
// side runs the tools with core.js against the site's recorded fixtures, so no site is called. This checks the
// plumbing, not the quality of the answer (evals judge that): the turn ends in an answer, every event follows the
// protocol, and steps after the first read the global segment from the prompt cache.
//   LIVE=1 node --test platform/brain/test/live.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { ClientTurn } from '../../contract/generated/types.ts';
import { listSites, repoRoot } from '../../contract/src/site-pack.ts';
import { runToolCall, startSession } from '../../core/src/index.ts';
import { validatorFor } from '../../core/src/validate.ts';
import { loadConversations } from '../../testkit/src/conversations.ts';
import { FakeClient, inProcess } from '../../testkit/src/fake-client.ts';
import { loadFixtures } from '../../testkit/src/fixtures.ts';
import { loadSiteRuntime } from '../../testkit/src/site-runtime.ts';
import { testHost } from '../../testkit/src/test-host.ts';
import { anthropicModel } from '../src/anthropic.ts';
import { setting } from '../src/env.ts';
import { Brain, type BrainLogEntry } from '../src/loop.ts';
import { loadSite } from '../src/site.ts';

const live = process.env.LIVE === '1';
const apiKey = setting('ANTHROPIC_API_KEY', path.join(repoRoot, '.env.local'));
const skip = !live ? 'set LIVE=1 to call the real model' : !apiKey ? 'no API key in ANTHROPIC_API_KEY or .env.local' : false;

for (const id of listSites()) {
  test(`${id}: a live turn through the real brain and the real model`, { skip, timeout: 240_000 }, async () => {
    const conversation = loadConversations(id)[0]!;
    const turn = conversation.messages.find((m) => m.type === 'turn') as ClientTurn;
    const now = Date.parse(conversation.now!);
    const site = await loadSite(id);
    const rt = await loadSiteRuntime(id);
    const host = testHost({ site: id, fixtures: loadFixtures(id), start: now, pageData: conversation.pageData ?? null });
    const { session } = await startSession({ pack: rt.pack, site: rt.code, validators: rt.validators, host: host.host });
    session.setPage(turn.pageContext);

    const log: BrainLogEntry[] = [];
    const brain = new Brain({ sites: [site], model: anthropicModel({ apiKey: apiKey! }), now: () => now, log: (e) => log.push(e) });
    const client = new FakeClient(inProcess(brain), {
      site: id,
      validate: validatorFor(site.validators.platform, 'messages.json'),
      results: async (call) => {
        const r = await runToolCall(session, call.name, call.args);
        return r.ok ? { ok: true, output: r.output } : { ok: false, error: r.error };
      },
    });
    const t = await client.turn(turn.message, turn.pageContext);

    const steps = log.filter((e) => e.kind === 'model_step').map((e) => e.detail as Record<string, unknown>);
    console.log(`\n${id}: "${turn.message}"`);
    for (const e of t.events) {
      const detail = e.type === 'tool_call' ? `${e.call.id} ${e.call.name} ${JSON.stringify(e.call.args)}`
        : e.type === 'progress' ? e.text : e.type === 'answer' ? `${e.text} | ${JSON.stringify(e.present)}` : e.type === 'error' ? `${e.code}: ${e.message}` : '';
      console.log(`  ${e.type}${detail ? `: ${detail.slice(0, 400)}` : ''}`);
    }
    for (const s of steps) console.log(`  step ${s.step}: ${s.finish}, ${s.ms} ms, input ${s.inputTokens} (cache read ${s.cacheReadTokens}, written ${s.cacheWriteTokens}), output ${s.outputTokens}`);
    for (const e of log.filter((x) => x.kind === 'call_refused' || x.kind === 'presentation_refused')) console.log(`  refused: ${JSON.stringify(e.detail)}`);

    assert.deepEqual(t.problems, []);
    assert.equal(t.error, null, `the turn failed: ${JSON.stringify(t.error)}`);
    assert.ok(t.answer, 'the turn ended in an answer');
    if (steps.length > 1) {
      assert.ok(steps.slice(1).every((s) => (s.cacheReadTokens as number) > 0), 'steps after the first read the cached prefix');
    }
  });
}
