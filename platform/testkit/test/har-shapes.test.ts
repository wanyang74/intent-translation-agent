// Tests: the shape of a recording shows names and types only (src/har-shapes.ts), so a person can read a recording
// that holds personal data without seeing any of it.
// How: a small HAR with made-up personal values in paths, queries, headers and bodies.
// Passes when: every call to the site's origins is listed with its field names and types, no value appears anywhere in
// the output, names that look like data are masked, and calls to other hosts and for scripts or images are left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatShapes, harShapes, shapeOf } from '../src/har-shapes.ts';

const SECRETS = ['Jordan', 'Example', 'jordan@example.com', 'ZZ999999', 'tok-abcdefghijklmnopqrstuvwxyz', '123456789', '4111', 'ABC123'];

const har = {
  log: {
    entries: [
      {
        request: { method: 'GET', url: 'https://www.example-air.com/api/account/ZZ999999/balances?member=ZZ999999&lang=en', headers: [{ name: 'X-Auth', value: 'tok-abcdefghijklmnopqrstuvwxyz' }] },
        response: { status: 200, content: { mimeType: 'application/json', text: JSON.stringify({ data: { firstName: 'Jordan', lastName: 'Example', email: 'jordan@example.com', miles: 123456789, trips: [{ confirmation: 'ABC123', card: '4111' }], byMember: { ZZ999999: { tier: 'Gold' } } } }) } },
      },
      {
        request: { method: 'POST', url: 'https://www.example-air.com/api/trips', headers: [], postData: { text: JSON.stringify({ lastName: 'Example' }) } },
        response: { status: 200, content: { mimeType: 'text/html', text: '<p>Jordan Example</p>' } },
      },
      { request: { method: 'GET', url: 'https://www.example-air.com/app.js', headers: [] }, response: { status: 200, content: { mimeType: 'application/javascript', text: 'Jordan' } } },
      { request: { method: 'GET', url: 'https://ads.example.net/pixel?u=Jordan', headers: [] }, response: { status: 200, content: { mimeType: 'image/gif', text: '' } } },
    ],
  },
};

test("a recording's shape lists each call to the site by its names and types, and no value from it", () => {
  const shapes = harShapes(har as never, ['https://www.example-air.com']);
  assert.deepEqual(shapes.map((shape) => `${shape.method} ${shape.path}`), ['GET /api/account/<id>/balances', 'POST /api/trips']);
  assert.deepEqual(shapes[0]!.query, ['member', 'lang']);
  assert.deepEqual(shapes[0]!.requestHeaders, ['x-auth']);
  const text = formatShapes(shapes);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `"${secret}" leaked:\n${text}`);
  for (const name of ['firstName', 'email', 'miles: number', 'trips: array(1)', 'confirmation: string', '<id>: {', 'tier: string', 'lastName: string']) assert.ok(text.includes(name), `${name} missing:\n${text}`);
  assert.match(text, /text\/html \(\d+ characters\)/);
});

test('a deep body is cut off rather than printed whole', () => {
  let deep: unknown = 'Jordan';
  for (let i = 0; i < 20; i++) deep = { level: deep };
  const shape = shapeOf(deep);
  assert.ok(!shape.includes('Jordan'));
  assert.match(shape, /\{ 1 fields \}/);
});
