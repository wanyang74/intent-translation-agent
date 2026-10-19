// core.js on Demo Flights: offers that expire, and a trips list that needs sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SitePack } from '../../../platform/contract/generated/types.ts';
import { checkPresentation, checkToolCall, effectivePolicy, IdSet } from '../../../platform/core/src/index.ts';
import { loadConversations } from '../../../platform/testkit/src/conversations.ts';

const pack = JSON.parse(readFileSync(new URL('../generated/site.json', import.meta.url), 'utf8')) as SitePack;
const conv = loadConversations('demo-flights').find((conversation) => conversation.id === 'one-way-search')!;
const NOW = Date.parse(conv.now!);
const searchOutput: any = (() => {
  for (const message of conv.messages) if (message.type === 'results') for (const result of message.results) if (result.ok) return result.output;
  throw new Error('no search result');
})();
const policy = effectivePolicy(pack).policy;

test('offers can be shown until they expire, and are refused after', () => {
  const ids = new IdSet(pack.entities);
  assert.equal(ids.learnFrom(searchOutput, pack.tools.search_flights!.ids!.output, NOW), 3);
  const show = { name: 'present_items' as const, args: { entity: 'flight_offer', ids: ['off_7GQ2'] as [string] } };
  assert.equal(checkPresentation({ pack, policy, ids, now: NOW }, show), null);
  const later = Date.parse(searchOutput.offers[0].expiresAt);
  assert.equal(checkPresentation({ pack, policy, ids, now: later }, show)?.code, 'expired');
});

test("the trips list needs sign-in, and says so in the site's words", () => {
  const ids = new IdSet(pack.entities);
  const page = { url: 'https://www.demo-flights.example/trips', pageType: 'trips' };
  const error = checkToolCall({ pack, policy, ids, now: NOW, page }, 'get_trips', { status: 'upcoming' });
  assert.deepEqual([error?.code, error?.reason, error?.message], ['auth_required', 'signed_out', pack.tools.get_trips!.errors!.signed_out!.message]);
  assert.equal(checkToolCall({ pack, policy, ids, now: NOW, page: { ...page, signedIn: true } }, 'get_trips', { status: 'upcoming' }), null);
});
