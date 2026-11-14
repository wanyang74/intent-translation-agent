// Tests: present_destination, the Take me there button (core/src/present/ and the boundary checks).
// How: the made-up shop's four destinations, after a search so the session knows some product IDs.
// Passes when: a destination's URL is built from its deep link or by site code, with the app's route when there is
// one; a page action that changes the site comes as a confirming button only with the item's summary; unknown destinations, bad or unknown params, and a URL off the site's pages are refused with errors the model
// can act on; and nothing about the URL comes from the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PresentationCall } from '../../contract/generated/types.ts';
import { present, runToolCall } from '../src/index.ts';
import { examplePack } from './example-pack.ts';
import { exampleCode, exampleSession, exampleValidators } from './example-site.ts';

async function afterSearch() {
  // The shop's search takes its query as text; the made-up validators check only what a test sets.
  const validators = exampleValidators({ 'tools/search_products.input.json': (data) => data.query === undefined || typeof data.query === 'string' });
  const { session } = await exampleSession({ validators });
  assert.ok((await runToolCall(session, 'search_products', { query: 'shoe' })).ok);
  return session;
}
const go = (destination: string, params?: Record<string, unknown>): PresentationCall => ({ name: 'present_destination', args: { destination, ...(params ? { params } : {}) } });

test("destinations: the URL comes from the site pack's deep link, or the site code for a tool's arguments, with the app's route; a button for one item names it", async () => {
  const session = await afterSearch();
  const { components, refused } = present(session, [go('product_page', { productId: 1 }), go('search_page', { query: 'shoe', colors: ['red'] }), go('help_center')]);
  assert.deepEqual(refused, []);
  assert.deepEqual(components[0], { type: 'destination', destination: 'product_page', title: 'This product', url: 'https://www.example.com/p/1', appRoute: 'shop://products/1', item: { kind: 'product', id: 1 } });
  assert.deepEqual(components[1], { type: 'destination', destination: 'search_page', title: 'These results', url: `https://www.example.com/s?q=shoe&state=${btoa(JSON.stringify({ colors: ['red'] }))}` });
  assert.deepEqual(components[2], { type: 'destination', destination: 'help_center', title: 'Help', url: 'https://www.example.com/help' });
});

test('destinations: unknown pages, bad or unknown params, unknown IDs and pages off the site are refused', async () => {
  const session = await afterSearch();
  const reasonFor = (call: PresentationCall) => present(session, [call]).refused[0]?.error.reason;
  assert.equal(reasonFor(go('checkout')), 'unknown_destination');
  assert.match(present(session, [go('checkout')]).refused[0]!.error.message, /product_page, search_page, help_center, partner/, 'the error lists the pages there are');
  assert.equal(reasonFor(go('product_page')), 'bad_destination_params', 'a missing param');
  assert.equal(reasonFor(go('product_page', { productId: 'one' })), 'bad_destination_params', 'the wrong type');
  assert.equal(reasonFor(go('product_page', { productId: 1, url: 'https://evil.example' })), 'bad_destination_params', 'a param the destination does not take');
  assert.equal(reasonFor(go('product_page', { productId: 999 })), 'unknown_id', 'an item this session never saw');
  assert.equal(reasonFor(go('search_page', { query: 7 })), 'bad_destination_params', "a tool's arguments are checked as a call to that tool");
  assert.equal(reasonFor(go('help_center', { section: 'returns' })), 'bad_destination_params', 'a destination with no params takes none');
  assert.equal(reasonFor(go('partner')), 'destination_unavailable', 'a URL off the pages where the agent appears');
});

/**
 * The shop with two page actions on its search page: one that shows a product, and one that adds it to the cart (D6).
 * `summary` is what the add button's builder says about the product; undefined leaves it out.
 */
async function withPageActions(summary: string[] | undefined) {
  const pack = structuredClone(examplePack);
  pack.pageActions = {
    show_product: { description: 'Opens the product on the search page', effect: 'shows_information', pageTypes: ['home'] },
    add_product: { description: "Presses the product's Add to cart", effect: 'changes_site_state', pageTypes: ['home'], button: 'Add to cart on the shop', consent: 'Puts it in your cart on the shop.', done: 'Added: {hint}.' },
  };
  const params = { productId: { type: 'integer' as const, entity: 'product' } };
  pack.destinations = { ...pack.destinations, show_on_page: { title: 'On the page', description: 'D', params, pageAction: 'show_product' }, add_to_cart: { title: 'Add to your cart', description: 'D', params, pageAction: 'add_product' } };
  const built = (params: { productId: number }) => ({ url: 'https://www.example.com/s?q=shoe', focus: { target: { productId: params.productId }, hint: `product ${params.productId}` }, ...(summary ? { summary } : {}) });
  const code = { ...exampleCode, destinations: { ...exampleCode.destinations, show_on_page: built, add_to_cart: built } };
  const validators = exampleValidators({ 'tools/search_products.input.json': (data) => data.query === undefined || typeof data.query === 'string' }, pack);
  const { session } = await exampleSession({ pack, code, validators });
  assert.ok((await runToolCall(session, 'search_products', { query: 'shoe' })).ok);
  return session;
}

test("destinations: a page action that changes the site is a confirming button, with the action's consent and the builder's summary", async () => {
  const session = await withPageActions(['Shoe, size 9', '$40']);
  const { components, refused } = present(session, [go('add_to_cart', { productId: 1 }), go('show_on_page', { productId: 1 })]);
  assert.deepEqual(refused, []);
  assert.deepEqual(components[0], {
    type: 'destination', destination: 'add_to_cart', title: 'Add to your cart', url: 'https://www.example.com/s?q=shoe',
    focus: { action: 'add_product', target: { productId: 1 }, hint: 'product 1' },
    confirm: { summary: ['Shoe, size 9', '$40'], consent: 'Puts it in your cart on the shop.', button: 'Add to cart on the shop' },
    item: { kind: 'product', id: 1 },
  });
  assert.equal((components[1] as { confirm?: unknown }).confirm, undefined, 'an action that only shows information has no confirming button');
});

test('destinations: with no summary of the item, a page action that changes the site gets no button', async () => {
  for (const summary of [undefined, [], ['  ']]) {
    const session = await withPageActions(summary);
    const { components, refused } = present(session, [go('add_to_cart', { productId: 1 }), go('show_on_page', { productId: 1 })]);
    assert.equal(refused[0]?.error.reason, 'destination_unavailable', `summary ${JSON.stringify(summary)}`);
    assert.deepEqual(components.map((component) => component.type === 'destination' && component.destination), ['show_on_page'], 'the button that only shows the product stays');
  }
});

test('destinations: a refused button leaves the rest of the answer standing', async () => {
  const session = await afterSearch();
  const { components, refused } = present(session, [{ name: 'present_items', args: { entity: 'product', ids: [1] } }, go('partner')]);
  assert.deepEqual(components.map((component) => component.type), ['items', 'notice']);
  assert.equal(refused.length, 1);
});
