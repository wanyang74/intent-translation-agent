// L1 for the small pieces: template filling, base64, derived-field formulas and deep links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64, buildLink, computeDerived, deepLink, derivedFields, fill, FormulaError, linkPlaceholders, parseFormula, utf8 } from '../src/index.ts';
import { examplePack } from './example-pack.ts';
import { random, riskyString } from './random.ts';
import { sitePacks } from './sites.ts';

const packs = [examplePack, ...sitePacks()];

test('fill joins lists, writes objects as JSON, and leaves unknown names visible', () => {
  assert.equal(fill('{a} and {b}', { a: 1, b: ['x', 'y'] }), '1 and x, y');
  assert.equal(fill('{o}|{n}|{u}', { o: { k: 1 }, n: null, u: undefined }), '{"k":1}||');
  assert.equal(fill('{missing} stays', {}), '{missing} stays');
});

test('UTF-8 and base64 match Node for random text, including lone surrogates', () => {
  const next = random(7);
  for (let i = 0; i < 500; i++) {
    const text = riskyString(next, 20);
    assert.deepEqual(utf8(text), [...Buffer.from(text, 'utf8')], JSON.stringify(text));
    assert.equal(base64(text), Buffer.from(text, 'utf8').toString('base64'), JSON.stringify(text));
  }
});

test('formulas follow arithmetic precedence and give no value instead of a wrong one', () => {
  const item = { a: 3, b: 4, s: 'x', n: { c: 2 } };
  const evaluate = (src: string) => parseFormula(src).evaluate(item);
  assert.equal(evaluate('a + b * 2'), 11);
  assert.equal(evaluate('(a + b) * 2'), 14);
  assert.equal(evaluate('-a - -b'), 1);
  assert.equal(evaluate('a * n.c - 1.5'), 4.5);
  assert.equal(evaluate('a / 0'), undefined);
  assert.equal(evaluate('a + missing'), undefined);
  assert.equal(evaluate('a + s'), undefined);
  assert.deepEqual(parseFormula('price.total + price.estimatedTaxesAndFees - price.total').paths, ['price.total', 'price.estimatedTaxesAndFees']);
});

test('a formula that does not parse says where', () => {
  for (const [src, msg] of [['2 * (a', /missing "\)"|ends too early/], ['a +', /ends too early/], ['3 # 4', /unexpected "#" at 2/], [')', /unexpected "\)" at 0/], ['', /empty/], ['a b', /unexpected field at 2/]] as const) {
    assert.throws(() => parseFormula(src), (error: Error) => error instanceof FormulaError && msg.test(error.message), src);
  }
});

test('every derived field in every site pack parses, and money is rounded to cents', () => {
  for (const pack of packs) {
    for (const kind of Object.keys(pack.entities)) assert.doesNotThrow(() => derivedFields(pack, kind), `${pack.site.id}/${kind}`);
  }
  assert.deepEqual(computeDerived(examplePack, 'product', { price: 0.1, shipping: { cost: 0.2 } }), { total: 0.3 });
  assert.deepEqual(computeDerived(examplePack, 'product', { price: 10 }), {}, 'a missing input leaves the field out');
  assert.deepEqual(computeDerived(examplePack, 'offer', { price: 1, shipping: { cost: 1 } }), {}, 'the formula applies to products only');
});

test('deep links URL-encode text and base64-encode JSON', () => {
  const link = deepLink(examplePack, 'search', { query: 'red shoes & socks', state: { page: 2, tags: ['é'] } });
  assert.ok(link.ok);
  const url = new URL(link.url);
  assert.equal(url.searchParams.get('q'), 'red shoes & socks');
  assert.deepEqual(JSON.parse(Buffer.from(url.searchParams.get('state')!.replace(/ /g, '+'), 'base64').toString('utf8')), { page: 2, tags: ['é'] });
  assert.deepEqual(deepLink(examplePack, 'product', { id: 7 }), { ok: true, url: 'https://www.example.com/p/7' });
});

test('a deep link with a missing or unusable value, or an unknown name, is refused with the reason', () => {
  assert.deepEqual(deepLink(examplePack, 'product', {}), { ok: false, problems: ['id is missing'] });
  assert.deepEqual(deepLink(examplePack, 'product', { id: { id: 7 } }), { ok: false, problems: ['id must be text or a number'] });
  assert.deepEqual(deepLink(examplePack, 'checkout', {}), { ok: false, problems: ['the site has no deep link named checkout'] });
  assert.deepEqual(buildLink('https://x.example/{a', {}), { ok: false, problems: ['the template has a malformed placeholder'] });
});

test("every site's deep links build once each placeholder has a value", () => {
  for (const pack of packs) {
    for (const [name, link] of Object.entries(pack.deepLinks ?? {})) {
      const params = Object.fromEntries(linkPlaceholders(link!.template).map((placeholder) => [placeholder.name, placeholder.encoding === 'base64json' ? { k: 1 } : 'v']));
      const built = buildLink(link!.template, params);
      assert.ok(built.ok && !/[{}]/.test(built.url) && built.url.startsWith('https://'), `${pack.site.id}/${name}: ${JSON.stringify(built)}`);
    }
  }
});
