// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the money conversions — every amount this app charges passes through them, and before the
// 2026-08-03 audit not one of them had a test (DONATIONS-044).
//
// IMPORTANT, so nobody is misled by a green run: some tests below assert the CURRENT behaviour of
// two known-wrong conversions rather than the correct answer, and say so at the assertion. They
// exist to make the wrongness visible and to fail loudly when it is fixed, because the fix changes
// what donors are charged and must be reconciled against Stripe by a human first:
//   • DONATIONS-001 — the three-decimal currencies (BHD, JOD, KWD, OMR, TND) charge 1/10.
//   • DONATIONS-008 — withCoveredFees drops the fixed fee for zero-decimal currencies.
// Both are documented in docs/audit/ACTION_REQUIRED.md. Do not "fix" a test here to make a red run
// green: if one of these fails, the arithmetic changed, and that is exactly what needs a human.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currencyDecimals,
  toMinor,
  toMajor,
  withCoveredFees,
  looksLikePublishable,
  looksLikeSecret,
  looksLikeWebhookSecret,
  stripeMode,
  stripeConfigured,
  publicStripeStatus,
} from './stripe';

// ── currencyDecimals ─────────────────────────────────────────────────────────

test('currencyDecimals: two decimals for ordinary currencies', () => {
  for (const c of ['GBP', 'USD', 'EUR', 'CAD', 'AUD', 'PKR', 'INR', 'MYR', 'ZAR', 'AED', 'SAR']) {
    assert.equal(currencyDecimals(c), 2, c);
  }
});

test('currencyDecimals: Stripe’s sixteen zero-decimal currencies', () => {
  // The full list per Stripe. If Stripe ever adds one, this test is where it should land.
  const zero = ['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];
  assert.equal(zero.length, 16);
  for (const c of zero) assert.equal(currencyDecimals(c), 0, c);
});

test('currencyDecimals: case-insensitive, and an unknown code falls back to two', () => {
  assert.equal(currencyDecimals('jpy'), 0);
  assert.equal(currencyDecimals('Jpy'), 0);
  assert.equal(currencyDecimals('ZZZ'), 2, 'an unknown code must not throw');
  assert.equal(currencyDecimals(''), 2);
});

test('currencyDecimals: DONATIONS-001 — the five three-decimal currencies', () => {
  // Stripe quotes BHD/JOD/KWD/OMR/TND in thousandths (fils/millimes). Before the fix this returned
  // 2, so a 10.000 KWD donation was sent as 1000 minor units — 1.000 KWD, a tenth of the amount the
  // donor was shown, with the ledger recording the full figure.
  const three = ['BHD', 'JOD', 'KWD', 'OMR', 'TND'];
  assert.equal(three.length, 5);
  for (const c of three) {
    assert.equal(currencyDecimals(c), 3, c);
    assert.equal(toMinor(10, c), 10_000, `${c}: 10.000 must charge 10.000, not 1.000`);
    assert.equal(toMajor(10_000, c), 10, `${c}: and read back as 10.000`);
  }
});

test('toMinor: DONATIONS-001 — a three-decimal amount is rounded to Stripe’s multiple of 10', () => {
  // Stripe rejects a three-decimal amount that is not a multiple of ten, so this must round rather
  // than let the charge fail in front of the donor. Nearest-10: rounding down would quietly shave
  // the gift, rounding up would take more than was agreed.
  assert.equal(toMinor(10.123, 'KWD'), 10_120, 'nearest 10 (down)');
  assert.equal(toMinor(10.126, 'KWD'), 10_130, 'nearest 10 (up)');
  assert.equal(toMinor(10.125, 'KWD') % 10, 0, 'the boundary is still a legal amount');
  for (const major of [1, 2.5, 7.777, 100, 1234.567]) {
    assert.equal(toMinor(major, 'BHD') % 10, 0, `BHD ${major} must be a multiple of 10`);
  }
});

test('withCoveredFees: DONATIONS-001 — the gross-up stays a legal three-decimal amount', () => {
  // A gross-up that lands on a non-multiple-of-10 would be rejected by Stripe, and the donor would
  // see a failure for an amount they never chose.
  for (const net of [10_000, 25_000, 1_000, 999_990]) {
    const gross = withCoveredFees(net, 'KWD');
    assert.equal(gross % 10, 0, `KWD gross-up of ${net} → ${gross} must be a multiple of 10`);
    assert.ok(gross > net, 'and must still be an increase');
  }
});

// ── toMinor / toMajor ────────────────────────────────────────────────────────

test('toMinor: two-decimal amounts, including the values floats get wrong', () => {
  assert.equal(toMinor(10, 'GBP'), 1000);
  assert.equal(toMinor(10.5, 'GBP'), 1050);
  assert.equal(toMinor(0.01, 'GBP'), 1);
  assert.equal(toMinor(33.33, 'GBP'), 3333);
  // 20.15 * 100 is 2014.9999999999998 in IEEE-754; Math.round is what saves it.
  assert.equal(toMinor(20.15, 'GBP'), 2015, 'binary-float rounding must not lose a penny');
  assert.equal(toMinor(0.1 + 0.2, 'GBP'), 30, '0.30000000000000004 → 30');
  assert.equal(toMinor(1234.56, 'GBP'), 123456);
});

test('toMinor: zero-decimal amounts are already the smallest unit', () => {
  assert.equal(toMinor(1000, 'JPY'), 1000);
  assert.equal(toMinor(1, 'KRW'), 1);
  // A fractional yen cannot exist; rounding is the only sane answer.
  assert.equal(toMinor(1000.4, 'JPY'), 1000);
  assert.equal(toMinor(1000.6, 'JPY'), 1001);
});

test('toMajor: inverts toMinor for both exponents', () => {
  assert.equal(toMajor(1050, 'GBP'), 10.5);
  assert.equal(toMajor(1, 'GBP'), 0.01);
  assert.equal(toMajor(1000, 'JPY'), 1000);
});

test('toMinor/toMajor: a round-trip through the API boundary is lossless', () => {
  // Amounts cross the API in MAJOR units, so every stored minor value makes this trip and back.
  for (const minor of [1, 30, 500, 1050, 3333, 99_999, 123_456, 99_999_999]) {
    assert.equal(toMinor(toMajor(minor, 'GBP'), 'GBP'), minor, `GBP ${minor}`);
  }
  for (const minor of [1, 100, 1000, 99_999_999]) {
    assert.equal(toMinor(toMajor(minor, 'JPY'), 'JPY'), minor, `JPY ${minor}`);
  }
});

test('toMinor: hostile inputs do not silently become a charge', () => {
  // The route validates before reaching here (zod + Number.isInteger + floor/ceiling checks), so
  // this documents what the conversion alone does with junk: NaN in, NaN out — never 0, which would
  // be a free donation, and never a huge number, which would be a surprise charge.
  assert.ok(Number.isNaN(toMinor(NaN, 'GBP')));
  assert.equal(toMinor(Infinity, 'GBP'), Infinity);
  assert.equal(toMinor(-5, 'GBP'), -500, 'negatives pass through — the ROUTE must reject them');
});

// ── withCoveredFees ──────────────────────────────────────────────────────────

test('withCoveredFees: grosses up so the masjid nets ~the intended amount', () => {
  // Model is 2.9% + 0.30. For £10.00: (1000 + 30) / (1 - 0.029) = 1060.76… → 1061.
  const gross = withCoveredFees(1000, 'GBP');
  assert.equal(gross, 1061);
  // Verify the point of the exercise: fee on the GROSS leaves the masjid with ~the original net.
  const fee = Math.round(gross * 0.029) + 30;
  assert.ok(Math.abs(gross - fee - 1000) <= 1, `net after fee should be ~1000, got ${gross - fee}`);
});

test('withCoveredFees: is always an increase, and monotonic', () => {
  let prev = 0;
  for (const net of [50, 100, 500, 1000, 5000, 100_000]) {
    const gross = withCoveredFees(net, 'GBP');
    assert.ok(gross > net, `${net} → ${gross} must be higher`);
    assert.ok(gross > prev);
    prev = gross;
  }
});

test('withCoveredFees: DONATIONS-008 — the fixed fee no longer vanishes for zero-decimal currencies', () => {
  // toMinor(0.30, 'JPY') is Math.round(0.3 * 1) = 0, so the "+30c" half of the model used to
  // disappear entirely and the gross-up under-recovered on every covered-fee donation. It is now
  // floored at one minor unit — deliberately an approximation, not an FX conversion (see the comment
  // on fixedFeeMinor); the point is that it is no longer zero.
  const jpy = withCoveredFees(1000, 'JPY');
  assert.equal(jpy, Math.round((1000 + 1) / (1 - 0.029)), 'the fixed component is present');
  assert.ok(jpy > Math.round(1000 / (1 - 0.029)), 'and strictly more than percentage-only');
  // Two-decimal currencies are unchanged by the fix — this is the regression guard on the common path.
  assert.equal(withCoveredFees(1000, 'GBP'), 1061); // (1000 + 30) / 0.971 = 1060.76 → 1061
  assert.equal(withCoveredFees(2500, 'USD'), 2606); // (2500 + 30) / 0.971 = 2605.56 → 2606
});

// ── Key shape + mode detection ───────────────────────────────────────────────

test('key shapes: only real Stripe key formats are accepted', () => {
  assert.ok(looksLikePublishable('pk_test_51AbCdEf'));
  assert.ok(looksLikePublishable('pk_live_51AbCdEf'));
  assert.ok(!looksLikePublishable('sk_test_51AbCdEf'), 'a SECRET key is not publishable');
  assert.ok(!looksLikePublishable('pk_test_'), 'prefix alone is not a key');
  assert.ok(!looksLikePublishable(' pk_test_51A'), 'no leading whitespace');
  assert.ok(!looksLikePublishable('pk_test_51A!'), 'no punctuation');

  assert.ok(looksLikeSecret('sk_test_51AbCdEf'));
  assert.ok(looksLikeSecret('sk_live_51AbCdEf'));
  assert.ok(looksLikeSecret('rk_live_51AbCdEf'), 'restricted keys are legitimate');
  assert.ok(!looksLikeSecret('pk_live_51AbCdEf'));

  assert.ok(looksLikeWebhookSecret('whsec_AbCdEf123'));
  assert.ok(!looksLikeWebhookSecret('whsec_'));
  assert.ok(!looksLikeWebhookSecret('sk_test_51A'));
});

test('stripeMode: test vs live is read from the key prefix', () => {
  assert.equal(stripeMode({ publishableKey: 'pk_test_1', secretKey: 'sk_test_1' }), 'test');
  assert.equal(stripeMode({ publishableKey: 'pk_live_1', secretKey: 'sk_live_1' }), 'live');
  assert.equal(stripeMode({ publishableKey: '', secretKey: '' }), 'unknown');
  // The SECRET key decides — it is the one that moves money.
  assert.equal(stripeMode({ publishableKey: 'pk_test_1', secretKey: 'sk_live_1' }), 'live');
});

test('stripeConfigured: needs a valid PAIR in the SAME mode', () => {
  const cfg = (publishableKey: string, secretKey: string) => ({ publishableKey, secretKey, webhookSecret: '', id: 'a', label: 'a' });
  assert.equal(stripeConfigured(cfg('pk_test_1', 'sk_test_1')), true);
  assert.equal(stripeConfigured(cfg('pk_live_1', 'sk_live_1')), true);
  assert.equal(stripeConfigured(cfg('pk_test_1', 'sk_live_1')), false, 'mixed modes must not go live');
  assert.equal(stripeConfigured(cfg('pk_test_1', '')), false);
  assert.equal(stripeConfigured(cfg('', 'sk_test_1')), false);
  assert.equal(stripeConfigured(cfg('nonsense', 'sk_test_1')), false);
});

test('publicStripeStatus: NEVER returns the secret or the webhook secret', () => {
  // This object is sent to the browser. The invariant is the whole point of the function.
  const status = publicStripeStatus({
    publishableKey: 'pk_live_51PUBLISHABLE',
    secretKey: 'sk_live_51SUPERSECRETVALUE',
    webhookSecret: 'whsec_SUPERSECRETHOOK',
  });
  const blob = JSON.stringify(status);
  assert.ok(!blob.includes('sk_live'), 'the secret key must never cross to the browser');
  assert.ok(!blob.includes('SUPERSECRETVALUE'));
  assert.ok(!blob.includes('whsec_'), 'nor the webhook secret');
  assert.ok(!blob.includes('SUPERSECRETHOOK'));
  // What it MAY say:
  assert.equal(status.publishableKey, 'pk_live_51PUBLISHABLE');
  assert.equal(status.hasSecretKey, true);
  assert.equal(status.hasWebhookSecret, true);
  assert.equal(status.mode, 'live');
  assert.equal(status.configured, true);
});

test('publicStripeStatus: flags a test/live key mismatch for the admin', () => {
  const s = publicStripeStatus({ publishableKey: 'pk_test_1', secretKey: 'sk_live_1', webhookSecret: '' });
  assert.equal(s.keysMismatch, true);
  assert.equal(s.configured, false);
});
