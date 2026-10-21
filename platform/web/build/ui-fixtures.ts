// UI fixtures: what the user saw in a whole conversation, saved so the overlay (and later the native sheets) can be
// built and screenshot-tested before the agent works, and without it. Each one is the surface's events, turn by turn:
// progress lines, early results, the answer with its filled-in cards, or the error message.
// They are made, never written by hand, from two sources that already pass npm test:
//   - each example conversation (sites/<id>/conversations/), played by FakeBrain through real core.js;
//   - each saved eval reference (sites/<id>/evals/references/), played by a FakeModel through real core.js and the
//     real brain, after the earlier turns of its case.
// They live in sites/<id>/ui-fixtures/ and are rebuilt with `npm run ui-fixtures`; a test fails when they're stale.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PageContext } from '../../contract/generated/types.ts';
import { sitesDir } from '../../contract/src/site-pack.ts';
import { runTurn, startSession } from '../../core/src/index.ts';
import { hasEvals, loadCases } from '../../evals/src/cases.ts';
import { loadReference } from '../../evals/src/references.ts';
import { loadSiteMaterials, runCase } from '../../evals/src/run.ts';
import { FakeBrain } from '../../testkit/src/fake-brain.ts';
import { FakeModel } from '../../testkit/src/fake-model.ts';
import { FakeSurface, type SurfaceEvent } from '../../testkit/src/fake-surface.ts';
import type { UiFixture, UiTurn } from '../src/ui-fixture.ts';
import { testHost } from '../../testkit/src/test-host.ts';

export const uiFixturesDir = (site: string) => path.join(sitesDir, site, 'ui-fixtures');

/**
 * Splits a surface's events into turns: each turn ends with its answer or error. A turn whose follow-ups ran as one
 * more turn shows two answers; the second stays with the first message, since the user typed nothing in between.
 */
function byTurn(messages: { message: string; page: PageContext }[], events: SurfaceEvent[]): UiTurn[] {
  const turns: UiTurn[] = messages.map((typed) => ({ ...typed, events: [] }));
  let index = 0;
  for (const event of events) {
    turns[Math.min(index, turns.length - 1)]!.events.push(event);
    if (event.type === 'answer' || event.type === 'error') index++;
  }
  return turns;
}

/**
 * Every UI fixture of one site, built in memory:
 *   1. Each example conversation, every turn, with FakeBrain playing the brain's side.
 *   2. Each case with a saved reference: its earlier turns and its own message, with a FakeModel writing the
 *      reference's steps.
 */
export async function buildUiFixtures(site: string): Promise<UiFixture[]> {
  const materials = await loadSiteMaterials(site);
  const { runtime } = materials;
  const built: UiFixture[] = [];

  // 1. The example conversations.
  for (const conversation of materials.conversations) {
    const { host } = testHost({ site, fixtures: materials.fixtures, start: conversation.now!, pageData: conversation.pageData, brain: new FakeBrain(conversation).brain });
    const { session } = await startSession({ pack: runtime.pack, site: runtime.code, validators: runtime.validators, host });
    const surface = new FakeSurface();
    const typed = conversation.messages.flatMap((message) => (message.type === 'turn' ? [{ message: message.message, page: message.pageContext }] : []));
    for (const turn of typed) {
      session.setPage(turn.page);
      await runTurn(session, turn.message, surface);
    }
    built.push({ id: conversation.id, site, source: 'conversation', description: conversation.description, turns: byTurn(typed, surface.events) });
  }

  // 2. The eval references.
  if (!hasEvals(site)) return built;
  for (const evalCase of loadCases(site)) {
    const reference = loadReference(site, evalCase.id);
    if (!reference) continue;
    const surface = new FakeSurface();
    const trial = await runCase(materials, evalCase, new FakeModel(reference.steps), surface);
    const conversation = evalCase.after ? materials.conversations.find((candidate) => candidate.id === evalCase.after!.conversation) : undefined;
    const earlier = (conversation?.messages ?? []).flatMap((message) => (message.type === 'turn' ? [{ message: message.message, page: message.pageContext }] : [])).slice(0, evalCase.after?.turns ?? 0);
    const page = evalCase.page ?? earlier.at(-1)?.page;
    if (trial.crash || !page) throw new Error(`${site}/${evalCase.id}: the reference didn't replay: ${trial.crash ?? 'no page'}`);
    built.push({ id: evalCase.id, site, source: 'reference', description: evalCase.description, turns: byTurn([...earlier, { message: evalCase.message, page }], surface.events) });
  }
  return built;
}

/** The files for a site's UI fixtures, by file name, exactly as they're written. */
export function fixtureFiles(fixtures: UiFixture[]): Map<string, string> {
  return new Map(fixtures.map((fixture) => [`${fixture.id}.json`, JSON.stringify(fixture, null, 2) + '\n']));
}

/** Writes a site's UI fixtures, removing ones whose source is gone; their screenshots stay. */
export function writeUiFixtures(site: string, fixtures: UiFixture[]): void {
  const dir = uiFixturesDir(site);
  mkdirSync(dir, { recursive: true });
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) rmSync(path.join(dir, file));
  for (const [file, text] of fixtureFiles(fixtures)) writeFileSync(path.join(dir, file), text);
}

export function loadUiFixtures(site: string): UiFixture[] {
  const dir = uiFixturesDir(site);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.json')).sort()
    .map((file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as UiFixture);
}
