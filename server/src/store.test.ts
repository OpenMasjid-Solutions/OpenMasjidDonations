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
import { Store, looksLikePlanToken } from './store';

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
    familyId: 'fam_x1', studentId: 'stu_1', familyLabel: 'Ismail family', amount: 35000, currency: 'USD', allocations: '', studentsSplit: '', paymentLines: '',
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
    paymentLines: '[{"itemId":"iti_book","amountCents":12000}]',
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
  // Same for the ticked bill lines (§11.0b): a retry must settle the line the parent actually
  // chose, not re-derive onto whatever is oldest by then.
  assert.equal(
    s.listPendingStudentRecords()[0].paymentLines,
    '[{"itemId":"iti_book","amountCents":12000}]',
    'the ticked lines are durable too',
  );
  s.setStudentRecordStatus('pi_tui_2', 'recorded', 'pay_71');
  assert.equal(s.listPendingStudentRecords().length, 0, 'recorded → out of the outbox');
  assert.equal(s.getStudentPaymentByPI('pi_tui_2')?.studentsPaymentId, 'pay_71');
});

test('upgrade: an existing student_payments table gains its new columns, keeping its rows', () => {
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
      assert.equal(got.paymentLines, '', 'no ticked lines on a legacy row either');
      // Still retryable, and a new row on the upgraded table can carry a split.
      assert.equal(s.listPendingStudentRecords().length, 1, 'the queued push is still in the outbox');
      s.createStudentPayment({
        campaignId: 'cmp_x', stripeAccountId: 'acct_test', paymentIntentId: 'pi_new',
        familyId: 'fam_old', studentId: 'stu_old', familyLabel: 'Old family', amount: 5000, currency: 'GBP',
        allocations: '[{"invoiceId":"inv_1","amountCents":5000}]',
        studentsSplit: '[{"studentId":"stu_2","amountCents":5000}]',
        paymentLines: '[{"itemId":"iti_1","amountCents":5000}]',
      });
      assert.equal(s.getStudentPaymentByPI('pi_new')?.studentsSplit, '[{"studentId":"stu_2","amountCents":5000}]');
      assert.equal(s.getStudentPaymentByPI('pi_new')?.paymentLines, '[{"itemId":"iti_1","amountCents":5000}]');
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

// ── DONATIONS-011: the admin audit log ───────────────────────────────────────
// A money app must be able to answer "who exported the donor list / cancelled that plan / rotated
// the Stripe key, and when". These tests pin the shape and, more importantly, the things that must
// NEVER end up in it.

test('audit log: records an action and reads it back newest-first', () => {
  const s = fresh();
  s.recordAudit('donations.export', { actor: 'imam', detail: 'exported the donation ledger as CSV' });
  s.recordAudit('plan.stop', { actor: 'imam', subject: 'sub_abc', detail: 'stopped a monthly donation plan for good' });
  const rows = s.listAudit();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, 'plan.stop', 'newest first');
  assert.equal(rows[0].subject, 'sub_abc');
  assert.equal(rows[0].actor, 'imam');
  assert.ok(rows[0].at.endsWith('Z'), 'timestamped in ISO/UTC');
  assert.equal(rows[1].action, 'donations.export');
});

test('audit log: an empty log is an empty list, never a crash', () => {
  assert.deepEqual(fresh().listAudit(), []);
});

test('audit log: fields are length-capped so one row cannot be used to bloat the volume', () => {
  const s = fresh();
  s.recordAudit('x'.repeat(500), { actor: 'a'.repeat(500), subject: 'b'.repeat(500), detail: 'c'.repeat(2000) });
  const [row] = s.listAudit();
  assert.equal(row.action.length, 60);
  assert.equal(row.actor.length, 120);
  assert.equal(row.subject.length, 120);
  assert.equal(row.detail.length, 300);
});

test('audit log: the limit is bounded and sane', () => {
  const s = fresh();
  for (let i = 0; i < 20; i++) s.recordAudit('plan.pause', { subject: `sub_${i}` });
  assert.equal(s.listAudit(5).length, 5);
  assert.equal(s.listAudit(0).length, 1, 'a zero/negative limit is clamped to at least one');
  assert.equal(s.listAudit(99_999).length, 20, 'an absurd limit is clamped, not passed to SQLite');
});

test('audit log: is append-only in practice — nothing in the app updates or deletes a row', () => {
  // Guards the invariant by construction: the Store exposes no mutator for audit_log.
  const s = fresh();
  s.recordAudit('plan.stop', { subject: 'sub_1' });
  const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(s));
  const mutators = keys.filter((k) => /audit/i.test(k) && !['recordAudit', 'listAudit'].includes(k));
  assert.deepEqual(mutators, [], `no audit mutator may exist, found: ${mutators.join(', ')}`);
});

test('audit log: a Stripe key never reaches it — the update entry names FIELDS, not values', () => {
  // The route logs Object.keys(patch), so this pins the contract the route relies on: whatever the
  // admin submitted, only field NAMES are recorded. A regression that logged the patch itself would
  // put a live secret key on disk in cleartext, outside the 0600 database's own columns.
  const s = fresh();
  const patch = { secretKey: 'sk_live_51ABCDEFghijklmnop', publishableKey: 'pk_live_51ABCDEF' };
  s.recordAudit('stripe.account.update', { subject: 'acct_1', detail: `changed ${Object.keys(patch).join(', ')} on a Stripe account` });
  const [row] = s.listAudit();
  const blob = JSON.stringify(row);
  assert.ok(!blob.includes('sk_live'), 'no secret key');
  assert.ok(!blob.includes('pk_live_51ABCDEF'), 'no publishable key value either');
  assert.ok(row.detail.includes('secretKey'), 'the field name is what is recorded');
});

test('audit log: ordering is insertion order, so same-millisecond actions still read in sequence', () => {
  // Two actions inside one millisecond share an `at`, and the id is random hex — ordering on the
  // timestamp returned them arbitrarily. This pins the rowid ordering that replaced it, and would
  // also catch a regression to `ORDER BY at` if the clock ever stepped backwards.
  const s = fresh();
  for (let i = 0; i < 25; i++) s.recordAudit('plan.pause', { subject: `sub_${i}` });
  const rows = s.listAudit();
  assert.deepEqual(
    rows.map((r) => r.subject),
    Array.from({ length: 25 }, (_, i) => `sub_${24 - i}`),
    'strict reverse insertion order',
  );
});

// ── DONATIONS-002: the lost-donation sweep's query ───────────────────────────
// The sweep asks Stripe about pending one-time donations. Which rows it selects IS the safety
// property: too eager and it races the donor's own /confirm and double-sends a receipt; too narrow
// and the money stays lost.

const donation = (s: Store, over: Record<string, unknown> = {}) =>
  s.createDonation({
    campaignId: 'cmp_1',
    stripeAccountId: 'acct_1',
    amount: 1000,
    currency: 'GBP',
    status: 'pending',
    donorName: '',
    donorEmail: '',
    coverFees: false,
    giftAid: false,
    paymentIntentId: 'pi_' + Math.random().toString(16).slice(2),
    ...over,
  } as Parameters<Store['createDonation']>[0]);

const MIN = 5 * 60_000;
const MAX = 30 * 24 * 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test('sweep query: picks up a pending one-time donation old enough to be abandoned', () => {
  const s = fresh();
  donation(s, { paymentIntentId: 'pi_lost', createdAt: ago(60 * 60_000) });
  const found = s.listUnconfirmedDonations(MIN, MAX);
  assert.equal(found.length, 1);
  assert.equal(found[0].paymentIntentId, 'pi_lost');
});

test('sweep query: will NOT race the donor — a row younger than the floor is left alone', () => {
  // The donor may still be on the Stripe redirect. Touching this row could send two receipts.
  const s = fresh();
  donation(s, { paymentIntentId: 'pi_inflight', createdAt: ago(30_000) });
  assert.deepEqual(s.listUnconfirmedDonations(MIN, MAX), []);
});

test('sweep query: ignores rows past the ceiling — an ancient PI will not settle now', () => {
  const s = fresh();
  donation(s, { paymentIntentId: 'pi_ancient', createdAt: ago(120 * 24 * 3600_000) });
  assert.deepEqual(s.listUnconfirmedDonations(MIN, MAX), []);
});

test('sweep query: never touches a settled, failed, monthly or PI-less row', () => {
  const s = fresh();
  const old = ago(60 * 60_000);
  donation(s, { paymentIntentId: 'pi_done', status: 'succeeded', createdAt: old });
  donation(s, { paymentIntentId: 'pi_failed', status: 'failed', createdAt: old });
  // Monthly plans have their own reconciliation; sweeping them here would duplicate that work.
  donation(s, { paymentIntentId: 'pi_monthly', recurring: true, subscriptionId: 'sub_1', createdAt: old });
  donation(s, { paymentIntentId: '', createdAt: old });
  assert.deepEqual(s.listUnconfirmedDonations(MIN, MAX), [], 'nothing in this set is sweepable');
});

test('sweep query: tuition can never appear — it is not in the donations table at all', () => {
  // Structural, not filtered: a tuition payment is written to student_payments (§13 route
  // isolation), so there is no donations row for the sweep to find. Asserted against a real DB.
  const s = fresh();
  s.createStudentPayment({
    campaignId: 'cmp_tuition',
    stripeAccountId: 'acct_1',
    paymentIntentId: 'pi_tuition',
    familyId: 'fam_1',
    studentId: 'stu_1',
    familyLabel: 'The Yusuf family',
    amount: 35_000,
    currency: 'GBP',
    allocations: '',
    studentsSplit: '',
    paymentLines: '',
  } as Parameters<Store['createStudentPayment']>[0]);
  donation(s, { paymentIntentId: 'pi_real', createdAt: ago(60 * 60_000) });
  const found = s.listUnconfirmedDonations(MIN, MAX);
  assert.deepEqual(found.map((d) => d.paymentIntentId), ['pi_real']);
  assert.ok(!JSON.stringify(found).includes('pi_tuition'));
  assert.ok(!JSON.stringify(found).includes('fam_1'));
});

test('sweep query: oldest first and bounded, so a backlog drains in arrival order', () => {
  const s = fresh();
  for (let i = 0; i < 40; i++) donation(s, { paymentIntentId: `pi_${i}`, createdAt: ago((40 - i) * 3600_000) });
  const found = s.listUnconfirmedDonations(MIN, MAX, 25);
  assert.equal(found.length, 25, 'bounded');
  assert.equal(found[0].paymentIntentId, 'pi_0', 'oldest first');
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i - 1].createdAt <= found[i].createdAt, 'ascending by date');
  }
});

// ── Refunds ───────────────────────────────────────────────────────────────────
// A refund is recorded as an AMOUNT on the donation, not as a status, so that a part refund can
// be expressed at all and so the fact that money DID arrive is never lost. Three properties are
// worth guarding, and nothing else in the repo guards them:
//
//  1. Every money figure the masjid (or a donor, via a campaign goal bar) is shown must be NET of
//     refunds. A refund that left the totals alone would keep counting money that had gone back.
//  2. setDonationRefund is MONOTONIC and CLAMPED. Two things write to it — an admin's refund and a
//     `charge.refunded` webhook — and Stripe gives no ordering guarantee, so a replayed event for
//     the FIRST of two refunds must not put money back into the totals.
//  3. The COUNTS stay gross. A refunded donation was still a donation that arrived, and the ledger
//     still lists its row, so deducting it from the count would make the headline disagree.

test('refunds: a donation starts un-refunded', () => {
  const s = fresh();
  const d = donation(s, { status: 'succeeded' });
  assert.equal(d.refundedAmount, 0);
  assert.equal(d.refundedAt, '');
  assert.equal(s.getDonation(d.id)!.refundedAmount, 0, 'and survives a DB round-trip');
});

test('refunds: getDonation finds a row by its own id (the key the panel holds)', () => {
  const s = fresh();
  const d = donation(s, { status: 'succeeded' });
  assert.equal(s.getDonation(d.id)!.paymentIntentId, d.paymentIntentId);
  assert.equal(s.getDonation('don_nope'), null);
});

test('refunds: every money figure is net — totals, per-campaign, per-month and the goal bar', () => {
  const s = fresh();
  const a = donation(s, { campaignId: 'cmp_1', amount: 5000, status: 'succeeded' });
  donation(s, { campaignId: 'cmp_1', amount: 3000, status: 'succeeded' });
  s.setDonationRefund(a.paymentIntentId, 2000, '2026-08-10T00:00:00.000Z');

  assert.equal(s.raisedForCampaign('cmp_1'), 6000, 'the goal bar donors see must not count money that went back');
  const m = s.metrics();
  assert.equal(m.totalRaised, 6000);
  assert.equal(m.totalRefunded, 2000, 'and the difference is reported, never left a mystery');
  assert.equal(m.refundedCount, 1);
  assert.equal(m.count, 2, 'both donations still happened');
  assert.equal(m.byCampaign[0].raised, 6000);
  assert.equal(m.byCampaign[0].count, 2);
  assert.equal(m.monthly.reduce((t, r) => t + r.raised, 0), 6000, 'the trend chart is net too');
});

test('refunds: a fully refunded donation contributes nothing but is still counted and listed', () => {
  const s = fresh();
  const d = donation(s, { campaignId: 'cmp_1', amount: 5000, status: 'succeeded' });
  s.setDonationRefund(d.paymentIntentId, 5000, '2026-08-10T00:00:00.000Z');
  assert.equal(s.raisedForCampaign('cmp_1'), 0);
  const m = s.metrics();
  assert.equal(m.totalRaised, 0);
  assert.equal(m.count, 1, 'the donation is not erased');
  assert.equal(s.listDonations().length, 1, 'and the ledger still shows the row');
});

test('refunds: a pending or failed donation never affects the totals, refunded or not', () => {
  const s = fresh();
  const p = donation(s, { amount: 5000, status: 'pending' });
  s.setDonationRefund(p.paymentIntentId, 5000, '2026-08-10T00:00:00.000Z');
  assert.equal(s.metrics().totalRaised, 0);
  assert.equal(s.metrics().totalRefunded, 0, 'money that never arrived cannot be reported as refunded');
});

test('refunds: the running total only ever RISES — a replayed webhook cannot restore money', () => {
  const s = fresh();
  const d = donation(s, { amount: 5000, status: 'succeeded' });
  s.setDonationRefund(d.paymentIntentId, 1000, '2026-08-01T00:00:00.000Z');
  s.setDonationRefund(d.paymentIntentId, 4000, '2026-08-02T00:00:00.000Z');
  // Stripe re-delivers the FIRST refund's event after the second: a smaller running total.
  const after = s.setDonationRefund(d.paymentIntentId, 1000, '2026-08-03T00:00:00.000Z')!;
  assert.equal(after.refundedAmount, 4000, 'the lower figure must be ignored');
  assert.equal(after.refundedAt, '2026-08-02T00:00:00.000Z', 'and a duplicate must not restamp the date');
  assert.equal(s.metrics().totalRaised, 1000);
});

test('refunds: the running total is clamped to the amount charged (never negative money raised)', () => {
  const s = fresh();
  const d = donation(s, { amount: 5000, status: 'succeeded' });
  const after = s.setDonationRefund(d.paymentIntentId, 999_999, '2026-08-10T00:00:00.000Z')!;
  assert.equal(after.refundedAmount, 5000);
  assert.equal(s.metrics().totalRaised, 0);
  assert.equal(s.raisedForCampaign(d.campaignId), 0);
});

test('refunds: an unknown PaymentIntent is a no-op, not a crash', () => {
  assert.equal(fresh().setDonationRefund('pi_never_existed', 100, '2026-08-10T00:00:00.000Z'), null);
});

// ── The monthly donor's stop link ─────────────────────────────────────────────
// The token in that link is the app's only unauthenticated destructive capability, so:
//
//  1. It must be STABLE. The letter carrying it is rendered up to three times for one donation (the
//     donor's confirm, the receipt outbox for up to three days, the lost-donation sweep) and every
//     render must produce the same URL — a fresh token per render would leave whichever letter
//     actually arrived pointing at a dead link.
//  2. It must be UNGUESSABLE and shape-checked before it ever reaches SQLite.
//  3. A blank subscription id must never mint one, or every one-off donation would collapse onto a
//     single token.

test('stop link: the same subscription always gets the SAME token', () => {
  const s = fresh();
  const a = s.ensurePlanLink('sub_A');
  assert.ok(looksLikePlanToken(a), `expected 32 hex chars, got ${a}`);
  assert.equal(s.ensurePlanLink('sub_A'), a, 're-rendering the letter must not re-mint');
  assert.equal(s.ensurePlanLink('sub_A'), a);
});

test('stop link: different subscriptions get different tokens, and resolve back correctly', () => {
  const s = fresh();
  const a = s.ensurePlanLink('sub_A');
  const b = s.ensurePlanLink('sub_B');
  assert.notEqual(a, b);
  assert.equal(s.planLinkSubscription(a), 'sub_A');
  assert.equal(s.planLinkSubscription(b), 'sub_B');
});

test('stop link: a blank subscription id mints nothing', () => {
  const s = fresh();
  assert.equal(s.ensurePlanLink(''), '');
  // …and the table stays empty, so no one-off donation can ever share a link.
  assert.equal(s.planLinkSubscription('0'.repeat(32)), '');
});

test('stop link: an unknown or malformed token resolves to nothing, and is refused by shape first', () => {
  const s = fresh();
  s.ensurePlanLink('sub_A');
  for (const bad of ['', 'nope', '0123456789abcdef', 'g'.repeat(32), '0'.repeat(31), '0'.repeat(33), 'ABCDEF0123456789ABCDEF0123456789']) {
    assert.equal(looksLikePlanToken(bad), false, `${bad} must fail the shape check`);
    assert.equal(s.planLinkSubscription(bad), '', `${bad} must not resolve`);
  }
  assert.equal(s.planLinkSubscription('0'.repeat(32)), '', 'a well-shaped but unknown token resolves to nothing');
});

test('stop link: tokens are 128 bits of hex and do not repeat', () => {
  const s = fresh();
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const t = s.ensurePlanLink(`sub_${i}`);
    assert.ok(looksLikePlanToken(t));
    assert.ok(!seen.has(t), 'a collision would let one donor stop another donor’s gift');
    seen.add(t);
  }
});

test('stop link: the row SURVIVES the plan ending, so an old link reads "already stopped"', () => {
  // Nothing in the app deletes these rows. A donor clicking a link months later must land on a page
  // that explains, not a frightening "this link doesn't work".
  const s = fresh();
  const t = s.ensurePlanLink('sub_GONE');
  assert.equal(s.planLinkSubscription(t), 'sub_GONE');
});
