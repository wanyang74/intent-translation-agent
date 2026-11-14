// Tests: opening a flight's Details on United's results page (page.ts, pageActions.open_flight_details).
// How: a fake results page built from two rows of United's real results page (SJC to MSY, Dec 8, as the user's
// Chrome showed them on 2026-11-10): both leave at 8:45 AM via Denver, and differ by arrival. Clicking Details
// shows the flight numbers in the row, as United's page does.
// Passes when: the right row is found by its times, airports and stops, scrolled to and opened with one click; an
// open row isn't clicked again; two matching rows, or none by the time limit, mean no click; and details that don't
// show the flight numbers are reported as not confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PageControl, PageElement } from '../../../platform/web/src/page-actions.ts';
import { isFlightRow, pageActions, type FlightTarget } from '../page.ts';

/** Row text as innerText gives it (the user's console joined the lines with " | "). */
const EARLY = ['1 STOP', '8:45 AM', 'Departing at 8:45 AM', '5:23 PM', 'Arriving at 5:23 PM', 'SJC', 'Origin San Jose, CA, US (SJC)', '6H, 38M', 'Duration 6 hours and 38 minutes', 'MSY', 'Destination New Orleans, LA, US (MSY)', 'DEN', '—', 'to', '1H, 26M', '1 hours and 26 minutes', 'United Economy', 'Details', 'Seats', '284 kg CO2', 'From', '$181'].join('\n');
const LATE = EARLY.replace(/5:23 PM/g, '9:22 PM').replace('6H, 38M', '10H, 37M').replace('1H, 26M', '5H, 26M').replace('$181', '$249');
const HEADER = 'Compare fare typesShow calendarUnited Economy®(Main cabin)Economy Plus®(Extra legroom)United First®(Extra-spacious seat)';

const target: FlightTarget = { departs: '8:45 AM', arrives: '5:23 PM', origin: 'SJC', destination: 'MSY', stops: ['DEN'], flightNumbers: ['UA 1554', 'UA 1068'] };

/** A results page whose rows appear after `appearAfter` waits; clicking a row's Details adds `opened` to its text. */
function resultsPage(rows: string[], options: { appearAfter?: number; opened?: (row: string) => string; expanded?: boolean } = {}) {
  const clicks: number[] = [];
  const scrolled: number[] = [];
  let waits = 0;
  const texts = [...rows];
  const expanded = rows.map(() => options.expanded ?? false);
  const rowElement = (index: number): PageElement => {
    const button: PageElement = {
      text: 'Details', attribute: (name) => (name === 'aria-expanded' ? String(expanded[index]) : null),
      find: () => null, findAll: () => [], byId: () => null, parent: () => null, scrollIntoView: () => {},
      click: () => {
        clicks.push(index);
        expanded[index] = true;
        texts[index] += `\n${options.opened ? options.opened(rows[index]!) : 'UA 1554 Boeing 737 UA 1068 Airbus A320'}`;
      },
    };
    return {
      get text() {
        return texts[index]!;
      },
      attribute: () => null, findAll: () => [], byId: () => null, parent: () => null, click: () => {},
      find: (selector) => (selector.startsWith('button[aria-label^="Details for the flight"]') ? button : null),
      scrollIntoView: () => scrolled.push(index),
    };
  };
  const page: PageControl = {
    findAll: (selector) => (selector === '[role="grid"] [role="row"]' && waits >= (options.appearAfter ?? 0) ? [HEADER, ...rows].map((_text, i) => (i === 0 ? { ...rowElement(0), get text() { return HEADER; } } : rowElement(i - 1))) : []),
    byId: () => null,
    wait: async () => {
      waits += 1;
    },
    url: () => 'https://www.united.com/en/us/fsr/choose-flights',
  };
  return { page, clicks, scrolled, waitCount: () => waits };
}

const open = pageActions.open_flight_details!;

test('row match: times, airports and stops pick one of two flights that leave at the same time', () => {
  assert.equal(isFlightRow(EARLY, target), true);
  assert.equal(isFlightRow(LATE, target), false, 'same departure, later arrival');
  assert.equal(isFlightRow(HEADER, target), false);
  assert.equal(isFlightRow(EARLY, { ...target, stops: [] }), false, 'a nonstop is not this one-stop flight');
  assert.equal(isFlightRow(EARLY.replace('8:45 AM', '8:45 AM'), target), true, 'a narrow space before AM still matches');
});

test('open: waits for the results, scrolls to the flight and opens its Details once, confirmed by its flight numbers', async () => {
  const fake = resultsPage([LATE, EARLY], { appearAfter: 3 });
  assert.deepEqual(await open(fake.page, target, { timeoutMs: 30_000 }), { done: true });
  assert.deepEqual([fake.clicks, fake.scrolled], [[1], [1]]);

  const alreadyOpen = resultsPage([EARLY], { expanded: true, opened: () => '' });
  await open(alreadyOpen.page, target, { timeoutMs: 30_000 });
  assert.deepEqual(alreadyOpen.clicks, [], 'an open row is not clicked again (that would close it)');
});

test("open: two matching rows, or none by the time limit, and nothing is clicked; details without the flight numbers aren't confirmed", async () => {
  const twice = resultsPage([EARLY, EARLY]);
  assert.deepEqual(await open(twice.page, target, { timeoutMs: 30_000 }), { done: false, reason: 'ambiguous' });
  assert.deepEqual(twice.clicks, []);

  const missing = resultsPage([LATE]);
  assert.deepEqual(await open(missing.page, target, { timeoutMs: 2_000 }), { done: false, reason: 'not_found' });
  assert.deepEqual(missing.clicks, []);
  assert.equal(missing.waitCount(), 4, 'it kept looking every half second until the time limit');

  const otherFlight = resultsPage([EARLY], { opened: () => 'UA 2600 Boeing 737' });
  assert.deepEqual(await open(otherFlight.page, target, { timeoutMs: 30_000 }), { done: false, reason: 'not_confirmed' });
});
