// Tests: reading server-sent event streams (contract/src/events.ts), the format of answers that arrive as a series
// of events (responseFormat: sse).
// How: streams written by hand with each feature of the format, then grouped and written back.
// Passes when: events split on blank lines; event names, data over several lines, comments and CRLF line ends are read
// as the format defines; JSON data is parsed and other data kept as text; grouping uses the kind named in the data,
// then the event's name, then "message"; and a list of events written as a stream reads back the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventStreamText, groupEvents, parseEventStream } from '../src/events.ts';

test('reading: blocks split on blank lines; names, multi-line data, comments and CRLF line ends follow the format', () => {
  const stream = [
    ': keep-alive',
    '',
    'event: search',
    'data: {"id":1}',
    '',
    'data: {"a":',
    'data:  2}',
    '',
    'data:plain words',
    '',
    '',
    '',
    'event: nothing',
    '',
  ].join('\r\n');
  assert.deepEqual(parseEventStream(stream), [
    { event: 'search', data: { id: 1 } },
    { data: { a: 2 } },
    { data: 'plain words' },
  ]);
});

test('reading: an empty stream, or one of only comments, has no events', () => {
  assert.deepEqual(parseEventStream(''), []);
  assert.deepEqual(parseEventStream(': ping\n\n: ping\n\n'), []);
});

test("grouping: by the kind the site names in the data, else the event's name, else message", () => {
  const events = [
    { data: { type: 'meta', total: 2 } },
    { data: { type: 'flight', id: 'a' } },
    { event: 'flight', data: { id: 'b' } },
    { data: { type: 'flight', id: 'c' } },
    { data: 'tick' },
  ];
  assert.deepEqual(groupEvents(events, 'type'), {
    meta: [{ type: 'meta', total: 2 }],
    flight: [{ type: 'flight', id: 'a' }, { id: 'b' }, { type: 'flight', id: 'c' }],
    message: ['tick'],
  });
  assert.deepEqual(Object.keys(groupEvents(events)), ['message', 'flight'], 'without eventKind, only the stream names count');
});

test('writing: a list of events, written as a stream, reads back the same', () => {
  const events = [{ event: 'search', data: { searchId: 's1' } }, { data: { type: 'flight', note: 'two\nlines' } }, { data: 'text\nover lines' }];
  const text = eventStreamText(events);
  assert.match(text, /^event: search\ndata: \{"searchId":"s1"\}\n\n/);
  assert.deepEqual(parseEventStream(text), events);
});
