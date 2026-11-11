// Server-sent event streams (responseFormat: sse): an answer that arrives as a series of events, such as a flight
// search that sends the search, then each flight, then the filters. core.js reads the whole stream and groups the
// events by kind, and the response schema checks the grouped object; fixtures keep the events as a list, and FakeHost
// turns that list back into a stream.
//   A stream is blocks separated by a blank line. In each block, "event: name" names the event and "data: ..." lines
//   carry it (several are joined with newlines); lines starting with ":" are comments. Data that is JSON is parsed.
// Pure functions: no Node or browser APIs, so core.js can use them too.
import { select } from './paths.ts';

export interface StreamEvent {
  /** The event's own name, when the stream gives one. */
  event?: string;
  data: unknown;
}

/** The events in a stream, in order. Blocks with no data (keep-alive comments) are skipped. */
export function parseEventStream(text: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    let name: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      // One space after the colon belongs to the format, not the value.
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') name = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (!dataLines.length) continue;
    const raw = dataLines.join('\n');
    let data: unknown = raw;
    try { data = JSON.parse(raw); } catch { /* not JSON: kept as text */ }
    events.push(name === undefined ? { data } : { event: name, data });
  }
  return events;
}

/**
 * The events grouped by kind, in order within each kind: {kind: [data, ...]}. The kind is the value at eventKind in
 * the event's data when the site pack gives one (some sites name events inside the data), else the event's own name,
 * else "message", as the format defines.
 */
export function groupEvents(events: StreamEvent[], eventKind?: string): Record<string, unknown[]> {
  const grouped: Record<string, unknown[]> = {};
  for (const streamEvent of events) {
    const named = eventKind ? select(streamEvent.data, eventKind) : undefined;
    const kind = typeof named === 'string' && named ? named : streamEvent.event ?? 'message';
    (grouped[kind] ??= []).push(streamEvent.data);
  }
  return grouped;
}

/** A list of events as a stream again, the way a server sends it. */
export function eventStreamText(events: StreamEvent[]): string {
  return events.map((streamEvent) => {
    const data = typeof streamEvent.data === 'string' ? streamEvent.data : JSON.stringify(streamEvent.data);
    const lines = data.split('\n').map((line) => `data: ${line}`);
    return [...(streamEvent.event === undefined ? [] : [`event: ${streamEvent.event}`]), ...lines].join('\n') + '\n\n';
  }).join('');
}
