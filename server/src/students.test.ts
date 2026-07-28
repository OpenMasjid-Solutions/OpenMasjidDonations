// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the security-critical bits of the tuition (Students-billing) flow: the amount is
// ALWAYS recomputed server-side from the stored session (never the client's numbers), and a
// tampered/unknown invoice selection is rejected — so a crafted request can't pay an
// arbitrary amount or an invoice that wasn't looked up.
//
// Also locks the per-CHILD split (students/billing v2). That split is not cosmetic: Students
// books a charge as one ledger row per child, and it takes those rows from `students[]` or
// else derives them by walking the FAMILY's open invoices oldest-due-first — a path that
// ignores `allocations`. Get the split wrong and a parent who ticked one child's month has the
// money land on a sibling's bill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTuitionSession, getTuitionSession, computeTuitionAmount, type TuitionSession } from './students';

function session(over: Partial<TuitionSession> = {}): TuitionSession {
  return createTuitionSession({
    campaignId: 'cmp_x',
    familyId: 'fam_x1',
    studentId: 'stu_1',
    familyLabel: 'Ismail family',
    currency: 'USD',
    balanceCents: 35000,
    // Two children, one open month each: inv_9 is Maryam's (stu_2), inv_10 is Yusuf's (stu_1,
    // the child whose ID was typed). Picking Maryam's month must credit MARYAM.
    invoices: [
      { id: 'inv_9', studentId: 'stu_2', balanceCents: 15000 },
      { id: 'inv_10', studentId: 'stu_1', balanceCents: 20000 },
    ],
    ...over,
  });
}

test('createTuitionSession returns an opaque id resolvable via getTuitionSession', () => {
  const s = session();
  assert.equal(typeof s.id, 'string');
  assert.ok(s.id.length >= 24, 'session id has real entropy');
  assert.equal(getTuitionSession(s.id)?.familyId, 'fam_x1');
  assert.equal(getTuitionSession('nope-not-a-session'), null);
});

test('full balance → whole balance, no splits (Students derives the same answer)', () => {
  const s = session();
  const r = computeTuitionAmount(s, { kind: 'full' });
  // No per-child split on purpose: paying everything covers every open invoice, so the split
  // Students derives is identical — and it's the one its reconciliation would reproduce.
  assert.deepEqual(r, { amountCents: 35000, allocations: null, students: null });
});

test('full balance of zero is rejected (nothing to pay)', () => {
  const s = session({ balanceCents: 0, invoices: [] });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'full' }), { error: 'nothing-due' });
});

test('picked invoices → sum of THOSE invoices + allocations + the per-child split', () => {
  const s = session();
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9'] });
  assert.deepEqual(r, {
    amountCents: 15000,
    allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }],
    // inv_9 is Maryam's month, so the money must be booked against stu_2 — NOT stu_1, the
    // matched child, and not whoever happens to own the family's oldest bill.
    students: [{ studentId: 'stu_2', amountCents: 15000 }],
  });
  const both = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9', 'inv_10'] });
  assert.deepEqual(both, {
    amountCents: 35000,
    allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }, { invoiceId: 'inv_10', amountCents: 20000 }],
    students: [{ studentId: 'stu_2', amountCents: 15000 }, { studentId: 'stu_1', amountCents: 20000 }],
  });
});

test('several months for the SAME child collapse into one split entry that sums', () => {
  const s = session({
    balanceCents: 45000,
    invoices: [
      { id: 'inv_jul', studentId: 'stu_1', balanceCents: 15000 },
      { id: 'inv_aug', studentId: 'stu_1', balanceCents: 20000 },
      { id: 'inv_sep', studentId: 'stu_2', balanceCents: 10000 },
    ],
  });
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_jul', 'inv_aug', 'inv_sep'] });
  assert.equal('amountCents' in r && r.amountCents, 45000);
  assert.deepEqual('students' in r ? r.students : null, [
    { studentId: 'stu_1', amountCents: 35000 },
    { studentId: 'stu_2', amountCents: 10000 },
  ]);
  // Students rejects (422) any split that doesn't hit amountCents to the penny.
  const total = ('students' in r ? r.students : [])?.reduce((sum, x) => sum + x.amountCents, 0);
  assert.equal(total, 'amountCents' in r ? r.amountCents : -1, 'the split must sum EXACTLY to the charge');
});

test('an invoice with no child yields NO split (degrade to derivation, never a 422)', () => {
  const s = session({ invoices: [{ id: 'inv_x', studentId: '', balanceCents: 5000 }], balanceCents: 5000 });
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_x'] });
  assert.deepEqual(r, { amountCents: 5000, allocations: [{ invoiceId: 'inv_x', amountCents: 5000 }], students: null });
});

test('duplicate invoice ids are de-duped (no double charge, no doubled split)', () => {
  const s = session();
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9', 'inv_9'] });
  assert.deepEqual(r, {
    amountCents: 15000,
    allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }],
    students: [{ studentId: 'stu_2', amountCents: 15000 }],
  });
});

test('an invoice id NOT in the session is rejected (no arbitrary/tampered target)', () => {
  const s = session();
  assert.deepEqual(computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_EVIL'] }), { error: 'unknown-invoice' });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9', 'inv_EVIL'] }), { error: 'unknown-invoice' });
});

test('empty invoice selection is rejected', () => {
  assert.deepEqual(computeTuitionAmount(session(), { kind: 'invoices', invoiceIds: [] }), { error: 'no-selection' });
});

test('the amount comes ONLY from the session — a client cannot inflate it', () => {
  // There is no path for a client amount to enter computeTuitionAmount: the selection carries
  // only invoice ids. This asserts the API surface stays that way (a regression guard).
  const s = session();
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_10'] });
  assert.equal('amountCents' in r && r.amountCents, 20000, 'amount is the stored invoice balance, not any client value');
});
