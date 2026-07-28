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
      { studentId: 'stu_1', studentCode: 'YUS1234', firstName: 'Yusuf', lastInitial: 'I', balanceCents: 20000 },
      { studentId: 'stu_2', studentCode: 'MAR8802', firstName: 'Maryam', lastInitial: 'I', balanceCents: 15000 },
    ],
    balanceCents: 35000,
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
  assert.deepEqual(r.family.students, [
    { studentId: 'stu_1', firstName: 'Yusuf', lastInitial: 'I', balanceCents: 20000 },
    { studentId: 'stu_2', firstName: 'Maryam', lastInitial: 'I', balanceCents: 15000 },
  ]);
  assert.deepEqual(r.family.openInvoices, [
    { id: 'inv_9', studentId: 'stu_2', label: 'Tuition — Jul 2026', dueDate: '2026-07-01', balanceCents: 15000 },
  ]);
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
test('info still speaks v:1 (unchanged at v2)', async () => {
  reply({ v: 2, enabled: true, schoolName: 'An-Noor', currency: 'usd', tagline: 'Pay with your Student ID' });
  const r = await students.studentsInfo(true);
  assert.equal(r.available && r.info.schoolName, 'An-Noor');
  assert.equal(r.available && r.info.currency, 'USD');
  assert.deepEqual(calls[0].body, { v: 1 });
});

test('record-payment still speaks v:1, with allocations and no per-child breakdown', async () => {
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
  });
  assert.deepEqual(r, { status: 'recorded', paymentId: 'pay_71', duplicate: false });
  assert.equal(calls[0].url, 'https://os.test/api/fabric/app/students/billing/record-payment');
  assert.deepEqual(calls[0].body, {
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
  });
  // The optional v2 `students[]` split is deliberately omitted — the provider derives it.
  assert.ok(!('students' in calls[0].body));
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
