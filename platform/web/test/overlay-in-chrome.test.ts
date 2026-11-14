// Tests: the overlay draws every UI fixture fully and safely in a real browser, and the user's clicks reach the agent.
// How: each site's UI fixtures, and the platform's hand-written states, are replayed into overlays in a gallery page
// (build/gallery.ts) in headless Chrome, and read back from each overlay's shadow root. Skipped when Chrome isn't
// installed (set CHROME_PATH to point at it).
// Passes when: every message, answer line, card, field value and error shows, links are only http(s), progress shows
// only while a turn runs, nothing reads "undefined", markup from the site stays text, picking an option or
// sending a form sends the right message, every button to the site reports which item it was for and leaves a line
// in the conversation, and a site's brand color reaches its buttons and the user's messages.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listSites, readSite } from '../../contract/src/site-pack.ts';
import type { CardView, UiComponent } from '../../core/src/present/present.ts';
import { chromePath, openChrome, type ChromePage } from '../build/chrome.ts';
import { galleryPage } from '../build/gallery.ts';
import { loadUiFixtures } from '../build/ui-fixtures.ts';
import type { UiFixture } from '../src/ui-fixture.ts';
import { UI_STATES } from './ui-states.ts';

const skip = !chromePath() && 'Chrome not installed';
const workDir = mkdtempSync(path.join(os.tmpdir(), 'overlay-test-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Writes a gallery of these fixtures and opens it. */
async function openGallery(name: string, fixtures: UiFixture[]): Promise<ChromePage> {
  const file = path.join(workDir, `${name}.html`);
  writeFileSync(file, await galleryPage(name, fixtures));
  const page = await openChrome({ width: 1600, height: 1000 });
  await page.goto(pathToFileURL(file).href);
  return page;
}

interface Drawn {
  id: string;
  text: string;
  users: string[];
  cards: number;
  hrefs: (string | null)[];
  progress: number;
  errors: string[];
  markup: number;
}

/** What each overlay on the page shows, read from its shadow root. */
const READ_OVERLAYS = `[...document.querySelectorAll('.overlay')].map((host) => {
  const root = host.shadowRoot;
  const texts = (selector) => [...root.querySelectorAll(selector)].map((node) => node.textContent);
  return {
    id: host.dataset.fixture, text: root.querySelector('.log').innerText, users: texts('.user'), cards: root.querySelectorAll('.card').length,
    hrefs: [...root.querySelectorAll('a')].map((link) => link.getAttribute('href')), progress: root.querySelectorAll('.progress').length,
    errors: texts('.error'), markup: root.querySelectorAll('img, script, i, a[href^="javascript"]').length,
  };
})`;

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The strings a component must show, and how many cards and links it draws. */
function expectations(component: UiComponent): { texts: string[]; cards: number; links: number } {
  // A list's rows are compact: values only, no labels.
  const cardTexts = (card: CardView, labels = true) => [card.title, card.subtitle ?? '', ...card.fields.flatMap((field) => [labels ? field.label : '', field.text])];
  const linked = (card: { link?: string }) => (card.link && /^https?:/.test(card.link) ? 1 : 0);
  switch (component.type) {
    case 'items':
      return { texts: [component.heading ?? '', ...component.items.flatMap((item) => cardTexts(item, component.layout !== 'list'))], cards: component.items.length, links: component.items.reduce((sum, item) => sum + linked(item), 0) };
    case 'options':
      return { texts: [component.heading ?? '', ...component.options.flatMap((option) => [option.title, option.subtitle ?? ''])], cards: 0, links: 0 };
    case 'comparison':
      return { texts: [...component.items.map((item) => item.title), ...component.rows.flatMap((row) => [row.label, ...row.cells.map((cell) => cell.text)])], cards: 0, links: component.items.reduce((sum, item) => sum + linked(item), 0) };
    case 'detail':
      return {
        texts: [...cardTexts(component.card), ...component.sections.flatMap((section) => [section.summary ?? '', ...(section.lines ?? []).map((line) => line.text), ...(section.fields ?? []).map((field) => field.text)])],
        cards: 1, links: linked(component.card),
      };
    case 'form':
      return { texts: [component.heading ?? '', ...component.fields.map((field) => field.label)], cards: 0, links: 0 };
    case 'notice':
      return { texts: [component.text], cards: 0, links: 0 };
    case 'destination':
      // A confirming button shows what will change and what the user agrees to, on a button that says what it does.
      return { texts: component.confirm ? [component.title, ...component.confirm.summary, component.confirm.consent, component.confirm.button] : [component.title, 'Take me there'], cards: 0, links: 0 };
  }
}

/** Checks one overlay against the fixture it replayed. */
function checkDrawn(fixture: UiFixture, drawn: Drawn): void {
  const where = `${fixture.site}/${fixture.id}`;
  const text = squash(drawn.text);
  assert.deepEqual(drawn.users.map(squash), fixture.turns.map((turn) => squash(turn.message)), `${where}: the user's messages`);
  assert.doesNotMatch(text, /\bundefined\b|\bNaN\b|\[object Object\]/, `${where}: a value didn't fill in`);
  let cards = 0;
  let links = 0;
  for (const event of fixture.turns.flatMap((turn) => turn.events)) {
    const expected: string[] = [];
    if (event.type === 'answer') {
      // The model's Markdown markers aren't shown; each line's words are.
      expected.push(...event.text.split('\n').map((line) => line.replace(/^\s*[-*•]\s+/, '').replace(/\*\*/g, '')));
      if (event.budgetReached) expected.push('I stopped early');
    }
    if (event.type === 'error') expected.push(event.message);
    for (const component of 'components' in event ? event.components : []) {
      const shown = expectations(component);
      expected.push(...shown.texts);
      cards += shown.cards;
      links += shown.links;
    }
    for (const part of expected.map(squash).filter(Boolean)) assert.ok(text.includes(part), `${where}: "${part}" isn't shown`);
  }
  assert.equal(drawn.cards, cards, `${where}: cards`);
  assert.equal(drawn.hrefs.length, links, `${where}: links`);
  for (const href of drawn.hrefs) assert.match(href ?? '', /^https?:\/\//, `${where}: a link that isn't http(s)`);
  const unfinished = fixture.turns.filter((turn) => turn.events.at(-1)?.type === 'progress').length;
  assert.equal(drawn.progress, unfinished, `${where}: a progress line stays only while a turn runs`);
  assert.equal(drawn.markup, 0, `${where}: markup from text was drawn as HTML`);
}

for (const [name, fixtures] of [...listSites().map((site) => [site, loadUiFixtures(site)] as const), ['platform states', UI_STATES] as const]) {
  test(`${name}: every UI fixture draws fully in Chrome`, { skip }, async () => {
    const page = await openGallery(name.replace(/\W+/g, '-'), fixtures);
    try {
      const drawn = await page.evaluate<Drawn[]>(READ_OVERLAYS);
      assert.equal(drawn.length, fixtures.length);
      for (const fixture of fixtures) checkDrawn(fixture, drawn.find((candidate) => candidate.id === fixture.id)!);
    } finally {
      await page.close();
    }
  });
}

test("clicks: an option sends its title, a form sends its values, Take me there and a card's button open their page with its page action and say which item was pressed, a confirming button takes one press, and site markup never runs", { skip }, async () => {
  const page = await openGallery('clicks', UI_STATES);
  try {
    const root = (id: string) => `document.querySelector('[data-fixture="${id}"]').shadowRoot`;
    await page.evaluate(`${root('state-options')}.querySelector('.chip').click()`);
    await page.evaluate(`(() => { const form = ${root('state-form')}.querySelector('form'); form.querySelector('select').value = 'Medium'; form.requestSubmit(); })()`);
    assert.deepEqual(await page.evaluate('window.sent'), [
      { fixture: 'state-options', message: 'Under $1,000' },
      { fixture: 'state-form', message: 'Postal code: 94402\nSize: Medium' },
    ]);
    assert.equal(await page.evaluate(`${root('state-options')}.querySelectorAll('.user').length`), 2, 'the picked option shows as the user’s message');
    await page.evaluate(`${root('state-destination')}.querySelector('.destination .btn').click()`);
    await page.evaluate(`${root('state-page-action')}.querySelector('.card button').click()`);
    await page.evaluate(`${root('state-page-action')}.querySelector('.destination .btn').click()`);
    // Pressed twice: the second press does nothing, so one confirmation can't start two writes.
    await page.evaluate(`${root('state-write-action')}.querySelector('.destination .btn').click()`);
    await page.evaluate(`${root('state-write-action')}.querySelector('.destination .btn').click()`);
    assert.deepEqual(await page.evaluate('window.navigated'), [
      { fixture: 'state-destination', url: 'https://shop.example/help/returns', press: { button: 'destination', title: 'Returns policy', destination: 'returns_policy' } },
      { fixture: 'state-page-action', url: 'https://shop.example/list?d=1', action: 'open_details', press: { button: 'card', title: 'Departure 1', kind: 'departure', id: 'dep_1' } },
      { fixture: 'state-page-action', url: 'https://shop.example/list?d=1', action: 'open_details', press: { button: 'destination', title: 'This departure', destination: 'departure_list', kind: 'departure', id: 'dep_1' } },
      { fixture: 'state-write-action', url: 'https://shop.example/list?d=1', action: 'add_fare_to_cart', press: { button: 'confirm', title: 'Add to your cart', destination: 'add_to_cart', kind: 'fare', id: 'fare_1' } },
    ]);
    assert.equal(await page.evaluate(`${root('state-write-action')}.querySelector('.destination .btn').textContent`), 'Add to cart on the shop', 'the button says what it does');
    // Each press leaves a quiet line, so the user sees what the agent will be told.
    assert.deepEqual(await page.evaluate(`[...${root('state-page-action')}.querySelectorAll('.pressed')].map((line) => line.textContent)`), ['You opened Departure 1 on platform', 'You pressed Take me there: This departure']);
    assert.deepEqual(await page.evaluate(`[...${root('state-write-action')}.querySelectorAll('.pressed')].map((line) => line.textContent)`), ['You pressed the confirming button: Add to your cart'], 'the second press of a confirming button does nothing, so it leaves no line');
    assert.equal(await page.evaluate('window.hacked'), undefined);
  } finally {
    await page.close();
  }
});

test("brand color: a site pack's brandColor colors its buttons and the user's messages; a site without one keeps the panel's blue", { skip }, async () => {
  const branded = listSites().map((site) => ({ site, color: readSite(site).pack.site.brandColor })).filter((entry) => entry.color && loadUiFixtures(entry.site).length);
  const unbranded = listSites().find((site) => !readSite(site).pack.site.brandColor && loadUiFixtures(site).length);
  assert.ok(branded.length && unbranded, 'a branded and an unbranded site pack with UI fixtures');
  const fixtures = [...branded.map((entry) => loadUiFixtures(entry.site)[0]!), loadUiFixtures(unbranded!)[0]!];
  const page = await openGallery('brand', fixtures);
  try {
    const colors = await page.evaluate<{ id: string; user: string; button: string | null }[]>(`[...document.querySelectorAll('.overlay')].map((host) => {
      const root = host.shadowRoot;
      const button = root.querySelector('.btn');
      return { id: host.dataset.fixture, user: getComputedStyle(root.querySelector('.user')).backgroundColor, button: button && getComputedStyle(button).backgroundColor };
    })`);
    const rgb = (hex: string) => `rgb(${[1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(', ')})`;
    for (const [i, entry] of branded.entries()) {
      assert.equal(colors[i]!.user, rgb(entry.color!), `${entry.site}: the user's messages`);
      if (colors[i]!.button) assert.equal(colors[i]!.button, rgb(entry.color!), `${entry.site}: the buttons`);
    }
    assert.equal(colors.at(-1)!.user, rgb('#1f5eff'), `${unbranded}: the panel's own blue`);
  } finally {
    await page.close();
  }
});
