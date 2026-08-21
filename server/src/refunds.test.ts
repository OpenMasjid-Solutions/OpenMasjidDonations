// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the PURE half of refunds (server/src/refunds.ts). This is money leaving the masjid's
// account, so three properties matter more than the rest and nothing else guards them:
//
//  1. THE CEILING. A refund may never exceed what is left on the charge. `refundableMinor` is the
//     only thing standing between a crafted (or simply stale) amount and Stripe being asked to
//     hand back more than the donor ever gave — and a "full" refund must be EXACT, because one
//     penny left behind is a support conversation.
//  2. THE THREE-DECIMAL RULE. KWD/BHD/JOD/OMR/TND are quoted in thousandths and Stripe requires a
//     multiple of ten. Getting this wrong on the CHARGE side was DONATIONS-001, a factor-of-ten
//     error that the app's own ledger agreed with; the refund side must not repeat it.
//  3. THE WORDS. A masjid must never read a bare Stripe code. `refundFailureMessage` passes a real
//     sentence through and replaces anything machine-shaped with our own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_REFUND_MINOR,
  REFUND_REASONS,
  isRefundReason,
  refundFailureMessage,
  refundState,
  refundableMinor,
  resolveRefundAmount,
  type ResolvedRefund,
} from './refunds';

/** The amount out of a successful resolve, so a test can read it without a non-null assertion. */
function ok(r: ResolvedRefund): number {
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  return r.ok ? r.amount : -1;
}

// ── 1. The ceiling ────────────────────────────────────────────────────────────

test('refundableMinor is what is left, and never negative', () => {
  assert.equal(refundableMinor(5000, 0), 5000);
  assert.equal(refundableMinor(5000, 2000), 3000);
  assert.equal(refundableMinor(5000, 5000), 0);
  // Stripe reporting more refunded than captured means there is nothing left — never that the
  // masjid owes the donor money.
  assert.equal(refundableMinor(5000, 6000), 0);
  assert.equal(refundableMinor(0, 0), 0);
});

test('an omitted amount refunds EXACTLY what is left (a full refund leaves nothing behind)', () => {
  assert.deepEqual(resolveRefundAmount(undefined, 5000, 'GBP'), { ok: true, amount: 5000 });
  // Including after a part refund: the rest, to the penny.
  assert.deepEqual(resolveRefundAmount(undefined, refundableMinor(5000, 1999), 'GBP'), { ok: true, amount: 3001 });
});

test('an amount over what is left is refused, not clamped', () => {
  const r = resolveRefundAmount(5001, 5000, 'GBP');
  assert.equal(r.ok, false, 'must refuse');
  assert.ok(!r.ok && !('amount' in r), 'and must NOT silently refund a different figure');
  assert.match(r.ok ? '' : r.error, /left to refund/i);
});

test('the exact remaining amount is allowed', () => {
  assert.deepEqual(resolveRefundAmount(5000, 5000, 'GBP'), { ok: true, amount: 5000 });
});

test('a fully refunded donation is refused before any amount is considered', () => {
  for (const requested of [undefined, 1, 100]) {
    const r = resolveRefundAmount(requested, 0, 'GBP');
    assert.equal(r.ok, false, `refundable 0 must refuse (requested ${requested})`);
    assert.match(r.ok ? '' : r.error, /already been fully refunded/i);
  }
});

test('zero, negative and non-finite amounts are refused', () => {
  for (const bad of [0, -1, -5000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveRefundAmount(bad, 5000, 'GBP').ok, false, `${bad} must be refused`);
  }
});

// ── 2. The three-decimal rule (DONATIONS-001's neighborhood) ─────────────────

test('a part refund in a three-decimal currency is snapped to a multiple of ten', () => {
  // 10.123 KWD typed → 10123 minor by the caller; Stripe only accepts multiples of 10.
  const r = ok(resolveRefundAmount(10123, 20000, 'KWD'));
  assert.equal(r, 10120);
  assert.equal(r % 10, 0);
  // Rounding is to NEAREST, as on the charge side — never a silent floor.
  assert.equal(ok(resolveRefundAmount(10126, 20000, 'KWD')), 10130);
});

test('snapping can never push a three-decimal refund past what is left', () => {
  // 9996 rounds to 10000, which is more than the 9998 available — refuse rather than overshoot.
  assert.equal(resolveRefundAmount(9996, 9998, 'KWD').ok, false, 'must refuse an amount whose snapped value exceeds the balance');
  // The balance itself is always refundable, because it is what was charged.
  assert.equal(ok(resolveRefundAmount(undefined, 9998, 'KWD')), 9998);
});

test('a three-decimal balance below one whole coin has nothing refundable', () => {
  // Under 10 thousandths there is no amount Stripe would accept.
  assert.equal(resolveRefundAmount(undefined, 9, 'KWD').ok, false);
  // …while a two-decimal currency can still give back its last penny.
  assert.deepEqual(resolveRefundAmount(undefined, 1, 'GBP'), { ok: true, amount: MIN_REFUND_MINOR });
});

test('zero-decimal currencies are untouched (a yen is a whole unit)', () => {
  assert.deepEqual(resolveRefundAmount(1234, 5000, 'JPY'), { ok: true, amount: 1234 });
});

// ── 3. The words ──────────────────────────────────────────────────────────────

test('refundFailureMessage passes a real sentence through', () => {
  const stripe = 'Insufficient funds in your Stripe account to issue this refund.';
  assert.equal(refundFailureMessage(stripe), stripe);
});

test('refundFailureMessage never shows a bare machine code', () => {
  for (const code of ['charge_already_refunded', 'balance_insufficient', 'card_declined', 'nope']) {
    const out = refundFailureMessage(code);
    assert.ok(!out.includes(code), `must not surface "${code}"`);
    assert.match(out, /Stripe dashboard/);
  }
});

test('refundFailureMessage takes the first sentence only, and finishes it', () => {
  assert.equal(
    refundFailureMessage('The charge has already been refunded\nSee the docs for more'),
    'The charge has already been refunded.',
  );
  assert.match(refundFailureMessage(''), /Stripe wouldn’t process/);
  assert.match(refundFailureMessage(null), /Stripe wouldn’t process/);
});

// ── Reasons + display state ───────────────────────────────────────────────────

test('only Stripe’s three reasons are accepted', () => {
  for (const r of REFUND_REASONS) assert.ok(isRefundReason(r));
  for (const bad of ['other', 'REQUESTED_BY_CUSTOMER', '', 1, null, undefined, {}]) {
    assert.equal(isRefundReason(bad), false, `${String(bad)} must be rejected`);
  }
});

test('refundState reads none / partial / full', () => {
  assert.equal(refundState(5000, 0), 'none');
  assert.equal(refundState(5000, 1), 'partial');
  assert.equal(refundState(5000, 4999), 'partial');
  assert.equal(refundState(5000, 5000), 'full');
  // Over-refunded (only reachable from a Stripe figure we clamp elsewhere) still reads as full,
  // never as "partial" — which would invite another refund on top.
  assert.equal(refundState(5000, 5001), 'full');
});
