// Tests: Carvana's eval cases themselves, where a case's text check must tell a good answer from a weak one.
// How: the case's own patterns against answers the real model wrote in past eval runs.
// Passes when: call-budget's check accepts answers that say how many cars were checked, with a number, and rejects
// the short answers that passed before only because they contained the word "first".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCases } from '../../../platform/evals/src/cases.ts';

const callBudget = loadCases('carvana').find((evalCase) => evalCase.id === 'call-budget')!;
const saysWhatWasChecked = (text: string) => (callBudget.expect.text?.matches ?? []).every((pattern) => new RegExp(pattern, 'i').test(text));

test('call-budget: an answer must say how many cars it checked, as a number', () => {
  for (const good of [
    "Carvana has 1,871 Teslas matching near 94402. That's 82 pages, and I could only check the first page of 21 cars.",
    'I checked 96 of the 1,871 Teslas.',
    'These are 24 cars from the first page; there are 1,871 in total.',
  ]) assert.ok(saysWhatWasChecked(good), `should pass: ${good}`);
  // Seen in the Oct 19 and Oct 20 runs, all graded pass by the old check.
  for (const weak of [
    'Tomorrow-delivery cars first, then Saturday.',
    'Earliest first (tomorrow), then Saturday.',
    'Tomorrow-delivery cars first (those arriving 10/9), then Saturday.',
    'Show earliest first (tomorrow ones).',
    'Show 12 cars first, then Saturday.',
  ]) assert.ok(!saysWhatWasChecked(weak), `should fail: ${weak}`);
});
