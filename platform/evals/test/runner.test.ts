// Tests: the eval runner end to end (evals/src/run.ts), on every site, with a FakeModel in place of the model under
// test.
// How: a case is made from an example conversation's last turn, with the turns before it replayed as state. The
// FakeModel then writes the conversation's answer, or a changed one. Then every saved reference
// (sites/<id>/evals/references/) replays.
// Passes when: the case passes when the model writes what the conversation did; fails when the model puts a price on
// screen that no tool returned; is unrecorded when the model asks the site for something no fixture answers; the
// device matches users' (no script sandbox, so no run_script) unless a run asks for scripts; and every saved
// reference passes again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSites } from '../../contract/src/site-pack.ts';
import type { ClientTurn } from '../../contract/generated/types.ts';
import { FakeModel, scriptFromConversation, type FakeStep } from '../../testkit/src/fake-model.ts';
import { hasFixtures } from '../../testkit/src/fixtures.ts';
import type { EvalCase } from '../src/cases.ts';
import { hasEvals, loadCases } from '../src/cases.ts';
import { grade } from '../src/grade.ts';
import { loadReference } from '../src/references.ts';
import type { ModelRequest } from '../../brain/src/model/model.ts';
import { FakeSurface } from '../../testkit/src/fake-surface.ts';
import { loadSiteMaterials, runCase } from '../src/run.ts';

for (const site of listSites().filter(hasFixtures)) {
  const materials = await loadSiteMaterials(site);
  for (const conversation of materials.conversations) {
    const turns = conversation.messages.filter((message): message is ClientTurn => message.type === 'turn');
    const last = turns.at(-1)!;
    // The model steps of the last turn: the conversation's script, after the earlier turns' steps.
    const earlierSteps = scriptFromConversation({ ...conversation, messages: conversation.messages.slice(0, conversation.messages.indexOf(last)) }).length;
    const lastSteps = scriptFromConversation(conversation).slice(earlierSteps);
    const answer = conversation.messages.filter((message) => message.type === 'answer').at(-1)!;
    const calls = conversation.messages.slice(conversation.messages.indexOf(last)).flatMap((message) => (message.type === 'tool_call' ? [message.call] : []));
    const evalCase: EvalCase = {
      id: `${conversation.id}-last-turn`, category: 'core', description: "the conversation's last turn", message: last.message,
      page: last.pageContext, now: conversation.now!, ...(conversation.pageData !== undefined ? { pageData: conversation.pageData } : {}), ...(turns.length > 1 ? { after: { conversation: conversation.id, turns: turns.length - 1 } } : {}),
      expect: {
        calls: calls.map((call) => ({ tool: call.name, args: call.args as Record<string, unknown> })),
        shows: (answer.present ?? []).flatMap((presentation) => ('ids' in presentation.args ? [{ entity: presentation.args.entity, includes: presentation.args.ids }] : [])),
      },
    };

    test(`${site}/${conversation.id}: pass when the model writes what the conversation did`, async () => {
      const trial = await runCase(materials, evalCase, new FakeModel(lastSteps));
      const result = grade(evalCase, trial);
      assert.deepEqual(result.checks.filter((check) => !check.pass), []);
      assert.equal(result.status, 'pass');
      assert.equal(trial.usage.steps, lastSteps.length, 'only the new turn is counted');
      assert.deepEqual(trial.modelSteps.map((step) => step.calls?.map((call) => call.name)), lastSteps.map((step) => step.calls?.map((call) => call.name)), 'what the model wrote is kept');
    });

    test(`${site}/${conversation.id}: fail on a price no tool returned; unrecorded on a request no fixture answers`, async () => {
      const madeUp: FakeStep[] = lastSteps.map((step, i) => (i === lastSteps.length - 1 ? { ...step, text: `${step.text} Only $123,457 today.` } : step));
      const failed = grade(evalCase, await runCase(materials, evalCase, new FakeModel(madeUp)));
      assert.equal(failed.status, 'fail');
      assert.deepEqual(failed.checks.filter((check) => !check.pass).map((check) => check.name), ['grounded_money']);

      const firstCall = lastSteps.find((step) => step.calls?.length && !step.calls[0]!.name.startsWith('present_'));
      if (!firstCall) return;
      const offPath: FakeStep[] = [{ calls: [{ name: firstCall.calls![0]!.name, input: { ...(firstCall.calls![0]!.input as object), page: 99 } }] }, { text: 'Nothing found.' }];
      const unrecorded = grade(evalCase, await runCase(materials, evalCase, new FakeModel(offPath)));
      if (unrecorded.status !== 'unrecorded') assert.equal(unrecorded.status, 'fail', 'a tool that refuses the argument is a plain failure');
    });
  }
}

for (const site of listSites().filter(hasEvals)) {
  test(`${site}: the eval device has no script sandbox unless the run asks for one, and then a script runs`, async () => {
    const materials = await loadSiteMaterials(site);
    const evalCase = loadCases(site).find((candidate) => !candidate.after)!;
    const script = { name: 'run_script', input: { source: 'return { checked: 0 };' } };
    const scriptRun = (seen: ModelRequest[]) => new FakeModel([{ calls: [script] }, (request) => { seen.push(request); return { text: 'Done.' }; }]);
    // Users' device: run_script isn't offered, and a script the model tries anyway is refused.
    const offSeen: ModelRequest[] = [];
    const off = await runCase(materials, evalCase, scriptRun(offSeen));
    assert.equal(off.scripts, false);
    assert.ok(!offSeen[0]!.tools.some((tool) => tool.name === 'run_script'));
    assert.match(JSON.stringify(offSeen[0]!.messages.at(-1)), /scripts_off/);
    // With scripts: offered, and the script runs in the sandbox.
    const onSeen: ModelRequest[] = [];
    const on = await runCase(materials, evalCase, scriptRun(onSeen), new FakeSurface(), { scripts: true });
    assert.equal(on.scripts, true);
    assert.ok(onSeen[0]!.tools.some((tool) => tool.name === 'run_script'));
    assert.match(JSON.stringify(onSeen[0]!.messages.at(-1)), /"checked":0/);
  });

  const withReferences = loadCases(site).map((evalCase) => ({ evalCase, reference: loadReference(site, evalCase.id) })).filter((entry) => entry.reference);
  for (const { evalCase, reference } of withReferences) {
    test(`${site}/${evalCase.id}: saved reference (${reference!.model}) replays and passes`, async () => {
      const materials = await loadSiteMaterials(site);
      const result = grade(evalCase, await runCase(materials, evalCase, new FakeModel(reference!.steps)));
      assert.deepEqual(result.checks.filter((check) => !check.pass), []);
    });
  }
}
