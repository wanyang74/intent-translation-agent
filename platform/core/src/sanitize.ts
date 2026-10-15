// One sanitizer for all text we didn't write: reviews and other free text from the site, the page context, and goals
// from outside agents. The result goes inside a fence the system prompt treats as material to report on, never as
// instructions. The rules:
//   - unpaired surrogates become U+FFFD first, so every engine reads the rest of the text the same way
//   - control characters (except newline and tab), bidirectional controls, and invisible characters that can carry
//     hidden text (zero-width, word joiners, the Unicode "tag" block, variation-selector supplements) are removed
//   - "<" before a letter, "/", "!" or "?" (spaces between allowed) becomes "‹", so the text can't open or close a
//     fence, a tool call or markup
//   - role labels at the start of a line ("System:", "Assistant:") are marked as quoted, so they can't pass for turns
//   - runs of blank lines collapse to one, surrounding space is trimmed, and the text is cut to a maximum length

// Without the u flag, so it matches code units: engines disagree on how u-flag patterns treat a lone surrogate.
// A pair matches first and is kept; any other surrogate is alone. (No lookbehind: iOS before 16.4 can't parse it.)
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const MARKUP = /[<\uFF1C](?=[ \t\n]*[A-Za-z/!?])/g;
const ROLE = /^([ \t]*)(system|assistant|user|human|developer|tool)([ \t]*):/gim;
const SOURCE = /^[a-z-]+$/;

export const DEFAULT_MAX_LENGTH = 1000;

/** The text with the rules applied, without a fence: what a card shows. */
export function cleanText(text: unknown, maxLength: number = DEFAULT_MAX_LENGTH): string {
  let s = String(text ?? '')
    .replace(SURROGATES, (pair) => (pair.length === 2 ? pair : '\uFFFD'))
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(MARKUP, '\u2039')
    .replace(ROLE, '$1$2 (quoted)$3:')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const chars = Array.from(s);
  if (chars.length > maxLength) s = chars.slice(0, maxLength).join('') + '…';
  return s;
}

/** The text cleaned and fenced: what the model sees. `source` names where it came from, in lowercase letters and dashes. */
export function fence(text: unknown, source: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
  if (!SOURCE.test(source)) throw new RangeError(`fence source must be lowercase letters and dashes, not ${JSON.stringify(source)}`);
  return `<untrusted source="${source}">${cleanText(text, maxLength)}</untrusted>`;
}
