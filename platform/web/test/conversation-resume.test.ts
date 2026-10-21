// Tests: which saved conversation the next page of a site carries on (web/src/conversation.ts).
// How: saved conversations of different ages and shapes, as the extension's storage might hand them back.
// Passes when: a conversation saved less than 30 minutes ago is resumed; an older one, a missing one, or one that
// isn't a saved conversation at all starts fresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSATION_IDLE_MS, conversationToResume, type SavedConversation } from '../src/conversation.ts';

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
