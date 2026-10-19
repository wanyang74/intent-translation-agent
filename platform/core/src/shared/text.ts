// Text helpers that need nothing but the JavaScript language: filling templates, UTF-8 and base64.
// core.js runs where there is no TextEncoder, btoa or Buffer (JavaScriptCore, QuickJS), so these are written out.

const NAME = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Text for a template value: arrays are joined with ", ", objects become JSON, null and undefined become "". */
export function show(value: unknown): string {
  if (Array.isArray(value)) return value.map(show).join(', ');
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Replaces each {name} with values[name]. Names that have no value are left as they are, so they can be found. */
export function fill(template: string, values: Record<string, unknown>): string {
  return template.replace(NAME, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? show(values[name]) : whole);
}

/** Whether a filled template still has a {name} left in it. */
export const hasPlaceholder = (text: string): boolean => /\{[A-Za-z_][A-Za-z0-9_]*\}/.test(text);

/** UTF-8 bytes of a string. Unpaired surrogates become U+FFFD, as TextEncoder does. */
export function utf8(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64, with padding, of the string's UTF-8 bytes. */
export function base64(text: string): string {
  const bytes = utf8(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64.charAt((chunk >> 18) & 63) + B64.charAt((chunk >> 12) & 63)
      + (i + 1 < bytes.length ? B64.charAt((chunk >> 6) & 63) : '=')
      + (i + 2 < bytes.length ? B64.charAt(chunk & 63) : '=');
  }
  return out;
}
