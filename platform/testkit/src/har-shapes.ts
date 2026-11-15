// The shape of a HAR recording, for a person to read without seeing anyone's data: each call to the site's origins,
// as its method, path, status, query and header names, and the field names and types of its JSON bodies. Used on
// recordings that hold personal data (a signed-in session), before any scrub rule exists for it. The rule it keeps:
// no value from the recording is ever in the output, only names and types. A name that looks like data (digits, an @,
// a long token) is masked too, since some APIs key objects by an ID or an email. Platform code: names no site.

/** One call, as its shape. */
export interface CallShape {
  method: string;
  /** The path, with segments that look like IDs masked. */
  path: string;
  status: number;
  query: string[];
  requestHeaders: string[];
  requestBody: string | null;
  responseBody: string | null;
}

/** A HAR entry, as far as this reads it. */
interface HarEntry {
  request: { method: string; url: string; headers: { name: string }[]; postData?: { text?: string } };
  response: { status: number; content?: { text?: string; encoding?: string; mimeType?: string } };
}

/** How deep a body's shape goes before it's cut off. */
const MAX_DEPTH = 8;

/** A name or path segment that may be data: digits in a run, an @, or a long unbroken token. */
const looksLikeData = (name: string) => /\d{4,}|@|^[A-Za-z0-9_-]{24,}$|^[0-9a-f-]{16,}$/i.test(name);

const maskName = (name: string) => (looksLikeData(name) ? '<id>' : name);

/**
 * A JSON value's shape, as indented lines: objects by their keys, arrays by their length and their first item's shape,
 * and leaves by their type only.
 */
export function shapeOf(value: unknown, depth = 0): string {
  const indent = '  '.repeat(depth + 1);
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return 'array(0)';
    return `array(${value.length}) of ${depth >= MAX_DEPTH ? '…' : shapeOf(value[0], depth + 1)}`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return '{}';
    if (depth >= MAX_DEPTH) return `{ ${entries.length} fields }`;
    return `{\n${entries.map(([key, field]) => `${indent}${maskName(key)}: ${shapeOf(field, depth + 1)}`).join('\n')}\n${'  '.repeat(depth)}}`;
  }
  return typeof value;
}

/** A body's shape: JSON as its shape, anything else as its kind and length. */
function bodyShape(text: string | undefined, encoding?: string, mimeType?: string): string | null {
  if (text === undefined || text === '') return null;
  if (encoding === 'base64') return `${mimeType ?? 'binary'} (${text.length} base64 characters)`;
  try {
    return shapeOf(JSON.parse(text));
  } catch {
    return `${mimeType ?? 'text'} (${text.length} characters)`;
  }
}

/** The shapes of a HAR's calls to these origins, in order; calls for scripts, styles, images and fonts are left out. */
export function harShapes(har: { log: { entries: HarEntry[] } }, origins: readonly string[]): CallShape[] {
  const shapes: CallShape[] = [];
  for (const entry of har.log.entries) {
    let url: URL;
    try {
      url = new URL(entry.request.url);
    } catch {
      continue;
    }
    if (!origins.includes(url.origin)) continue;
    const mimeType = entry.response.content?.mimeType ?? '';
    if (/javascript|css|image|font/.test(mimeType)) continue;
    shapes.push({
      method: entry.request.method,
      path: url.pathname.split('/').map(maskName).join('/'),
      status: entry.response.status,
      query: [...new Set(url.searchParams.keys())].map(maskName),
      requestHeaders: [...new Set(entry.request.headers.map((header) => header.name.toLowerCase()))].filter((name) => !name.startsWith(':')).sort(),
      requestBody: bodyShape(entry.request.postData?.text),
      responseBody: bodyShape(entry.response.content?.text, entry.response.content?.encoding, mimeType),
    });
  }
  return shapes;
}

/** The shapes as text for a person to read: one block per call. */
export function formatShapes(shapes: readonly CallShape[]): string {
  return shapes
    .map((shape) => [
      `## ${shape.method} ${shape.path} → ${shape.status}`,
      shape.query.length ? `query: ${shape.query.join(', ')}` : null,
      `request headers: ${shape.requestHeaders.join(', ')}`,
      shape.requestBody ? `request body: ${shape.requestBody}` : null,
      shape.responseBody ? `response body: ${shape.responseBody}` : null,
    ].filter(Boolean).join('\n'))
    .join('\n\n');
}
