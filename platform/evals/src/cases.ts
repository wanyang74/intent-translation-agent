// Snapshot eval cases: what a site pack brings to grade the agent's answers. A case builds a state directly (the
// first turns of an example conversation, replayed as saved), adds the user's next message, runs the agent, and
// grades the outcome: the tool calls of the new turn, the answer on screen, and its text. It never grades the exact
// path the agent took, which would make cases brittle.
// Cases live in sites/<id>/evals/*.json, one file per category, each with defaults for its cases (the clock and the
// page). checkCases says whether every case refers only to what exists: conversations, tools, entities, notices,
// fixtures, and the site's pages.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PageContext, SitePack } from '../../contract/generated/types.ts';
import { sitesDir } from '../../contract/src/site-pack.ts';
import type { Conversation } from '../../testkit/src/conversations.ts';
import type { Fixture } from '../../testkit/src/fixtures.ts';

export const CATEGORIES = ['core', 'context', 'safety', 'interface', 'across'] as const;
export type Category = (typeof CATEGORIES)[number];

export type IdValue = string | number;

/** A site tool call the new turn must make. Arguments are a subset: only the keys given are compared. */
export interface CallExpect {
  tool: string;
  /** Arrays compare as sets and strings ignore case, so equivalent arguments in another order still match. */
  args?: Record<string, unknown>;
  /** Arguments the call must not have. */
  without?: string[];
}

/** Something that must be on screen after the turn: a component of a type, or showing an entity's IDs, or a notice. */
export interface ShowExpect {
  type?: 'items' | 'options' | 'comparison' | 'detail' | 'form' | 'notice';
  entity?: string;
  notice?: string;
  /** Every one of these IDs is shown. */
  includes?: IdValue[];
  /** The component starts with these IDs, in this order. */
  first?: IdValue[];
  /** Every ID shown is one of these. */
  only?: IdValue[];
  minItems?: number;
  maxItems?: number;
}

export interface Expect {
  /** How the turn ends. Default: an answer. */
  outcome?: 'answer' | 'error';
  calls?: CallExpect[];
  /** The last call to this tool in the turn (the doc's "last tool call's arguments"). */
  lastCall?: CallExpect;
  /** Tools the turn must not call; true means no site tool at all. */
  noCalls?: string[] | true;
  maxCalls?: number;
  shows?: ShowExpect[];
  /** No item, option, comparison or detail component (a notice alone is fine). */
  showsNoItems?: boolean;
  text?: {
    /** Substrings, ignoring case. */
    includes?: string[];
    /** Regular expressions, ignoring case: each must match. */
    matches?: string[];
    /** Regular expressions, ignoring case: none may match. */
    excludes?: string[];
  };
  /** The answer asks the user something and shows no items yet. */
  asks?: boolean;
  /** A progress line reached the user before the answer. */
  progress?: boolean;
}

/** A change to the fixtures for one case: edit a fixture in place, or add an edited copy under a new ID. */
export interface FixtureEdit {
  from: string;
  /** Add a copy with this ID instead of editing the original. */
  copyAs?: string;
  /** Dotted paths into the fixture (numbers index arrays), with their new values. */
  set: Record<string, unknown>;
}

export interface EvalCase {
  id: string;
  category: Category;
  description: string;
  /** Runs on every change: high-traffic cases. Safety cases always do. */
  quick?: boolean;
  /** The state: the first `turns` user turns of an example conversation, replayed as saved. */
  after?: { conversation: string; turns: number };
  /** The page the message is sent from. Default: the file's page, or the last replayed turn's page. */
  page?: PageContext;
  pageData?: unknown;
  /** The clock (ISO 8601). Default: the file's, or the conversation's. */
  now?: string;
  fixtures?: FixtureEdit[];
  message: string;
  expect: Expect;
}

/** A case file: one category's cases and what they share. */
export interface CaseFile {
  category: Category;
  defaults?: { now?: string; page?: PageContext; pageData?: unknown };
  cases: Omit<EvalCase, 'category'>[];
}

export const evalsDir = (site: string) => path.join(sitesDir, site, 'evals');

export const hasEvals = (site: string) => existsSync(evalsDir(site)) && caseFiles(site).length > 0;

function caseFiles(site: string): string[] {
  return readdirSync(evalsDir(site)).filter((file) => file.endsWith('.json') && file !== 'baseline.json').sort();
}

/** Every case of a site, with its file's defaults filled in. */
export function loadCases(site: string): EvalCase[] {
  if (!existsSync(evalsDir(site))) return [];
  return caseFiles(site).flatMap((file) => {
    const caseFile = JSON.parse(readFileSync(path.join(evalsDir(site), file), 'utf8')) as CaseFile;
    const { now, page, pageData } = caseFile.defaults ?? {};
    return caseFile.cases.map((partial): EvalCase => ({
      ...(now ? { now } : {}), ...(page ? { page } : {}), ...(pageData !== undefined ? { pageData } : {}),
      ...partial, category: caseFile.category,
    }));
  });
}

/** What the checks compare cases with. */
export interface CaseContext {
  pack: SitePack;
  conversations: readonly Conversation[];
  fixtures: readonly Fixture[];
}

const SHOW_TYPES = new Set(['items', 'options', 'comparison', 'detail', 'form', 'notice']);

/** Problems with a site's cases, or none. Each is named by its case. */
export function checkCases(cases: readonly EvalCase[], ctx: CaseContext): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const { pack } = ctx;
  for (const evalCase of cases) {
    const add = (problem: string) => problems.push(`${evalCase.id}: ${problem}`);
    // 1. Identity and the message.
    if (!/^[a-z0-9-]+$/.test(evalCase.id)) add('IDs are lowercase words joined by hyphens');
    if (seen.has(evalCase.id)) add('the ID is used twice');
    seen.add(evalCase.id);
    if (!CATEGORIES.includes(evalCase.category)) add(`unknown category ${evalCase.category}`);
    if (!evalCase.message.trim() || evalCase.message.length > 2000) add('the message is empty or longer than a turn allows');
    if (!evalCase.description.trim()) add('no description');
    // 2. The state: a conversation that exists, with enough turns; or a page and a clock of its own.
    const conversation = evalCase.after && ctx.conversations.find((candidate) => candidate.id === evalCase.after!.conversation);
    if (evalCase.after && !conversation) add(`no example conversation ${evalCase.after.conversation}`);
    if (conversation) {
      const turns = conversation.messages.filter((message) => message.type === 'turn').length;
      if (evalCase.after!.turns < 1 || evalCase.after!.turns > turns) add(`${conversation.id} has ${turns} turns, not ${evalCase.after!.turns}`);
    }
    if (!evalCase.after && !evalCase.page) add('a case with no earlier conversation needs a page');
    if (!evalCase.after && !evalCase.now) add('a case with no earlier conversation needs a clock');
    if (evalCase.now && Number.isNaN(Date.parse(evalCase.now))) add(`${evalCase.now} isn't a date`);
    if (evalCase.page) {
      if (!pack.site.pageTypes?.includes(evalCase.page.pageType)) add(`page type ${evalCase.page.pageType} isn't one of the site's`);
      if (!pack.site.origins.some((origin) => evalCase.page!.url.startsWith(origin))) add(`page ${evalCase.page.url} isn't on the site`);
    }
    // 3. Fixture edits name fixtures that exist, and copies get new IDs.
    for (const edit of evalCase.fixtures ?? []) {
      if (!ctx.fixtures.some((fixture) => fixture.id === edit.from)) add(`no fixture ${edit.from}`);
      if (edit.copyAs && ctx.fixtures.some((fixture) => fixture.id === edit.copyAs)) add(`fixture ${edit.copyAs} already exists`);
    }
    // 4. Expectations name the site's tools, entities and notices, and their patterns compile.
    const { expect } = evalCase;
    const tools = [...(expect.calls ?? []), ...(expect.lastCall ? [expect.lastCall] : [])].map((call) => call.tool);
    if (Array.isArray(expect.noCalls)) tools.push(...expect.noCalls);
    for (const tool of tools) if (!pack.tools[tool]) add(`${tool} isn't one of the site's tools`);
    for (const show of expect.shows ?? []) {
      if (show.type && !SHOW_TYPES.has(show.type)) add(`unknown component type ${show.type}`);
      if (show.entity && !pack.entities[show.entity]) add(`unknown entity ${show.entity}`);
      if (show.notice && !pack.notices?.[show.notice]) add(`unknown notice ${show.notice}`);
      if (!show.type && !show.entity && !show.notice) add('a shows expectation needs a type, an entity or a notice');
    }
    for (const pattern of [...(expect.text?.matches ?? []), ...(expect.text?.excludes ?? [])]) {
      try {
        new RegExp(pattern, 'i');
      } catch {
        add(`${pattern} isn't a valid regular expression`);
      }
    }
  }
  return problems;
}

/** Sets a dotted path (numbers index arrays) in a value, creating nothing: the path must exist up to its last key. */
export function setPath(target: unknown, dotted: string, value: unknown): boolean {
  const keys = dotted.split('.');
  let node = target as Record<string, unknown> | unknown[];
  for (const key of keys.slice(0, -1)) {
    const next = (node as Record<string, unknown>)[key];
    if (next === null || typeof next !== 'object') return false;
    node = next as Record<string, unknown>;
  }
  (node as Record<string, unknown>)[keys.at(-1)!] = value;
  return true;
}

/** The fixtures with a case's edits applied; the originals are left as they were. */
export function editFixtures(fixtures: readonly Fixture[], edits: readonly FixtureEdit[] = []): Fixture[] {
  const out = fixtures.map((fixture) => fixture);
  for (const edit of edits) {
    const i = out.findIndex((fixture) => fixture.id === edit.from);
    if (i < 0) throw new Error(`no fixture ${edit.from}`);
    const copy = structuredClone(out[i]!);
    for (const [dotted, value] of Object.entries(edit.set)) {
      if (!setPath(copy, dotted, value)) throw new Error(`fixture ${edit.from} has no ${dotted}`);
    }
    if (edit.copyAs) out.push({ ...copy, id: edit.copyAs, kind: 'synthetic' });
    else out[i] = copy;
  }
  return out;
}
