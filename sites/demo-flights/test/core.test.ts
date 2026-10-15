// core.js on Demo Flights: offers that expire, and a trips list that needs sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SitePack } from '../../../platform/contract/generated/types.ts';
import { checkPresentation, checkToolCall, effectivePolicy, IdSet } from '../../../platform/core/src/index.ts';
import { loadConversations } from '../../../platform/testkit/src/conversations.ts';

const pack = JSON.parse(readFileSync(new URL('../generated/site.json', import.meta.url), 'utf8')) as SitePack;
const conv = loadConversations('demo-flights').find((c) => c.id === 'one-way-search')!;
const NOW = Date.parse(conv.now!);
const offers: any = (() => {
  for (const m of conv.messages) if (m.type === 'results') for (const r of m.results) if (r.ok) return r.output;
  throw new Error('no search result');
})();
const policy = effectivePolicy(pack).policy;

test('offers can be shown until they expire, and are refused after', () => {
  const ids = new IdSet(pack.entities);
  assert.equal(ids.learnFrom(offers, pack.tools.search_flights!.ids!.output, NOW), 3);
  const show = { name: 'present_items' as const, args: { entity: 'flight_offer', ids: ['off_7GQ2'] as [string] } };
  assert.equal(checkPresentation({ pack, policy, ids, now: NOW }, show), null);
  const later = Date.parse(offers.offers[0].expiresAt);
  assert.equal(checkPresentation({ pack, policy, ids, now: later }, show)?.code, 'expired');
});

test("the trips list needs sign-in, and says so in the site's words", () => {
  const ids = new IdSet(pack.entities);
  const page = { url: 'https://www.demo-flights.example/trips', pageType: 'trips' };
  const e = checkToolCall({ pack, policy, ids, now: NOW, page }, 'get_trips', { status: 'upcoming' });
  assert.deepEqual([e?.code, e?.reason, e?.message], ['auth_required', 'signed_out', pack.tools.get_trips!.errors!.signed_out!.message]);
  assert.equal(checkToolCall({ pack, policy, ids, now: NOW, page: { ...page, signedIn: true } }, 'get_trips', { status: 'upcoming' }), null);
});
