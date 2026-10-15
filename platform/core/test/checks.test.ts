// L1 for errors and boundary checks, on the made-up shop: every way a tool call or a presentation call can be refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSitePack, validateToolError } from '../../contract/generated/validators.js';
import type { PresentationCall } from '../../contract/generated/types.ts';
import {
  allowedValueRules, checkPresentation, checkToolCall, effectivePolicy, errorFor, hasPlaceholder, IdSet, missingNotices,
  missingValueSources, PLATFORM_ERRORS, platformError, siteError, withRequiredNotices, type CheckContext, type PlatformReason,
} from '../src/index.ts';
import { examplePack as pack } from './example-pack.ts';
import { sitePacks } from './sites.ts';

const NOW = Date.UTC(2026, 9, 14, 12);
const STANDARD = { tool: 't', details: 'd', value: 'v', field: 'f', options: ['a', 'b'], kind: 'k', id: 1, idType: 'numbers', what: 'w',
  scope: 'task', limit: 5, section: 's', sections: ['x'], fields: ['y'], notice: 'n', form: 'fm', status: 503, skill: 'sk', skills: ['a'] };

function context(over: Partial<CheckContext> = {}): CheckContext {
  const ids = new IdSet(pack.entities);
  ids.learn('product', 1);
  ids.learn('product', 2);
  ids.learn('offer', 'of_ab12', { expiresAt: NOW + 60_000 });
  ids.learn('offer', 'of_old1', { expiresAt: NOW - 1 });
  ids.learn('token', 'tok');
  ids.learn('order', 'ABC123');
  return {
    pack, policy: effectivePolicy(pack).policy, ids, now: NOW, page: { url: 'https://www.example.com/', pageType: 'home' },
    responses: { filters: { colors: [{ key: 'Gray' }, { key: 'Black' }] } }, ...over,
  };
}
const reason = (e: { reason?: string } | null) => e?.reason ?? null;

test('the made-up shop is a valid site pack', () => {
  assert.ok(validateSitePack(pack), JSON.stringify(validateSitePack.errors));
});

test('every platform error and every site error matches the contract, with every placeholder filled', () => {
  for (const r of Object.keys(PLATFORM_ERRORS) as PlatformReason[]) {
    const e = platformError(r, STANDARD);
    assert.ok(validateToolError(e), r);
    assert.ok(!hasPlaceholder(e.message), `${r}: ${e.message}`);
  }
  for (const site of [pack, ...sitePacks()]) {
    for (const [tool, t] of Object.entries(site.tools)) {
      for (const r of Object.keys(t?.errors ?? {})) assert.ok(validateToolError(siteError(site, tool, r, STANDARD)), `${site.site.id}/${tool}/${r}`);
    }
  }
  assert.equal(siteError(pack, 'get_offer', 'no_such_reason'), null);
});

test("a problem in a tool call uses the tool's own wording when it has exactly one fitting error", () => {
  assert.deepEqual(errorFor(pack, 'get_offer', 'expired_id', { kind: 'offer', id: 'of_old1' }),
    { code: 'expired', reason: 'offer_gone', message: 'That offer ended. Search again for a current price.', retryable: true });
  assert.equal(errorFor(pack, 'compare_products', 'expired_id', { kind: 'product', id: 1 }).reason, 'expired_id', 'no own error: the platform wording');
});

test('tool calls: unknown, switched off, writes, sign-in and bad arguments are refused in that order', () => {
  const ctx = context();
  assert.equal(reason(checkToolCall(ctx, 'no_such_tool', {})), 'unknown_tool');
  assert.equal(reason(checkToolCall({ ...ctx, policy: { ...ctx.policy, disabledTools: ['place_order'] } }, 'place_order', {})), 'tool_disabled');
  assert.equal(reason(checkToolCall(ctx, 'place_order', { offerId: 'of_ab12' })), 'writes_off');
  assert.equal(checkToolCall(ctx, 'place_order', { offerId: 'of_ab12' })!.code, 'policy_blocked');
  assert.equal(reason(checkToolCall(ctx, 'my_orders', {})), 'signed_out', 'the site wording for auth_required');
  assert.equal(checkToolCall({ ...ctx, page: { url: 'https://www.example.com/', pageType: 'account', signedIn: true } }, 'my_orders', {}), null);
  const bad = checkToolCall({ ...ctx, validateInput: () => 'colors must be a list' }, 'search_products', { colors: 'Gray' });
  assert.deepEqual([bad?.reason, bad?.code], ['bad_arguments', 'invalid_value']);
  assert.match(bad!.message, /colors must be a list/);
});

test('tool calls: IDs must be known, current and the right shape', () => {
  const ctx = context();
  assert.equal(checkToolCall(ctx, 'get_offer', { offerId: 'of_ab12' }), null);
  assert.equal(reason(checkToolCall(ctx, 'get_offer', { offerId: 'of_zz00' })), 'unknown_id');
  assert.equal(reason(checkToolCall(ctx, 'get_offer', { offerId: 'of_old1' })), 'offer_gone');
  assert.equal(reason(checkToolCall(ctx, 'get_offer', { offerId: 'BAD' })), 'bad_id');
  assert.equal(checkToolCall(ctx, 'compare_products', { productIds: [1, 2] }), null);
  assert.match(checkToolCall(ctx, 'compare_products', { productIds: [1, 99] })!.message, /product 99 wasn't returned/);
  assert.match(checkToolCall(ctx, 'compare_products', { productIds: [1, '2'] })!.message, /"2" isn't a valid product ID: product IDs are numbers/);
});

test('tool calls: values must be ones the site offers, listing the valid options', () => {
  const ctx = context();
  assert.equal(checkToolCall(ctx, 'search_products', { colors: ['Gray', 'Black'] }), null);
  const e = checkToolCall(ctx, 'search_products', { colors: ['Gray', 'Grey'] });
  assert.deepEqual(e, { code: 'invalid_value', reason: 'bad_color', message: "'Grey' isn't one of the colors we sell. Try one of: Gray, Black.", retryable: true });
  const many = { colors: Array.from({ length: 30 }, (_, i) => ({ key: `C${i}` })) };
  assert.match(checkToolCall({ ...ctx, responses: { filters: many } }, 'search_products', { colors: ['Zz'] })!.message, /C19, …\.$/);
  assert.deepEqual(allowedValueRules(pack, 'search_products'), [{ arg: 'colors', endpoint: 'filters', path: 'colors[].key' }]);
  assert.deepEqual(missingValueSources({ ...ctx, responses: {} }, 'search_products', { colors: ['Gray'] }), ['filters']);
  assert.deepEqual(missingValueSources({ ...ctx, responses: {} }, 'search_products', {}), [], 'no colors given, nothing to check');
});

test('presentation calls: kinds, IDs, fields, sections, notices and forms must be ones the site pack declares', () => {
  const ctx = context();
  const check = (call: PresentationCall) => reason(checkPresentation(ctx, call));
  assert.equal(check({ name: 'present_items', args: { entity: 'product', ids: [1, 2] } }), null);
  assert.equal(check({ name: 'present_items', args: { entity: 'product', ids: [1, 3] } }), 'unknown_id');
  assert.equal(check({ name: 'present_items', args: { entity: 'token', ids: ['tok'] } }), 'internal_kind');
  assert.equal(check({ name: 'present_items', args: { entity: 'ghost', ids: [1] } }), 'unknown_kind');
  assert.equal(check({ name: 'present_items', args: { entity: 'order', ids: ['ABC123'] } }), 'needs_sign_in');
  assert.equal(check({ name: 'present_comparison', args: { entity: 'product', ids: [1, 2], attributes: ['price', 'weight'] } }), 'unknown_field');
  assert.equal(check({ name: 'present_detail', args: { entity: 'product', id: 1, sections: ['overview', 'history'] } }), 'unknown_section');
  assert.equal(check({ name: 'present_detail', args: { entity: 'offer', id: 'of_old1' } }), 'expired_id');
  assert.equal(check({ name: 'present_notice', args: { notice: 'total_estimate' } }), null);
  assert.equal(check({ name: 'present_notice', args: { notice: 'made_up' } }), 'unknown_notice');
  assert.equal(check({ name: 'present_form', args: { form: 'gift_wrap' } }), 'unknown_form');
  assert.equal(check({ name: 'present_form', args: { form: 'shipping', prefill: { zip: '94402', speed: 'express', quantity: 2 } } }), null);
  for (const prefill of [{ zip: '9440' }, { quantity: 12 }, { quantity: 1.5 }, { speed: 'overnight' }, { color: 'red' }, { zip: 94402 }]) {
    assert.equal(check({ name: 'present_form', args: { form: 'shipping', prefill } }), 'bad_prefill', JSON.stringify(prefill));
  }
});

test('a notice is required whenever a field it explains is on screen, and core.js adds it if missing', () => {
  const items: PresentationCall = { name: 'present_items', args: { entity: 'product', ids: [1] } };
  const notice: PresentationCall = { name: 'present_notice', args: { notice: 'total_estimate' } };
  assert.deepEqual(missingNotices(pack, [items]), ['total_estimate']);
  assert.deepEqual(missingNotices(pack, [items, notice]), []);
  assert.deepEqual(missingNotices(pack, [{ name: 'present_comparison', args: { entity: 'product', ids: [1, 2], attributes: ['rating'] } }]), []);
  assert.deepEqual(withRequiredNotices(pack, [items]), [items, notice]);
});
