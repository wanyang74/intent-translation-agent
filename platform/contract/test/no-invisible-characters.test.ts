// Tests: every hand-written source file in the repo (generated code and recorded data are left out).
// How: scans each file for raw invisible characters (zero-width, bidirectional and the like).
// Passes when: there are none. In code they're written as \u escapes, so a reader can see them and no editor or
// tool can silently drop or add one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../src/site-pack.ts';

const SKIP = new Set(['node_modules', 'generated', 'fixtures', 'recordings']);
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(entryPath) : /\.(ts|js|mjs)$/.test(entry.name) ? [entryPath] : [];
  });
}
// Controls other than tab and line breaks, and format characters such as zero-width spaces, bidi controls and BOMs.
const INVISIBLE = /[^\P{Cc}\t\n\r]|\p{Cf}/u;

test('no source file holds a raw invisible character', () => {
  const files = ['platform', 'sites'].flatMap((dir) => sources(path.join(repoRoot, dir)));
  assert.ok(files.length > 30, `scanned ${files.length} files`);
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const match = INVISIBLE.exec(line);
      if (match) hits.push(`${path.relative(repoRoot, file)}:${i + 1} U+${match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
    });
  }
  assert.deepEqual(hits, []);
});
