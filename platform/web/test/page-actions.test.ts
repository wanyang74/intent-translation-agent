// Tests: running a page action after a button in the panel (web/src/page-actions.ts, web/src/conversation.ts), both
// kinds: actions that only show information, and writes that change the site (D6).
// How: a fake page and fake page code that records what it's asked to do, in order, and saved conversations of
// different ages, for the page they were meant for and for other pages. No site's markup: each site's own page code
// is tested in its pack.
// Passes when: a focus runs once, only on the page it was saved for and only moments after; only an action the site
// pack lists, with its kind, on one of its page types, runs at all; an action that couldn't finish tells the user how
// to find the item themselves, and one that throws counts as not finding it. A write saves its check before its one
// press, presses nothing when it stops or can't save, is reported done only when the site shows the change, and is
// confirmed on the page its press led to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SitePack } from '../../contract/generated/types.ts';
import type { PageFocus } from '../../core/src/present/present.ts';
import { FOCUS_FRESH_MS, checkToRun, focusToRun, type SavedConversation } from '../src/conversation.ts';
import {
  PAGE_ACTION_MESSAGES, WRITE_CHECK_MS, WRITE_CHECK_POLL_MS, WRITE_MESSAGES, runCheck, runFocus, runWrite, writeStopped,
  type PageAction, type PageControl, type PendingCheck, type WriteAction, type WriteStop,
} from '../src/page-actions.ts';

const NOW = Date.parse('2026-11-10T18:00:00Z');
const RESULTS = 'https://shop.example/results?from=A&to=B';
const focus: PageFocus = { action: 'open_details', target: { item: 7 }, hint: 'item 7, leaving at 8:45 AM' };
const saved = (secondsAgo: number, url = RESULTS): SavedConversation => ({
  session: { id: 'sess_1', ids: [], records: [], tracking: [], store: [], responses: {}, used: { session: 0, day: 0, dayKey: 0 } },
  shown: [], open: true, savedAt: NOW - secondsAgo * 1000, focus: { url, focus },
});

test('focus: runs on the page it was saved for, moments after, even when the site adds to the query', () => {
  assert.deepEqual(focusToRun(saved(2), RESULTS, NOW), focus);
  assert.deepEqual(focusToRun(saved(2), 'https://shop.example/results/?from=A&to=B&session=xyz', NOW), focus);
  assert.equal(focusToRun(saved(2), 'https://shop.example/home', NOW), null, 'another page');
  assert.equal(focusToRun(saved(FOCUS_FRESH_MS / 1000 + 1), RESULTS, NOW), null, 'too old: a page loaded later');
  assert.equal(focusToRun({ ...saved(2), focus: undefined } as unknown as SavedConversation, RESULTS, NOW), null);
  assert.equal(focusToRun(saved(2, 'not a url'), RESULTS, NOW), null);
});

const pack = { pageActions: { open_details: { description: 'D', effect: 'shows_information', pageTypes: ['results'] } } } as unknown as SitePack;
const page: PageControl = { findAll: () => [], byId: () => null, wait: async () => {}, url: () => RESULTS };

test('page actions: only a listed action, on one of its page types, runs; its outcome becomes a message only when it fell short', async () => {
  const ran: unknown[] = [];
  const action = (outcome: Awaited<ReturnType<PageAction>>): PageAction => async (_page, target) => {
    ran.push(target);
    return outcome;
  };
  assert.equal(await runFocus(pack, { open_details: action({ done: true }) }, focus, page, 'results'), null);
  assert.deepEqual(ran, [{ item: 7 }]);
  assert.equal(await runFocus(pack, { open_details: action({ done: true }) }, focus, page, 'home'), null, 'not on this page type');
  assert.equal(await runFocus(pack, { select_item: action({ done: true }) }, { ...focus, action: 'select_item' }, page, 'results'), null, 'not listed in the site pack');
  assert.equal(ran.length, 1, 'neither ran');

  assert.equal(await runFocus(pack, { open_details: action({ done: false, reason: 'ambiguous' }) }, focus, page, 'results'), PAGE_ACTION_MESSAGES.ambiguous.replace('{hint}', focus.hint));
  const failing: PageAction = async () => {
    throw new Error('the page changed');
  };
  assert.equal(await runFocus(pack, { open_details: failing }, focus, page, 'results'), "I couldn't find it on this page. Look for item 7, leaving at 8:45 AM.");
});

// ---------------------------------------------------------------- writes (D6)

const writePack = {
  pageActions: {
    open_details: { description: 'D', effect: 'shows_information', pageTypes: ['results'] },
    add_to_cart: { description: 'D', effect: 'changes_site_state', pageTypes: ['results'], button: 'Add to cart', consent: 'C', done: 'Added to your cart: {hint}.' },
  },
} as unknown as SitePack;
const writeFocus: PageFocus = { action: 'add_to_cart', target: { item: 7, fare: 'standard' }, hint: 'item 7, Standard, $377' };

/**
 * A write action that records what happens, in order: prepare, the saved check, each press and each check of the page.
 * `prepared` is what prepare returns (a stop, or ready); `states` are what check answers, one per look (the last repeats).
 */
function recordingWrite(prepared: WriteStop | 'ready' | 'throws', states: (ReturnType<WriteAction['check']> | 'throws')[] = ['confirmed'], pressThrows = false) {
  const events: string[] = [];
  const saved: PendingCheck[] = [];
  let looks = 0;
  const action: WriteAction = {
    async prepare(_page, target) {
      events.push(`prepare ${JSON.stringify(target)}`);
      if (prepared === 'throws') throw new Error('the page changed');
      if (prepared !== 'ready') return prepared;
      return {
        ready: true,
        press: () => {
          events.push('press');
          if (pressThrows) throw new Error('detached');
        },
      };
    },
    check() {
      const state = states[Math.min(looks++, states.length - 1)]!;
      if (!events.includes('check')) events.push('check');
      if (state === 'throws') throw new Error('mid-navigation');
      return state;
    },
  };
  const savePending = async (pending: PendingCheck) => {
    events.push('save');
    saved.push(pending);
    return true;
  };
  return { action, events, saved, savePending, looks: () => looks };
}
const write = (recording: ReturnType<typeof recordingWrite>, overrides: { focus?: PageFocus; pageType?: string; savePending?: (pending: PendingCheck) => Promise<boolean> } = {}) =>
  runWrite(writePack, { add_to_cart: recording.action }, overrides.focus ?? writeFocus, page, overrides.pageType ?? 'results', overrides.savePending ?? recording.savePending, () => NOW);

test('writes: the check is saved before the one press, and the report is done once the site shows the change', async () => {
  const recording = recordingWrite('ready', ['waiting', 'waiting', 'confirmed']);
  assert.deepEqual(await write(recording), { action: 'add_to_cart', result: 'done', message: 'Added to your cart: item 7, Standard, $377.' });
  assert.deepEqual(recording.events, ['prepare {"item":7,"fare":"standard"}', 'save', 'press', 'check'], 'saved, then pressed once, then checked');
  assert.deepEqual(recording.saved, [{ action: 'add_to_cart', target: writeFocus.target, hint: writeFocus.hint, savedAt: NOW }]);
  assert.equal(recording.looks(), 3, 'it looked until the site showed the change, and no longer');
});

test('writes: every stop presses nothing and saves nothing, and tells the user why', async () => {
  const stops: [WriteStop, string][] = [
    [{ done: false, reason: 'not_found' }, "I couldn't find it on this page, so I didn't press anything. Look for item 7, Standard, $377."],
    [{ done: false, reason: 'ambiguous' }, "More than one item here matches, so I didn't press anything. Look for item 7, Standard, $377."],
    [{ done: false, reason: 'price_changed', shown: '$341' }, "The price on this page is now $341, not the one you confirmed, so I didn't press anything. Look for item 7, Standard, $377."],
    [{ done: false, reason: 'needs_user' }, "It's open, but the site asks you to accept its terms first, so I stopped there. Accept them and press the button yourself: item 7, Standard, $377."],
    [{ done: false, reason: 'unavailable' }, "Its button is turned off on this page, so I didn't press it. Look for item 7, Standard, $377."],
  ];
  for (const [stop, message] of stops) {
    const recording = recordingWrite(stop);
    assert.deepEqual(await write(recording), { action: 'add_to_cart', result: 'stopped', message }, stop.reason);
    assert.deepEqual(recording.events, ['prepare {"item":7,"fare":"standard"}'], `${stop.reason}: nothing saved, pressed or checked`);
  }
});

test('writes: page code that throws while preparing presses nothing', async () => {
  const recording = recordingWrite('throws');
  assert.equal((await write(recording))?.result, 'stopped');
  assert.ok(!recording.events.includes('press'));
});

test("writes: when the check can't be saved, nothing is pressed, since the next page couldn't confirm it", async () => {
  const recording = recordingWrite('ready');
  const report = await write(recording, { savePending: async () => false });
  assert.deepEqual(report, { action: 'add_to_cart', result: 'stopped', message: "I couldn't keep track of this step, so I didn't press anything. Look for item 7, Standard, $377." });
  assert.ok(!recording.events.includes('press'));
  assert.deepEqual(writeStopped(writeFocus, 'not_saved'), report, "the same report as when the button's focus couldn't be dropped");
});

test('writes: never reported done without the site showing it; a page that looks as before was ignored; pressed once however long it waits', async () => {
  const ignored = recordingWrite('ready', ['unchanged']);
  assert.deepEqual(await write(ignored), { action: 'add_to_cart', result: 'unconfirmed', message: WRITE_MESSAGES.ignored.replace('{hint}', writeFocus.hint) });
  assert.equal(ignored.looks(), WRITE_CHECK_MS / WRITE_CHECK_POLL_MS + 1, 'it looked for the whole time limit');
  const waiting = recordingWrite('ready', ['waiting']);
  assert.deepEqual(await write(waiting), { action: 'add_to_cart', result: 'unconfirmed', message: WRITE_MESSAGES.unconfirmed.replace('{hint}', writeFocus.hint) });
  // A check that throws (the page is changing) may follow a press that worked: unconfirmed, never "ignored".
  const throwing = recordingWrite('ready', ['throws']);
  assert.equal((await write(throwing))?.message, WRITE_MESSAGES.unconfirmed.replace('{hint}', writeFocus.hint));
  const pressFails = recordingWrite('ready', ['confirmed'], true);
  assert.equal((await write(pressFails))?.result, 'unconfirmed', 'a press that threw may still have gone through');
  for (const recording of [ignored, waiting, throwing, pressFails]) assert.equal(recording.events.filter((event) => event === 'press').length, 1);
});

test("writes: only an action listed as changing the site runs as a write, on its page types; a write never runs as an action that shows", async () => {
  const recording = recordingWrite('ready');
  assert.equal(await write(recording, { pageType: 'home' }), null, 'not on this page type');
  assert.equal(await runWrite(writePack, { open_details: recording.action }, { ...writeFocus, action: 'open_details' }, page, 'results', recording.savePending, () => NOW), null, 'listed as only showing information');
  assert.equal(await runWrite(writePack, { remove_item: recording.action }, { ...writeFocus, action: 'remove_item' }, page, 'results', recording.savePending, () => NOW), null, 'not listed');
  assert.deepEqual(recording.events, [], 'none of them prepared anything');
  let ranAsShowing = false;
  const showing: PageAction = async () => {
    ranAsShowing = true;
    return { done: true };
  };
  assert.equal(await runFocus(writePack, { add_to_cart: showing }, writeFocus, page, 'results'), null);
  assert.equal(ranAsShowing, false, 'page code listing a write among its showing actions still never runs it that way');
});

test("write checks: the page a press led to confirms it, if the check is fresh by its own time; a changed page can't mean ignored", async () => {
  const pending: PendingCheck = { action: 'add_to_cart', target: writeFocus.target, hint: writeFocus.hint, savedAt: NOW - 5_000 };
  const withCheck = (check: PendingCheck | undefined): SavedConversation => {
    const { focus: _focus, ...conversation } = saved(0);
    return { ...conversation, ...(check ? { pendingCheck: check } : {}) };
  };
  assert.deepEqual(checkToRun(withCheck(pending), NOW), pending, 'on any page of the site');
  assert.equal(checkToRun(withCheck({ ...pending, savedAt: NOW - FOCUS_FRESH_MS - 1 }), NOW), null, 'stale, even though the conversation was saved just now');
  assert.equal(checkToRun(withCheck(undefined), NOW), null);
  assert.equal(checkToRun(null, NOW), null);

  const confirmed = recordingWrite('ready', ['waiting', 'confirmed']);
  assert.deepEqual(await runCheck(writePack, { add_to_cart: confirmed.action }, pending, page), { action: 'add_to_cart', result: 'done', message: 'Added to your cart: item 7, Standard, $377.' });
  const unchanged = recordingWrite('ready', ['unchanged']);
  assert.deepEqual(await runCheck(writePack, { add_to_cart: unchanged.action }, pending, page), { action: 'add_to_cart', result: 'unconfirmed', message: WRITE_MESSAGES.unconfirmed.replace('{hint}', writeFocus.hint) });
  assert.equal(await runCheck(writePack, { open_details: confirmed.action }, { ...pending, action: 'open_details' }, page), null, 'a check for an action that only shows');
  for (const recording of [confirmed, unchanged]) assert.ok(!recording.events.includes('press') && !recording.events.some((event) => event.startsWith('prepare')), 'a check never prepares or presses');
});
