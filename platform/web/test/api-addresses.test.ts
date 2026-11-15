// Tests: finding API addresses in a site's JavaScript (web/build/api-addresses.ts), as scan-api uses it.
// How: small made-up scripts in the shapes bundlers emit (minified literals, template strings, a webpack runtime).
// Passes when: API addresses are found with their query names and nearby methods; pages, static files and bare base
// URLs are left out; IDs are masked; and a bundler runtime's later chunks are listed by file name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressesIn, apiAddress, laterChunks, maskIds } from '../build/api-addresses.ts';

test('API addresses in minified code are found, with query names and the methods written near them', () => {
  const code = 'const a="https://api.example-shop.test/catalog/api/v2/search?zip=94402&page=1";fetch(a,{method:"POST",body:b});'
    + 'n.get(`/api/v1/items/${item.id}/reviews`);location.href="/cars/red-shoes";';
  const found = addressesIn(code).map((entry) => ({ ...entry.address, methods: entry.methods }));
  assert.deepEqual(found, [
    { host: 'api.example-shop.test', path: '/catalog/api/v2/search', queryNames: ['page', 'zip'], methods: ['GET', 'POST'] },
    { host: '(relative)', path: '/api/v1/items/{id}/reviews', queryNames: [], methods: ['GET', 'POST'] },
  ]);
  assert.ok(addressesIn(code).every((entry) => entry.context.length > 0));
});

test('pages, static files and bare base URLs are not endpoints', () => {
  for (const literal of ['/cars/red-shoes', '/_next/static/chunks/app.js', 'https://cdn.example-shop.test/fonts/Brand.otf', 'https://cdn.example-shop.test/module/assets-manifest.json', 'https://api.example-shop.test/', 'not a url']) {
    assert.equal(apiAddress(literal), null, literal);
  }
});

test("IDs in a path are masked, so a visitor's IDs from a recording never reach the report", () => {
  assert.equal(maskIds('/vehicles/4790305/images/0f1e2d3c4b5a69788796a5b4c3d2e1f0/cameras.glb'), '/vehicles/{id}/images/{id}/cameras.glb');
  assert.equal(maskIds('/consent/019e943c-ca67-78f0-992c-28c0dfd3c06c/en.json'), '/consent/{id}/en.json');
  assert.equal(maskIds('/api/v2/search'), '/api/v2/search');
  assert.equal(maskIds('/api/referenceData/nearestAirport/12.3456/-65.4321/4/airports'), '/api/referenceData/nearestAirport/{number}/{number}/4/airports', 'coordinates could place whoever recorded it');
});

test("a webpack runtime's later chunks are listed by name and hash", () => {
  const runtime = 'd.u=e=>"static/chunks/"+({12:"checkout",34:"finance"}[e]||e)+"."+{12:"0123456789abcdef",34:"fedcba9876543210",56:"00112233aabbccdd"}[e]+".js"';
  assert.deepEqual(laterChunks('https://cdn.example-shop.test/shop/_next/static/chunks/webpack-1.js', runtime), [
    'https://cdn.example-shop.test/shop/_next/static/chunks/checkout.0123456789abcdef.js',
    'https://cdn.example-shop.test/shop/_next/static/chunks/finance.fedcba9876543210.js',
    'https://cdn.example-shop.test/shop/_next/static/chunks/56.00112233aabbccdd.js',
  ]);
});
