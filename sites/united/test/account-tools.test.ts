// Tests: United's sign-in mode: the MileagePlus tools run by core.js (tools.ts), the signed-in check and the token the
// page keeps (page.ts, D7), and the header's Sign in button.
// How: core.js's Execute with FakeHost answering from United's made-up account fixtures, which accept only the test
// page's signed-in token on account calls; a fake page view, a fake page storage and a fake page for page.ts.
// Passes when: signed out, or before the traveler's yes, nothing is asked of United; once allowed, the balance and the
// activity come back with the amounts and lines only (no loyalty ID, customer ID, TravelBank account number or names
// on tickets), signed with the page's token; United's signed-out answer (202, only Errors) is "signed out"; the
// signed-in check reads the header's avatar; the token is the one token-shaped value in the saved state, or none; and
// Sign in is pressed only when the traveler is signed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runToolCall, startSession } from '../../../platform/core/src/index.ts';
import { FAKE_PAGE_TOKEN } from '../../../platform/testkit/src/fake-host.ts';
import { loadFixtures } from '../../../platform/testkit/src/fixtures.ts';
import { loadSiteRuntime } from '../../../platform/testkit/src/site-runtime.ts';
import { testHost } from '../../../platform/testkit/src/test-host.ts';
import type { PageControl, PageElement } from '../../../platform/web/src/page-actions.ts';
import type { PageView } from '../../../platform/web/src/page.ts';
import { pageActions, pageToken, readPage } from '../page.ts';

const rt = await loadSiteRuntime('united');
const MY_UNITED = 'https://www.united.com/en/us/myunited';

async function accountSession(options: { signedIn: boolean; allowed: boolean }) {
  const harness = testHost({ site: 'united', fixtures: loadFixtures('united'), start: '2026-11-15T20:00:00Z' });
  const { session } = await startSession({ pack: rt.pack, site: rt.code, validators: rt.validators, host: harness.host });
  session.setPage({ url: MY_UNITED, pageType: 'account', signedIn: options.signedIn, locale: 'en-US' });
  session.accountAllowed = options.allowed;
  return { session, harness };
}

test('signed out, or signed in before the yes: the account tools ask nothing of United', async () => {
  for (const state of [{ signedIn: false, allowed: true }, { signedIn: true, allowed: false }]) {
    const { session, harness } = await accountSession(state);
    for (const tool of ['get_miles_balance', 'get_miles_activity']) {
      const outcome = await runToolCall(session, tool, {});
      assert.equal(outcome.ok, false, `${tool} ${JSON.stringify(state)}`);
      assert.equal(outcome.ok ? '' : outcome.error.code, 'auth_required');
    }
    assert.equal(harness.fake.calls.length, 0);
  }
});

test("the balance: amounts only, signed with the page's token, and nothing that identifies the account", async () => {
  const { session, harness } = await accountSession({ signedIn: true, allowed: true });
  const outcome = await runToolCall(session, 'get_miles_balance', {});
  assert.deepEqual(outcome.ok && outcome.output, { miles: 25000, lifetimeMiles: 61000, plusPoints: 0, travelBankDollars: 120.5 });
  assert.ok(!/100000001|00000000-0000-4000-8000/.test(JSON.stringify(outcome)), 'no loyalty ID, customer ID or TravelBank account number');
  assert.deepEqual(harness.fake.calls.map((call) => call.endpoint), ['balances'], "the page's token, so no anonymous token is fetched");
});

test('the activity: newest first, amounts and descriptions, without the names on tickets', async () => {
  const { session } = await accountSession({ signedIn: true, allowed: true });
  const outcome = await runToolCall(session, 'get_miles_activity', {});
  const activities = outcome.ok ? (outcome.output as { activities: { description: string; miles: number }[] }).activities : [];
  assert.deepEqual(activities.map((activity) => [activity.description, activity.miles]), [['UA 1554 SFO to EWR', 1200], ['Card purchases', 800], ['Award travel', -12500]]);
  assert.ok(!JSON.stringify(outcome).includes('FIXTURE TRAVELER'), 'no names on tickets');
});

test("United's signed-out answer (202, only Errors) means signed out, and the page without a token is too", async () => {
  const { session, harness } = await accountSession({ signedIn: true, allowed: true });
  harness.fake.inject({ endpoint: 'balances', status: 202, headers: { 'content-type': 'application/json' }, body: '{"Errors":[{}]}' });
  const outcome = await runToolCall(session, 'get_miles_balance', {});
  assert.equal(outcome.ok ? '' : outcome.error.code, 'auth_required');
  const noToken = testHost({ site: 'united', fixtures: loadFixtures('united'), pageToken: null });
  const { session: tokenless } = await startSession({ pack: rt.pack, site: rt.code, validators: rt.validators, host: noToken.host });
  tokenless.setPage({ url: MY_UNITED, pageType: 'account', signedIn: true });
  tokenless.accountAllowed = true;
  const tokenlessOutcome = await runToolCall(tokenless, 'get_miles_activity', {});
  assert.deepEqual(tokenlessOutcome.ok ? 'ok' : [tokenlessOutcome.error.code, tokenlessOutcome.error.reason], ['auth_required', 'signed_out'], "the tool's own signed-out error");
  assert.equal(noToken.fake.calls.length, 0);
});

/** A page view whose header has these elements, by selector. */
const viewWith = (url: string, present: string[]): PageView => ({ url, text: (selector) => (present.includes(selector) ? 'Hi, Fixture' : null), cookie: '', scripts: () => [] });

test("the page reader: signed in when the header's button is the avatar; My United, activity and My Trips are account pages", () => {
  assert.deepEqual(readPage(viewWith(MY_UNITED, ['#loginButton.atm-c-avatar'])).context, { url: MY_UNITED, pageType: 'account', signedIn: true, locale: 'en-US' });
  assert.equal(readPage(viewWith('https://www.united.com/en/us/', ['#loginButton.atm-c-btn'])).context.signedIn, false);
  assert.equal(readPage(viewWith('https://www.united.com/en/us/account/activity', [])).context.pageType, 'account');
  assert.equal(readPage(viewWith('https://www.united.com/en/us/manageres/mytrips?tab=upcoming', [])).context.pageType, 'account');
  assert.equal(readPage(viewWith('https://www.united.com/en/us/fsr/choose-flights?f=SFO', [])).context.pageType, 'results');
});

test("the token: the one token-shaped value in the page's saved state, however it's stored; none, or two, is no token", async () => {
  const token = 'Ab1+/'.repeat(40);
  const other = 'Zz9+/'.repeat(40);
  const storage = (saved: unknown) => ({ cookie: '', stored: async (database: string, store: string, key: string) => (database === 'localforage' && store === 'keyvaluepairs' && key === 'reduxPersist:global' ? saved : null) });
  const compact = JSON.stringify(JSON.stringify([[0, 1], [0, { 99: [0, 1, token] }]]));
  assert.equal(await pageToken(storage(compact)), token);
  assert.equal(await pageToken(storage([0, { 99: [token] }])), token, 'stored as a value, not text');
  assert.equal(await pageToken(storage(null)), null);
  assert.equal(await pageToken(storage(JSON.stringify([token, other]))), null, 'two: no guess');
  assert.equal(await pageToken(storage(JSON.stringify(['x'.repeat(199)]))), null);
  assert.equal(FAKE_PAGE_TOKEN.length < 200, true, "the tests' made-up token isn't one United's page would keep");
});

/** A page whose header has these elements; clicks are counted. */
function headerPage(classes: string): { page: PageControl; clicks: () => number } {
  let clicks = 0;
  const button: PageElement = {
    text: '', attribute: (name) => (name === 'class' ? classes : null), find: () => null, findAll: () => [], byId: () => null, parent: () => null,
    click: () => { clicks++; }, scrollIntoView: () => {},
  };
  const has = (cls: string) => classes.split(' ').includes(cls);
  const page: PageControl = {
    findAll: (selector) => ((selector === '#loginButton.atm-c-avatar' && has('atm-c-avatar')) || (selector === '#loginButton.atm-c-btn' && has('atm-c-btn')) ? [button] : []),
    byId: () => null, wait: async () => {}, url: () => 'https://www.united.com/en/us/',
  };
  return { page, clicks: () => clicks };
}

test("Sign in: pressed when the header shows it; signed in (the avatar), nothing is pressed", async () => {
  const signedOut = headerPage('atm-c-btn atm-c-btn--bare');
  assert.deepEqual(await pageActions.open_sign_in!(signedOut.page, {}, { timeoutMs: 1000 }), { done: true });
  assert.equal(signedOut.clicks(), 1);
  const signedIn = headerPage('atm-c-avatar atm-c-avatar--small');
  assert.deepEqual(await pageActions.open_sign_in!(signedIn.page, {}, { timeoutMs: 1000 }), { done: true });
  assert.equal(signedIn.clicks(), 0);
  assert.deepEqual(await pageActions.open_sign_in!(headerPage('').page, {}, { timeoutMs: 1000 }), { done: false, reason: 'not_found' });
});
