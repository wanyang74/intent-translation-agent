// Tests: the eval graders on their own (evals/src/grade.ts).
// How: hand-made trials and expectations, no model and no runner.
// Passes when: arguments match as a subset, what's on screen is judged right, money in the text is read and traced to
// a source, internal IDs in the text are caught, and a trial's checks add up to the right status (pass, fail or
// unrecorded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiComponent } from '../../core/src/present/present.ts';
import type { EvalCase } from '../src/cases.ts';
import { callMatches, grade, idsInText, moneyIn, showMatches, ungroundedMoney, valueMatches } from '../src/grade.ts';
import type { Trial } from '../src/run.ts';

test('call arguments: match as a subset: arrays as sets, strings ignoring case, objects by their given keys', () => {
  assert.ok(valueMatches({ colors: ['Gray', 'Black'] }, { colors: ['black', 'gray'], make: 'Tesla' }));
  assert.ok(!valueMatches({ colors: ['Gray'] }, { colors: ['Gray', 'Black'] }), 'an extra color is a different search');
  assert.ok(valueMatches({ current: { make: 'Tesla' } }, { current: { make: 'TESLA', zip5: '94402' } }));
  assert.ok(!valueMatches({ year_min: 2023 }, { year_min: '2023' }), 'numbers are not strings');
  assert.ok(callMatches({ tool: 'search', args: { make: 'Tesla' }, without: ['colors'] }, { name: 'search', args: { make: 'Tesla' } }));
  assert.ok(!callMatches({ tool: 'search', without: ['colors'] }, { name: 'search', args: { colors: ['Gray'] } }));
  assert.ok(!callMatches({ tool: 'search' }, { name: 'quote', args: {} }));
});

const items: UiComponent = { type: 'items', entity: 'car', layout: 'cards', items: [1, 2, 3].map((id) => ({ id, title: `Car ${id}`, fields: [] })) };

test('on screen: type, entity, IDs included, first in order, only from a set, how many, and which page a button opens', () => {
  assert.ok(showMatches({ type: 'items', entity: 'car', includes: [2], first: [1, 2], only: [1, 2, 3, 4], minItems: 3, maxItems: 3 }, items));
  assert.ok(showMatches({ entity: 'car', includes: ['3'] }, items), 'IDs compare as text');
  assert.ok(!showMatches({ first: [2] }, items));
  assert.ok(!showMatches({ only: [1, 2] }, items));
  assert.ok(!showMatches({ type: 'detail' }, items));
  assert.ok(showMatches({ notice: 'total' }, { type: 'notice', notice: 'total', text: 'Estimated.' }));
  const button: UiComponent = { type: 'destination', destination: 'help', title: 'Help', url: 'https://www.example.com/help' };
  assert.ok(showMatches({ destination: 'help' }, button));
  assert.ok(showMatches({ type: 'destination' }, button));
  assert.ok(!showMatches({ destination: 'returns' }, button), 'another page');
  assert.ok(!showMatches({ destination: 'help' }, items), 'cards are not a button');
});

test('money reading: amounts in the text are read with commas, cents and "k"', () => {
  assert.deepEqual(moneyIn('$39,427 total, $1,195.50 GAP, under $40k, $ 12').map((amount) => amount.value), [39427, 1195.5, 40000, 12]);
});

test('money grounding: a source has it, or it is a sum or difference of two amounts a source has', () => {
  const sources = [{ price: 35590, fees: 3837 }, { note: 'GAP waiver $1,195' }];
  assert.deepEqual(ungroundedMoney('$35,590 plus $3,837 is $39,427; GAP $1,195; $400 less than $35,990', sources, ['under $36k please']), ['$400', '$35,990']);
  assert.deepEqual(ungroundedMoney('About $36k', sources, []), [], 'a rounded figure is near enough to its source');
  assert.deepEqual(ungroundedMoney('It costs $9,999', sources, []), ['$9,999']);
});

test('internal IDs: caught in the text; short IDs and small numbers are not, since they match ordinary words', () => {
  assert.deepEqual(idsInText('Car 4812031 is ready; 2023 model; off_3MZ8 offer; id 42', [4812031, 2023, 'off_3MZ8', 42]), ['4812031', 'off_3MZ8']);
  assert.deepEqual(idsInText('48120310 and 1,481,203', [481203]), [], 'only whole numbers count');
});

const trial = (over: Partial<Trial> = {}): Trial => ({
  site: 'any', caseId: 'case', category: 'core', outcome: 'answer',
  answer: { text: 'Here is car 1 at $100.', present: [{ name: 'present_items', args: { entity: 'car', ids: [1, 2, 3] } }], components: [items] },
  errorMessage: null, calls: [{ name: 'search', args: { make: 'Tesla' } }], progress: ['Searching…'], fixtureMisses: [], protocolProblems: [], refusals: [],
  sources: [{ price: 100 }], userMessages: ['cars'], knownIds: [1, 2, 3], usage: { steps: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ms: 1, modelSteps: [], ...over,
});
const evalCase = (expect: EvalCase['expect']): EvalCase => ({ id: 'case', category: 'core', description: 'd', message: 'cars', expect });

test('status: pass when every check does, fail on any, unrecorded when a request had no fixture', () => {
  const expect = { calls: [{ tool: 'search', args: { make: 'tesla' } }], shows: [{ type: 'items' as const, includes: [1] }], progress: true, text: { includes: ['car 1'] } };
  assert.equal(grade(evalCase(expect), trial()).status, 'pass');
  const failed = grade(evalCase({ ...expect, noCalls: ['search'] }), trial());
  assert.equal(failed.status, 'fail');
  assert.deepEqual(failed.checks.filter((check) => !check.pass).map((check) => check.name), ['no search']);
  assert.equal(grade(evalCase(expect), trial({ fixtureMisses: ['FakeHost: no search fixture matches'] })).status, 'unrecorded');
  // A call the case forbids fails the trial even when no fixture answers it (seen live: a quote with a guessed zip).
  const forbidden = trial({ calls: [{ name: 'get_quote', args: { zip: '00000' } }], fixtureMisses: ['FakeHost: no quote fixture matches'] });
  assert.equal(grade(evalCase({ noCalls: ['get_quote'] }), forbidden).status, 'fail');
  assert.equal(grade(evalCase(expect), trial({ crash: 'boom' })).status, 'crash');
  // notShown: the turn must not show it (a button where cards were wanted, or the other way round).
  assert.deepEqual(grade(evalCase({ notShown: [{ type: 'items' }] }), trial()).checks.filter((check) => !check.pass).map((check) => check.name), ["doesn't show items"]);
  assert.equal(grade(evalCase({ notShown: [{ type: 'destination' }] }), trial()).status, 'pass');
});

test('universal checks: outcome, cards on screen, grounded money and no internal IDs, on every case', () => {
  const failing = (over: Partial<Trial>) => grade(evalCase({}), trial(over)).checks.filter((check) => !check.pass).map((check) => check.name);
  assert.deepEqual(failing({ outcome: 'error', answer: null, errorMessage: 'Try again.' }), ['outcome']);
  assert.deepEqual(failing({ answer: { ...trial().answer!, components: [] } }), ['cards_shown']);
  assert.deepEqual(failing({ answer: { ...trial().answer!, text: 'Only $77.' } }), ['grounded_money']);
  assert.deepEqual(failing({ knownIds: [12345], answer: { ...trial().answer!, text: 'Car 12345.' } }), ['no_internal_ids']);
});

test('asks: a question mark or a plain request for input counts, never with items on screen', () => {
  const asks = (text: string, components: UiComponent[] = []) => grade(evalCase({ asks: true }), trial({ answer: { text, present: [], components } })).checks.find((check) => check.name === 'asks')!.pass;
  assert.ok(asks('Which make do you have in mind?'));
  assert.ok(asks('Tell me what matters to you, and I will search right away.'));
  assert.ok(!asks('Here are some cars.'));
  assert.ok(!asks('Which one?', [items]));
});
