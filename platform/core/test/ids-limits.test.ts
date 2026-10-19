// L1 for the typed ID set, the call budget and the rate limiter, including random sequences and concurrent callers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallBudget, effectivePolicy, IdSet, RateLimiter } from '../src/index.ts';
import type { RemoteConfig } from '../../contract/generated/types.ts';
import { examplePack } from './example-pack.ts';
import { pick, random } from './random.ts';

const NOW = Date.UTC(2026, 9, 14, 12);
const MIN = 60_000;

test('IDs are typed: the kind must exist and the ID must have its type and pattern', () => {
  const ids = new IdSet(examplePack.entities);
  assert.equal(ids.learn('product', 7), true);
  assert.equal(ids.learn('product', '7'), false, 'product IDs are numbers');
  assert.equal(ids.learn('product', 7.5), false);
  assert.equal(ids.learn('offer', 'bad'), false, 'offer IDs match ^of_[a-z0-9]{4}$');
  assert.equal(ids.learn('ghost', 1), false);
  assert.equal(ids.status('product', 7, NOW), 'known');
  assert.equal(ids.status('product', '7', NOW), 'unknown');
  assert.equal(ids.status('offer', 7, NOW), 'unknown', 'a known ID of another kind is not known for this one');
});

test('IDs expire at their time, a while after they were shown, or at once if the time is unreadable', () => {
  const ids = new IdSet(examplePack.entities);
  ids.learn('offer', 'of_ab12', { expiresAt: '2026-10-14T12:30:00Z' });
  ids.learn('coupon', 'SAVEX', { now: NOW });
  ids.learn('offer', 'of_zz99', { expiresAt: 'tomorrow-ish' });
  assert.deepEqual(['of_ab12', 'of_zz99'].map((id) => ids.status('offer', id, NOW)), ['known', 'expired']);
  assert.equal(ids.status('offer', 'of_ab12', NOW + 30 * MIN), 'expired', 'expiry time itself counts as expired');
  assert.equal(ids.status('coupon', 'SAVEX', NOW + 9 * MIN), 'known');
  assert.equal(ids.status('coupon', 'SAVEX', NOW + 10 * MIN), 'expired');
  ids.learn('offer', 'of_ab12', { expiresAt: '2026-10-14T14:00:00Z' });
  assert.equal(ids.status('offer', 'of_ab12', NOW + 30 * MIN), 'known', 'learning an ID again takes its latest expiry');
});

test('learnFrom reads each ID with the expiry beside it, and skips IDs of the wrong shape', () => {
  const ids = new IdSet(examplePack.entities);
  const learned = ids.learnFrom({
    products: [{ id: 1 }, { id: 'x' }],
    offers: [{ id: 'of_cd34', expiresAt: '2026-10-14T13:00:00Z' }, { id: 'of_ef56' }],
    coupons: ['ABCDE'],
    token: 'tok',
  }, examplePack.tools.search_products!.ids!.output, NOW);
  assert.equal(learned, 5);
  assert.equal(ids.status('offer', 'of_cd34', NOW), 'known');
  assert.equal(ids.status('offer', 'of_ef56', NOW), 'expired', 'an offer whose expiry is missing fails safe');
  assert.equal(ids.status('coupon', 'ABCDE', NOW + 11 * MIN), 'expired');
});

test("scripts get a view that can read the set but can't add to it", () => {
  const ids = new IdSet(examplePack.entities);
  ids.learn('product', 1);
  const view = ids.view() as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(view).sort(), ['has', 'list']);
  assert.equal(ids.view().has('product', 1, NOW), true);
  assert.deepEqual(ids.view().list('product'), [1]);
});

test('random sequences of learning and checking agree with a simple model', () => {
  const next = random(11);
  const ids = new IdSet(examplePack.entities);
  const model = new Map<string, number | null>();
  for (let i = 0; i < 3000; i++) {
    const id = pick(next, ['of_aa11', 'of_bb22', 'of_cc33', 'bad', 7]);
    const at = NOW + Math.floor(next() * 120) * MIN;
    if (next() < 0.5) {
      const expiresAt = next() < 0.3 ? null : NOW + Math.floor(next() * 120) * MIN;
      const ok = ids.learn('offer', id, { expiresAt });
      assert.equal(ok, typeof id === 'string' && id.startsWith('of_'));
      if (ok) model.set(String(id), expiresAt);
    } else {
      const recorded = model.get(String(id));
      const expected = recorded === undefined ? 'unknown' : recorded !== null && recorded <= at ? 'expired' : 'known';
      assert.equal(ids.status('offer', id, at), expected, `step ${i}`);
    }
  }
});

const config = (over: Partial<RemoteConfig> = {}): RemoteConfig => ({
  site: 'example-shop', version: '1', issuedAt: '2026-10-14T00:00:00Z', disabledTools: [], disabledSkills: [],
  budgets: { perTask: 9, perSession: 6, perDay: null }, rateLimitPerSecond: 5, signature: 'x', ...over,
});

test('the remote config can only make the site pack stricter, and only for its own site', () => {
  assert.deepEqual(effectivePolicy(examplePack).policy.budgets, { perTask: 5, perSession: 8, perDay: 10 });
  const { policy } = effectivePolicy(examplePack, config({ disabledTools: ['my_orders'] }));
  assert.deepEqual(policy.budgets, { perTask: 5, perSession: 6, perDay: 10 }, 'the stricter of each; null means no limit');
  assert.equal(policy.rateLimitPerSecond, 2);
  assert.deepEqual(policy.disabledTools, ['my_orders']);
  const other = effectivePolicy(examplePack, config({ site: 'other-shop', rateLimitPerSecond: 0.1 }));
  assert.equal(other.policy.rateLimitPerSecond, 2);
  assert.match(other.warnings[0]!, /other-shop/);
});

test('the call budget stops at the first limit reached: task, then day, then session', () => {
  let time = Date.UTC(2026, 9, 14, 23, 59, 58);
  const budget = new CallBudget({ perTask: 3, perSession: 10, perDay: 6 }, () => time, { day: 2, dayKey: Math.floor(time / 86_400_000) });
  assert.deepEqual([1, 2, 3, 4].map(() => budget.tryAcquire().ok), [true, true, true, false]);
  assert.deepEqual(budget.tryAcquire(), { ok: false, scope: 'task', limit: 3, used: 3 });
  budget.startTask();
  assert.deepEqual(budget.tryAcquire(), { ok: true });
  assert.deepEqual(budget.tryAcquire(), { ok: false, scope: 'day', limit: 6, used: 6 }, 'two calls were used earlier today');
  time += 5000;
  assert.deepEqual(budget.tryAcquire(), { ok: true }, 'a new day resets the day budget');
  assert.deepEqual(budget.used(), { task: 2, session: 5, day: 1, dayKey: Math.floor(time / 86_400_000) });

  const session = new CallBudget({ perTask: 10, perSession: 2, perDay: null }, () => time);
  assert.deepEqual([1, 2, 3].map(() => session.tryAcquire()), [{ ok: true }, { ok: true }, { ok: false, scope: 'session', limit: 2, used: 2 }]);
  session.startTask();
  assert.equal(session.tryAcquire().ok, false, 'a new task does not reset the session budget');
});

test('several calls at once take all of their budget or none of it', () => {
  const budget = new CallBudget({ perTask: 4, perSession: null, perDay: null }, () => NOW);
  assert.equal(budget.tryAcquire(3).ok, true);
  assert.equal(budget.tryAcquire(2).ok, false);
  assert.equal(budget.tryAcquire(1).ok, true);
  assert.deepEqual(budget.used().task, 4);
});

test('concurrent callers never take more than the budget allows', async () => {
  const next = random(5);
  for (let round = 0; round < 20; round++) {
    const limits = { perTask: 1 + Math.floor(next() * 30), perSession: 1 + Math.floor(next() * 30), perDay: null };
    const budget = new CallBudget(limits, () => NOW);
    let granted = 0;
    const worker = async () => {
      for (;;) {
        for (let spins = Math.floor(next() * 3); spins > 0; spins--) await Promise.resolve();
        if (!budget.tryAcquire().ok) return;
        granted++;
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    assert.equal(granted, Math.min(limits.perTask, limits.perSession), JSON.stringify(limits));
  }
});

test('the rate limiter spaces parallel calls evenly and lets a call start at once when the way is clear', () => {
  const limiter = new RateLimiter(2);
  assert.deepEqual([0, 0, 0, 100, 2000, 5000].map((now) => limiter.reserve(now)), [0, 500, 1000, 1500, 2000, 5000]);
  const thirds = new RateLimiter(3);
  const starts = [0, 0, 0, 0].map(() => thirds.reserve(0));
  starts.slice(1).forEach((start, i) => assert.ok(Math.abs(start - starts[i]! - 1000 / 3) < 1e-9));
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => new RateLimiter(bad), RangeError);
});
