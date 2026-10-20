// Tests: Respond's presentation (core/src/present/): presentation calls become UI components filled from tool
// results with the site's templates (L3).
// How: runs tools on the made-up shop so the session holds records, then calls present() and formatting helpers.
// Passes when: cards, comparisons, detail views, options, forms and notices come out as expected; fields no tool
// returned read "not available"; required notices are added; a call that fails the checks is left out and
// reported; and the fast path shows a tool result with the site's presentation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PresentationCall } from '../../contract/generated/types.ts';
import { displayText, formatMoney, groupDigits, present, presentToolResult, runToolCall } from '../src/index.ts';
import { exampleSession } from './example-site.ts';

async function afterSearch() {
  const shop = await exampleSession();
  const outcome = await runToolCall(shop.session, 'search_products', { query: 'shoe' });
  assert.ok(outcome.ok);
  return { ...shop, output: outcome.output };
}
const items = (ids: number[]): PresentationCall => ({ name: 'present_items', args: { entity: 'product', ids: ids as [number, ...number[]], heading: 'Shoes' } });

test('formatting: money and units read the way people write them, without Intl', () => {
  assert.deepEqual([0, 7, 1250, 1234567.5, -45.5, 39427, 0.1 + 0.2].map(formatMoney), ['$0', '$7', '$1,250', '$1,234,567.50', '-$45.50', '$39,427', '$0.30']);
  assert.deepEqual([27689, 1518, 999, 2023.5].map(groupDigits), ['27,689', '1,518', '999', '2,023.5']);
});

test('card text: keeps the parts it has and drops the parts it lacks', () => {
  const template = '{year} {make} {model}';
  assert.equal(displayText(template, { year: 2023, make: 'Tesla', model: 'Model Y' }), '2023 Tesla Model Y');
  assert.equal(displayText(template, { make: 'Tesla', model: 'Model Y' }), 'Tesla Model Y');
  assert.equal(displayText('{trim} · {mileage} mi', { trim: 'Long Range' }), 'Long Range');
  assert.equal(displayText('{trim} · {mileage} mi', { mileage: '27,689' }), '27,689 mi');
  assert.equal(displayText('{trim} · {mileage} mi', { trim: 'LR', mileage: '27,689' }), 'LR · 27,689 mi');
  assert.equal(displayText('{rating} stars', {}), '');
  assert.equal(displayText('{matches} cars', { matches: 0 }), '0 cars', 'zero is a value');
  assert.equal(displayText('Plain title', {}), 'Plain title');
});

test("cards: filled from tool results with the site's templates: title, subtitle, formatted fields, link", async () => {
  const { session } = await afterSearch();
  const { components, refused } = present(session, [items([1, 2])]);
  assert.deepEqual(refused, []);
  const [list] = components;
  assert.equal(list!.type, 'items');
  assert.deepEqual(list!.type === 'items' && list!.items[0], {
    id: 1, title: 'Red Shoe', subtitle: '4.5 stars', link: 'https://www.example.com/p/1',
    fields: [
      { key: 'price', label: 'Price', value: 40, text: '$40' },
      { key: 'total', label: 'Total', value: 45.5, text: '$45.50', estimate: true },
    ],
  });
  assert.equal(list!.type === 'items' && list!.items[1]!.fields[0]!.text, '$1,250');
});

test('missing values: read "not available", and a template drops the missing part', async () => {
  const { session } = await exampleSession();
  session.ids.learn('product', 7);
  const [list] = present(session, [items([7])]).components;
  const card = list!.type === 'items' ? list!.items[0]! : undefined;
  assert.equal(card?.title, '7', 'no name: the ID stands in');
  assert.equal(card?.subtitle, undefined, 'no rating: no subtitle rather than " stars"');
  assert.deepEqual(card?.fields.map((field) => field.text), ['not available', 'not available']);
});

test("other components: comparisons, detail views with the site's sections, options, forms and notices", async () => {
  const { session } = await afterSearch();
  const shown = present(session, [
    { name: 'present_comparison', args: { entity: 'product', ids: [1, 2], attributes: ['price', 'rating'] } },
    { name: 'present_detail', args: { entity: 'product', id: 1, sections: ['overview', 'reviews'] } },
    { name: 'present_form', args: { form: 'shipping', prefill: { zip: '94402', quantity: 2 }, heading: 'Where to?' } },
    { name: 'present_notice', args: { notice: 'total_estimate' } },
  ]);
  const [comparison, detail, form, notice] = shown.components;
  assert.deepEqual(comparison!.type === 'comparison' && comparison!.rows.map((row) => [row.label, row.cells.map((field) => field.text)]), [['Price', ['$40', '$1,250']], ['Rating', ['4.5', '3.9']]]);
  assert.deepEqual(comparison!.type === 'comparison' && comparison!.items.map((i) => i.title), ['Red Shoe', 'Blue Shoe']);
  assert.ok(detail!.type === 'detail');
  assert.deepEqual(detail!.type === 'detail' && detail!.sections.map((section) => section.name), ['overview', 'reviews']);
  assert.deepEqual(detail!.type === 'detail' && detail!.sections[0]!.fields!.map((field) => field.key), ['price', 'total', 'rating', 'name']);
  assert.equal(detail!.type === 'detail' && detail!.sections[1]!.summary, 'Rated 4.5 of 5.');
  assert.deepEqual(form, {
    type: 'form', form: 'shipping', heading: 'Where to?', submitTool: 'place_order',
    fields: [
      { key: 'zip', label: 'Zip', type: 'code', required: true, value: '94402' },
      { key: 'speed', label: 'Speed', type: 'select', required: false, options: ['standard', 'express'] },
      { key: 'quantity', label: 'Quantity', type: 'integer', required: false, min: 1, max: 9, value: 2 },
    ],
  });
  assert.deepEqual(notice, { type: 'notice', notice: 'total_estimate', text: 'Totals are estimates until checkout.', version: '1' });
  assert.equal(shown.components.length, 4, 'the notice was already there: not added twice');
});

test('notices: a required notice is added when a field it explains is shown', async () => {
  const { session } = await afterSearch();
  const { components } = present(session, [items([1])]);
  assert.deepEqual(components.map((component) => component.type), ['items', 'notice']);
});

test('refused cards: a call that fails the checks is left out, reported and logged', async () => {
  const { session, log } = await afterSearch();
  const shown = present(session, [items([1, 99]), { name: 'present_notice', args: { notice: 'made_up' } }]);
  assert.deepEqual(shown.components, []);
  assert.deepEqual(shown.refused.map((refusal) => refusal.error.reason), ['unknown_id', 'unknown_notice']);
  assert.ok(log.some((entry) => entry.kind === 'presentation_refused'));
});

test("fast path: a tool's result is shown with the presentation the site pack names for it", async () => {
  const { session, output } = await afterSearch();
  const components = presentToolResult(session, 'search_products', output);
  assert.deepEqual(components.map((component) => component.type), ['items', 'notice']);
  assert.deepEqual(components[0]!.type === 'items' && components[0]!.items.map((i) => i.id), [1, 2]);
  assert.deepEqual(presentToolResult(session, 'my_orders', { orders: [] }), [], 'no presentation named: nothing early');
});
