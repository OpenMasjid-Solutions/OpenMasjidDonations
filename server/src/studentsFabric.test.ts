// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the `students/billing` WIRE contract as this app speaks it (FABRIC_BILLING_CONTRACT.md
// §11). The v2 migration (provider 0.39.0) is the reason this file exists: `lookup` must send
// the Student ID ALONE at v:2 — a v1-shaped body with name+PIN 400s, which is exactly the bug
// these tests would have caught — while `info`, `record-payment` and `check` must keep sending
// v:1 so the money path can never be broken by a change to the lookup screen. It also pins the
// fail-soft rules (a broker error or a 400 is never reported as "wrong ID") and the promise
// that a Student ID never leaves the JSON body.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// students.ts reads `config` at import time, so the Fabric env must be in place BEFORE the
// module loads — hence the dynamic import inside before().
process.env.OPENMASJID_BASE_URL = 'https://os.test';
process.env.OPENMASJID_APP_SECRET = 'our-app-secret';

type Students = typeof import('./students');
let students: Students;

interface Call {
  url: string;
  method: string;
  secret: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
let queued: { status: number; payload: unknown }[] = [];
const realFetch = globalThis.fetch;

/** Queue the next broker response (FIFO, one per expected call). */
const reply = (payload: unknown, status = 200): void => {
  queued.push({ status, payload });
};

before(async () => {
  globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      secret: init?.headers?.['x-openmasjid-app-secret'] ?? '',
      body: JSON.parse(init?.body ?? '{}') as Record<string, unknown>,
    });
    const n = queued.shift() ?? { status: 200, payload: {} };
    return new Response(JSON.stringify(n.payload), { status: n.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  students = await import('./students');
});
beforeEach(() => {
  calls = [];
  queued = [];
});
after(() => {
  globalThis.fetch = realFetch;
});

// ── normalisation ───────────────────────────────────────────────────────────
test('a typed Student ID is canonicalised the way the provider does (case, spaces, hyphens)', () => {
  assert.equal(students.normaliseStudentCode('  yus-1234 '), 'YUS1234');
  assert.equal(students.normaliseStudentCode('yus 12 34'), 'YUS1234');
  assert.equal(students.normaliseStudentCode('YUS1234'), 'YUS1234');
  assert.equal(students.normaliseStudentCode('   '), '');
  // NOT a format check — the provider owns the format, so anything else passes through.
  assert.equal(students.normaliseStudentCode('abcd12345'), 'ABCD12345');
});

// ── identify (the confirmation step that replaced the PIN) ───────────────────
test('identify POSTs v:2 + the normalised code to the broker with OUR secret', async () => {
  reply({ v: 2, found: true, student: { studentCode: 'YUS1234', firstName: 'Yusuf', lastInitial: 'I' } });
  const r = await students.studentsIdentify('  yus-1234 ');
  assert.deepEqual(r, { status: 'found', student: { studentCode: 'YUS1234', firstName: 'Yusuf', lastInitial: 'I' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://os.test/api/fabric/app/students/billing/identify');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].secret, 'our-app-secret');
  assert.deepEqual(calls[0].body, { v: 2, studentCode: 'YUS1234' }, 'the ID travels in the JSON body only');
});

test('identify: a child recorded under one name comes back with no last initial', async () => {
  reply({ v: 2, found: true, student: { studentCode: 'AMI9001', firstName: 'Amina', lastInitial: '' } });
  const r = await students.studentsIdentify('AMI9001');
  assert.equal(r.status === 'found' && r.student.lastInitial, '');
});

test('identify: found:false is uniform not-found (unknown / withdrawn / locked / off)', async () => {
  reply({ v: 2, found: false });
  assert.deepEqual(await students.studentsIdentify('NOP0000'), { status: 'not-found' });
});

test('identify: a nameless "found" is unavailable, not a confirmation we invent', async () => {
  reply({ v: 2, found: true, student: { studentCode: 'YUS1234' } });
  assert.deepEqual(await students.studentsIdentify('YUS1234'), { status: 'unavailable' });
});

test('identify: an empty code never reaches the broker', async () => {
  assert.deepEqual(await students.studentsIdentify('  -  '), { status: 'not-found' });
  assert.equal(calls.length, 0);
});

test('identify: a broker error fails soft (tuition unavailable, no crash)', async () => {
  reply({ fabric_error: { code: 'target_not_installed', message: 'nope' } }, 503);
  assert.deepEqual(await students.studentsIdentify('YUS1234'), { status: 'unavailable' });
});

// ── lookup (v2: the Student ID ALONE) ───────────────────────────────────────
const FOUND = {
  v: 2,
  found: true,
  matchedStudent: { id: 'stu_1', balanceCents: 20000 },
  family: {
    id: 'fam_x1',
    label: 'Ismail family',
    students: [
      { studentId: 'stu_1', studentCode: 'YUS1234', firstName: 'Yusuf', lastInitial: 'I', balanceCents: 20000, creditCents: 0 },
      { studentId: 'stu_2', studentCode: 'MAR8802', firstName: 'Maryam', lastInitial: 'I', balanceCents: 15000, creditCents: 0 },
    ],
    balanceCents: 35000,
    creditCents: 0,
    currency: 'usd',
    openInvoices: [{ id: 'inv_9', studentId: 'stu_2', label: 'Tuition — Jul 2026', dueDate: '2026-07-01', balanceCents: 15000 }],
  },
};

test('lookup sends { v: 2, studentCode } and NEVER a name or a pin (a v1 body would 400)', async () => {
  reply(FOUND);
  await students.studentsLookup('yus-1234');
  assert.equal(calls[0].url, 'https://os.test/api/fabric/app/students/billing/lookup');
  assert.deepEqual(calls[0].body, { v: 2, studentCode: 'YUS1234' });
  assert.ok(!('name' in calls[0].body), 'v1 `name` is gone');
  assert.ok(!('pin' in calls[0].body), 'v1 `pin` is gone');
});

test('lookup parses the matched child, the per-child balances and the per-child invoices', async () => {
  reply(FOUND);
  const r = await students.studentsLookup('YUS1234');
  assert.equal(r.status, 'found');
  if (r.status !== 'found') return;
  assert.equal(r.matchedStudentId, 'stu_1', 'the child whose ID was typed — for §11.3 metadata');
  assert.equal(r.family.id, 'fam_x1');
  assert.equal(r.family.balanceCents, 35000, 'the household total is what "pay full balance" charges');
  assert.equal(r.family.currency, 'USD');
  assert.equal(r.family.creditCents, 0);
  assert.deepEqual(r.family.students, [
    { studentId: 'stu_1', firstName: 'Yusuf', lastInitial: 'I', balanceCents: 20000, creditCents: 0 },
    { studentId: 'stu_2', firstName: 'Maryam', lastInitial: 'I', balanceCents: 15000, creditCents: 0 },
  ]);
  assert.deepEqual(r.family.openInvoices, [
    // No `items` in this fixture (a pre-0.43.0 Students) → not itemised, pay the bill as one
    // thing exactly as before.
    { id: 'inv_9', studentId: 'stu_2', label: 'Tuition — Jul 2026', dueDate: '2026-07-01', balanceCents: 15000, items: [] },
  ]);
});

test('lookup parses a family that has PAID AHEAD — credit at all three levels (§11.0a)', async () => {
  // The case a balance alone cannot express: nothing due, but money on the account. Once an
  // advance settles its invoice, openInvoices is empty and credit is the only signal left.
  reply({
    v: 2,
    found: true,
    matchedStudent: { id: 'stu_1', balanceCents: 0, creditCents: 5000 },
    family: {
      id: 'fam_x1',
      label: 'Ismail family',
      students: [
        { studentId: 'stu_1', studentCode: 'YUS1234', firstName: 'Yusuf', lastInitial: 'I', balanceCents: 0, creditCents: 5000 },
        { studentId: 'stu_2', studentCode: 'MAR8802', firstName: 'Maryam', lastInitial: 'I', balanceCents: 0, creditCents: 0 },
      ],
      balanceCents: 0,
      creditCents: 5000,
      currency: 'usd',
      openInvoices: [],
    },
  });
  const r = await students.studentsLookup('YUS1234');
  assert.equal(r.status, 'found');
  if (r.status !== 'found') return;
  assert.equal(r.family.balanceCents, 0);
  assert.equal(r.family.creditCents, 5000, 'household credit');
  assert.equal(r.family.students[0].creditCents, 5000, 'the child who is ahead');
  assert.equal(r.family.students[1].creditCents, 0);
  assert.deepEqual(r.family.openInvoices, [], 'nothing open — credit is the only record');
  // The pair is complementary: never both non-zero on the same subject.
  for (const st of r.family.students) assert.ok(st.balanceCents === 0 || st.creditCents === 0);
});

test('lookup: a credit from an un-upgraded Students reads as zero, never NaN', async () => {
  reply({
    v: 2,
    found: true,
    matchedStudent: { id: 'stu_1', balanceCents: 20000 },
    family: {
      id: 'fam_x1', label: 'F', balanceCents: 20000, currency: 'usd',
      students: [{ studentId: 'stu_1', firstName: 'Y', lastInitial: 'I', balanceCents: 20000 }],
      openInvoices: [],
    },
  });
  const r = await students.studentsLookup('YUS1234');
  assert.equal(r.status === 'found' && r.family.creditCents, 0);
  assert.equal(r.status === 'found' && r.family.students[0].creditCents, 0);
});

test('lookup parses ITEMISED bills — tuition + a one-off charge + a bursary (§11.0b)', async () => {
  reply({
    v: 2,
    found: true,
    matchedStudent: { id: 'stu_1', balanceCents: 25000, creditCents: 0 },
    family: {
      id: 'fam_x1', label: 'Ismail family', balanceCents: 25000, creditCents: 0, currency: 'usd',
      students: [{ studentId: 'stu_1', firstName: 'Yusuf', lastInitial: 'I', balanceCents: 25000, creditCents: 0 }],
      openInvoices: [{
        id: 'inv_feb', studentId: 'stu_1', label: 'Tuition — Feb 2027', dueDate: '2027-02-01', balanceCents: 25000,
        items: [
          { id: 'iti_1', label: 'Monthly tuition', kind: 'tuition', amountCents: 20000, balanceCents: 20000 },
          { id: 'iti_2', label: 'Book fee', kind: 'charge', amountCents: 5000, balanceCents: 5000 },
          // A bursary is billed as a NEGATIVE amount — clamping it would render "Bursary $0.00".
          { id: 'iti_3', label: 'Bursary', kind: 'credit', amountCents: -3000, balanceCents: 0 },
        ],
      }],
    },
  });
  const r = await students.studentsLookup('YUS1234');
  assert.equal(r.status, 'found');
  if (r.status !== 'found') return;
  const inv = r.family.openInvoices[0];
  assert.equal(inv.items.length, 3, 'every line is kept, including the credit');
  assert.deepEqual(inv.items.map((it) => it.kind), ['tuition', 'charge', 'credit']);
  // The contract's guarantee, which is what lets us total whatever the parent ticks with no
  // special case: the lines add up to the bill (the credit is already deducted above).
  assert.equal(inv.items.reduce((s, it) => s + it.balanceCents, 0), inv.balanceCents);
  assert.equal(inv.items[2].balanceCents, 0, 'a credit line is never payable');
  assert.equal(inv.items[2].amountCents, -3000, 'a credit keeps its sign, so the bill can show the deduction');
});

test('lookup keeps an UNKNOWN item kind as a plain line rather than dropping money', async () => {
  reply({
    v: 2, found: true, matchedStudent: { id: 'stu_1', balanceCents: 5000 },
    family: {
      id: 'fam_x1', label: 'F', balanceCents: 5000, currency: 'usd',
      students: [{ studentId: 'stu_1', firstName: 'Y', lastInitial: 'I', balanceCents: 5000 }],
      openInvoices: [{ id: 'inv_1', studentId: 'stu_1', label: 'Feb', dueDate: '', balanceCents: 5000,
        items: [{ id: 'iti_x', label: 'Trip deposit', kind: 'excursion', amountCents: 5000, balanceCents: 5000 }] }],
    },
  });
  const r = await students.studentsLookup('YUS1234');
  assert.equal(r.status === 'found' && r.family.openInvoices[0].items[0].kind, 'excursion', 'kind is an open set');
  assert.equal(r.status === 'found' && r.family.openInvoices[0].items.length, 1);
});

test('lookup DISTRUSTS itemisation that cannot reconcile or be paid by id', async () => {
  // Lines that don't add up to the bill, or one without an id, would let us show a breakdown we
  // can't charge from — drop to a single un-itemised bill instead.
  const bad = (items: unknown[]) => ({
    v: 2, found: true, matchedStudent: { id: 'stu_1', balanceCents: 25000 },
    family: {
      id: 'fam_x1', label: 'F', balanceCents: 25000, currency: 'usd',
      students: [{ studentId: 'stu_1', firstName: 'Y', lastInitial: 'I', balanceCents: 25000 }],
      openInvoices: [{ id: 'inv_1', studentId: 'stu_1', label: 'Feb', dueDate: '', balanceCents: 25000, items }],
    },
  });
  reply(bad([{ id: 'iti_1', label: 'Tuition', kind: 'tuition', amountCents: 20000, balanceCents: 20000 }])); // sums to 20000, not 25000
  let r = await students.studentsLookup('YUS1234');
  assert.deepEqual(r.status === 'found' ? r.family.openInvoices[0].items : 'x', [], 'mismatched sum → not itemised');
  reply(bad([
    { label: 'Tuition', kind: 'tuition', amountCents: 20000, balanceCents: 20000 }, // no id
    { id: 'iti_2', label: 'Book fee', kind: 'charge', amountCents: 5000, balanceCents: 5000 },
  ]));
  r = await students.studentsLookup('YUS1234');
  assert.deepEqual(r.status === 'found' ? r.family.openInvoices[0].items : 'x', [], 'a line with no id → not itemised');
});

test('lookup: found:false is uniform not-found', async () => {
  reply({ v: 2, found: false });
  assert.deepEqual(await students.studentsLookup('NOP0000'), { status: 'not-found' });
});

test('lookup: a 400 (we sent a stale shape) is unavailable — never "wrong ID"', async () => {
  reply({ error: { code: 'invalid', message: 'Bad request.' } }, 400);
  assert.deepEqual(await students.studentsLookup('YUS1234'), { status: 'unavailable' });
});

test('lookup: a "found" family with no id is unavailable (unusable for the pay step)', async () => {
  reply({ v: 2, found: true, family: { label: 'Nobody', balanceCents: 100 } });
  assert.deepEqual(await students.studentsLookup('YUS1234'), { status: 'unavailable' });
});

test('lookup: a network fault fails soft', async () => {
  const stub = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
  try {
    assert.deepEqual(await students.studentsLookup('YUS1234'), { status: 'unavailable' });
  } finally {
    globalThis.fetch = stub;
  }
});

// ── the money path: unchanged, still v1 ─────────────────────────────────────
test('info still speaks v:1, and picks up allowAdvance + minAmountCents (§11.0a)', async () => {
  reply({ v: 2, enabled: true, schoolName: 'An-Noor', currency: 'usd', tagline: 'Pay with your Student ID', allowAdvance: true, minAmountCents: 100 });
  const r = await students.studentsInfo(true);
  assert.equal(r.available && r.info.schoolName, 'An-Noor');
  assert.equal(r.available && r.info.currency, 'USD');
  assert.equal(r.available && r.info.allowAdvance, true);
  assert.equal(r.available && r.info.minAmountCents, 100);
  assert.deepEqual(calls[0].body, { v: 1 });
});

test('info from an un-upgraded Students: no advance, but still a real floor', async () => {
  // Advertised rather than assumed — a Students without §11.0a must not have advance payments
  // inferred for it, but we still refuse to start a penny charge.
  reply({ v: 2, enabled: true, schoolName: 'Old School', currency: 'gbp', tagline: 'x' });
  const r = await students.studentsInfo(true);
  assert.equal(r.available && r.info.allowAdvance, false, 'never assumed');
  assert.equal(r.available && r.info.minAmountCents, students.MIN_TUITION_CENTS);
});

test('info: a floor advertised below ours is raised to ours (no sub-$1 charges)', async () => {
  reply({ v: 2, enabled: true, schoolName: 'S', currency: 'usd', tagline: 'x', allowAdvance: true, minAmountCents: 25 });
  const r = await students.studentsInfo(true);
  assert.equal(r.available && r.info.minAmountCents, students.MIN_TUITION_CENTS, 'we take the stricter of the two');
});

test('info: a floor advertised ABOVE ours is honoured as-is', async () => {
  reply({ v: 2, enabled: true, schoolName: 'S', currency: 'usd', tagline: 'x', allowAdvance: true, minAmountCents: 500 });
  const r = await students.studentsInfo(true);
  assert.equal(r.available && r.info.minAmountCents, 500);
});

test('record-payment sends the per-child split (what actually books the ledger) on v:1', async () => {
  reply({ v: 2, recorded: true, paymentId: 'pay_71', duplicate: false });
  const r = await students.recordStudentPayment({
    idempotencyKey: 'pi_3PabcDEF',
    familyId: 'fam_x1',
    studentId: 'stu_1',
    amountCents: 15000,
    currency: 'USD',
    occurredAt: '2026-07-15T18:03:22Z',
    externalRef: { stripePaymentIntentId: 'pi_3PabcDEF', stripeChargeId: 'ch_1' },
    allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }],
    students: [{ studentId: 'stu_2', amountCents: 15000 }],
  });
  assert.deepEqual(r, { status: 'recorded', paymentId: 'pay_71', duplicate: false });
  assert.equal(calls[0].url, 'https://os.test/api/fabric/app/students/billing/record-payment');
  assert.deepEqual(calls[0].body, {
    // v:1 on purpose: the method is byte-identical across versions and `students[]` is an
    // additive optional field, so a pre-v2 provider ignores it instead of 400ing the money path.
    v: 1,
    idempotencyKey: 'pi_3PabcDEF',
    familyId: 'fam_x1',
    studentId: 'stu_1',
    amountCents: 15000,
    currency: 'usd',
    channel: 'donations-web',
    occurredAt: '2026-07-15T18:03:22Z',
    externalRef: { stripePaymentIntentId: 'pi_3PabcDEF', stripeChargeId: 'ch_1' },
    allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }],
    // The picked month belongs to stu_2, so stu_2 is who gets credited — even though stu_1 is
    // the matched child. Without this the provider ignores `allocations` and derives its own
    // split from the family's oldest bills, landing the money on the wrong child.
    students: [{ studentId: 'stu_2', amountCents: 15000 }],
  });
});

test('record-payment sends ticked LINES ALONE — never alongside students or allocations', async () => {
  // The provider resolves exactly one breakdown (lines → allocations → students → derive), so
  // sending more than one is at best dead weight and at worst a contradiction to debug.
  reply({ v: 2, recorded: true, paymentId: 'pay_90', duplicate: false });
  const r = await students.recordStudentPayment({
    idempotencyKey: 'pi_lines',
    familyId: 'fam_x1',
    studentId: 'stu_1',
    amountCents: 5000,
    currency: 'USD',
    occurredAt: '2027-02-15T10:00:00Z',
    externalRef: { stripePaymentIntentId: 'pi_lines' },
    lines: [{ itemId: 'iti_2', amountCents: 5000 }],
    // Deliberately passed too: they must be dropped in favour of `lines`.
    allocations: [{ invoiceId: 'inv_feb', amountCents: 5000 }],
    students: [{ studentId: 'stu_1', amountCents: 5000 }],
  });
  assert.deepEqual(r, { status: 'recorded', paymentId: 'pay_90', duplicate: false });
  assert.deepEqual(calls[0].body.lines, [{ itemId: 'iti_2', amountCents: 5000 }]);
  assert.ok(!('allocations' in calls[0].body), 'lines supersedes allocations');
  assert.ok(!('students' in calls[0].body), 'lines supersedes students[]');
  assert.equal(calls[0].body.v, 1, 'still the v1 money path');
});

test('record-payment: without lines, whole-invoice payments still send allocations + students', async () => {
  // The pre-0.43.0 belt-and-braces path: `allocations` was ignored back then, so `students`
  // is what stopped a picked month landing on a sibling. Harmless on 0.43.0+ (allocations wins).
  reply({ v: 2, recorded: true, paymentId: 'pay_91', duplicate: false });
  await students.recordStudentPayment({
    idempotencyKey: 'pi_inv',
    familyId: 'fam_x1',
    amountCents: 15000,
    currency: 'usd',
    occurredAt: '2027-02-15T10:00:00Z',
    externalRef: { stripePaymentIntentId: 'pi_inv' },
    allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }],
    students: [{ studentId: 'stu_2', amountCents: 15000 }],
  });
  assert.deepEqual(calls[0].body.allocations, [{ invoiceId: 'inv_9', amountCents: 15000 }]);
  assert.deepEqual(calls[0].body.students, [{ studentId: 'stu_2', amountCents: 15000 }]);
  assert.ok(!('lines' in calls[0].body));
});

test('record-payment omits the split for a full balance (Students derives it)', async () => {
  reply({ v: 2, recorded: true, paymentId: 'pay_80', duplicate: false });
  await students.recordStudentPayment({
    idempotencyKey: 'pi_full',
    familyId: 'fam_x1',
    amountCents: 35000,
    currency: 'usd',
    occurredAt: '2026-07-15T18:03:22Z',
    externalRef: { stripePaymentIntentId: 'pi_full' },
  });
  assert.ok(!('students' in calls[0].body), 'no split for pay-everything');
  assert.ok(!('allocations' in calls[0].body), 'no allocations for pay-everything');
});

test('record-payment: a permanent app error is rejected (stop), a transient one retried', async () => {
  reply({ error: { code: 'invalid_allocation', message: 'no' } }, 422);
  const input = {
    idempotencyKey: 'pi_x',
    familyId: 'fam_x1',
    amountCents: 100,
    currency: 'usd',
    occurredAt: '2026-07-15T18:03:22Z',
    externalRef: { stripePaymentIntentId: 'pi_x' },
  };
  assert.deepEqual(await students.recordStudentPayment(input), { status: 'rejected', code: 'invalid_allocation' });
  reply({ fabric_error: { code: 'timeout', message: 'slow' } }, 504);
  assert.deepEqual(await students.recordStudentPayment(input), { status: 'unavailable' });
});

test('check still speaks v:1 and reads paymentId (kept alongside v2 paymentIds[])', async () => {
  reply({ v: 2, recorded: true, paymentId: 'pay_71', paymentIds: ['pay_71', 'pay_72'] });
  assert.deepEqual(await students.checkStudentPayment('pi_3PabcDEF'), { status: 'recorded', paymentId: 'pay_71' });
  assert.deepEqual(calls[0].body, { v: 1, idempotencyKey: 'pi_3PabcDEF' });
  reply({ v: 2, recorded: false });
  assert.deepEqual(await students.checkStudentPayment('pi_3PabcDEF'), { status: 'not-recorded' });
});
