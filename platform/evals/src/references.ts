// References: what a real model wrote in a trial that passed, saved so the case can be replayed with no model. npm test
// replays every reference through the whole stack with a FakeModel and grades it again, so a code change that would
// make a known-good answer fail is caught deterministically, before any eval runs. They live in
// sites/<id>/evals/references/<case>.json and are refreshed with `npm run evals -- --save-references`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FakeStep } from '../../testkit/src/fake-model.ts';
import { evalsDir } from './cases.ts';

export interface Reference {
  caseId: string;
  /** The model that wrote it, and when. */
  model: string;
  recorded: string;
  steps: FakeStep[];
}

const referencesDir = (site: string) => path.join(evalsDir(site), 'references');

export function loadReference(site: string, caseId: string): Reference | null {
  const file = path.join(referencesDir(site), `${caseId}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Reference) : null;
}

export function saveReference(site: string, reference: Reference): void {
  mkdirSync(referencesDir(site), { recursive: true });
  writeFileSync(path.join(referencesDir(site), `${reference.caseId}.json`), JSON.stringify(reference, null, 2) + '\n');
}
