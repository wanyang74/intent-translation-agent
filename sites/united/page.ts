// United's page code: the page reader, the signed-in token the page keeps (D7), the header's Sign in button, and the
// page actions on the results page: opening a flight's details, opening a fare's options, and adding a fare to
// United's cart (D6).
// Page reader: the page type from the URL's path. The results page (/fsr/choose-flights) is a search's; the home page
// is where searches start; My United, account activity and My Trips are the account's; anything else (check-in, help)
// is "other". United's pages carry nothing the agent reads about the item on screen.
// Signed in or not, from the header (seen 2026-11-15): its #loginButton is a "Sign in" button (atm-c-btn) when signed
// out and the traveler's avatar (atm-c-avatar) when signed in. Only whether the avatar is there is read, never its text
// (the traveler's name). localStorage's loginStatus can't tell: United leaves it in place after signing out.
// The token: United's page keeps its current token in its saved app state (IndexedDB "localforage", key
// "reduxPersist:global", a compact list with no field names): the anonymous one when signed out, the traveler's own
// once signed in, renewed on every load. Exactly one token-shaped value is there; anything else reads as none, rather
// than a guess. Read only when an account tool runs, and handed to core.js, which never keeps it.
// United has no page for one flight, so a flight's or fare's button opens the search's results page and the action
// finds the flight there. The results page (seen 2026-11-10 and 2026-11-13 in the user's Chrome) is a grid: one
// role="row" per flight, whose text says "Departing at 8:45 AM", "Arriving at 5:23 PM", the airports as "(SJC)", the
// stops ("1 STOP", then each stop's code on its own line), and a button labeled "Details for the flight: …" with
// aria-expanded. Flight numbers show only once Details is open (and on a nonstop's row).
// Each row has a cell per cabin, under the column headers (role="columnheader": "United Economy®(Main cabin)",
// "Economy Plus®(Extra legroom)", …). A cell is one button, "… cabin select to view fare options", with
// aria-expanded; clicking it opens "Select a fare to continue" under the row, one card per fare with its price and a
// Select button labeled "Select United Economy Standard". Basic's Select stays disabled until the traveler ticks
// "Basic Economy works for me" (accepting its terms). The headers' own buttons sort the results ("Link. Select to
// sort …"), so nothing here looks for "Select" without the fare's name.
// Only Select changes anything (it puts the fare in United's cart). The actions lean on these labels and texts, not
// on United's generated class names, and press nothing when anything doesn't match exactly.
import type { PageAction, PageControl, PageElement, WriteAction, WriteStop } from '../../platform/web/src/page-actions.ts';
import type { PageReader, PageTokenReader } from '../../platform/web/src/page.ts';

/** The header's button: the traveler's avatar when signed in, a Sign in button when not. */
const SIGNED_IN_AVATAR = '#loginButton.atm-c-avatar';
const SIGN_IN_BUTTON = '#loginButton.atm-c-btn';
const ACCOUNT_PAGES = /\/(myunited|account\/[a-z-]+|manageres\/mytrips)$/;

export const readPage: PageReader = (view) => {
  const path = new URL(view.url).pathname.replace(/\/+$/, '');
  const pageType = /\/fsr\/choose-flights$/.test(path) ? 'results'
    : /^(\/[a-z]{2}\/[a-z]{2})?$/.test(path) ? 'home'
      : ACCOUNT_PAGES.test(path) ? 'account' : 'other';
  // Whether the avatar is there; its text, the traveler's name, isn't kept.
  const signedIn = view.text(SIGNED_IN_AVATAR) !== null;
  return { context: { url: view.url, pageType, signedIn, locale: 'en-US' }, data: null };
};

/** A token as United's page keeps it: 200 characters of base64, standing alone. */
const TOKEN = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{200}(?![A-Za-z0-9+/=])/g;

/** The token United's page keeps: the only token-shaped value in its saved state, or null. */
export const pageToken: PageTokenReader = async (storage) => {
  const saved = await storage.stored('localforage', 'keyvaluepairs', 'reduxPersist:global');
  const text = typeof saved === 'string' ? saved : saved === null || saved === undefined ? '' : JSON.stringify(saved);
  const found = text.match(TOKEN) ?? [];
  return found.length === 1 ? found[0]! : null;
};

/** Presses the header's Sign in, which opens United's own sign-in; signed in, the button is the avatar and nothing is pressed. */
const openSignIn: PageAction = async (page) => {
  if (page.findAll(SIGNED_IN_AVATAR).length === 1) return { done: true };
  const buttons = page.findAll(SIGN_IN_BUTTON);
  if (buttons.length !== 1) return { done: false, reason: buttons.length ? 'ambiguous' : 'not_found' };
  buttons[0]!.click();
  return { done: true };
};

/** A flight as United's results page shows it, from the search's own data (tools.ts builds it). */
export interface FlightTarget {
  /** Local times as the page writes them: "8:45 AM". */
  departs: string;
  arrives: string;
  origin: string;
  destination: string;
  /** Each stop's airport code, in order; empty for a nonstop. */
  stops: string[];
  /** "UA 1554", one per segment: shown only in the opened details, so they confirm the right flight opened. */
  flightNumbers: string[];
}

/** A fare as the results page shows it, on its flight: the cabin's column and the fare's name, as United's search names them. */
export interface FareTarget extends FlightTarget {
  /** The cabin's title, which is its column header's name: "United Economy", "United Polaris". */
  cabin: string;
  /** The fare within the cabin: "Standard", "Flexible (Fully refundable)", "Base (Most restrictive)" (the page says Basic). */
  fare: string;
  /** The prices the page may show for it, in dollars: per traveler, and for all travelers. */
  prices: number[];
}

/** Text with every kind of space (a narrow one before AM, say) as one plain space. */
const plain = (text: string) => text.replace(/\s+/g, ' ').trim();
const compact = (text: string) => text.replace(/\s+/g, '').toUpperCase();

const ROWS = '[role="grid"] [role="row"]';
const DETAILS = 'button[aria-label^="Details for the flight"]';
const HEADERS = '[role="columnheader"]';
const CELLS = '[role="gridcell"]';
const CABIN_BUTTON = 'button[aria-expanded]';
const FARE_SELECTS = 'button[aria-label^="Select "]';
const TERMS_BOX = 'input[type="checkbox"]';
const PANEL_HEADING = 'Select a fare to continue';
const POLL_MS = 500;
const CONFIRM_MS = 5_000;
/** How long a cabin's fare options may take to open after its cell is clicked. */
const OPTIONS_MS = 10_000;
/**
 * How long a fare's Select may stay turned off after its card shows. United draws the cards with their Select off
 * while it finishes loading the fares, then turns it on (seen live on 2026-11-13).
 */
const ENABLE_MS = 5_000;

/** Whether a results row is this flight: its times, airports, number of stops and each stop's airport. */
export function isFlightRow(rowText: string, target: FlightTarget): boolean {
  const text = plain(rowText);
  const lines = rowText.split('\n').map(plain);
  const stopsLine = target.stops.length ? new RegExp(`^${target.stops.length} STOPS?$`, 'i') : /^NONSTOP$/i;
  return text.includes(`Departing at ${target.departs}`) && text.includes(`Arriving at ${target.arrives}`)
    && text.includes(`(${target.origin})`) && text.includes(`(${target.destination})`)
    && lines.some((line) => stopsLine.test(line))
    && target.stops.every((stop) => lines.includes(stop));
}

/** Where the opened details may be: the panel the button controls, the row itself, or a dialog over the page. */
function detailsText(page: PageControl, row: PageElement, button: PageElement): string {
  const controlled = button.attribute('aria-controls');
  const panel = controlled ? page.byId(controlled) : null;
  return [panel?.text ?? '', row.text, ...page.findAll('[role="dialog"]').map((dialog) => dialog.text)].join('\n');
}

/**
 * Waits for exactly one row that is this flight; results arrive over several seconds. Two matches stop at once; none
 * by the time limit is not found.
 */
async function findRow(page: PageControl, target: FlightTarget, timeoutMs: number): Promise<PageElement | 'ambiguous' | 'not_found'> {
  for (let waited = 0; ; waited += POLL_MS) {
    const matches = page.findAll(ROWS).filter((candidate) => isFlightRow(candidate.text, target));
    if (matches.length > 1) return 'ambiguous';
    if (matches.length === 1) return matches[0]!;
    if (waited >= timeoutMs) return 'not_found';
    await page.wait(POLL_MS);
  }
}

/** A column header's cabin: "United Economy®(Main cabin)" is United Economy. */
const cabinOfHeader = (header: string) => plain(header.replace(/[®™]/g, '').split('(')[0]!);

/** A fare's name in the words United's page uses: its search's "Base" is the page's "Basic"; case and marks don't count. */
const fareWords = (text: string) => plain(text.replace(/[®™]/g, '')).toLowerCase().replace(/\bbase\b/g, 'basic');

/** Whether a Select button is this fare's: its label is "Select", the cabin and the fare, exactly. */
export function isFareSelect(label: string, target: Pick<FareTarget, 'cabin' | 'fare'>): boolean {
  return fareWords(label) === fareWords(`Select ${target.cabin} ${target.fare}`);
}

/** Dollar amounts in a text, in order: "$1,107" is 1107. */
export const dollarsIn = (text: string) => [...text.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g)].map((match) => Number(match[1]!.replace(/,/g, '')));

/** Whether a button is turned off, as the page marks it. */
const isDisabled = (button: PageElement) => button.attribute('disabled') !== null || button.attribute('aria-disabled') === 'true';

/** This fare's Select buttons on the page, by their labels. */
const fareSelectsOn = (page: PageControl, target: FareTarget) => page.findAll(FARE_SELECTS).filter((button) => isFareSelect(button.attribute('aria-label') ?? '', target));

/**
 * The fare card around a Select button: the largest element around it holding no other fare's Select, and still
 * inside the panel. The panel's heading and the results rows bound it, so a panel with one fare doesn't stretch its
 * card over the page (and its price over the rows' "From" prices).
 */
function cardOf(button: PageElement): PageElement {
  let card = button;
  for (let around = button.parent(); around; around = around.parent()) {
    if (around.findAll(FARE_SELECTS).length !== 1 || around.findAll('[role="row"]').length || around.text.includes(PANEL_HEADING)) break;
    card = around;
  }
  return card;
}

/**
 * Opens a fare's options under its flight and finds its card, pressing nothing that changes anything:
 *   1. The flight's row.
 *   2. The cabin's cell, by its column header (Economy Plus's cell also says "United Economy cabin"); clicked only if
 *      its options aren't open yet, since a second click closes them.
 *   3. Exactly one Select labeled with this fare, once the options open; the card around it is scrolled to.
 */
async function openFare(page: PageControl, target: FareTarget, timeoutMs: number): Promise<{ button: PageElement; card: PageElement } | WriteStop> {
  // 1. The row.
  const row = await findRow(page, target, timeoutMs);
  if (typeof row === 'string') return { done: false, reason: row };
  // 2. The cabin's cell.
  const column = page.findAll(HEADERS).findIndex((header) => cabinOfHeader(header.text) === plain(target.cabin));
  const cabinButton = column < 0 ? null : row.findAll(CELLS)[column]?.find(CABIN_BUTTON);
  if (!cabinButton) return { done: false, reason: 'not_found' };
  row.scrollIntoView();
  if (cabinButton.attribute('aria-expanded') !== 'true') cabinButton.click();
  // 3. The fare's Select, and its card.
  for (let waited = 0; ; waited += POLL_MS) {
    const selects = fareSelectsOn(page, target);
    if (selects.length > 1) return { done: false, reason: 'ambiguous' };
    if (selects.length === 1) {
      const card = cardOf(selects[0]!);
      card.scrollIntoView();
      return { button: selects[0]!, card };
    }
    if (waited >= OPTIONS_MS) return { done: false, reason: 'not_found' };
    await page.wait(POLL_MS);
  }
}

/**
 * Opens a flight's Details on United's results page:
 *   1. Wait for exactly one row that is this flight; results arrive over several seconds. Two matches, or none by
 *      the time limit, and nothing is clicked.
 *   2. Scroll to it and click its Details button, unless the details are already open.
 *   3. Confirm by the flight numbers, which show only in the details.
 */
const openFlightDetails: PageAction = async (page, target: FlightTarget, options) => {
  // 1. The row.
  const row = await findRow(page, target, options.timeoutMs);
  if (typeof row === 'string') return { done: false, reason: row };
  const button = row.find(DETAILS);
  if (!button) return { done: false, reason: 'not_found' };
  // 2. Open.
  row.scrollIntoView();
  if (button.attribute('aria-expanded') !== 'true') button.click();
  // 3. Confirm.
  for (let waited = 0; waited <= CONFIRM_MS; waited += POLL_MS) {
    const shown = compact(detailsText(page, row, button));
    if (target.flightNumbers.every((number) => shown.includes(compact(number)))) return { done: true };
    await page.wait(POLL_MS);
  }
  return { done: false, reason: 'not_confirmed' };
};

/**
 * Shows a fare on United's results page: its options open under its flight, scrolled to its card. A target with no
 * fare (a return flight's button, which can only show its outbound flight) opens that flight's Details instead.
 */
const openFareOptions: PageAction = async (page, target: FareTarget | FlightTarget, options) => {
  if (!('fare' in target)) return openFlightDetails(page, target, options);
  const opened = await openFare(page, target, options.timeoutMs);
  return 'button' in opened ? { done: true } : { done: false, reason: opened.reason === 'ambiguous' ? 'ambiguous' : 'not_found' };
};

/**
 * Adds a fare to United's cart by pressing its own Select (D6), after the user confirmed it in the panel:
 *   prepare  1. Open the fare's options and find its one Select (openFare).
 *            2. A card with a terms box (Basic) stops there: accepting terms is the traveler's to do.
 *            3. Wait for the Select to turn on: United shows it off until its fares finish loading. Still off after
 *               ENABLE_MS stops. It's found again on each look, since the page may draw a new button in its place.
 *            4. The card's price must be one the user confirmed.
 *   check    United takes the press when the fare's Select is gone, and the page shows a cart (cartId in the address)
 *            or has moved on from the results, showing the flight's numbers. Still there and enabled on the results
 *            page means it ignored the press.
 */
const addFareToCart: WriteAction = {
  async prepare(page, target: FareTarget, options) {
    // 1. The fare's Select.
    const opened = await openFare(page, target, options.timeoutMs);
    if (!('button' in opened)) return opened;
    let { button, card } = opened;
    // 2. Terms. Checked before waiting: Basic's Select stays off until the traveler accepts them.
    if (card.find(TERMS_BOX)) return { done: false, reason: 'needs_user' };
    // 3. Turned on.
    for (let waited = 0; isDisabled(button); waited += POLL_MS) {
      if (waited >= ENABLE_MS) return { done: false, reason: 'unavailable' };
      await page.wait(POLL_MS);
      const selects = fareSelectsOn(page, target);
      if (selects.length !== 1) return { done: false, reason: selects.length ? 'ambiguous' : 'not_found' };
      button = selects[0]!;
      card = cardOf(button);
    }
    // 4. The price.
    const [shown] = dollarsIn(card.text);
    if (shown === undefined) return { done: false, reason: 'not_found' };
    if (!target.prices.some((price) => Math.round(price * 100) === Math.round(shown * 100))) return { done: false, reason: 'price_changed', shown: `$${shown.toLocaleString('en-US')}` };
    return { ready: true, press: () => button.click() };
  },
  check(page, target: FareTarget) {
    const address = new URL(page.url());
    const onResults = /\/fsr\/choose-flights\/?$/.test(address.pathname);
    const [select] = fareSelectsOn(page, target);
    if (select) return onResults && !isDisabled(select) ? 'unchanged' : 'waiting';
    const shown = compact(page.findAll('body')[0]?.text ?? '');
    const showsFlight = target.flightNumbers.every((number) => shown.includes(compact(number)));
    return (address.searchParams.has('cartId') || !onResults) && showsFlight ? 'confirmed' : 'waiting';
  },
};

export const pageActions: Record<string, PageAction> = { open_sign_in: openSignIn, open_flight_details: openFlightDetails, open_fare_options: openFareOptions };
export const writeActions: Record<string, WriteAction> = { add_fare_to_cart: addFareToCart };
