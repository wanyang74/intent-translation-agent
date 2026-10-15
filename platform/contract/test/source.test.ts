// Source files hold no raw invisible characters. In code they're written as \u escapes, so a reader can see them and
// no editor or tool can silently drop or add one. Generated code and recorded data are left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../src/site-pack.ts';

const SKIP = new Set(['node_modules', 'generated', 'fixtures', 'recordings']);
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.(ts|js|mjs)$/.test(e.name) ? [p] : [];
  });
}
// Controls other than tab and line breaks, and format characters such as zero-width spaces, bidi controls and BOMs.
const INVISIBLE = /[^\P{Cc}\t\n\r]|\p{Cf}/u;

test('no source file holds a raw invisible character', () => {
  const files = ['platform', 'sites'].flatMap((d) => sources(path.join(repoRoot, d)));
  assert.ok(files.length > 30, `scanned ${files.length} files`);
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const m = INVISIBLE.exec(line);
      if (m) hits.push(`${path.relative(repoRoot, file)}:${i + 1} U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
    });
  }
  assert.deepEqual(hits, []);
});
