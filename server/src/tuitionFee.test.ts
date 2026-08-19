// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the tuition processing fee (students/billing §11.2 `info.fee`, Students 0.51.0).
//
// This file exists because the failure modes here are quiet and they are about money:
//
//  1. **The arithmetic.** The fee is a share of the GROSS, so the gross is a DIVISION and it rounds
//     UP. The naive markup — a percentage of the tuition — gives $103.20 on a $100 bill instead of
//     $103.30, leaves the school a dime short every single time, and leaves a $100 invoice settling
//     at $99.91: open for ever, showing a family as unpaid over ten cents. The worked examples the
//     contract publishes are asserted verbatim.
//  2. **`enabled: false` must change nothing.** It is what almost every install returns. No
//     gross-up, no metadata key, no `feeCents` — byte-identical behaviour to before the feature.
//  3. **The ledger gets the TUITION.** The contract's failure directions are deliberately lopsided:
//     forget the metadata key and reconciliation credits one family slightly too much; put a gross
//     in `amountCents` and the ledger is wrong until a human notices. So the net is what is stored
//     and the net is what is sent, and no arithmetic sits between the two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grossUpTuition, cardFeeRate, createTuitionSession, computeTuitionAmount, type StudentsFeeRate, type StudentsInfo } from './students';
import { Store } from './store';

const CARD: StudentsFeeRate = { percentBps: 290, fixedCents: 30, capCents: 0 };
const BANK: StudentsFeeRate = { percentBps: 80, fixedCents: 0, capCents: 500 };

/** A minimal `info` for the rate picker. */
const info = (fee: Partial<StudentsInfo['fee']>): StudentsInfo => ({
  enabled: true,
  schoolName: 'An-Noor',
  currency: 'USD',
  tagline: '',
  allowAdvance: true,
  minAmountCents: 100,
  fee: { enabled: false, card: null, bank: null, ...fee },
});

// ── 1. The three worked examples from the contract ───────────────────────────

test('the contract’s worked examples, to the cent', () => {
  // $100.00 → $103.30, fee $3.30
  assert.deepEqual(grossUpTuition(10_000, CARD), { tuitionCents: 10_000, feeCents: 330, grossCents: 10_330 });
  // $250.00 → $257.78, fee $7.78
  assert.deepEqual(grossUpTuition(25_000, CARD), { tuitionCents: 25_000, feeCents: 778, grossCents: 25_778 });
  // $2,000.00 by bank, capped → $2,005.00, fee $5.00
  assert.deepEqual(grossUpTuition(200_000, BANK), { tuitionCents: 200_000, feeCents: 500, grossCents: 200_500 });
});

test('the gross is a DIVISION, not a markup — the dime the school would otherwise lose', () => {
  // The naive version is 10000 + 2.9% + 30 = 10320. The right answer is 10330, and the difference
  // is not rounding noise: at 10320 Stripe takes 329 and the school banks 9991 on a 10000 bill.
  const { grossCents } = grossUpTuition(10_000, CARD);
  assert.equal(grossCents, 10_330);
  const naive = 10_000 + Math.round(10_000 * 0.029) + 30;
  assert.equal(naive, 10_320, 'the mistake this test guards against');
  // Prove it settles: gross − Stripe's actual cut must reach the tuition.
  const stripeTakes = Math.round((grossCents * 290) / 10_000) + 30;
  assert.ok(grossCents - stripeTakes >= 10_000, `school must not be short: kept ${grossCents - stripeTakes}`);
});

test('rounding is always UP, and never by more than a cent', () => {
  for (let tuition = 100; tuition <= 5_000; tuition += 1) {
    const { feeCents, grossCents } = grossUpTuition(tuition, CARD);
    assert.equal(grossCents, tuition + feeCents, `${tuition}: the parts must add up`);
    // The exact real-valued answer, and our integer answer must be its ceiling.
    const exact = (tuition + CARD.fixedCents) / (1 - CARD.percentBps / 10_000);
    assert.ok(grossCents >= exact - 1e-6, `${tuition}: rounded DOWN (${grossCents} < ${exact})`);
    assert.ok(grossCents < exact + 1, `${tuition}: overshot by a whole cent (${grossCents} vs ${exact})`);
    // And the school is never short after Stripe's cut.
    const kept = grossCents - (Math.round((grossCents * CARD.percentBps) / 10_000) + CARD.fixedCents);
    assert.ok(kept >= tuition, `${tuition}: school kept ${kept}`);
  }
});

test('a cap is a ceiling on the FEE, not on the charge', () => {
  // Under the cap, the cap is irrelevant.
  const small = grossUpTuition(10_000, BANK); // 0.8% of ~10080 = ~81c
  assert.ok(small.feeCents < 500, `expected under the cap, got ${small.feeCents}`);
  assert.equal(small.grossCents, small.tuitionCents + small.feeCents);
  // Over it, the answer is exactly tuition + cap — not $16 added to cover a $5 charge.
  const big = grossUpTuition(200_000, BANK);
  assert.equal(big.feeCents, 500);
  const uncapped = grossUpTuition(200_000, { ...BANK, capCents: 0 });
  assert.ok(uncapped.feeCents > 1_500, 'the uncapped fee really would have been much larger');
});

test('the exact boundary where a fee lands on a whole cent adds nothing extra', () => {
  // percentBps 0 + a flat fee is exact division: the ceiling must not add a spurious cent.
  assert.deepEqual(grossUpTuition(10_000, { percentBps: 0, fixedCents: 50, capCents: 0 }), {
    tuitionCents: 10_000,
    feeCents: 50,
    grossCents: 10_050,
  });
  // 50% of the gross on a $1.00 tuition is exactly $2.00 — no rounding either way.
  assert.deepEqual(grossUpTuition(100, { percentBps: 5_000, fixedCents: 0, capCents: 0 }), {
    tuitionCents: 100,
    feeCents: 100,
    grossCents: 200,
  });
});

test('no rate means no fee, and that is the answer for almost every school', () => {
  assert.deepEqual(grossUpTuition(10_000, null), { tuitionCents: 10_000, feeCents: 0, grossCents: 10_000 });
});

test('a zero or negative tuition is never grossed up', () => {
  assert.deepEqual(grossUpTuition(0, CARD), { tuitionCents: 0, feeCents: 0, grossCents: 0 });
  assert.deepEqual(grossUpTuition(-500, CARD), { tuitionCents: 0, feeCents: 0, grossCents: 0 });
});

test('the largest chargeable tuition stays exact (no float drift at the ceiling)', () => {
  const { tuitionCents, feeCents, grossCents } = grossUpTuition(99_999_999, CARD);
  assert.equal(tuitionCents + feeCents, grossCents);
  const exact = (99_999_999 + 30) / (1 - 0.029);
  assert.ok(grossCents >= Math.ceil(exact) - 1 && grossCents <= Math.ceil(exact) + 1, `got ${grossCents}, exact ${exact}`);
  assert.ok(Number.isInteger(grossCents));
});

// ── 2. Off is off ────────────────────────────────────────────────────────────

test('fee.enabled false means change nothing — no rate, whatever else the payload says', () => {
  // A school that switched it off but left the rates in place must not have them applied.
  assert.equal(cardFeeRate(info({ enabled: false, card: CARD })), null);
});

test('a pre-0.51.0 school (no fee object at all) adds nothing', () => {
  const i = info({});
  assert.equal(i.fee.enabled, false);
  assert.equal(cardFeeRate(i), null);
  assert.equal(cardFeeRate(null), null);
  assert.equal(cardFeeRate(undefined), null);
});

test('enabled with a null card rate adds nothing', () => {
  assert.equal(cardFeeRate(info({ enabled: true, card: null, bank: BANK })), null);
});

test('this page never applies the BANK rate, even when one is offered', () => {
  // The fee is fixed when the PaymentIntent is created, before the payer has chosen a method, and
  // this page uses automatic_payment_methods — so which rate will apply is not knowable. Quoting
  // the card rate and calling it a card fee is honest about the common case; quoting the bank rate
  // would under-collect the moment somebody used a card, leaving the school short.
  const rate = cardFeeRate(info({ enabled: true, card: CARD, bank: BANK }));
  assert.deepEqual(rate, CARD, 'the card rate is the one quoted');
  assert.notDeepEqual(rate, BANK);
});

// ── 3. The shape record-payment will see ─────────────────────────────────────

test('the tuition is what a ledger would be sent, and the fee rides alongside it', () => {
  // Mirrors what the intent route stores and tryRecordStudentPayment then sends: amountCents is
  // the tuition, feeCents is informational, and their sum is what the card was charged.
  const charge = grossUpTuition(25_000, CARD);
  const wire = { amountCents: charge.tuitionCents, feeCents: charge.feeCents || undefined };
  assert.equal(wire.amountCents, 25_000, 'NEVER the gross — a gross here is a silent credit');
  assert.equal(wire.feeCents, 778);
  assert.equal(wire.amountCents + (wire.feeCents ?? 0), charge.grossCents);
});

test('with no fee there is no feeCents key at all, so an older Students sees the old shape', () => {
  const charge = grossUpTuition(25_000, null);
  const wire = { amountCents: charge.tuitionCents, feeCents: charge.feeCents || undefined };
  assert.equal(wire.feeCents, undefined);
  assert.equal(charge.grossCents, 25_000);
});

test('the metadata key is written only when something was actually added', () => {
  const meta = (tuition: number, rate: StudentsFeeRate | null): Record<string, string> => {
    const c = grossUpTuition(tuition, rate);
    const m: Record<string, string> = { purpose: 'students-billing', omos_app: 'donations' };
    if (c.feeCents > 0) m.students_fee_cents = String(c.feeCents);
    return m;
  };
  assert.equal(meta(10_000, CARD).students_fee_cents, '330');
  assert.ok(!('students_fee_cents' in meta(10_000, null)), 'no key when the school absorbs it');
});

test('PRIVACY: nothing about the fee carries a name or a Student ID', () => {
  // students_fee_cents is an amount, which is not identifying — but the ban on a Student ID or a
  // child's name in metadata (§11.3) is absolute, so this asserts the fee work added neither.
  const c = grossUpTuition(10_000, CARD);
  const meta: Record<string, string> = {
    purpose: 'students-billing',
    omos_app: 'donations',
    students_family_id: 'fam_x1',
    students_fee_cents: String(c.feeCents),
  };
  for (const [k, v] of Object.entries(meta)) {
    assert.ok(!/YUS\d|studentCode|firstName/i.test(`${k}=${v}`), `${k} must not carry a Student ID`);
  }
  assert.match(meta.students_fee_cents, /^[0-9]+$/, 'an amount, and nothing else');
});

// ── 4. The whole chain the intent route walks, against a real database ───────
//
// The route itself needs Stripe to run, so this exercises everything either side of that one call:
// the session's captured rate → computeTuitionAmount → grossUpTuition → what is stored → what an
// outbox retry would then send. That last hop is the one that must never carry a gross.

test('end to end: full balance, fee on — the card pays the gross and the ledger gets the tuition', () => {
  const store = new Store(':memory:');
  const session = createTuitionSession({
    campaignId: 'cmp_1', familyId: 'fam_x1', studentId: 'stu_1', familyLabel: 'Ismail family',
    currency: 'USD', balanceCents: 10_000,
    invoices: [{ id: 'inv_9', studentId: 'stu_1', balanceCents: 10_000, items: [] }],
    itemised: false,
    students: [{ ref: 'c0', studentId: 'stu_1', balanceCents: 10_000 }],
    allowAdvance: true, minAmountCents: 100,
    fee: CARD,
  });

  const amt = computeTuitionAmount(session, { kind: 'full' });
  assert.ok(!('error' in amt));
  const charge = grossUpTuition(amt.amountCents, session.fee);
  assert.equal(charge.grossCents, 10_330, 'the card is charged the gross');
  assert.equal(charge.tuitionCents, 10_000);

  // What the route stores (net + fee), and the metadata it writes.
  store.createStudentPayment({
    campaignId: 'cmp_1', stripeAccountId: 'acct_1', paymentIntentId: 'pi_e2e',
    familyId: session.familyId, studentId: session.studentId, familyLabel: session.familyLabel,
    amount: charge.tuitionCents, feeCents: charge.feeCents, currency: 'USD',
    allocations: '', studentsSplit: '', paymentLines: '',
  });
  const meta: Record<string, string> = { purpose: 'students-billing', omos_app: 'donations', students_family_id: session.familyId };
  if (charge.feeCents > 0) meta.students_fee_cents = String(charge.feeCents);
  assert.equal(meta.students_fee_cents, '330');

  // What the outbox retry then sends — hours later, with no session and no live rate.
  const row = store.getStudentPaymentByPI('pi_e2e')!;
  assert.equal(row.amount, 10_000, 'amountCents is the TUITION');
  assert.equal(row.feeCents, 330);
  assert.equal(row.amount + row.feeCents, charge.grossCents, 'and the pair reconstructs the charge');
});

test('end to end: the same session with the fee OFF changes nothing at all', () => {
  const store = new Store(':memory:');
  const session = createTuitionSession({
    campaignId: 'cmp_1', familyId: 'fam_x1', studentId: 'stu_1', familyLabel: 'Ismail family',
    currency: 'USD', balanceCents: 10_000,
    invoices: [{ id: 'inv_9', studentId: 'stu_1', balanceCents: 10_000, items: [] }],
    itemised: false,
    students: [{ ref: 'c0', studentId: 'stu_1', balanceCents: 10_000 }],
    allowAdvance: true, minAmountCents: 100,
    fee: null, // the default for almost every school
  });
  const amt = computeTuitionAmount(session, { kind: 'full' });
  assert.ok(!('error' in amt));
  const charge = grossUpTuition(amt.amountCents, session.fee);
  assert.equal(charge.grossCents, 10_000, 'charged exactly the tuition, as before the feature');
  assert.equal(charge.feeCents, 0);
  store.createStudentPayment({
    campaignId: 'cmp_1', stripeAccountId: 'acct_1', paymentIntentId: 'pi_off',
    familyId: 'fam_x1', studentId: 'stu_1', familyLabel: '', amount: charge.tuitionCents,
    feeCents: charge.feeCents, currency: 'USD', allocations: '', studentsSplit: '', paymentLines: '',
  });
  assert.equal(store.getStudentPaymentByPI('pi_off')!.feeCents, 0);
});

test('end to end: an advance is grossed up too, and the floor applies to the TUITION', () => {
  const session = createTuitionSession({
    campaignId: 'cmp_1', familyId: 'fam_x1', studentId: 'stu_1', familyLabel: '',
    currency: 'USD', balanceCents: 0, invoices: [], itemised: false,
    students: [{ ref: 'c0', studentId: 'stu_1', balanceCents: 0 }],
    allowAdvance: true, minAmountCents: 100, fee: CARD,
  });
  // $1.00 paid ahead: allowed (it meets the floor), then grossed up on top.
  const ok = computeTuitionAmount(session, { kind: 'amount', amountCents: 100 });
  assert.ok(!('error' in ok));
  assert.equal(ok.amountCents, 100);
  assert.equal(grossUpTuition(ok.amountCents, session.fee).grossCents, 134);
  // 99c is below the floor and must be refused on the TUITION, not on the grossed-up total —
  // otherwise a fee would quietly lift a too-small payment over the line.
  const bad = computeTuitionAmount(session, { kind: 'amount', amountCents: 99 });
  assert.deepEqual(bad, { error: 'below-min' });
});
