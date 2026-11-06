// Reading the data Carvana's pages embed for themselves. The pages are Next.js App Router pages, which stream their
// data as `self.__next_f.push([1, "<chunk>"])` scripts; joined, the chunks hold the page's objects as JSON text.
// Used by the page reader (page.ts: the car on screen, from the live page's scripts) and by vehicle_details' parser
// (tools.ts: the same page fetched as HTML), and by the fixture hooks to keep only the car's own data from a recording.
// Plain string work, no DOM and no Node: it runs in core.js wherever core.js runs.

const FLIGHT = 'self.__next_f.push(';

/** The page's streamed data, joined: each script's chunk is the string in its pushed [1, "..."] array. */
export function flightData(scripts: string[]): string {
  return scripts.filter((text) => text.startsWith(FLIGHT)).map((text) => {
    try {
      const entry = JSON.parse(text.slice(FLIGHT.length, text.lastIndexOf(')')));
      return Array.isArray(entry) && typeof entry[1] === 'string' ? entry[1] : '';
    } catch {
      return '';
    }
  }).join('');
}

/** The text of each inline script in a page's HTML. */
export function scriptsIn(html: string): string[] {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
}

/** One streamed script, as the page writes it, for building a page from data. */
export const flightScript = (chunk: string) => `<script>${FLIGHT}${JSON.stringify([1, chunk]).replace(/<\//g, '<\\/')})</script>`;

/**
 * Where the JSON object that opens at `start` ends (just past its closing brace), skipping braces inside strings;
 * -1 if it doesn't close.
 */
export function objectEnd(data: string, start: number): number {
  let inString = false;
  let depth = 0;
  for (let i = start; i < data.length; i++) {
    const char = data[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The JSON object around position `at`:
 *   1. Walk back to the brace that opens the object holding `at`, counting the braces of objects that close in between.
 *   2. Walk forward to its closing brace, skipping braces inside strings.
 *   3. Parse it; null if it isn't JSON.
 */
export function objectAround(data: string, at: number): Record<string, unknown> | null {
  // 1. The opening brace. A brace inside a string before `at` could mislead this; step 3 rejects what doesn't parse.
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    if (data[i] === '}') depth++;
    else if (data[i] === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  // 2. The closing brace.
  const end = objectEnd(data, start);
  if (end < 0) return null;
  // 3. Parse.
  try {
    return JSON.parse(data.slice(start, end)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The text of the object a key names, such as "vehicleDetails":{…}, exactly as the page streams it; null if absent. */
export function namedObjectText(data: string, key: string): string | null {
  const at = data.indexOf(`"${key}":{`);
  if (at < 0) return null;
  const start = at + key.length + 3;
  const end = objectEnd(data, start);
  return end < 0 ? null : data.slice(start, end);
}
