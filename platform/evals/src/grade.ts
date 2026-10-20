// Grades one Trial against its case. Two kinds of checks:
//   - Every case: the harness ran, every request had a fixture, the link kept to the protocol, every card the answer
//     named reached the screen, every price in the text comes from a tool result or the user, and no internal ID is
//     in the text.
//   - The case's own expectations: the calls it must (or must not) make, what must be on screen, and the text.
// A trial passes when every check does. A trial whose requests had no fixture is "unrecorded": the model took a path
// the recordings don't cover, so its answer says nothing about the agent, only that the case needs a recording.
import type { UiComponent } from '../../core/src/present/present.ts';
import type { CallExpect, EvalCase, IdValue, ShowExpect } from './cases.ts';
import type { Trial } from './run.ts';

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export type Status = 'pass' | 'fail' | 'unrecorded' | 'crash';

export interface Grade {
  status: Status;
  checks: Check[];
}

// ------------------------------------------------------------------ comparing values

/** Expected and actual argument values: arrays as sets, strings ignoring case, objects by the expected keys only. */
export function valueMatches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item) => actual.some((candidate) => valueMatches(item, candidate)));
  }
  if (typeof expected === 'string') return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) => valueMatches(value, (actual as Record<string, unknown>)[key]));
  }
  return expected === actual;
}

export function callMatches(expected: CallExpect, call: { name: string; args: unknown }): boolean {
  if (call.name !== expected.tool) return false;
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (expected.args && !valueMatches(expected.args, args)) return false;
  return (expected.without ?? []).every((key) => args[key] === undefined || args[key] === null);
}

/** The IDs a component shows, in order. */
export function idsShown(component: UiComponent): IdValue[] {
  switch (component.type) {
    case 'items': return component.items.map((card) => card.id);
    case 'options': return component.options.map((card) => card.id);
    case 'comparison': return component.items.map((item) => item.id);
    case 'detail': return [component.card.id];
    default: return [];
  }
}

const sameId = (left: IdValue, right: IdValue) => String(left) === String(right);
const ITEM_TYPES = new Set(['items', 'options', 'comparison', 'detail']);

export function showMatches(expected: ShowExpect, component: UiComponent): boolean {
  if (expected.type && component.type !== expected.type) return false;
  if (expected.notice && (component.type !== 'notice' || component.notice !== expected.notice)) return false;
  if (expected.entity && (!('entity' in component) || component.entity !== expected.entity)) return false;
  const ids = idsShown(component);
  if (expected.includes && !expected.includes.every((id) => ids.some((shown) => sameId(shown, id)))) return false;
  if (expected.first && !expected.first.every((id, i) => ids[i] !== undefined && sameId(ids[i]!, id))) return false;
  if (expected.only && !ids.every((shown) => expected.only!.some((id) => sameId(shown, id)))) return false;
  if (expected.minItems !== undefined && ids.length < expected.minItems) return false;
  if (expected.maxItems !== undefined && ids.length > expected.maxItems) return false;
  return true;
}

// ------------------------------------------------------------------ facts in the text

/** Money amounts written in a text: "$39,427", "$1,195.50", "$40k". */
export function moneyIn(text: string): { written: string; value: number; rounded: boolean }[] {
  return [...text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\s?[kK]\b)?/g)].map((match) => {
    const whole = Number(match[1]!.replace(/,/g, ''));
    const value = match[3] ? whole * 1000 : whole + Number(`0.${match[2] ?? '0'}`);
    return { written: match[0].trim(), value, rounded: Boolean(match[3]) };
  });
}

/** Every number in a value: numbers anywhere in it, and numbers written inside its strings (with or without commas). */
export function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  else if (typeof value === 'string') {
    for (const match of value.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) out.push(Number(match[0].replace(/,/g, '')));
    for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s?[kK]\b/g)) out.push(Number(match[1]) * 1000);
  } else if (Array.isArray(value)) for (const item of value) numbersIn(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) numbersIn(item, out);
  return out;
}

/**
 * Money in the text that no source supports. An amount is supported when a source has it (to the dollar; to the
 * thousand when written as "$40k"), or when it is the sum or difference of two amounts a source has, as in "$3,837 in
 * taxes and fees" or "$400 cheaper".
 */
export function ungroundedMoney(text: string, sources: readonly unknown[], userMessages: readonly string[]): string[] {
  const known = numbersIn([...sources, ...userMessages]).filter((number) => number >= 1);
  const rounded = new Set(known.map((number) => Math.round(number)));
  const near = (value: number, tolerance: number) => known.some((number) => Math.abs(number - value) <= tolerance);
  const combined = (value: number) => known.some((number) => rounded.has(Math.round(value - number)) || rounded.has(Math.round(number - value)));
  return moneyIn(text).filter((amount) => !(amount.rounded ? near(amount.value, 1000) : near(amount.value, 1) || combined(amount.value))).map((amount) => amount.written);
}

/** IDs the session learned that appear in the text. Short IDs and small numbers are left out: they'd match ordinary words and figures. */
export function idsInText(text: string, ids: readonly IdValue[]): string[] {
  return [...new Set(ids.map(String))].filter((id) => {
    if (/^\d+$/.test(id)) return Number(id) >= 10_000 && new RegExp(`(?<![\\d,.])${id}(?![\\d,])`).test(text);
    return id.length >= 4 && text.includes(id);
  });
}

// ------------------------------------------------------------------ grading

/**
 * Grades a trial:
 *   1. Did the run say anything at all: no harness crash, and every request answered by a fixture.
 *   2. The checks every case gets.
 *   3. The case's own expectations, each one a check.
 */
export function grade(evalCase: EvalCase, trial: Trial): Grade {
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, ...(detail && !pass ? { detail } : {}) });

  // 1. Whether the trial can be judged.
  if (trial.crash) return { status: 'crash', checks: [{ name: 'harness', pass: false, detail: trial.crash }] };
  check('recorded', trial.fixtureMisses.length === 0, trial.fixtureMisses.join('; '));

  // 2. Every case.
  const { expect } = evalCase;
  const text = trial.answer?.text ?? '';
  const components = trial.answer?.components ?? [];
  check('protocol', trial.protocolProblems.length === 0, trial.protocolProblems.join('; '));
  check('outcome', trial.outcome === (expect.outcome ?? 'answer'), `ended with ${trial.outcome}${trial.errorMessage ? `: ${trial.errorMessage}` : ''}`);
  if (trial.answer) {
    check('cards_shown', components.length === trial.answer.present.length, `${trial.answer.present.length} presentation calls, ${components.length} on screen`);
    const ungrounded = ungroundedMoney(text, trial.sources, trial.userMessages);
    check('grounded_money', ungrounded.length === 0, `no source for ${ungrounded.join(', ')}`);
    const leaked = idsInText(text, trial.knownIds);
    check('no_internal_ids', leaked.length === 0, `the text shows ${leaked.join(', ')}`);
  }

  // 3. The case's expectations.
  for (const expected of expect.calls ?? []) {
    check(`calls ${expected.tool}`, trial.calls.some((call) => callMatches(expected, call)), `calls: ${JSON.stringify(trial.calls).slice(0, 400)}`);
  }
  if (expect.lastCall) {
    const last = trial.calls.filter((call) => call.name === expect.lastCall!.tool).at(-1);
    check(`last ${expect.lastCall.tool}`, Boolean(last && callMatches(expect.lastCall, last)), `last: ${JSON.stringify(last ?? null).slice(0, 300)}`);
  }
  if (expect.noCalls === true) check('no site calls', trial.calls.length === 0, `called ${trial.calls.map((call) => call.name).join(', ')}`);
  else for (const tool of expect.noCalls ?? []) check(`no ${tool}`, !trial.calls.some((call) => call.name === tool), `called ${tool}`);
  if (expect.maxCalls !== undefined) check(`at most ${expect.maxCalls} calls`, trial.calls.length <= expect.maxCalls, `${trial.calls.length} calls`);
  const onScreen = components.map((component) => `${component.type}${'entity' in component ? ` ${component.entity}` : ''} [${idsShown(component).join(', ')}]`).join('; ');
  for (const expected of expect.shows ?? []) {
    check(`shows ${expected.type ?? expected.notice ?? expected.entity}`, components.some((component) => showMatches(expected, component)), `on screen: ${onScreen || 'nothing'}`);
  }
  const showsItems = components.some((component) => ITEM_TYPES.has(component.type));
  if (expect.showsNoItems) check('shows no items', !showsItems, `on screen: ${onScreen}`);
  // A question mark, or a request for input in so many words ("Tell me…", "Let me know…").
  if (expect.asks) check('asks', (text.includes('?') || /\b(tell me|let me know)\b/i.test(text)) && !showsItems, `text: ${text.slice(0, 200)}`);
  if (expect.progress) check('progress line', trial.progress.length > 0, 'no progress line before the answer');
  for (const substring of expect.text?.includes ?? []) check(`text includes "${substring}"`, text.toLowerCase().includes(substring.toLowerCase()), `text: ${text.slice(0, 300)}`);
  for (const pattern of expect.text?.matches ?? []) check(`text matches /${pattern}/`, new RegExp(pattern, 'i').test(text), `text: ${text.slice(0, 300)}`);
  for (const pattern of expect.text?.excludes ?? []) {
    const found = new RegExp(pattern, 'i').exec(text);
    check(`text excludes /${pattern}/`, !found, `found "${found?.[0]}"`);
  }

  const passed = checks.every((item) => item.pass);
  return { status: passed ? 'pass' : trial.fixtureMisses.length ? 'unrecorded' : 'fail', checks };
}
