// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the PURE half of Monthly plans (server/src/plans.ts). Three things are worth
// guarding here and nothing else in this repo guards them:
//
//  1. THE MATHS. "Stop after N more payments" turns into a single Stripe `cancel_at`
//     instant, and if it is off by one interval the masjid either loses a payment the
//     donor agreed to or takes one they didn't. It must land strictly AFTER the last
//     intended charge and strictly BEFORE the following one — for every interval, at a
//     month-end anchor, and at a leap year. That is the property these tests attack.
//  2. THE INDEX. `groupPlanSeeds` decides which subscriptions the admin can even see, and
//     therefore act on. The earliest row must supply identity (renewals are copies of it),
//     only 'succeeded' money may be counted, and a row that isn't part of a plan must be
//     invisible — including, structurally, every tuition payment (§13 route isolation puts
//     those in `student_payments`, so there is no donation row to fold). That absence is a
//     security property, so it is asserted against a real throwaway DB, not a fixture.
//  3. THE WORDS. A masjid must never read a bare Stripe error code or a machine status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type Donation } from './store';
import {
  ABANDONED_MS,
  DAY_SECONDS,
  MAX_FURTHER_PAYMENTS,
  addIntervals,
  cancelAtAfterCharges,
  endOfDayUnix,
  endsAtUnix,
  failureReason,
  frequencyLabel,
  friendlyStatus,
  groupPlanSeeds,
  invoiceStatusLabel,
  isAbandonedSeed,
  isoFromUnix,
  mapWithLimit,
  nextPaymentUnix,
  planIsOver,
  planSyncOrder,
  type PlanSeed,
  type PlanState,
} from './plans';

// ── helpers ───────────────────────────────────────────────────────────────────

/** A recurring donation row. Defaults are a plain healthy monthly plan; every test
 *  overrides only the field it is about. */
function don(over: Partial<Donation> = {}): Donation {
  return {
    id: 'don_aaaaaaaa',
    campaignId: 'cmp_general',
    stripeAccountId: 'acct_first',
    amount: 1000,
    currency: 'gbp',
    status: 'succeeded',
    donorName: 'Aisha',
    donorEmail: 'aisha@example.org',
    coverFees: false,
    giftAid: false,
    paymentIntentId: 'pi_1',
    cardBrand: 'visa',
    cardLast4: '4242',
    recurring: true,
    subscriptionId: 'sub_A',
    refundedAmount: 0,
    refundedAt: '',
    receipt: 'stripe',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** Unix seconds for an ISO instant — the tests speak in dates, the code in unix. */
const at = (isoDate: string): number => Math.floor(new Date(isoDate).getTime() / 1000);

function state(over: Partial<PlanState> = {}): PlanState {
  return {
    status: 'active',
    paused: false,
    amountMinor: 1000,
    currency: 'GBP',
    interval: 'month',
    intervalCount: 1,
    cardBrand: 'visa',
    cardLast4: '4242',
    startDateUnix: at('2026-01-01T09:00:00Z'),
    currentPeriodEndUnix: at('2026-08-01T09:00:00Z'),
    cancelAtUnix: 0,
    cancelAtPeriodEnd: false,
    endedAtUnix: 0,
    latestInvoiceId: 'in_1',
    latestInvoicePaid: true,
    ...over,
  };
}

/** A plan seed. Defaults are a healthy plan that has taken one payment; the abandoned-seed
 *  tests override `payments` / `startedAt`, which are the only two fields the predicate reads. */
function seed(over: Partial<PlanSeed> = {}): PlanSeed {
  return {
    subscriptionId: 'sub_A',
    firstDonationId: 'don_aaaaaaaa',
    campaignId: 'cmp_general',
    stripeAccountId: 'acct_first',
    donorName: 'Aisha',
    donorEmail: 'aisha@example.org',
    currency: 'GBP',
    amountMinor: 1000,
    coverFees: false,
    giftAid: false,
    cardBrand: 'visa',
    cardLast4: '4242',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastPaymentAt: '2026-01-01T00:00:00.000Z',
    collectedMinor: 1000,
    payments: 1,
    ...over,
  };
}

// ── groupPlanSeeds: the index ─────────────────────────────────────────────────

test('groupPlanSeeds: the EARLIEST row supplies the plan identity, later rows only money', () => {
  // The renewal rows deliberately carry wrong descriptive fields: only the donor's own
  // first row was filled in by a human, so nothing later may override it.
  const seeds = groupPlanSeeds([
    don({ id: 'don_first111', createdAt: '2026-01-10T00:00:00.000Z', paymentIntentId: 'pi_a1', amount: 1500 }),
    don({
      id: 'don_second22',
      createdAt: '2026-02-10T00:00:00.000Z',
      paymentIntentId: 'pi_a2',
      amount: 1500,
      campaignId: 'cmp_WRONG',
      donorName: 'Renewal Copy',
      donorEmail: 'wrong@example.org',
      stripeAccountId: 'acct_WRONG',
      cardBrand: 'amex',
      cardLast4: '0005',
      coverFees: true,
      giftAid: true,
      currency: 'usd',
    }),
    don({ id: 'don_third333', createdAt: '2026-03-10T00:00:00.000Z', paymentIntentId: 'pi_a3', amount: 1500 }),
  ]);
  assert.equal(seeds.length, 1, 'three rows of one subscription are ONE plan');
  const s = seeds[0];
  assert.equal(s.subscriptionId, 'sub_A');
  assert.equal(s.firstDonationId, 'don_first111', 'the display ref comes from the first row');
  assert.equal(s.campaignId, 'cmp_general');
  assert.equal(s.stripeAccountId, 'acct_first');
  assert.equal(s.donorName, 'Aisha');
  assert.equal(s.donorEmail, 'aisha@example.org');
  assert.equal(s.cardBrand, 'visa');
  assert.equal(s.cardLast4, '4242');
  assert.equal(s.coverFees, false);
  assert.equal(s.giftAid, false);
  assert.equal(s.currency, 'GBP', 'currency is normalized to upper case');
  assert.equal(s.amountMinor, 1500, 'the first charge is the fallback amount');
  assert.equal(s.startedAt, '2026-01-10T00:00:00.000Z');
  assert.equal(s.collectedMinor, 4500, 'all three succeeded rows are money');
  assert.equal(s.payments, 3);
  assert.equal(s.lastPaymentAt, '2026-03-10T00:00:00.000Z');
});

test('groupPlanSeeds: only SUCCEEDED rows are money, and lastPaymentAt is the newest succeeded one', () => {
  const [s] = groupPlanSeeds([
    don({ id: 'don_1', createdAt: '2026-01-01T00:00:00.000Z', paymentIntentId: 'pi_1', amount: 2000, status: 'succeeded' }),
    don({ id: 'don_2', createdAt: '2026-02-01T00:00:00.000Z', paymentIntentId: 'pi_2', amount: 2000, status: 'succeeded' }),
    // A failed renewal and a still-pending one: neither is income, and neither may move
    // "last payment" forward — the admin would otherwise think money arrived in March.
    don({ id: 'don_3', createdAt: '2026-03-01T00:00:00.000Z', paymentIntentId: 'pi_3', amount: 2000, status: 'failed' }),
    don({ id: 'don_4', createdAt: '2026-04-01T00:00:00.000Z', paymentIntentId: 'pi_4', amount: 2000, status: 'pending' }),
  ]);
  assert.equal(s.collectedMinor, 4000);
  assert.equal(s.payments, 2);
  assert.equal(s.lastPaymentAt, '2026-02-01T00:00:00.000Z', 'a failed/pending row never becomes the last payment');
});

test('groupPlanSeeds: a refunded payment comes off "collected", but still counts as a payment', () => {
  // A refund is money that came and went. "Collected so far" is what the masjid KEPT, so it must
  // match the donation totals (which are net) rather than contradicting them on the next tab —
  // while the payment itself stays counted, because it happened and the ledger still lists it.
  const [s] = groupPlanSeeds([
    don({ id: 'don_1', createdAt: '2026-01-01T00:00:00.000Z', paymentIntentId: 'pi_1', amount: 2000, status: 'succeeded' }),
    // Part refunded…
    don({ id: 'don_2', createdAt: '2026-02-01T00:00:00.000Z', paymentIntentId: 'pi_2', amount: 2000, status: 'succeeded', refundedAmount: 500 }),
    // …and one given back in full.
    don({ id: 'don_3', createdAt: '2026-03-01T00:00:00.000Z', paymentIntentId: 'pi_3', amount: 2000, status: 'succeeded', refundedAmount: 2000 }),
  ]);
  assert.equal(s.collectedMinor, 3500, '2000 + (2000-500) + (2000-2000)');
  assert.equal(s.payments, 3, 'three payments really were taken');
  assert.equal(s.lastPaymentAt, '2026-03-01T00:00:00.000Z', 'a refund does not un-happen the payment');
});

test('groupPlanSeeds: an over-refunded row can never make "collected" go negative', () => {
  const [s] = groupPlanSeeds([don({ amount: 1000, status: 'succeeded', refundedAmount: 1500 })]);
  assert.equal(s.collectedMinor, 0);
});

test('groupPlanSeeds: a plan whose FIRST payment failed still appears, with nothing collected', () => {
  // This is the plan an admin most needs to see (a donor whose card was declined at
  // signup) — dropping it because no money landed would hide the problem.
  const [s] = groupPlanSeeds([don({ id: 'don_dud1', status: 'failed', subscriptionId: 'sub_DUD' })]);
  assert.equal(s.subscriptionId, 'sub_DUD');
  assert.equal(s.collectedMinor, 0);
  assert.equal(s.payments, 0);
  assert.equal(s.lastPaymentAt, '', 'no succeeded payment → no last payment date, not a fake one');
  assert.equal(s.startedAt, '2026-01-01T00:00:00.000Z', 'it still started when the donor set it up');
});

test('groupPlanSeeds: a one-off row, or a recurring row with no subscription id, is invisible', () => {
  const seeds = groupPlanSeeds([
    don({ id: 'don_ok', subscriptionId: 'sub_REAL' }),
    // A plain one-time donation that happens to carry a subscription id (shouldn't exist,
    // but recurring=false is the flag that decides).
    don({ id: 'don_oneoff', recurring: false, subscriptionId: 'sub_GHOST', paymentIntentId: 'pi_x' }),
    // recurring=true but no subscription id: without the guard, every such row would
    // collapse into one bogus '' plan whose totals are the sum of unrelated donors.
    don({ id: 'don_blank1', subscriptionId: '', paymentIntentId: 'pi_y' }),
    don({ id: 'don_blank2', subscriptionId: '', paymentIntentId: 'pi_z' }),
  ]);
  assert.deepEqual(
    seeds.map((s) => s.subscriptionId),
    ['sub_REAL'],
  );
});

test('groupPlanSeeds: two subscriptions stay separate, newest plan first, whatever the input order', () => {
  const rows = [
    don({ id: 'don_b2', subscriptionId: 'sub_B', createdAt: '2026-05-02T00:00:00.000Z', paymentIntentId: 'pi_b2', amount: 500 }),
    don({ id: 'don_a1', subscriptionId: 'sub_A', createdAt: '2026-01-01T00:00:00.000Z', paymentIntentId: 'pi_a1', amount: 1000 }),
    don({ id: 'don_b1', subscriptionId: 'sub_B', createdAt: '2026-04-02T00:00:00.000Z', paymentIntentId: 'pi_b1', amount: 500, donorName: 'Bilal' }),
    don({ id: 'don_a2', subscriptionId: 'sub_A', createdAt: '2026-02-01T00:00:00.000Z', paymentIntentId: 'pi_a2', amount: 1000 }),
  ];
  const oldestFirst = groupPlanSeeds([...rows].sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1)));
  const newestFirst = groupPlanSeeds([...rows].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)));
  // The route calls this with either ordering, so the answer must not depend on it.
  assert.deepEqual(oldestFirst, newestFirst, 'grouping is order-insensitive');
  assert.deepEqual(
    oldestFirst.map((s) => s.subscriptionId),
    ['sub_B', 'sub_A'],
    'newest plan first (sub_B started in April)',
  );
  assert.equal(oldestFirst[0].donorName, 'Bilal', "sub_B's identity is its own April row");
  assert.equal(oldestFirst[0].collectedMinor, 1000);
  assert.equal(oldestFirst[1].collectedMinor, 2000);
});

test('groupPlanSeeds: rows sharing a timestamp still pick a deterministic first row', () => {
  const a = don({ id: 'don_bbb', createdAt: '2026-01-01T00:00:00.000Z', paymentIntentId: 'pi_1', donorName: 'Later id' });
  const b = don({ id: 'don_aaa', createdAt: '2026-01-01T00:00:00.000Z', paymentIntentId: 'pi_2', donorName: 'Earlier id' });
  assert.equal(groupPlanSeeds([a, b])[0].donorName, 'Earlier id');
  assert.equal(groupPlanSeeds([b, a])[0].donorName, 'Earlier id', 'the id tie-break, not the array order, decides');
});

test('groupPlanSeeds: no rows → no plans (an empty tab, never a crash)', () => {
  assert.deepEqual(groupPlanSeeds([]), []);
});

test('groupPlanSeeds does NOT filter abandoned sign-ups — that is the caller\'s job, after syncing', () => {
  // The predicate must stay OUT of the index: the index is what feeds the sync, and the sync
  // is what heals a $0 row whose payment really did land. Asserted so nobody "tidies" it in.
  const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const seeds = groupPlanSeeds([don({ id: 'don_dud1', status: 'pending', subscriptionId: 'sub_DUD', createdAt: old })]);
  assert.equal(seeds.length, 1, 'an ancient never-paid sign-up is still in the index, ready to be synced');
  assert.equal(seeds[0].payments, 0);
});

// ── isAbandonedSeed: hiding monthly checkouts that never went through ──────────

test('isAbandonedSeed: a never-paid sign-up older than 24h is abandoned; a fresh one is not', () => {
  // Why they exist at all: the recurring donation row is written at /intent, BEFORE the donor
  // enters a card, so every abandoned monthly checkout leaves a $0 row behind for ever.
  const now = Date.parse('2026-06-10T12:00:00.000Z');
  const startedAgo = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(isAbandonedSeed(seed({ payments: 0, collectedMinor: 0, startedAt: startedAgo(ABANDONED_MS + 1000) }), now), true);
  assert.equal(isAbandonedSeed(seed({ payments: 0, collectedMinor: 0, startedAt: startedAgo(30 * 24 * 3600_000) }), now), true, 'a month old');
  // Inside the window the donor may still be typing their card in, or on the 3-D Secure step.
  assert.equal(isAbandonedSeed(seed({ payments: 0, collectedMinor: 0, startedAt: startedAgo(60_000) }), now), false, 'a minute old');
  assert.equal(isAbandonedSeed(seed({ payments: 0, collectedMinor: 0, startedAt: startedAgo(ABANDONED_MS - 1000) }), now), false, 'just inside');
  assert.equal(isAbandonedSeed(seed({ payments: 0, collectedMinor: 0, startedAt: startedAgo(ABANDONED_MS) }), now), false, 'exactly 24h is kept');
});

test('isAbandonedSeed: any payment at all makes it a real plan, however old and however it ended', () => {
  const now = Date.parse('2026-06-10T12:00:00.000Z');
  const ancient = '2024-01-01T00:00:00.000Z';
  assert.equal(isAbandonedSeed(seed({ payments: 1, startedAt: ancient }), now), false);
  assert.equal(isAbandonedSeed(seed({ payments: 40, startedAt: ancient }), now), false, 'a long-running plan is never hidden');
  // A plan the donor themselves canceled after one payment is history the masjid keeps.
  assert.equal(isAbandonedSeed(seed({ payments: 1, collectedMinor: 500, startedAt: ancient, lastPaymentAt: ancient }), now), false);
});

test('isAbandonedSeed: THE TRAP — a first payment that succeeded but was never confirmed looks identical', () => {
  // The donor paid, then closed the tab before /confirm ran, so our row is still 'pending' and
  // the seed reads payments === 0 — indistinguishable from an abandoned checkout, even a month
  // later. Reconciliation (Stripe's invoice list) is the ONLY thing that can tell them apart.
  // So this predicate alone WOULD hide real money, which is exactly why the route must sync
  // first and apply it afterwards, never as a filter on the index that feeds the sync.
  const now = Date.parse('2026-06-10T12:00:00.000Z');
  const unconfirmed = seed({ payments: 0, collectedMinor: 0, lastPaymentAt: '', startedAt: '2026-05-01T00:00:00.000Z' });
  assert.equal(isAbandonedSeed(unconfirmed, now), true, 'hidden on local data alone — money the admin would never see');
  // After the sync has reconciled that invoice, the very same plan is visible again.
  const reconciled = { ...unconfirmed, payments: 1, collectedMinor: 1000, lastPaymentAt: '2026-05-01T00:00:00.000Z' };
  assert.equal(isAbandonedSeed(reconciled, now), false, 'reconciliation is what rescues it — hence sync FIRST, hide SECOND');
});

test('isAbandonedSeed: an unreadable start date is never grounds for hiding a plan', () => {
  const now = Date.parse('2026-06-10T12:00:00.000Z');
  assert.equal(isAbandonedSeed(seed({ payments: 0, startedAt: '' }), now), false);
  assert.equal(isAbandonedSeed(seed({ payments: 0, startedAt: 'not a date' }), now), false);
  // A clock skew that puts the start in the future must not hide it either.
  assert.equal(isAbandonedSeed(seed({ payments: 0, startedAt: '2027-01-01T00:00:00.000Z' }), now), false);
});

// ── planSyncOrder: the refresh cap must never starve a real plan ───────────────

test('planSyncOrder: paid plans first, newest-first within each group, nothing lost', () => {
  // The cap (200) exists so a Pi doesn't make thousands of Stripe calls. Filled newest-first,
  // a burst of unauthenticated abandoned sign-ups would fill it entirely and every real plan
  // would silently stop being reconciled. Paying plans therefore go to the front.
  const input = [
    seed({ subscriptionId: 'sub_new_unpaid', payments: 0, startedAt: '2026-06-09T00:00:00.000Z' }),
    seed({ subscriptionId: 'sub_new_unpaid2', payments: 0, startedAt: '2026-06-08T00:00:00.000Z' }),
    seed({ subscriptionId: 'sub_newest_paid', payments: 3, startedAt: '2026-06-07T00:00:00.000Z' }),
    seed({ subscriptionId: 'sub_old_unpaid', payments: 0, startedAt: '2026-02-01T00:00:00.000Z' }),
    seed({ subscriptionId: 'sub_older_paid', payments: 9, startedAt: '2026-01-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(
    planSyncOrder(input).map((s) => s.subscriptionId),
    ['sub_newest_paid', 'sub_older_paid', 'sub_new_unpaid', 'sub_new_unpaid2', 'sub_old_unpaid'],
  );
  // The cap can now never push a paying plan out of the refresh window.
  const flood = [
    ...Array.from({ length: 250 }, (_, i) => seed({ subscriptionId: `sub_junk_${i}`, payments: 0, startedAt: '2026-06-10T00:00:00.000Z' })),
    seed({ subscriptionId: 'sub_real', payments: 12, startedAt: '2025-01-01T00:00:00.000Z' }),
  ];
  assert.equal(planSyncOrder(flood).slice(0, 200)[0].subscriptionId, 'sub_real', '250 junk sign-ups cannot bury the one real plan');
  assert.equal(planSyncOrder([]).length, 0);
  assert.equal(planSyncOrder(input).length, input.length, 'a re-ordering, never a filter — the caller decides what to hide');
});

// ── frequencyLabel ────────────────────────────────────────────────────────────

test('frequencyLabel: warm words for every interval Stripe can send', () => {
  assert.equal(frequencyLabel('month', 1), 'Monthly');
  assert.equal(frequencyLabel('year', 1), 'Yearly');
  assert.equal(frequencyLabel('week', 1), 'Weekly');
  assert.equal(frequencyLabel('day', 1), 'Daily');
  assert.equal(frequencyLabel('month', 3), 'Every 3 months');
  assert.equal(frequencyLabel('month', 6), 'Every 6 months');
  assert.equal(frequencyLabel('week', 2), 'Every 2 weeks');
  // 0 is what a missing recurring block gives us; treat it as "one".
  assert.equal(frequencyLabel('month', 0), 'Monthly');
});

test("frequencyLabel: an unknown or missing interval says nothing rather than inventing a schedule", () => {
  assert.equal(frequencyLabel('', 1), '', 'Stripe unreachable → the UI omits the frequency');
  assert.equal(frequencyLabel('fortnight', 1), '');
});

// ── friendlyStatus ────────────────────────────────────────────────────────────

test('friendlyStatus: every Stripe subscription status becomes plain words', () => {
  assert.deepEqual(friendlyStatus('active', false), { status: 'active', label: 'Active' });
  assert.deepEqual(friendlyStatus('past_due', false), { status: 'past_due', label: 'Payment failed' });
  assert.deepEqual(friendlyStatus('unpaid', false), { status: 'unpaid', label: 'Unpaid' });
  assert.deepEqual(friendlyStatus('incomplete', false), { status: 'incomplete', label: 'Not finished' });
  assert.deepEqual(friendlyStatus('trialing', false), { status: 'trialing', label: 'Trial' });
  assert.deepEqual(friendlyStatus('canceled', false), { status: 'canceled', label: 'Stopped' });
  // Stripe's own `paused` STATUS — a different mechanism from `pause_collection`, but the same
  // news for a masjid, so it must not read "Not known".
  assert.deepEqual(friendlyStatus('paused', false), { status: 'paused', label: 'Paused' });
  // Stripe's eighth status, absent from the API contract's union — it must not fall through
  // to "Not known", because it is simply a plan that never got going.
  assert.deepEqual(friendlyStatus('incomplete_expired', false), { status: 'canceled', label: 'Stopped' });
  // Anything new Stripe invents, plus the '' we use when Stripe is unreachable.
  assert.deepEqual(friendlyStatus('', false), { status: 'unknown', label: 'Not known' });
  assert.deepEqual(friendlyStatus('some_future_status', false), { status: 'unknown', label: 'Not known' });
});

test('friendlyStatus: pause_collection WINS over the underlying status', () => {
  // A paused donation plan is still `active` at Stripe. Reading sub.status first would tell
  // the admin the plan is Active right after they paused it — and they would pause it again.
  assert.deepEqual(friendlyStatus('active', true), { status: 'paused', label: 'Paused' });
  assert.deepEqual(friendlyStatus('past_due', true), { status: 'paused', label: 'Paused' });
  assert.deepEqual(friendlyStatus('trialing', true), { status: 'paused', label: 'Paused' });
});

// ── invoiceStatusLabel + failureReason ────────────────────────────────────────

test('invoiceStatusLabel: warm words, and null/unknown lands on "Not known"', () => {
  assert.deepEqual(invoiceStatusLabel('paid'), { status: 'paid', label: 'Paid' });
  assert.deepEqual(invoiceStatusLabel('open'), { status: 'open', label: 'Waiting' });
  assert.deepEqual(invoiceStatusLabel('draft'), { status: 'draft', label: 'Not sent yet' });
  assert.deepEqual(invoiceStatusLabel('void'), { status: 'void', label: 'Canceled' });
  // Deliberately NOT "Written off"/"Uncollectible" — a masjid volunteer is not a bookkeeper.
  assert.deepEqual(invoiceStatusLabel('uncollectible'), { status: 'uncollectible', label: 'Not collected' });
  assert.deepEqual(invoiceStatusLabel(null), { status: 'unknown', label: 'Not known' });
  assert.deepEqual(invoiceStatusLabel(undefined), { status: 'unknown', label: 'Not known' });
  assert.deepEqual(invoiceStatusLabel('deleted'), { status: 'unknown', label: 'Not known' });
});

test("failureReason: the card's own decline message wins over the invoice's", () => {
  assert.equal(
    failureReason('Your card was declined.', 'The invoice could not be finalised.'),
    'Your card was declined.',
    "the bank's reason is the one that helps the donor",
  );
  // Falls back to finalisation only when there is no PaymentIntent error.
  assert.equal(failureReason(null, 'This invoice could not be finalised.'), 'This invoice could not be finalised.');
  assert.equal(failureReason('   ', 'This invoice could not be finalised.'), 'This invoice could not be finalised.', 'whitespace is not a reason');
});

test('failureReason: nothing to say → the empty string (the UI shows no failure row)', () => {
  assert.equal(failureReason(), '');
  assert.equal(failureReason(null, null), '');
  assert.equal(failureReason(undefined, undefined), '');
  assert.equal(failureReason('', ''), '');
});

test('failureReason: a bare error CODE is NEVER shown to a masjid', () => {
  const generic = failureReason('card_declined');
  assert.ok(generic.length > 0);
  assert.notEqual(generic, 'card_declined');
  assert.ok(/\s/.test(generic), 'the replacement is a sentence, not another token');
  assert.ok(/[.!?]$/.test(generic), 'and it is punctuated');
  // Every shape of "machine string" lands on the same friendly sentence.
  for (const code of ['card_declined', 'insufficient_funds', 'declined', 'expired_card', 'authentication_required']) {
    assert.equal(failureReason(code), generic, `${code} must not reach the admin verbatim`);
    assert.equal(failureReason(null, code), generic, `${code} must not reach the admin from the invoice either`);
  }
});

test('failureReason: one sentence only, punctuated, and bounded', () => {
  assert.equal(
    failureReason('Your card was declined. Please contact your bank for more information about this decline.'),
    'Your card was declined.',
    'the first sentence is enough — the rest is Stripe talking to a developer',
  );
  assert.equal(failureReason('The card has expired'), 'The card has expired.', 'a missing full stop is added');
  assert.equal(failureReason('Something went wrong\nrequest id: req_123'), 'Something went wrong.', 'never a second line');
  const long = failureReason(`${'a b'.repeat(400)}`);
  assert.ok(long.length <= 201, `a runaway message is truncated (got ${long.length})`);
});

// ── isoFromUnix ───────────────────────────────────────────────────────────────

test('isoFromUnix: 0 / negative / NaN mean "we don\'t know", not 1970', () => {
  assert.equal(isoFromUnix(0), '');
  assert.equal(isoFromUnix(-1), '');
  assert.equal(isoFromUnix(Number.NaN), '');
  assert.equal(isoFromUnix(at('2026-03-04T05:06:07Z')), '2026-03-04T05:06:07.000Z');
});

// ── addIntervals ──────────────────────────────────────────────────────────────

test('addIntervals: day and week arithmetic', () => {
  const from = at('2026-01-31T09:00:00Z');
  assert.equal(isoFromUnix(addIntervals(from, 'day', 1, 1)), '2026-02-01T09:00:00.000Z');
  assert.equal(isoFromUnix(addIntervals(from, 'day', 1, 30)), '2026-03-02T09:00:00.000Z');
  assert.equal(isoFromUnix(addIntervals(from, 'week', 1, 1)), '2026-02-07T09:00:00.000Z');
  // 42 days from 31 Jan: 28 to the end of February, then 14 more.
  assert.equal(isoFromUnix(addIntervals(from, 'week', 2, 3)), '2026-03-14T09:00:00.000Z', '2-weekly, 3 times = 42 days');
  assert.equal(addIntervals(from, 'week', 2, 3) - from, 42 * DAY_SECONDS, 'and weeks really are fixed-length');
});

test('addIntervals: a MONTH-END anchor is clamped, never rolled into the next month', () => {
  // 31 Jan is the anchor Stripe itself keeps: it charges 28/29 Feb, then 31 Mar again.
  // Naive `setUTCMonth` would turn 31 Feb into 3 March and every later date would drift.
  const jan31 = at('2026-01-31T09:00:00Z');
  assert.equal(isoFromUnix(addIntervals(jan31, 'month', 1, 1)), '2026-02-28T09:00:00.000Z');
  assert.equal(isoFromUnix(addIntervals(jan31, 'month', 1, 2)), '2026-03-31T09:00:00.000Z', 'the 31st comes BACK — the anchor is not lost');
  assert.equal(isoFromUnix(addIntervals(jan31, 'month', 1, 3)), '2026-04-30T09:00:00.000Z');
  assert.equal(isoFromUnix(addIntervals(jan31, 'month', 1, 12)), '2027-01-31T09:00:00.000Z');
  // A leap February.
  const jan31Leap = at('2028-01-31T09:00:00Z');
  assert.equal(isoFromUnix(addIntervals(jan31Leap, 'month', 1, 1)), '2028-02-29T09:00:00.000Z');
  // 29 Feb + a year → 28 Feb, the same clamp.
  assert.equal(isoFromUnix(addIntervals(at('2028-02-29T09:00:00Z'), 'year', 1, 1)), '2029-02-28T09:00:00.000Z');
  // Quarterly and yearly step counts.
  assert.equal(isoFromUnix(addIntervals(at('2026-01-15T09:00:00Z'), 'month', 3, 2)), '2026-07-15T09:00:00.000Z');
  assert.equal(isoFromUnix(addIntervals(at('2026-01-15T09:00:00Z'), 'year', 1, 2)), '2028-01-15T09:00:00.000Z');
});

test('addIntervals: an interval we cannot understand returns 0 ("refuse", never "guess")', () => {
  const from = at('2026-01-15T09:00:00Z');
  assert.equal(addIntervals(from, '', 1, 1), 0, 'Stripe unreachable → no interval → no arithmetic');
  assert.equal(addIntervals(from, 'fortnight', 1, 1), 0);
  assert.equal(addIntervals(0, 'month', 1, 1), 0, 'no starting point → no answer');
  assert.equal(addIntervals(Number.NaN, 'month', 1, 1), 0);
  // times = 0 is the identity, not an error.
  assert.equal(addIntervals(from, 'month', 1, 0), from);
});

// ── endOfDayUnix ──────────────────────────────────────────────────────────────

test('endOfDayUnix: the LAST instant of that UTC day, so "stop on the 30th" includes the 30th', () => {
  const u = endOfDayUnix('2026-06-15');
  assert.ok(u !== null);
  assert.equal(isoFromUnix(u), '2026-06-15T23:59:59.000Z');
  assert.ok(u > at('2026-06-15T00:00:00Z'), 'end of day, not start');
  assert.ok(u < at('2026-06-16T00:00:00Z'), 'and it does not spill into the next day');
  assert.equal(isoFromUnix(endOfDayUnix(' 2026-12-31 ')!), '2026-12-31T23:59:59.000Z', 'surrounding spaces are tolerated');
  assert.equal(isoFromUnix(endOfDayUnix('2028-02-29')!), '2028-02-29T23:59:59.000Z', 'a real leap day is accepted');
});

test('endOfDayUnix: anything that is not a real calendar day is refused, not rolled over', () => {
  // Date.UTC(2026, 1, 31) would silently become 3 March — the plan would run a month
  // longer than the admin asked for, which is money taken without consent.
  assert.equal(endOfDayUnix('2026-02-31'), null);
  assert.equal(endOfDayUnix('2026-02-30'), null);
  assert.equal(endOfDayUnix('2026-04-31'), null);
  assert.equal(endOfDayUnix('2026-02-29'), null, '2026 is not a leap year');
  assert.equal(endOfDayUnix('2026-13-01'), null);
  assert.equal(endOfDayUnix('2026-00-10'), null);
  assert.equal(endOfDayUnix('2026-06-00'), null);
  assert.equal(endOfDayUnix('2026-06-32'), null);
  assert.equal(endOfDayUnix('2026-6-15'), null, 'the input is a date field, so the format is exact');
  assert.equal(endOfDayUnix(''), null);
  assert.equal(endOfDayUnix('tomorrow'), null);
  assert.equal(endOfDayUnix('2026-06-15T12:00:00Z'), null);
});

// ── cancelAtAfterCharges: the maths that decides how much money is taken ──────

test('cancelAtAfterCharges: 1 further payment ends the plan after that one charge', () => {
  const next = at('2026-01-31T09:00:00Z');
  const got = cancelAtAfterCharges(next, 'month', 1, 1);
  assert.ok(got !== null);
  // The one promised charge is 31 Jan; the one to prevent is 28 Feb. A day's clearance.
  assert.equal(isoFromUnix(got), '2026-02-27T09:00:00.000Z');
  assert.ok(got > next, 'strictly after the charge the donor agreed to');
  assert.ok(got < at('2026-02-28T09:00:00Z'), 'strictly before the charge they did not');
});

test('cancelAtAfterCharges: 6 further payments — the 6th lands, the 7th does not', () => {
  const next = at('2026-01-31T09:00:00Z');
  const got = cancelAtAfterCharges(next, 'month', 1, 6);
  assert.ok(got !== null);
  // Charges: 31 Jan, 28 Feb, 31 Mar, 30 Apr, 31 May, 30 Jun (the 6th). Cancel before 31 Jul.
  assert.equal(isoFromUnix(got), '2026-07-30T09:00:00.000Z');
  assert.ok(got > at('2026-06-30T09:00:00Z'), 'after the 6th charge');
  assert.ok(got < at('2026-07-31T09:00:00Z'), 'before the 7th');
});

test('cancelAtAfterCharges: STRICTLY between the last promised charge and the next, for every interval and count', () => {
  // The property that matters, hammered rather than spot-checked. A month-end anchor is
  // included on purpose: it is where naive arithmetic slips by a whole billing period.
  const anchors = ['2026-01-31T09:00:00Z', '2026-01-15T00:00:00Z', '2028-01-31T23:30:00Z', '2026-11-30T12:00:00Z'];
  const intervals: Array<[string, number]> = [
    ['day', 1],
    ['week', 1],
    ['week', 2],
    ['month', 1],
    ['month', 3],
    ['year', 1],
  ];
  for (const anchor of anchors) {
    const next = at(anchor);
    for (const [interval, count] of intervals) {
      for (let remaining = 1; remaining <= 12; remaining++) {
        const got = cancelAtAfterCharges(next, interval, count, remaining);
        assert.ok(got !== null, `${anchor} ${interval}/${count} x${remaining} should be schedulable`);
        const lastCharge = remaining === 1 ? next : addIntervals(next, interval, count, remaining - 1);
        const following = addIntervals(next, interval, count, remaining);
        assert.ok(
          got > lastCharge,
          `${anchor} ${interval}/${count} x${remaining}: cancel_at ${isoFromUnix(got)} must be AFTER the last charge ${isoFromUnix(lastCharge)}`,
        );
        assert.ok(
          got < following,
          `${anchor} ${interval}/${count} x${remaining}: cancel_at ${isoFromUnix(got)} must be BEFORE the next charge ${isoFromUnix(following)}`,
        );
        // And never sitting on a charge instant, which is the race the clearance exists for.
        assert.notEqual(got, lastCharge);
        assert.notEqual(got, following);
      }
    }
  }
});

test('cancelAtAfterCharges: the clearance shrinks for short intervals instead of overshooting backwards', () => {
  // A flat 1-day clearance on a DAILY plan with 1 further payment would land exactly on the
  // charge instant — the very race the rule exists to avoid — so it is capped at half the gap.
  const next = at('2026-05-01T09:00:00Z');
  const daily = cancelAtAfterCharges(next, 'day', 1, 1);
  assert.ok(daily !== null);
  assert.equal(daily - next, DAY_SECONDS / 2, 'half a day for a daily plan');
  // Monthly (all this app creates) keeps the full day.
  const monthly = cancelAtAfterCharges(next, 'month', 1, 1);
  assert.ok(monthly !== null);
  assert.equal(addIntervals(next, 'month', 1, 1) - monthly, DAY_SECONDS, 'exactly one day before the charge we are preventing');
});

test('cancelAtAfterCharges: out-of-range or unworkable requests return null (the route then explains itself)', () => {
  const next = at('2026-05-01T09:00:00Z');
  assert.equal(cancelAtAfterCharges(next, 'month', 1, 0), null, '"0 further payments" is a cancel, not a schedule');
  assert.equal(cancelAtAfterCharges(next, 'month', 1, -3), null);
  assert.equal(cancelAtAfterCharges(next, 'month', 1, 1.5), null, 'half a payment is not a thing');
  assert.equal(cancelAtAfterCharges(next, 'month', 1, Number.NaN), null);
  assert.equal(cancelAtAfterCharges(next, 'month', 1, MAX_FURTHER_PAYMENTS + 1), null);
  assert.ok(cancelAtAfterCharges(next, 'month', 1, MAX_FURTHER_PAYMENTS) !== null, 'the cap itself is allowed');
  // No next payment date, or an interval we can't read: refuse rather than pick a date.
  assert.equal(cancelAtAfterCharges(0, 'month', 1, 3), null);
  assert.equal(cancelAtAfterCharges(next, '', 1, 3), null);
  assert.equal(cancelAtAfterCharges(next, 'fortnight', 1, 3), null);
});

// ── nextPaymentUnix / endsAtUnix ──────────────────────────────────────────────

test('nextPaymentUnix: only promises a date when a charge really is coming', () => {
  const periodEnd = at('2026-08-01T09:00:00Z');
  assert.equal(nextPaymentUnix(state()), periodEnd, 'a healthy active plan renews at the period end');
  assert.equal(nextPaymentUnix(state({ paused: true })), 0, "paused with behavior 'void' — nothing is taken, and nothing is owed later");
  assert.equal(nextPaymentUnix(state({ status: 'canceled' })), 0);
  assert.equal(nextPaymentUnix(state({ status: 'incomplete_expired' })), 0);
  assert.equal(nextPaymentUnix(state({ status: 'incomplete' })), 0, 'the first payment never landed — do not promise a second');
  assert.equal(nextPaymentUnix(state({ status: 'paused' })), 0, "Stripe's own paused status — nothing is being collected");
  assert.equal(nextPaymentUnix(state({ status: 'unpaid' })), 0, 'Stripe has GIVEN UP retrying, so the period end is a date no card is hit on');
  assert.equal(nextPaymentUnix(state({ endedAtUnix: at('2026-07-01T09:00:00Z') })), 0);
  assert.equal(nextPaymentUnix(state({ cancelAtPeriodEnd: true })), 0, 'it ends at the boundary instead of renewing');
  // An end date BEFORE the boundary stops the renewal; one after it does not.
  assert.equal(nextPaymentUnix(state({ cancelAtUnix: at('2026-07-15T09:00:00Z') })), 0);
  assert.equal(nextPaymentUnix(state({ cancelAtUnix: at('2026-09-15T09:00:00Z') })), periodEnd, 'one more charge is still coming');
  // A past_due plan is still trying, so its next attempt is real news for the admin.
  assert.equal(nextPaymentUnix(state({ status: 'past_due' })), periodEnd);
});

test('endsAtUnix: 0 means open-ended, which is what a donation normally is', () => {
  assert.equal(endsAtUnix(state()), 0);
  assert.equal(endsAtUnix(state({ cancelAtUnix: at('2026-12-31T23:59:59Z') })), at('2026-12-31T23:59:59Z'));
  assert.equal(endsAtUnix(state({ cancelAtPeriodEnd: true })), at('2026-08-01T09:00:00Z'), 'stopping at period end ends at the period end');
  assert.equal(
    endsAtUnix(state({ cancelAtUnix: at('2026-12-31T23:59:59Z'), cancelAtPeriodEnd: true })),
    at('2026-12-31T23:59:59Z'),
    'an explicit end date wins',
  );
});

test('endsAtUnix: a plan stopped by hand reports WHEN it stopped, never "open-ended"', () => {
  // subscriptions.cancel sets ended_at and leaves cancel_at null. Reading only the schedule
  // fields would make a just-stopped plan claim it keeps going, one row under a "Stopped" pill.
  const ended = state({ status: 'canceled', endedAtUnix: at('2026-07-20T12:00:00Z'), currentPeriodEndUnix: at('2026-08-01T09:00:00Z') });
  assert.equal(endsAtUnix(ended), at('2026-07-20T12:00:00Z'));
  assert.equal(nextPaymentUnix(ended), 0, 'and nothing more is coming');
});

test('planIsOver: only a plan Stripe will never invoice again', () => {
  assert.equal(planIsOver(state()), false);
  assert.equal(planIsOver(state({ status: 'past_due' })), false, 'a failed renewal may still be retried');
  assert.equal(planIsOver(state({ paused: true })), false, 'a paused plan can be resumed');
  assert.equal(planIsOver(state({ status: 'canceled' })), true);
  assert.equal(planIsOver(state({ status: 'incomplete_expired' })), true);
  assert.equal(planIsOver(state({ endedAtUnix: at('2026-07-20T12:00:00Z') })), true);
});

// ── mapWithLimit ──────────────────────────────────────────────────────────────

test('mapWithLimit: keeps input order and never exceeds the concurrency limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 23 }, (_, i) => i);
  const out = await mapWithLimit(items, 5, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, n % 3));
    inFlight -= 1;
    return n * 2;
  });
  assert.deepEqual(out, items.map((n) => n * 2), 'results stay in input order despite finishing out of order');
  assert.ok(peak <= 5, `a Pi must not open more than 5 sockets at once (peak was ${peak})`);
  assert.deepEqual(await mapWithLimit([], 5, async () => 1), [], 'no plans → no workers, no hang');
});

// ── the structural guarantee, against a real DB ───────────────────────────────

test('STRUCTURAL: tuition can never become a "plan" — it has no donations row to fold', () => {
  // §13 route isolation: a tuition payment is written to `student_payments` and NEVER to
  // `donations`. So the Monthly-plans index cannot show it — not because we filter it, but
  // because there is nothing there. This asserts that against a real DB rather than a
  // fixture, because it is the property that stops tuition money being counted as a
  // donation (and stops another app's subscriptions appearing in a shared Stripe account).
  const s = new Store(':memory:');
  try {
    const tuitionCampaign = s.createCampaign({ title: 'School fees', stripeAccountId: 'acct_test', type: 'tuition' });
    const general = s.createCampaign({ title: 'General Fund', stripeAccountId: 'acct_test' });

    // A real monthly donation plan (must appear).
    s.createDonation({
      campaignId: general.id,
      stripeAccountId: 'acct_test',
      amount: 2500,
      currency: 'GBP',
      status: 'succeeded',
      donorName: 'Aisha',
      donorEmail: 'aisha@example.org',
      coverFees: false,
      giftAid: true,
      paymentIntentId: 'pi_plan_1',
      recurring: true,
      subscriptionId: 'sub_ours',
    });
    // A one-time donation on the same campaign (must NOT appear).
    s.createDonation({
      campaignId: general.id,
      stripeAccountId: 'acct_test',
      amount: 9900,
      currency: 'GBP',
      status: 'succeeded',
      donorName: 'Yusuf',
      donorEmail: '',
      coverFees: false,
      giftAid: false,
      paymentIntentId: 'pi_oneoff_1',
    });
    // A tuition payment, succeeded and queued for the Students push — the most "plan-like"
    // recurring-looking money in the box, and still invisible here.
    s.createStudentPayment({
      campaignId: tuitionCampaign.id,
      stripeAccountId: 'acct_test',
      paymentIntentId: 'pi_tuition_1',
      familyId: 'fam_x1',
      studentId: 'stu_1',
      familyLabel: 'Ismail family',
      amount: 35000,
      currency: 'GBP',
      allocations: '',
      studentsSplit: '',
      paymentLines: '',
    });
    s.markStudentPaymentPaid('pi_tuition_1', 'succeeded', new Date().toISOString());

    const rows = s.listRecurringDonations();
    assert.deepEqual(rows.map((d) => d.paymentIntentId), ['pi_plan_1'], 'only the plan row — not the one-off, not the tuition payment');

    const seeds = groupPlanSeeds(rows);
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0].subscriptionId, 'sub_ours');
    assert.equal(seeds[0].campaignId, general.id, 'and it belongs to the donation campaign, never the tuition one');
    assert.equal(seeds[0].collectedMinor, 2500);
    assert.equal(seeds[0].payments, 1);
    // Belt and braces: nothing anywhere in the index points at the tuition campaign or its PI.
    const dump = JSON.stringify(seeds);
    assert.ok(!dump.includes(tuitionCampaign.id), 'no tuition campaign leaks into a plan');
    assert.ok(!dump.includes('pi_tuition_1'));
    assert.ok(!dump.includes('fam_x1'));
    // The tuition payment is still safe in its own ledger — we excluded it, not lost it.
    assert.equal(s.getStudentPaymentByPI('pi_tuition_1')?.amount, 35000);
  } finally {
    s.close();
  }
});

test('STRUCTURAL: listRecurringDonations is oldest-first and skips a blank subscription id', () => {
  const s = new Store(':memory:');
  try {
    const c = s.createCampaign({ title: 'General', stripeAccountId: 'acct_test' });
    const base = {
      campaignId: c.id,
      stripeAccountId: 'acct_test',
      currency: 'GBP',
      status: 'succeeded' as const,
      donorName: 'A',
      donorEmail: '',
      coverFees: false,
      giftAid: false,
      amount: 1000,
    };
    s.createDonation({ ...base, paymentIntentId: 'pi_new', recurring: true, subscriptionId: 'sub_1', createdAt: '2026-03-01T00:00:00.000Z' });
    s.createDonation({ ...base, paymentIntentId: 'pi_old', recurring: true, subscriptionId: 'sub_1', createdAt: '2026-01-01T00:00:00.000Z' });
    // recurring, but no subscription — a row like this must not seed a phantom plan.
    s.createDonation({ ...base, paymentIntentId: 'pi_nosub', recurring: true, subscriptionId: '' });
    assert.deepEqual(
      s.listRecurringDonations().map((d) => d.paymentIntentId),
      ['pi_old', 'pi_new'],
      'oldest first, so the first row of each subscription is the origin',
    );
  } finally {
    s.close();
  }
});

test('STORE: a reconciled renewal keeps the date the money actually arrived, and its card', () => {
  // The one widening of createDonation this feature is allowed. It exists so a renewal we
  // catch up on weeks later lands in the right month in the donations log and the 6-month
  // trend chart — stamping it "today" would quietly move income between months.
  const s = new Store(':memory:');
  try {
    const c = s.createCampaign({ title: 'General', stripeAccountId: 'acct_test' });
    const base = {
      campaignId: c.id,
      stripeAccountId: 'acct_test',
      currency: 'GBP',
      donorName: 'Aisha',
      donorEmail: 'aisha@example.org',
      coverFees: false,
      giftAid: false,
      amount: 2500,
    };
    const back = s.createDonation({
      ...base,
      status: 'succeeded',
      paymentIntentId: 'pi_renewal',
      recurring: true,
      subscriptionId: 'sub_ours',
      createdAt: '2026-05-01T09:00:00.000Z',
      cardBrand: 'visa',
      cardLast4: '4242',
      receipt: 'stripe',
    });
    assert.equal(back.createdAt, '2026-05-01T09:00:00.000Z');
    const read = s.getDonationByPaymentIntent('pi_renewal')!;
    assert.equal(read.createdAt, '2026-05-01T09:00:00.000Z', 'the backdated date survives the round-trip');
    assert.equal(read.cardBrand, 'visa', 'the card is written by the INSERT, not only by markDonation');
    assert.equal(read.cardLast4, '4242');
    assert.equal(read.receipt, 'stripe', 'a catch-up never owes a letter');

    // Every existing caller (which omits all three) must behave exactly as before.
    const plain = s.createDonation({ ...base, paymentIntentId: 'pi_plain' });
    assert.equal(plain.status, 'pending');
    assert.equal(plain.cardBrand, '');
    assert.equal(plain.cardLast4, '');
    assert.equal(plain.recurring, false);
    assert.equal(plain.subscriptionId, '');
    assert.equal(plain.receipt, 'stripe');
    assert.ok(Date.now() - new Date(plain.createdAt).getTime() < 60_000, 'no createdAt → now');
    // An explicitly-undefined field must still fall back, never write undefined.
    const undef = s.createDonation({ ...base, paymentIntentId: 'pi_undef', createdAt: undefined, cardBrand: undefined, cardLast4: undefined });
    assert.notEqual(undef.createdAt, undefined);
    assert.equal(s.getDonationByPaymentIntent('pi_undef')!.cardBrand, '');

    // And the plan built from these rows reads the right money and the right dates.
    const [seed] = groupPlanSeeds(s.listRecurringDonations());
    assert.equal(seed.startedAt, '2026-05-01T09:00:00.000Z');
    assert.equal(seed.lastPaymentAt, '2026-05-01T09:00:00.000Z');
    assert.equal(seed.cardLast4, '4242');
  } finally {
    s.close();
  }
});
