// Tests: which saved conversation the next page of a site carries on (web/src/conversation.ts).
// How: saved conversations of different ages and shapes, as the extension's storage might hand them back.
// Passes when: a conversation saved less than 30 minutes ago is resumed; an older one, a missing one, or one that
// isn't a saved conversation at all starts fresh; the presses kept for the next message count a repeat once and keep
// only the latest; and a press's line in the conversation says what was opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PanelPress } from '../../contract/generated/types.ts';
import { CONVERSATION_IDLE_MS, MAX_PRESSES, conversationToResume, pressText, withPress, type SavedConversation } from '../src/conversation.ts';

const NOW = Date.parse('2026-10-21T18:00:00Z');
const saved = (minutesAgo: number): SavedConversation => ({
  session: { id: 'sess_1', ids: [], records: [], tracking: [], store: [], responses: {}, used: { session: 2, day: 2, dayKey: 0 } },
  shown: [{ type: 'user', text: 'Teslas under $40k' }], open: true, savedAt: NOW - minutesAgo * 60_000,
});

test('resume: a conversation idle under 30 minutes carries on; an older or malformed one starts fresh', () => {
  assert.equal(CONVERSATION_IDLE_MS, 30 * 60_000, 'the same as the brain forgets an idle session');
  assert.equal(conversationToResume(saved(5), NOW)?.session.id, 'sess_1');
  assert.equal(conversationToResume(saved(29.9), NOW)?.session.id, 'sess_1');
  assert.equal(conversationToResume(saved(30), NOW), null);
  assert.equal(conversationToResume(null, NOW), null);
  assert.equal(conversationToResume({ savedAt: NOW } as unknown as SavedConversation, NOW), null);
});

test('presses: the same button twice in a row counts once, and only the latest are kept, oldest first', () => {
  const card = (id: number): PanelPress => ({ button: 'card', title: `Car ${id}`, kind: 'vehicle', id });
  assert.deepEqual(withPress(withPress([], card(1)), card(1)), [card(1)], 'a repeat in a row');
  assert.deepEqual(withPress([card(1), card(2)], card(1)), [card(1), card(2), card(1)], 'back to an earlier one counts: it is now the latest');
  let pressed: PanelPress[] = [];
  for (let i = 1; i <= MAX_PRESSES + 2; i++) pressed = withPress(pressed, card(i));
  assert.equal(MAX_PRESSES, 5, 'the schema allows five');
  assert.deepEqual(pressed.map((press) => press.id), [3, 4, 5, 6, 7]);
});

test("presses: the line in the conversation says what was opened, on which site, or which button was pressed", () => {
  assert.equal(pressText({ button: 'card', title: 'Flight 1079', kind: 'flight', id: 'f1' }, 'Example Air'), 'You opened Flight 1079 on Example Air');
  assert.equal(pressText({ button: 'card', title: 'Flight 1079' }), 'You opened Flight 1079 on the site');
  assert.equal(pressText({ button: 'destination', title: 'These flights', destination: 'results' }), 'You pressed Take me there: These flights');
  assert.equal(pressText({ button: 'confirm', title: 'Add this fare to your cart', destination: 'add' }), 'You pressed the confirming button: Add this fare to your cart');
});
