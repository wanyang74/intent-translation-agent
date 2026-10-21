// Tests: a core.js session carries over to the next page of the site (Session.snapshot and restore), so the
// conversation follows the user after a Take me there button or a link.
// How: a session runs a search and a tool that keeps its own state, is saved, goes through JSON (as a host stores it),
// and is restored into a fresh session.
// Passes when: the restored session has the same ID, knows the same IDs (expiry included), fills the same cards,
// keeps the same tracking IDs and site-code state, and carries on with the call budget already used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { present, runToolCall, Session } from '../src/index.ts';
import { examplePack } from './example-pack.ts';
import { exampleCode, exampleSession, exampleValidators } from './example-site.ts';

test('snapshot: a restored session is the same conversation, its cards, IDs, tracking and budget included', async () => {
  const { session, host } = await exampleSession();
  assert.ok((await runToolCall(session, 'search_products', { query: 'shoe' })).ok);
  session.store.set('route', { token: 'abc' });
  const visitorId = session.trackingId('visitorId');
  const cards = present(session, [{ name: 'present_items', args: { entity: 'product', ids: [1, 2] } }]).components;

  const saved = JSON.parse(JSON.stringify(session.snapshot()));
  const restored = new Session({ pack: examplePack, site: exampleCode, validators: exampleValidators(), host, policy: session.policy, restore: saved });

  assert.equal(restored.id, session.id);
  assert.equal(restored.ids.size, session.ids.size);
  assert.deepEqual(restored.ids.entries(), session.ids.entries(), 'the same IDs, with the same expiry');
  assert.deepEqual(present(restored, [{ name: 'present_items', args: { entity: 'product', ids: [1, 2] } }]).components, cards, 'the same cards, from the same records');
  assert.equal(restored.trackingId('visitorId'), visitorId);
  assert.deepEqual(restored.store.get('route'), { token: 'abc' });
  assert.deepEqual(restored.budget.used(), { ...session.budget.used(), task: 0 }, 'the session and day budgets carry on; a new page starts no task');
});
