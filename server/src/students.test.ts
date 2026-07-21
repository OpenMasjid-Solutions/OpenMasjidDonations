// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the security-critical bits of the tuition (Students-billing) flow: the amount is
// ALWAYS recomputed server-side from the stored session (never the client's numbers), and a
// tampered/unknown invoice selection is rejected — so a crafted request can't pay an
// arbitrary amount or an invoice that wasn't looked up.
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
    invoices: [
      { id: 'inv_9', balanceCents: 15000 },
      { id: 'inv_10', balanceCents: 20000 },
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

test('full balance → whole balance, no allocations (Students auto-allocates)', () => {
  const s = session();
  const r = computeTuitionAmount(s, { kind: 'full' });
  assert.deepEqual(r, { amountCents: 35000, allocations: null });
});

test('full balance of zero is rejected (nothing to pay)', () => {
  const s = session({ balanceCents: 0, invoices: [] });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'full' }), { error: 'nothing-due' });
});

test('picked invoices → sum of THOSE invoices at their stored amounts + allocations', () => {
  const s = session();
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9'] });
  assert.deepEqual(r, { amountCents: 15000, allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }] });
  const both = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9', 'inv_10'] });
  assert.deepEqual(both, { amountCents: 35000, allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }, { invoiceId: 'inv_10', amountCents: 20000 }] });
});

test('duplicate invoice ids are de-duped (no double charge)', () => {
  const s = session();
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9', 'inv_9'] });
  assert.deepEqual(r, { amountCents: 15000, allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }] });
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
