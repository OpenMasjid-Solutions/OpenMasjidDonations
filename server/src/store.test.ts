// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the campaign type→fee derivation and the large-donation validation, so the
// enforcement rules (Zakat always covers the fee; the qrImage allowlist) can't regress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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
    familyId: 'fam_x1', studentId: 'stu_1', familyLabel: 'Ismail family', amount: 35000, currency: 'USD', allocations: '', studentsSplit: '',
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
    familyId: 'fam_y', studentId: '', familyLabel: 'Y family', amount: 12000, currency: 'GBP',
    allocations: '[{"invoiceId":"inv_9","amountCents":12000}]',
    studentsSplit: '[{"studentId":"stu_2","amountCents":12000}]',
  });
  assert.equal(s.listPendingStudentRecords().length, 0, 'not succeeded yet → not in the outbox');
  s.markStudentPaymentPaid('pi_tui_2', 'succeeded', new Date().toISOString());
  assert.equal(s.listPendingStudentRecords().length, 1, 'succeeded + pending → in the outbox');
  // The per-child split survives to the retry, so an outbox push books the payment against the
  // same child the first attempt would have (never re-derived onto a sibling's oldest bill).
  assert.equal(
    s.listPendingStudentRecords()[0].studentsSplit,
    '[{"studentId":"stu_2","amountCents":12000}]',
    'the split is durable, not recomputed at retry time',
  );
  s.setStudentRecordStatus('pi_tui_2', 'recorded', 'pay_71');
  assert.equal(s.listPendingStudentRecords().length, 0, 'recorded → out of the outbox');
  assert.equal(s.getStudentPaymentByPI('pi_tui_2')?.studentsPaymentId, 'pay_71');
});

test('upgrade: an existing student_payments table gains students_split, keeping its rows', () => {
  // The real upgrade an installed masjid hits. CREATE TABLE IF NOT EXISTS won't touch a table
  // that already exists, so the column has to arrive via ensureColumn — and a tuition payment
  // already queued in the outbox has to survive and stay pushable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-upgrade-'));
  const dbPath = path.join(dir, 'donations.db');
  try {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE student_payments (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        stripe_account_id TEXT NOT NULL,
        payment_intent_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        student_id TEXT NOT NULL DEFAULT '',
        family_label TEXT NOT NULL DEFAULT '',
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        allocations TEXT NOT NULL DEFAULT '',
        pay_status TEXT NOT NULL DEFAULT 'pending',
        record_status TEXT NOT NULL DEFAULT 'pending',
        students_payment_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        occurred_at TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO student_payments (id, campaign_id, stripe_account_id, payment_intent_id, family_id,
        student_id, family_label, amount, currency, allocations, pay_status, record_status,
        students_payment_id, created_at, occurred_at)
      VALUES ('spy_old', 'cmp_x', 'acct_test', 'pi_old', 'fam_old', 'stu_old', 'Old family',
        9900, 'GBP', '', 'succeeded', 'pending', '', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    `);
    legacy.close();

    const s = new Store(dbPath);
    try {
      const got = s.getStudentPaymentByPI('pi_old');
      assert.ok(got, 'the legacy row survives the migration');
      assert.equal(got.amount, 9900);
      assert.equal(got.familyId, 'fam_old');
      assert.equal(got.studentsSplit, '', 'no split on a legacy row → Students derives it, as it always did');
      // Still retryable, and a new row on the upgraded table can carry a split.
      assert.equal(s.listPendingStudentRecords().length, 1, 'the queued push is still in the outbox');
      s.createStudentPayment({
        campaignId: 'cmp_x', stripeAccountId: 'acct_test', paymentIntentId: 'pi_new',
        familyId: 'fam_old', studentId: 'stu_old', familyLabel: 'Old family', amount: 5000, currency: 'GBP',
        allocations: '[{"invoiceId":"inv_1","amountCents":5000}]',
        studentsSplit: '[{"studentId":"stu_2","amountCents":5000}]',
      });
      assert.equal(s.getStudentPaymentByPI('pi_new')?.studentsSplit, '[{"studentId":"stu_2","amountCents":5000}]');
    } finally {
      s.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('email receipt: defaults off; caps text; allowlists accent', () => {
  const s = fresh();
  assert.equal(s.getEmailReceipt().enabled, false, 'off by default — nothing emails until the admin opts in');
  const r = s.setEmailReceipt({ enabled: true, accent: 'red; }x{', subject: 'x'.repeat(300), body: 'y'.repeat(5000) });
  assert.equal(r.enabled, true);
  assert.equal(r.accent, '', 'invalid accent rejected (no CSS injection)');
  assert.equal(r.subject.length, 200, 'subject capped');
  assert.equal(r.body.length, 4000, 'body capped');
  assert.equal(s.setEmailReceipt({ accent: '#D4AF37' }).accent, '#D4AF37', 'valid hex accepted');
  assert.equal(s.getEmailReceipt().enabled, true, 'persists across reads');
});

test('receipt outbox: only succeeded + pending + in-window donations are retried', () => {
  const s = fresh();
  const camp = mk(s, { title: 'Gen' });
  const base = { campaignId: camp.id, stripeAccountId: 'acct_test', currency: 'USD', donorName: 'A', donorEmail: 'a@b.co', coverFees: false, giftAid: false };
  s.createDonation({ ...base, amount: 1000, status: 'succeeded', paymentIntentId: 'pi_r1', receipt: 'pending' }); // owed
  s.createDonation({ ...base, amount: 2000, status: 'succeeded', paymentIntentId: 'pi_r2', receipt: 'stripe' }); // Stripe sent it → never owed
  s.createDonation({ ...base, amount: 3000, status: 'pending', paymentIntentId: 'pi_r3', receipt: 'pending' }); // not succeeded yet
  const win = 3 * 24 * 3600 * 1000;
  assert.deepEqual(s.listPendingReceipts(win).map((d) => d.paymentIntentId), ['pi_r1'], 'only the succeeded+pending one');
  s.setDonationReceipt('pi_r1', 'sent');
  assert.equal(s.listPendingReceipts(win).length, 0, 'a sent receipt drops out of the outbox');
  // An ancient owed receipt is not chased forever.
  s.createDonation({ ...base, amount: 4000, status: 'succeeded', paymentIntentId: 'pi_old', receipt: 'pending' });
  (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db
    .prepare("UPDATE donations SET created_at='2000-01-01T00:00:00.000Z' WHERE payment_intent_id='pi_old'")
    .run();
  assert.ok(!s.listPendingReceipts(win).some((d) => d.paymentIntentId === 'pi_old'), 'donations older than the window are excluded');
  // A recorded receipt state survives a round-trip.
  assert.equal(s.getDonationByPaymentIntent('pi_r2')!.receipt, 'stripe');
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
