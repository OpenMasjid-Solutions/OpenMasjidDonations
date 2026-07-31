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
      { id: 'inv_9', studentId: 'stu_2', balanceCents: 15000, items: [] },
      { id: 'inv_10', studentId: 'stu_1', balanceCents: 20000, items: [] },
    ],
    // The two children, each with the opaque ref the browser uses to say who an advance is for.
    students: [
      { ref: 'c0', studentId: 'stu_1', balanceCents: 20000 },
      { ref: 'c1', studentId: 'stu_2', balanceCents: 15000 },
    ],
    itemised: false,
    allowAdvance: true,
    minAmountCents: 100, // the school's advertised floor ($1)
    ...over,
  });
}

/** The bill the brief calls out: February = $200 monthly tuition + $50 book fee, with a $30
 *  bursary already deducted and last month's book fee settled. `items[].balanceCents` sums to
 *  the invoice balance (25000), and the two zero-balance lines are unpayable. */
function itemisedSession(over: Partial<TuitionSession> = {}): TuitionSession {
  return createTuitionSession({
    campaignId: 'cmp_x',
    familyId: 'fam_x1',
    studentId: 'stu_1',
    familyLabel: 'Ismail family',
    currency: 'USD',
    balanceCents: 25000,
    invoices: [
      {
        id: 'inv_feb',
        studentId: 'stu_1',
        balanceCents: 25000,
        items: [
          { id: 'iti_tuition', balanceCents: 20000 },
          { id: 'iti_book', balanceCents: 5000 },
          { id: 'iti_bursary', balanceCents: 0 }, // a credit line — value already deducted above
          { id: 'iti_settled', balanceCents: 0 }, // an earlier line, already paid
        ],
      },
    ],
    students: [{ ref: 'c0', studentId: 'stu_1', balanceCents: 25000 }], // an only child
    itemised: true,
    allowAdvance: true,
    minAmountCents: 100,
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
  assert.deepEqual(r, { amountCents: 35000, allocations: null, students: null, lines: null, targetStudentId: null });
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
    lines: null,
    targetStudentId: null,
  });
  const both = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9', 'inv_10'] });
  assert.deepEqual(both, {
    amountCents: 35000,
    allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }, { invoiceId: 'inv_10', amountCents: 20000 }],
    students: [{ studentId: 'stu_2', amountCents: 15000 }, { studentId: 'stu_1', amountCents: 20000 }],
    lines: null,
    targetStudentId: null,
  });
});

test('several months for the SAME child collapse into one split entry that sums', () => {
  const s = session({
    balanceCents: 45000,
    invoices: [
      { id: 'inv_jul', studentId: 'stu_1', balanceCents: 15000, items: [] },
      { id: 'inv_aug', studentId: 'stu_1', balanceCents: 20000, items: [] },
      { id: 'inv_sep', studentId: 'stu_2', balanceCents: 10000, items: [] },
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
  const s = session({ invoices: [{ id: 'inv_x', studentId: '', balanceCents: 5000, items: [] }], balanceCents: 5000 });
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_x'] });
  assert.deepEqual(r, { amountCents: 5000, allocations: [{ invoiceId: 'inv_x', amountCents: 5000 }], students: null, lines: null, targetStudentId: null });
});

test('duplicate invoice ids are de-duped (no double charge, no doubled split)', () => {
  const s = session();
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9', 'inv_9'] });
  assert.deepEqual(r, {
    amountCents: 15000,
    allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }],
    students: [{ studentId: 'stu_2', amountCents: 15000 }],
    lines: null,
    targetStudentId: null,
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

// ── Itemised bills — paying one LINE of a bill (§11.0b, Students 0.43.0) ────
test('one line of a bill: the book fee alone, priced from the session', () => {
  const s = itemisedSession();
  const r = computeTuitionAmount(s, { kind: 'items', itemIds: ['iti_book'] });
  assert.deepEqual(r, {
    amountCents: 5000,
    // `lines` alone goes on the wire: it supersedes students[] (each line resolves to its own
    // child) and is what makes the ticked line the line that ends up settled.
    allocations: null,
    students: null,
    lines: [{ itemId: 'iti_book', amountCents: 5000 }],
    targetStudentId: null,
  });
});

test('several lines: they sum to the charge exactly (or Students 422s)', () => {
  const s = itemisedSession();
  const r = computeTuitionAmount(s, { kind: 'items', itemIds: ['iti_tuition', 'iti_book'] });
  assert.equal('amountCents' in r && r.amountCents, 25000, 'the whole February bill');
  const lines = 'lines' in r ? r.lines : null;
  assert.deepEqual(lines, [
    { itemId: 'iti_tuition', amountCents: 20000 },
    { itemId: 'iti_book', amountCents: 5000 },
  ]);
  assert.equal(lines?.reduce((sum, l) => sum + l.amountCents, 0), 'amountCents' in r ? r.amountCents : -1);
});

test('a credit line and a settled line are NOT payable, even if a request names one', () => {
  const s = itemisedSession();
  // The browser is never offered these; a crafted request naming one is refused rather than
  // silently dropped, which would charge less than the parent was shown.
  assert.deepEqual(computeTuitionAmount(s, { kind: 'items', itemIds: ['iti_bursary'] }), { error: 'unknown-item' });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'items', itemIds: ['iti_settled'] }), { error: 'unknown-item' });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'items', itemIds: ['iti_book', 'iti_bursary'] }), { error: 'unknown-item' });
});

test('a line id from outside the session is refused (the household wall, our side)', () => {
  const s = itemisedSession();
  assert.deepEqual(computeTuitionAmount(s, { kind: 'items', itemIds: ['iti_SOMEONE_ELSE'] }), { error: 'unknown-item' });
});

test('duplicate line ids are de-duped (no double charge)', () => {
  const s = itemisedSession();
  const r = computeTuitionAmount(s, { kind: 'items', itemIds: ['iti_book', 'iti_book'] });
  assert.deepEqual(r, { amountCents: 5000, allocations: null, students: null, lines: [{ itemId: 'iti_book', amountCents: 5000 }], targetStudentId: null });
});

test('an empty line selection is refused', () => {
  assert.deepEqual(computeTuitionAmount(itemisedSession(), { kind: 'items', itemIds: [] }), { error: 'no-selection' });
});

test('a line selection against a NON-itemised family is refused, not guessed at', () => {
  // The provider honours lines OR allocations, never a mixture, so we only accept a line
  // selection when we advertised that every bill was itemised.
  assert.deepEqual(computeTuitionAmount(session(), { kind: 'items', itemIds: ['iti_book'] }), { error: 'not-itemised' });
});

test('the floor applies to a single ticked line too', () => {
  const s = itemisedSession({
    balanceCents: 60,
    invoices: [{ id: 'inv_x', studentId: 'stu_1', balanceCents: 60, items: [{ id: 'iti_tiny', balanceCents: 60 }] }],
  });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'items', itemIds: ['iti_tiny'] }), { error: 'below-min' });
});

test('a SINGLE-line bill still pays as one thing — whole-bill and line paths agree', () => {
  // The common case the brief calls out: no itemised UI needed, and both routes charge the same.
  const s = itemisedSession({
    balanceCents: 20000,
    invoices: [{ id: 'inv_mar', studentId: 'stu_1', balanceCents: 20000, items: [{ id: 'iti_only', balanceCents: 20000 }] }],
  });
  const viaLine = computeTuitionAmount(s, { kind: 'items', itemIds: ['iti_only'] });
  const viaFull = computeTuitionAmount(s, { kind: 'full' });
  assert.equal('amountCents' in viaLine && viaLine.amountCents, 20000);
  assert.equal('amountCents' in viaFull && viaFull.amountCents, 20000);
  // The line route names the line; the full route lets Students allocate oldest-due-first.
  assert.deepEqual('lines' in viaLine ? viaLine.lines : null, [{ itemId: 'iti_only', amountCents: 20000 }]);
  assert.equal('lines' in viaFull ? viaFull.lines : 'missing', null);
});

test('the whole-balance and advance paths never send lines', () => {
  const s = itemisedSession();
  assert.equal('lines' in computeTuitionAmount(s, { kind: 'full' }) ? (computeTuitionAmount(s, { kind: 'full' }) as { lines: unknown }).lines : 'missing', null);
  const adv = computeTuitionAmount(s, { kind: 'amount', amountCents: 50000 });
  assert.equal('lines' in adv ? adv.lines : 'missing', null);
});

// ── Advance / part payments + the floor (§11.0a, Students 0.41.0) ───────────
test('an advance payment is allowed with NOTHING due (that is the point)', () => {
  const s = session({ balanceCents: 0, invoices: [] });
  // "full" has nothing to charge, but a typed amount must still go through: money beyond the
  // open invoices becomes the child's credit, which their next invoice absorbs.
  assert.deepEqual(computeTuitionAmount(s, { kind: 'full' }), { error: 'nothing-due' });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 50000 }), {
    amountCents: 50000,
    allocations: null,
    // No split: Students covers any open invoices oldest-first and parks the rest as the
    // matched child's credit — the child whose ID the parent typed.
    students: null,
    lines: null,
    targetStudentId: null,
  });
});

test('an advance names WHICH child, and lands on that child even if a sibling owes older', () => {
  // The whole point of per-child "add money": stu_2 (Maryam) owns the family's older bill, so a
  // derived split would send Yusuf's money there. Naming him keeps it on his account.
  const s = session();
  const r = computeTuitionAmount(s, { kind: 'amount', amountCents: 5000, studentRef: 'c0' });
  assert.deepEqual(r, {
    amountCents: 5000,
    allocations: null,
    students: [{ studentId: 'stu_1', amountCents: 5000 }],
    lines: null,
    targetStudentId: 'stu_1',
  });
  // …and the sibling can be named just as well.
  const forSibling = computeTuitionAmount(s, { kind: 'amount', amountCents: 5000, studentRef: 'c1' });
  assert.deepEqual('students' in forSibling ? forSibling.students : null, [{ studentId: 'stu_2', amountCents: 5000 }]);
  assert.equal('targetStudentId' in forSibling ? forSibling.targetStudentId : '', 'stu_2');
});

test('an advance for an only child needs no ref — there is one answer', () => {
  const s = itemisedSession(); // a single child, stu_1
  const r = computeTuitionAmount(s, { kind: 'amount', amountCents: 5000 });
  assert.equal('targetStudentId' in r ? r.targetStudentId : '', 'stu_1');
  assert.deepEqual('students' in r ? r.students : null, [{ studentId: 'stu_1', amountCents: 5000 }]);
});

test('a studentRef from outside the session is refused (the household wall, our side)', () => {
  const s = session();
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 5000, studentRef: 'c99' }), { error: 'unknown-student' });
  // A browser never holds a studentId, so naming one directly can't work either.
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 5000, studentRef: 'stu_1' }), { error: 'unknown-student' });
});

test('with several children and NO ref, Students derives the split (surplus → matched child)', () => {
  const s = session();
  const r = computeTuitionAmount(s, { kind: 'amount', amountCents: 5000 });
  assert.equal('students' in r ? r.students : 'x', null);
  assert.equal('targetStudentId' in r ? r.targetStudentId : 'x', null);
});

test('a per-child advance still honours the floor and the ceiling', () => {
  const s = session();
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 99, studentRef: 'c0' }), { error: 'below-min' });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 100_000_000, studentRef: 'c0' }), { error: 'too-large' });
});

test('an advance payment on TOP of a balance is allowed (overpaying builds credit)', () => {
  const s = session();
  const r = computeTuitionAmount(s, { kind: 'amount', amountCents: 100000 }); // > the 35000 owed
  assert.deepEqual(r, { amountCents: 100000, allocations: null, students: null, lines: null, targetStudentId: null });
});

test('the floor is enforced on a typed amount, and quoted from the SESSION not the client', () => {
  const s = session({ minAmountCents: 100 });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 99 }), { error: 'below-min' });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 100 }), { amountCents: 100, allocations: null, students: null, lines: null, targetStudentId: null });
  // A school advertising a higher floor is honoured too.
  const strict = session({ minAmountCents: 500 });
  assert.deepEqual(computeTuitionAmount(strict, { kind: 'amount', amountCents: 400 }), { error: 'below-min' });
});

test('the floor also covers invoice-derived charges (one floor on every surface)', () => {
  // MIN_PAYMENT_CENTS is "the smallest card payment a parent may start, wherever they start
  // it" — so a 60¢ month can't be taken here either, exactly as the school's own portal.
  const s = session({ balanceCents: 60, invoices: [{ id: 'inv_tiny', studentId: 'stu_1', balanceCents: 60, items: [] }] });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_tiny'] }), { error: 'below-min' });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'full' }), { error: 'below-min' });
});

test('without allowAdvance a PART payment is still fine — only money ABOVE the balance is refused', () => {
  // Paying part of a real balance isn't paying ahead, it's settling what's already owed, so it
  // needs no permission. Only the excess does.
  const s = session({ allowAdvance: false }); // balance 35000
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 5000 }), { amountCents: 5000, allocations: null, students: null, lines: null, targetStudentId: null });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 35000 }), { amountCents: 35000, allocations: null, students: null, lines: null, targetStudentId: null });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 35001 }), { error: 'advance-not-allowed' });
  // With nothing due, EVERY amount is an advance — so all of them need the permission.
  const square = session({ allowAdvance: false, balanceCents: 0, invoices: [] });
  assert.deepEqual(computeTuitionAmount(square, { kind: 'amount', amountCents: 5000 }), { error: 'advance-not-allowed' });
  // …and the normal paths still work.
  assert.equal('amountCents' in computeTuitionAmount(s, { kind: 'full' }), true);
});

test('a school advertising a floor UNDER a pound/dollar cannot drag ours below it', () => {
  // The floor is the stricter of theirs and ours: no sub-$1 card charge, whatever `info` says.
  const s = session({ minAmountCents: 50 });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 50 }), { error: 'below-min' });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 99 }), { error: 'below-min' });
  assert.equal('amountCents' in computeTuitionAmount(s, { kind: 'amount', amountCents: 100 }), true);
});

test('a typed amount must be a positive whole number of minor units, and is capped', () => {
  const s = session();
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 0 }), { error: 'bad-amount' });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: -5000 }), { error: 'bad-amount' });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 12.5 }), { error: 'bad-amount' });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 100_000_000 }), { error: 'too-large' });
});

test('a session with no advertised floor still gets one (never a penny charge)', () => {
  const s = session({ minAmountCents: 0 }); // an un-upgraded Students advertised nothing
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 50 }), { error: 'below-min' });
  assert.equal('amountCents' in computeTuitionAmount(s, { kind: 'amount', amountCents: 100 }), true);
});

test('the amount comes ONLY from the session — a client cannot inflate it', () => {
  // There is no path for a client amount to enter computeTuitionAmount: the selection carries
  // only invoice ids. This asserts the API surface stays that way (a regression guard).
  const s = session();
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_10'] });
  assert.equal('amountCents' in r && r.amountCents, 20000, 'amount is the stored invoice balance, not any client value');
});
