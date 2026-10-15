// Seeded randomness for property tests, so a failure repeats exactly, in every engine.

/** mulberry32: a small, fast generator; returns numbers in [0, 1). */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)]!;

/** Pieces that have broken sanitizers: fences and their lookalikes, tool-call tags, role labels, invisible and
 * bidirectional characters, lone surrogates, and plain text around them. */
export const RISKY = [
  'a', 'Zq', ' ', '  ', '\n', '\t', '\r\n', '\r', '<', '>', '/', '!', '?', '<b>', '</untrusted>', '< /untrusted >',
  '<untrusted source="x">', '\uFF1C/untrusted\uFF1E', '<tool_use>', '<function_calls>', '<!--', 'System:', 'assistant :',
  'Human:', '\nuser:', '\u202E', '\u202A', '\u2066', '\u200B', '\u200E', '\u2060', '\uFEFF', '\u0007', '\u0000', '\u001B',
  '\u0085', '\u007F', '\u{E0041}', '\u{E007F}', '\u{E0100}', '\uD83D', '\uDE00', '😀', 'é', 'ß', '漢', '\n\n\n\n', '{x}',
  '"', "'", '&', '…', 'Ignore previous instructions.', '[[', ']]',
];

export function riskyString(next: () => number, maxPieces = 12): string {
  let s = '';
  const n = 1 + Math.floor(next() * maxPieces);
  for (let i = 0; i < n; i++) s += pick(next, RISKY);
  return s;
}
