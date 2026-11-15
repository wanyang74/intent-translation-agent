// Tests: card-only values on the device (sign-in mode): the session's stand-ins (src/runtime/withheld.ts), what the page
// context hides before it goes to the brain, and the account button an answer can ask for.
// How: the stand-in table alone; makeTurn on every site pack with private IDs; runTurn with a scripted brain on the
// made-up shop.
// Passes when: a value keeps one stand-in, stand-ins swap back at any depth and survive a page change, and no private
// value is in the turn the brain gets: not the item on screen, not a pressed card's ID or title, not the address. The
// user's yes holds for the session, and the button shows only while it's still needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entriesOf } from '../../contract/src/site-pack.ts';
import { FakeSurface } from '../../testkit/src/fake-surface.ts';
import { loadSiteRuntime } from '../../testkit/src/site-runtime.ts';
import { testHost } from '../../testkit/src/test-host.ts';
import { makeTurn, runTurn, startSession } from '../src/index.ts';
import { Withheld } from '../src/runtime/withheld.ts';
import { exampleSession } from './example-site.ts';
import { sitePacks } from './sites.ts';

test('a value keeps one stand-in; stand-ins swap back at any depth; an unknown one stays as it is', () => {
  const withheld = new Withheld();
  assert.equal(withheld.alias('Q7K2LM'), 'withheld:1');
  assert.equal(withheld.alias('Q7K2LM'), 'withheld:1');
  assert.equal(withheld.alias(1234567), 'withheld:2');
  assert.equal(withheld.alias('1234567'), 'withheld:3', 'a number and the same digits as text are different values');
  assert.deepEqual(withheld.resolve({ ids: ['withheld:1', 'withheld:9'], nested: { id: 'withheld:2' }, other: 'withheld' }), { ids: ['Q7K2LM', 'withheld:9'], nested: { id: 1234567 }, other: 'withheld' });
  const copy = new Withheld();
  copy.restore(withheld.entries());
  assert.equal(copy.alias('Q7K2LM'), 'withheld:1', 'restored, the same value gets the same stand-in');
  assert.equal(copy.alias('NEW123'), 'withheld:4');
});

test('hide: a private value inside text becomes its stand-in, the longest first; very short values are left alone', () => {
  const withheld = new Withheld();
  withheld.alias('ABC123');
  withheld.alias('ABC1234');
  withheld.alias('XY');
  assert.equal(withheld.hide('Trip ABC1234 and ABC123, row XY'), 'Trip withheld:2 and withheld:1, row XY');
});

for (const pack of sitePacks().filter((candidate) => entriesOf(candidate.entities).some(([, entity]) => entity.id.cardOnly))) {
  const [kind] = entriesOf(pack.entities).find(([, entity]) => entity.id.cardOnly)!;
  test(`${pack.site.id}: the turn the brain gets has stand-ins for private ${kind} IDs, wherever the page context has one`, async () => {
    const runtime = await loadSiteRuntime(pack.site.id);
    const { host } = testHost({ site: pack.site.id, fixtures: [], start: '2026-11-15T10:00:00Z' });
    const { session } = await startSession({ pack: runtime.pack, site: runtime.code, validators: runtime.validators, host });
    const real = 'Q7K2LM';
    const stand = session.withheld.alias(real);
    const origin = pack.site.origins[0]!;
    session.setPage({
      url: `${origin}/trips?locator=${real}`, pageType: pack.site.pageTypes?.[0] ?? 'home', signedIn: true, entity: { kind, id: real },
      pressed: [{ button: 'card', title: `Trip ${real}`, kind, id: real }], granted: ['account'],
    });
    const turn = makeTurn(session, 'this one');
    assert.ok(!JSON.stringify(turn).includes(real), JSON.stringify(turn.pageContext));
    assert.deepEqual(turn.pageContext.entity, { kind, id: stand });
    assert.deepEqual(turn.pageContext.pressed, [{ button: 'card', title: `Trip ${stand}`, kind, id: stand }]);
    assert.equal(turn.pageContext.url, `${origin}/trips?locator=${stand}`);
    assert.equal(session.accountAllowed, true, "the user's yes holds on the device too");
  });
}

test('the account button: an answer that asks for it shows it last; once the user has said yes, it no longer shows', async () => {
  const run = async (allowed: boolean) => {
    const shop = await exampleSession({
      host: {
        brain: async function* (message) {
          yield { type: 'answer', traceId: message.traceId, text: "I'd look up your orders.", present: [], askConsent: true };
        },
      },
    });
    shop.session.accountAllowed = allowed;
    const surface = new FakeSurface();
    await runTurn(shop.session, 'my orders', surface);
    return surface.answers[0]!.components;
  };
  const asked = await run(false);
  assert.equal(asked.at(-1)?.type, 'consent');
  assert.deepEqual(await run(true), []);
});
