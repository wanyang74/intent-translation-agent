// Tests: showing a fare and adding it to United's cart on the results page (page.ts: open_fare_options, and the write
// add_fare_to_cart, D6), through the platform's own runners (web/src/page-actions.ts) and United's site pack.
// How: a fake results page (testkit FakePage) built from what the user's Chrome showed on 2026-11-13, SFO to SEA on
// Nov 20: the column headers with their sort buttons, a nonstop and a one-stop row with a cell per cabin, and the
// "Select a fare to continue" panel a cabin's cell opens, with Basic, Standard and Flexible cards, their prices, Basic's
// terms box and each card's labeled Select. Each test decides what United does with a press: put the fare in a cart
// (cartId in the address), ignore it, or move on to another page.
// Passes when: only the confirmed fare's own Select is ever pressed, once, after the check is saved; the cabin is found
// by its column (Economy Plus's cell also says "United Economy"); a Select that's off while its fares load is waited
// for; a changed price, Basic's terms, a button still off after that, two matching rows or no such fare press nothing;
// the report says done only once United shows a cart or a new page with the flight's numbers; an ignored press says
// so; and showing a fare never presses Select.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSite } from '../../../platform/contract/src/site-pack.ts';
import type { PageFocus } from '../../../platform/core/src/present/present.ts';
import { el, append, remove, FakePage, type FakeNode } from '../../../platform/testkit/src/fake-page.ts';
import { WRITE_MESSAGES, runCheck, runFocus, runWrite, type PendingCheck } from '../../../platform/web/src/page-actions.ts';
import { dollarsIn, isFareSelect, pageActions, writeActions, type FareTarget } from '../page.ts';

const { pack } = readSite('united');
const RESULTS = 'https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=SEA&d=2026-11-20&tt=1&sc=7&px=1&taxng=1&newHP=True&clm=7';
const NOW = Date.parse('2026-11-13T17:15:00Z');
const CABINS = [['United Economy', 'Main cabin'], ['Economy Plus', 'Extra legroom'], ['United First', 'Extra-spacious seat']] as const;

const standard: FareTarget = {
  departs: '4:25 PM', arrives: '9:50 PM', origin: 'SFO', destination: 'SEA', stops: ['LAX'], flightNumbers: ['UA 1506', 'UA 684'],
  cabin: 'United Economy', fare: 'Standard', prices: [377],
};

/** What United does when a fare's Select is pressed. */
type OnSelect = (page: FakePage, panel: FakeNode) => void;
const putInCart: OnSelect = (page, panel) => {
  page.address += '&cartId=7F3A';
  remove(panel);
  append(page.root.children[0]!, el('div', {}, ['Your selected flight', 'UA 1506', 'UA 684', 'Select a return flight']));
};
const ignore: OnSelect = () => {};

/** A fare card in the panel: its cabin, name, price and rules, and its Select (with Basic's terms box). */
function fareCard(fare: string, price: number, options: { basic?: boolean; ticked?: boolean; disabled?: boolean; onSelect: () => void }) {
  return el('div', {}, [
    el('div', {}, ['United Economy®', fare]),
    el('div', {}, [`$${price.toLocaleString('en-US')}`, options.basic ? 'Non-refundable' : 'No change fees']),
    el('button', { type: 'button', 'aria-label': `${price} MileagePlus miles. United Economy ${fare}, select to see more information about MileagePlus earnings` }, [`${price} MileagePlus miles`]),
    ...(options.basic ? [el('input', { type: 'checkbox' }), el('div', {}, ['Basic Economy works for me.']), el('button', { type: 'button', role: 'link', 'aria-label': `View terms for United Economy ${fare} fare for $${price}` }, ['View terms'])] : []),
    el('button', { type: 'button', 'aria-label': `Select United Economy ${fare}`, ...((options.basic && !options.ticked) || options.disabled ? { disabled: '' } : {}) }, ['Select'], options.onSelect),
  ]);
}

/**
 * The results page: headers, then each flight's row. A cabin cell's click marks it open and adds the fare panel after
 * its row, as United does; `fares` is what the United Economy panel offers (name and price).
 */
function resultsPage(options: { rows?: string[][]; onSelect?: OnSelect; fares?: [string, number][]; disabled?: string[]; cabinOpen?: boolean; basicTicked?: boolean } = {}) {
  const fares = options.fares ?? [['Basic (Most restrictive)', 327], ['Standard', 377], ['Flexible (Fully refundable)', 422]];
  const grid = el('div', { role: 'grid' });
  const body = el('body', {}, [grid]);
  const page = new FakePage(el('html', {}, [body]), RESULTS);
  append(grid, el('div', { role: 'row' }, [
    el('div', { role: 'columnheader' }, ['Compare fare types', 'Show calendar']),
    ...CABINS.map(([cabin, note]) => el('div', { role: 'columnheader' }, [el('button', { 'aria-label': `Link. Select to sort results by ${cabin} ${note} from lowest to highest price.` }, [`${cabin}® (${note})`])])),
  ]));
  const openPanel = (row: FakeNode) => {
    const panel: FakeNode = el('div', {}, [el('h4', {}, ['Select a fare to continue'])]);
    for (const [fare, price] of fares) {
      append(panel, fareCard(fare, price, { basic: fare.startsWith('Basic'), ticked: options.basicTicked ?? false, disabled: options.disabled?.includes(fare) ?? false, onSelect: () => (options.onSelect ?? putInCart)(page, panel) }));
    }
    grid.children.splice(grid.children.indexOf(row) + 1, 0, panel);
    panel.parent = grid;
  };
  for (const lines of options.rows ?? [NONSTOP, ONE_STOP]) {
    const row = el('div', { role: 'row' }, [el('div', { role: 'gridcell' }, [...lines, el('button', { 'aria-label': `Details for the flight: Depart ${lines[1]}`, 'aria-expanded': 'false' }, ['Details'])])]);
    for (const [cabin] of CABINS) {
      // Economy Plus is in the economy cabin, and its cell says so: only the column tells it apart.
      const cabinWord = cabin === 'United First' ? 'United First' : 'United Economy';
      const cell = el('div', { role: 'gridcell' }, [el('button', { 'aria-expanded': options.cabinOpen ? 'true' : 'false' }, [`${cabin}®`, 'From', '$327', `${cabinWord} cabin select to view fare options`], (clicked) => {
        clicked.attrs['aria-expanded'] = 'true';
        if (cabin === 'United Economy') openPanel(row);
      })]);
      append(row, cell);
    }
    append(grid, row);
    if (options.cabinOpen) openPanel(row);
  }
  return page;
}

const NONSTOP = ['NONSTOP', '7:25 AM', 'Departing at 7:25 AM', '9:40 AM', 'Arriving at 9:40 AM', 'SFO', 'Origin San Francisco, CA, US (SFO)', '2H, 15M', 'SEA', 'Destination Seattle, WA, US (SEA)', 'UA 494 (Airbus A320)'];
const ONE_STOP = ['1 STOP', '4:25 PM', 'Departing at 4:25 PM', '9:50 PM', 'Arriving at 9:50 PM', 'SFO', 'Origin San Francisco, CA, US (SFO)', '5H, 25M', 'SEA', 'Destination Seattle, WA, US (SEA)', 'LAX', '—', '52M'];

const CABIN_CELL = 'United Economy®';
const focusOn = (target: FareTarget, action = 'add_fare_to_cart'): PageFocus => ({ action, target, hint: `UA 1506 / UA 684 leaving SFO at 4:25 PM, ${target.cabin} ${target.fare}, $${target.prices[0]}` });

/** Runs the write as the extension does, recording how many clicks had happened when the check was saved. */
async function add(page: FakePage, target: FareTarget = standard) {
  const saves: { check: PendingCheck; clicksBefore: number }[] = [];
  const report = await runWrite(pack, writeActions, focusOn(target), page, 'results', async (check) => {
    saves.push({ check, clicksBefore: page.clicks.length });
    return true;
  }, () => NOW);
  return { report, saves };
}

test('fare names: the page says Basic where the search says Base; the sort buttons and other fares never match', () => {
  assert.equal(isFareSelect('Select United Economy Standard', standard), true);
  assert.equal(isFareSelect('Select United Economy Basic (Most restrictive)', { cabin: 'United Economy', fare: 'Base (Most restrictive)' }), true);
  assert.equal(isFareSelect('Select United Economy® Flexible (Fully refundable)', { cabin: 'United Economy', fare: 'Flexible (Fully refundable)' }), true);
  assert.equal(isFareSelect('Select United Economy Flexible (Fully refundable)', standard), false);
  assert.equal(isFareSelect('Link. Select to sort results by United Economy Main cabin from lowest to highest price.', standard), false);
  assert.equal(isFareSelect('Select Economy Plus Standard', standard), false, 'another cabin');
  assert.deepEqual(dollarsIn('From $1,107 or $327.50'), [1107, 327.5]);
});

test("adding: opens the fare's cabin, saves the check, presses the fare's own Select once, and is done when United shows the cart", async () => {
  const page = resultsPage();
  const { report, saves } = await add(page);
  assert.deepEqual(report, { action: 'add_fare_to_cart', result: 'done', message: pack.pageActions!.add_fare_to_cart!.done!.replace('{hint}', focusOn(standard).hint) });
  assert.deepEqual(page.clicks, [CABIN_CELL, 'Select United Economy Standard'], 'the cabin cell, then that fare’s Select, and nothing else');
  assert.equal(saves.length, 1);
  assert.equal(saves[0]!.clicksBefore, 1, 'the check was saved after opening the cabin and before the press');
  assert.ok(page.scrolled.includes('Select United Economy Standard') || page.scrolled.some((name) => name.startsWith('United Economy®')), 'the fare card was scrolled to');
});

test("adding: the cabin is found by its column, so Economy Plus's cell (which also says United Economy) is never opened for it", async () => {
  const page = resultsPage({ onSelect: putInCart });
  await add(page);
  assert.ok(!page.clicks.includes('Economy Plus®'));
  // Asked for Economy Plus, the third cell is the one clicked; its panel isn't recorded here, so nothing is pressed.
  const plus = resultsPage();
  const { report } = await add(plus, { ...standard, cabin: 'Economy Plus' });
  assert.deepEqual(plus.clicks, ['Economy Plus®']);
  assert.equal(report?.result, 'stopped');
});

// A panel with one fare once read the cabin cell's "From" price as the fare's: the card must stay inside the panel.
test('adding: a price other than the confirmed one presses nothing and says what the page shows', async () => {
  const page = resultsPage({ fares: [['Standard', 401]] });
  const { report, saves } = await add(page);
  assert.equal(report?.result, 'stopped');
  assert.equal(report?.message, WRITE_MESSAGES.price_changed.replace('{shown}', '$401').replace('{hint}', focusOn(standard).hint));
  assert.deepEqual(page.clicks, [CABIN_CELL], 'only the cabin was opened');
  assert.deepEqual(saves, [], 'no check saved: nothing was going to be pressed');
});

test("adding: Basic stops at its terms box, which is the traveler's to tick; the box and Select are never touched", async () => {
  const page = resultsPage();
  const basic = { ...standard, fare: 'Base (Most restrictive)', prices: [327] };
  const { report } = await add(page, basic);
  assert.equal(report?.result, 'stopped');
  assert.match(report!.message, /accept its terms first/);
  assert.deepEqual(page.clicks, [CABIN_CELL]);
  // Even with its Select enabled (the traveler ticked the box), a card with a terms box is never pressed.
  const ticked = resultsPage({ basicTicked: true });
  const enabled = await add(ticked, basic);
  assert.equal(enabled.report?.result, 'stopped');
  assert.ok(!ticked.clicks.some((name) => name.startsWith('Select')));
});

/** The page's node with this aria-label. */
function nodeLabeled(node: FakeNode, label: string): FakeNode | null {
  if (node.attrs['aria-label'] === label) return node;
  for (const child of node.children) {
    const found = nodeLabeled(child, label);
    if (found) return found;
  }
  return null;
}

// Seen live: the Standard card showed its Select off for a moment while its fares loaded, and the write stopped with
// "turned off" although the button was on by the time the traveler looked.
test("adding: a Select that's off while its fares load is waited for, and the button the page draws in its place is the one pressed", async () => {
  const page = resultsPage({ disabled: ['Standard'] });
  page.onWait = (waits) => {
    const old = nodeLabeled(page.root, 'Select United Economy Standard');
    if (waits < 2 || !old || old.attrs.disabled === undefined) return;
    // The page draws a new, enabled button; the old one is gone from the page.
    const { disabled: _off, ...attrs } = old.attrs;
    const fresh = el('button', attrs, ['Select'], old.onClick);
    const siblings = old.parent!.children;
    siblings.splice(siblings.indexOf(old), 1, fresh);
    fresh.parent = old.parent;
    old.parent = null;
  };
  const { report, saves } = await add(page);
  assert.equal(report?.result, 'done');
  assert.deepEqual(page.clicks, [CABIN_CELL, 'Select United Economy Standard'], 'pressed once, when it was on');
  assert.equal(saves[0]!.clicksBefore, 1, 'the check was saved before the press');
});

test('adding: a turned-off Select, two matching rows, or no such fare press nothing', async () => {
  const off = resultsPage({ disabled: ['Standard'] });
  assert.match((await add(off)).report!.message, /turned off/);
  assert.deepEqual(off.clicks, [CABIN_CELL], 'a turned-off button is never clicked, not even to see');
  assert.ok(off.waits >= 2 && off.waits <= 20, `it waited a while for the button to turn on, then gave up (${off.waits} waits)`);

  const twice = resultsPage({ rows: [ONE_STOP, ONE_STOP] });
  assert.match((await add(twice)).report!.message, /More than one item/);
  assert.deepEqual(twice.clicks, [], 'two matching rows: not even a cabin is opened');

  const noFlexible = resultsPage({ fares: [['Standard', 377]] });
  const flexible = { ...standard, fare: 'Flexible (Fully refundable)', prices: [422] };
  assert.match((await add(noFlexible, flexible)).report!.message, /couldn't find it/);
  assert.deepEqual(noFlexible.clicks, [CABIN_CELL]);
});

test('adding: when United ignores the press, the report says so, and it was pressed exactly once', async () => {
  const page = resultsPage({ onSelect: ignore });
  const { report } = await add(page);
  assert.deepEqual(report, { action: 'add_fare_to_cart', result: 'unconfirmed', message: WRITE_MESSAGES.ignored.replace('{hint}', focusOn(standard).hint) });
  assert.equal(page.clicks.filter((name) => name === 'Select United Economy Standard').length, 1);
});

test("adding: an already open cabin isn't clicked again, since a second click would close it", async () => {
  const page = resultsPage({ cabinOpen: true, rows: [ONE_STOP] });
  await add(page);
  assert.deepEqual(page.clicks, ['Select United Economy Standard']);
});

test("checking: a cart with no sign of the flight isn't done; a new page with the flight's numbers is, and one without them isn't", async () => {
  const action = writeActions.add_fare_to_cart!;
  const silentCart = resultsPage({ onSelect: (page, panel) => {
    page.address += '&cartId=7F3A';
    remove(panel);
  } });
  assert.equal((await add(silentCart)).report?.result, 'unconfirmed', 'cartId alone is not proof it was this flight');

  // The press led to a new page, which ended the script there; this page confirms it from the saved check.
  const pending: PendingCheck = { action: 'add_fare_to_cart', target: standard, hint: focusOn(standard).hint, savedAt: NOW };
  const tripPage = new FakePage(el('html', {}, [el('body', {}, ['Review your trip', 'UA 1506', 'San Francisco to Los Angeles', 'UA 684', 'Los Angeles to Seattle'])]), 'https://www.united.com/en/us/fsr/review-trip');
  assert.equal(action.check(tripPage, standard), 'confirmed');
  assert.deepEqual(await runCheck(pack, writeActions, pending, tripPage), { action: 'add_fare_to_cart', result: 'done', message: pack.pageActions!.add_fare_to_cart!.done!.replace('{hint}', pending.hint) });
  const otherPage = new FakePage(el('html', {}, [el('body', {}, ['Something went wrong'])]), 'https://www.united.com/en/us/error');
  assert.equal((await runCheck(pack, writeActions, pending, otherPage))?.result, 'unconfirmed');
});

test('showing a fare: opens its cabin and scrolls to its card, never pressing Select; a return flight shows its outbound Details', async () => {
  const page = resultsPage();
  assert.equal(await runFocus(pack, pageActions, focusOn(standard, 'open_fare_options'), page, 'results'), null);
  assert.deepEqual(page.clicks, [CABIN_CELL]);
  assert.ok(page.scrolled.length >= 2, 'the row, then the card');

  const outbound = resultsPage({ rows: [ONE_STOP] });
  const { cabin: _cabin, fare: _fare, prices: _prices, ...flight } = standard;
  await runFocus(pack, pageActions, { action: 'open_fare_options', target: flight, hint: 'your outbound flight' }, outbound, 'results');
  assert.ok(outbound.clicks[0]?.startsWith('Details for the flight'), 'no fare to show: its Details opens instead');
  assert.ok(!outbound.clicks.some((name) => name.startsWith('Select')));
});
