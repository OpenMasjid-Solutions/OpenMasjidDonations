// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the campaign type→fee derivation and the large-donation validation, so the
// enforcement rules (Zakat always covers the fee; the qrImage allowlist) can't regress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store';

function fresh(): Store {
  return new Store(':memory:');
}
const mk = (s: Store, over: Record<string, unknown> = {}) =>
  s.createCampaign({ title: 'Test', stripeAccountId: 'acct_test', ...over });

test('campaign type defaults to donation, fee not forced', () => {
  const c = mk(fresh());
  assert.equal(c.type, 'donation');
  assert.equal(c.forceCoverFees, false);
});

test('zakat forces cover-fees (and implies coverFees), ignoring the body flags', () => {
  const s = fresh();
  const c = mk(s, { type: 'zakat', coverFees: false, forceCoverFees: false });
  assert.equal(c.type, 'zakat');
  assert.equal(c.forceCoverFees, true, 'zakat must force the fee');
  assert.equal(c.coverFees, true, 'forcing implies offering');
  const got = s.getCampaign(c.id)!; // survives a DB round-trip
  assert.equal(got.forceCoverFees, true);
  assert.equal(got.coverFees, true);
});

test('donation never forces the fee, even if the body sets forceCoverFees', () => {
  const c = mk(fresh(), { type: 'donation', forceCoverFees: true });
  assert.equal(c.forceCoverFees, false);
});

test('tuition is a Students-billing shell — NEVER has a card-fee, whatever the body sends', () => {
  const s = fresh();
  // Tuition is now a Students-billing shell (exact school balance, no gross-up). Any
  // coverFees/forceCoverFees in a crafted body must be forced off — a fee would overpay
  // an invoice and break Students' allocation.
  const on = mk(s, { type: 'tuition', forceCoverFees: true, coverFees: true });
  assert.equal(on.forceCoverFees, false, 'tuition never forces a fee');
  assert.equal(on.coverFees, false, 'tuition never offers a fee');
  const off = mk(s, { title: 'Test 2', type: 'tuition', forceCoverFees: false, coverFees: true });
  assert.equal(off.forceCoverFees, false);
  assert.equal(off.coverFees, false);
});

test('updateCampaign re-derives fees when the type changes', () => {
  const s = fresh();
  const c = mk(s, { type: 'donation' });
  assert.equal(s.updateCampaign(c.id, { type: 'zakat' })!.forceCoverFees, true);
  assert.equal(s.updateCampaign(c.id, { type: 'donation' })!.forceCoverFees, false);
});

test('a legacy row with an empty/invalid type reads back as donation', () => {
  const s = fresh();
  const c = mk(s);
  (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db
    .prepare("UPDATE campaigns SET type='' WHERE id=?")
    .run(c.id);
  assert.equal(s.getCampaign(c.id)!.type, 'donation');
});

test('tuition (Students-billing) payments are EXCLUDED from every donation total/log', () => {
  const s = fresh();
  const camp = mk(s, { type: 'tuition' });
  // A real donation on some campaign (counts).
  const don = mk(s, { title: 'General' });
  s.createDonation({
    campaignId: don.id, stripeAccountId: 'acct_test', amount: 5000, currency: 'USD',
    status: 'succeeded', donorName: 'A', donorEmail: '', coverFees: false, giftAid: false, paymentIntentId: 'pi_don_1',
  });
  // A tuition payment (must NOT count as a donation anywhere).
  s.createStudentPayment({
    campaignId: camp.id, stripeAccountId: 'acct_test', paymentIntentId: 'pi_tui_1',
    familyId: 'fam_x1', studentId: 'stu_1', familyLabel: 'Ismail family', amount: 35000, currency: 'USD', allocations: '',
  });
  s.markStudentPaymentPaid('pi_tui_1', 'succeeded', new Date().toISOString());
  const m = s.metrics();
  assert.equal(m.totalRaised, 5000, 'tuition payment is not in the donation total');
  assert.equal(m.count, 1, 'tuition payment is not counted as a donation');
  assert.equal(s.listDonations().length, 1, 'tuition payment is not in the donations log');
  assert.equal(s.raisedForCampaign(camp.id), 0, 'the tuition campaign raised nothing as a "donation"');
  // But the tuition payment IS tracked in its own ledger for the record/outbox flow.
  assert.equal(s.getStudentPaymentByPI('pi_tui_1')?.amount, 35000);
});

test('student payment record flow: outbox lists only pending-succeeded; status is idempotent', () => {
  const s = fresh();
  s.createStudentPayment({
    campaignId: 'cmp_x', stripeAccountId: 'acct_test', paymentIntentId: 'pi_tui_2',
    familyId: 'fam_y', studentId: '', familyLabel: 'Y family', amount: 12000, currency: 'GBP', allocations: '[{"invoiceId":"inv_9","amountCents":12000}]',
  });
  assert.equal(s.listPendingStudentRecords().length, 0, 'not succeeded yet → not in the outbox');
  s.markStudentPaymentPaid('pi_tui_2', 'succeeded', new Date().toISOString());
  assert.equal(s.listPendingStudentRecords().length, 1, 'succeeded + pending → in the outbox');
  s.setStudentRecordStatus('pi_tui_2', 'recorded', 'pay_71');
  assert.equal(s.listPendingStudentRecords().length, 0, 'recorded → out of the outbox');
  assert.equal(s.getStudentPaymentByPI('pi_tui_2')?.studentsPaymentId, 'pay_71');
});

test('large-donation clamps the threshold, caps the message, and allowlists qrImage', () => {
  const s = fresh();
  const ld = s.setLargeDonation({ threshold: -50, message: 'x'.repeat(700), qrImage: 'javascript:alert(1)' });
  assert.equal(ld.threshold, 0, 'negative threshold clamps to 0');
  assert.equal(ld.message.length, 600, 'message capped at 600');
  assert.equal(ld.qrImage, '', 'javascript: rejected');
  assert.equal(s.setLargeDonation({ qrImage: 'data:image/png;base64,AAAA' }).qrImage, '', 'data: rejected');
  assert.equal(s.setLargeDonation({ qrImage: '/uploads/qr_1.png' }).qrImage, '/uploads/qr_1.png', 'uploads accepted');
  assert.equal(s.setLargeDonation({ threshold: 25000, qrImage: 'https://ex.org/qr.png' }).qrImage, 'https://ex.org/qr.png', 'https accepted');
  assert.equal(s.getLargeDonation().threshold, 25000);
});
