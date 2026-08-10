// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Monthly plans — the admin's view of recurring (subscription) donations.
 *
 * WHERE THE DATA COMES FROM. A masjid box is usually LAN-only, so inbound Stripe
 * webhooks cannot be relied on (CLAUDE.md §5). So this feature is split three ways:
 *
 *  1. The INDEX of plans is LOCAL: the `donations` rows with recurring=1 and a
 *     subscription_id. `groupPlanSeeds` folds them into one "seed" per subscription,
 *     the earliest row being the plan's origin (campaign, Stripe account, donor,
 *     currency, cover-fees, Gift Aid, card). Two security properties fall out of that
 *     and must be kept: a subscription WE did not create can never appear (it has no
 *     local row — which matters in a shared Fabric Stripe account, where another app's
 *     subscriptions live in the same Stripe account), and TUITION can never appear
 *     (a tuition payment is written to `student_payments`, never to `donations` — the
 *     donation routes reject `type === 'tuition'` outright, §13 — so there is no row
 *     here for it to be grouped from; it is structurally absent, not filtered out).
 *  2. PLAN STATE (status, next payment, interval, end date, card) is fetched LIVE from
 *     Stripe per plan — an outbound HTTPS call, which always works.
 *  3. MONEY (collected / payments / last payment) is LOCAL, summed over those rows —
 *     which is only truthful if renewals are recorded, hence the reconciliation the
 *     route performs while syncing (see index.ts).
 *
 * This file is deliberately in two halves: everything above "Stripe transport" is PURE
 * and unit-testable (no Stripe client, no I/O, no hidden clock — a caller passes `now`),
 * and everything below fails SOFT — it returns null instead of throwing, exactly like
 * students.ts, so a Stripe outage degrades the tab instead of breaking it.
 */
import type { Donation } from './store';
import { makeLog } from './logger';
import { stripeClient } from './stripe';

const log = makeLog('plans');

/** Seconds in a day — the clearance we leave around a scheduled charge instant. */
export const DAY_SECONDS = 86_400;

/** The most "further payments" an admin may schedule (10 years of monthly). */
export const MAX_FURTHER_PAYMENTS = 120;

/** How long a monthly sign-up has to actually go through before we stop calling it a plan. */
export const ABANDONED_MS = 24 * 3600_000;

// ── (a) PURE, testable logic ──────────────────────────────────────────────────

/** The local half of a plan: who set it up, for what, and how much has actually
 *  arrived. All money in MINOR units (major units happen at the API boundary only). */
export interface PlanSeed {
  subscriptionId: string;
  /** The id of the FIRST donation row — the plan's display ref is derived from it. */
  firstDonationId: string;
  campaignId: string;
  stripeAccountId: string;
  donorName: string;
  donorEmail: string;
  currency: string;
  /** What the first charge was, in minor units — the fallback when Stripe's price is
   *  unreadable (a tiered/custom price has `unit_amount: null`). */
  amountMinor: number;
  coverFees: boolean;
  giftAid: boolean;
  cardBrand: string;
  cardLast4: string;
  /** ISO — when the plan started, i.e. the first donation row's date. */
  startedAt: string;
  /** ISO of the newest SUCCEEDED payment, '' when none has succeeded yet. */
  lastPaymentAt: string;
  collectedMinor: number;
  payments: number;
}

/** Fold recurring donation rows into one seed per subscription.
 *
 *  Input order does not matter (we sort), so this is safe to call with either
 *  `listRecurringDonations()` (oldest first) or `listDonations()` (newest first).
 *  Output is NEWEST PLAN FIRST, which is both the tab's ordering and the order the
 *  200-plan refresh cap is applied in. */
export function groupPlanSeeds(donations: Donation[]): PlanSeed[] {
  // Only rows that really belong to a plan. A blank subscription_id would otherwise
  // collapse every one-off row into one bogus "plan".
  const rows = donations
    .filter((d) => d.recurring && d.subscriptionId)
    // ISO 8601 strings sort lexicographically; the id tie-break keeps the "first row"
    // deterministic when two rows share a timestamp.
    .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1));

  const bySub = new Map<string, PlanSeed>();
  for (const d of rows) {
    let seed = bySub.get(d.subscriptionId);
    if (!seed) {
      // First row wins for every descriptive field — it is the one the donor actually
      // filled in; renewals are copies of it.
      seed = {
        subscriptionId: d.subscriptionId,
        firstDonationId: d.id,
        campaignId: d.campaignId,
        stripeAccountId: d.stripeAccountId,
        donorName: d.donorName,
        donorEmail: d.donorEmail,
        currency: d.currency.toUpperCase(),
        amountMinor: d.amount,
        coverFees: d.coverFees,
        giftAid: d.giftAid,
        cardBrand: d.cardBrand,
        cardLast4: d.cardLast4,
        startedAt: d.createdAt,
        lastPaymentAt: '',
        collectedMinor: 0,
        payments: 0,
      };
      bySub.set(d.subscriptionId, seed);
    }
    // Only money that actually landed counts — a pending or failed row is not income. And only
    // the part of it the masjid KEPT: a refunded payment is money that came and went, so it comes
    // off "collected so far" (as it comes off every other total) while still counting as one of
    // the plan's payments — it did happen, and the donations list still shows it.
    if (d.status === 'succeeded') {
      seed.collectedMinor += Math.max(0, d.amount - d.refundedAmount);
      seed.payments += 1;
      if (d.createdAt > seed.lastPaymentAt) seed.lastPaymentAt = d.createdAt;
    }
  }
  return [...bySub.values()].sort((a, b) =>
    a.startedAt === b.startedAt ? a.subscriptionId.localeCompare(b.subscriptionId) : a.startedAt < b.startedAt ? 1 : -1,
  );
}

/** True for a seed that is really an ABANDONED monthly checkout, not a plan.
 *
 *  The recurring donation row is written at `/…/intent` — BEFORE the donor has entered a
 *  card — so every monthly checkout somebody starts and walks away from leaves a row behind
 *  for a subscription that never collected a penny. Left alone those pile up for ever
 *  (£0 collected, later reported "Stopped"), and a visitor on the masjid's own network can
 *  create them without logging in, so they must never be able to crowd out a real plan.
 *
 *  WHERE THIS MAY BE USED — and where it may NOT. A plan whose first payment really DID
 *  succeed, but whose /confirm never round-tripped (the donor closed the tab), also has
 *  `payments === 0` in our table. Reconciliation is what puts that row right. So this
 *  predicate may only be applied AFTER a sync + reconciliation, to decide what to show —
 *  never as a filter on the index that feeds the sync, or we would hide exactly the row we
 *  needed to heal, permanently. */
export function isAbandonedSeed(seed: PlanSeed, nowMs: number): boolean {
  if (seed.payments > 0) return false; // money arrived: it is a real plan, whatever its state
  const started = Date.parse(seed.startedAt);
  // An unreadable date is never grounds for hiding somebody's plan.
  if (!Number.isFinite(started)) return false;
  return nowMs - started > ABANDONED_MS;
}

/** The order the live-refresh cap is applied in: plans that have actually taken money first,
 *  then the never-paid ones, newest first within each group (the input's own order).
 *
 *  This is what stops the cap starving real plans. The cap is there so a Pi doesn't make
 *  thousands of Stripe calls, but filled newest-first a burst of abandoned sign-ups would
 *  fill it entirely — and every real plan would then stop being reconciled, silently. */
export function planSyncOrder(seeds: PlanSeed[]): PlanSeed[] {
  return [...seeds.filter((s) => s.payments > 0), ...seeds.filter((s) => s.payments === 0)];
}

/** Warm words for a billing interval, e.g. "Monthly", "Every 3 months". '' when we
 *  don't know the interval (Stripe unreachable), so the UI simply omits it rather
 *  than claiming a schedule we can't see. */
export function frequencyLabel(interval: string, intervalCount: number): string {
  if (!interval) return '';
  const n = Math.round(intervalCount);
  if (n <= 1) {
    switch (interval) {
      case 'day':
        return 'Daily';
      case 'week':
        return 'Weekly';
      case 'month':
        return 'Monthly';
      case 'year':
        return 'Yearly';
      default:
        return '';
    }
  }
  return `Every ${n} ${interval}s`;
}

export type PlanStatus = 'active' | 'paused' | 'past_due' | 'unpaid' | 'incomplete' | 'trialing' | 'canceled' | 'unknown';

/** Stripe's status → what a masjid admin should read.
 *
 *  `paused` is checked FIRST and deliberately: pausing a donation plan is
 *  `pause_collection`, not a Stripe status, and the subscription stays `active`
 *  underneath. Reading `sub.status` first would report a paused plan as Active. */
export function friendlyStatus(stripeStatus: string, paused: boolean): { status: PlanStatus; label: string } {
  if (paused) return { status: 'paused', label: 'Paused' };
  switch (stripeStatus) {
    case 'active':
      return { status: 'active', label: 'Active' };
    // Stripe's own `paused` STATUS — a different thing from `pause_collection` above, and a
    // real value of Subscription.Status. Either way the masjid reads the same word.
    case 'paused':
      return { status: 'paused', label: 'Paused' };
    case 'past_due':
      return { status: 'past_due', label: 'Payment failed' };
    case 'unpaid':
      return { status: 'unpaid', label: 'Unpaid' };
    case 'incomplete':
      return { status: 'incomplete', label: 'Not finished' };
    case 'trialing':
      return { status: 'trialing', label: 'Trial' };
    case 'canceled':
    // Stripe's eighth status: an `incomplete` plan whose very first payment never landed
    // within ~23 hours. For a masjid that is simply a plan that never got going.
    case 'incomplete_expired':
      return { status: 'canceled', label: 'Stopped' };
    default:
      return { status: 'unknown', label: 'Not known' };
  }
}

export type InvoiceStatus = 'paid' | 'open' | 'draft' | 'void' | 'uncollectible' | 'unknown';

/** Stripe's invoice status → warm words. `status` is nullable on the Stripe object, so
 *  null and anything unrecognised both land on 'unknown'. */
export function invoiceStatusLabel(status: string | null | undefined): { status: InvoiceStatus; label: string } {
  switch (status) {
    case 'paid':
      return { status: 'paid', label: 'Paid' };
    case 'open':
      return { status: 'open', label: 'Waiting' };
    case 'draft':
      return { status: 'draft', label: 'Not sent yet' };
    case 'void':
      return { status: 'void', label: 'Cancelled' };
    // "Uncollectible" and "written off" are accounts-package words. What it means to a masjid
    // is that Stripe stopped trying and the money never came.
    case 'uncollectible':
      return { status: 'uncollectible', label: 'Not collected' };
    default:
      return { status: 'unknown', label: 'Not known' };
  }
}

/** What we say when the only thing Stripe gave us is a machine code. */
const GENERIC_FAILURE = 'This payment didn’t go through — the donor may need to check with their bank.';

/** ONE plain sentence explaining why a renewal failed, or ''.
 *
 *  Precedence: the PaymentIntent's own error (the card decline the donor's bank sent),
 *  then the invoice's finalisation error, then nothing. Stripe's `.message` is already
 *  written for humans, so we pass it through — but we never surface a bare code like
 *  `card_declined` to a masjid, and we never let a multi-sentence dump through. */
export function failureReason(paymentIntentMessage?: string | null, finalizationMessage?: string | null): string {
  const raw = (paymentIntentMessage ?? '').trim() || (finalizationMessage ?? '').trim();
  if (!raw) return '';
  // A single token, or a snake_case identifier, is a code and not a sentence.
  if (!/\s/.test(raw) || /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(raw)) return GENERIC_FAILURE;
  // First sentence only, bounded, and finished with a full stop.
  const first = raw.split('\n')[0].split(/(?<=[.!?])\s+/)[0].slice(0, 200).trim();
  if (!first) return GENERIC_FAILURE;
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

/** Unix seconds → ISO string, '' for "we don't know" (0/absent). */
export function isoFromUnix(unix: number): string {
  if (!Number.isFinite(unix) || unix <= 0) return '';
  return new Date(Math.round(unix) * 1000).toISOString();
}

/** Add whole months to a UTC date IN PLACE, clamping the day to the target month's
 *  length (31 Jan + 1 month → 28/29 Feb). That clamp is not a detail: it is what Stripe
 *  itself does with a monthly billing anchor, so our arithmetic lands on the same day
 *  Stripe will actually charge. */
function addMonthsUTC(d: Date, months: number): void {
  const day = d.getUTCDate();
  d.setUTCDate(1); // avoid the classic 31st → "next month +1" overflow while shifting
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfMonth));
}

/** `from` (unix seconds) plus `times` billing intervals. Returns 0 when the interval is
 *  one we don't recognise — the caller must treat 0 as "can't work this out" and refuse
 *  rather than guess a cancel date. */
export function addIntervals(fromUnix: number, interval: string, intervalCount: number, times: number): number {
  if (!Number.isFinite(fromUnix) || fromUnix <= 0) return 0;
  const step = Math.max(1, Math.round(intervalCount || 1));
  const n = Math.round(times);
  const d = new Date(Math.round(fromUnix) * 1000);
  switch (interval) {
    case 'day':
      d.setUTCDate(d.getUTCDate() + step * n);
      break;
    case 'week':
      d.setUTCDate(d.getUTCDate() + 7 * step * n);
      break;
    case 'month':
      addMonthsUTC(d, step * n);
      break;
    case 'year':
      addMonthsUTC(d, 12 * step * n);
      break;
    default:
      return 0;
  }
  return Math.floor(d.getTime() / 1000);
}

/** The last instant of a 'YYYY-MM-DD' calendar day, UTC, in unix seconds. Returns null
 *  for anything that isn't a real date (including 2026-02-31, which Date would happily
 *  roll over into March). END of day, not start, so "stop on the 30th" includes the 30th. */
export function endOfDayUnix(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day, 23, 59, 59);
  const check = new Date(ms);
  // Reject a rolled-over date (31 February) rather than silently ending a month late.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return Math.floor(ms / 1000);
}

/** "Stop after N MORE payments" → the `cancel_at` to set.
 *
 *  Charges land at `nextPaymentUnix`, then one interval later, and so on. So for
 *  `remaining` further charges the last one we want is at
 *  `nextPaymentUnix + (remaining - 1) intervals`, and we must cancel strictly AFTER that
 *  and strictly BEFORE the following one. We aim a day short of the following charge —
 *  never ON a charge instant, which would be a race with Stripe's billing job.
 *
 *  For a very short interval (a daily plan) a whole day would overshoot back past the
 *  last charge we promised, so the clearance is capped at half the gap. Returns null when
 *  the request is out of range or the schedule can't be worked out; the caller turns that
 *  into its own friendly sentence. */
export function cancelAtAfterCharges(nextPaymentUnix: number, interval: string, intervalCount: number, remaining: number): number | null {
  if (!Number.isInteger(remaining) || remaining < 1 || remaining > MAX_FURTHER_PAYMENTS) return null;
  if (!Number.isFinite(nextPaymentUnix) || nextPaymentUnix <= 0) return null;
  const lastCharge = remaining === 1 ? Math.round(nextPaymentUnix) : addIntervals(nextPaymentUnix, interval, intervalCount, remaining - 1);
  const followingCharge = addIntervals(nextPaymentUnix, interval, intervalCount, remaining);
  if (!lastCharge || !followingCharge || followingCharge <= lastCharge) return null;
  const clearance = Math.min(DAY_SECONDS, Math.floor((followingCharge - lastCharge) / 2));
  const at = followingCharge - clearance;
  return at > lastCharge ? at : null;
}

/** The live half of a plan, as read from Stripe. Money in MINOR units. */
export interface PlanState {
  /** Stripe's own status string, unmapped (friendlyStatus turns it into words). */
  status: string;
  /** True when `pause_collection` is set — our "paused". */
  paused: boolean;
  /** The price's unit amount, or null for a price with no fixed amount. */
  amountMinor: number | null;
  currency: string;
  interval: string;
  intervalCount: number;
  cardBrand: string;
  cardLast4: string;
  startDateUnix: number;
  currentPeriodEndUnix: number;
  cancelAtUnix: number;
  cancelAtPeriodEnd: boolean;
  endedAtUnix: number;
  /** Half of the cheap change-detector: the newest invoice's id. */
  latestInvoiceId: string;
  /** The other half — whether that newest invoice has been PAID. The id alone is not enough:
   *  when a renewal fails and Stripe retries it, the retry pays the SAME invoice, so the id
   *  never changes and money would go unrecorded until the plan raised its next one. */
  latestInvoicePaid: boolean;
}

/** When Stripe will next take money, in unix seconds, or 0 for "no further payment".
 *  Deliberately conservative — we only promise a date when a charge really is coming. */
export function nextPaymentUnix(state: PlanState): number {
  if (state.paused) return 0; // pause_collection: 'void' — nothing is taken and nothing is owed later
  if (state.endedAtUnix) return 0;
  // canceled / incomplete_expired are over; `incomplete` never got its first payment
  // through, so its period end is not a date we should promise a donor's card will be hit.
  // `paused` is Stripe's own pause status (not pause_collection) — nothing is being collected.
  // `unpaid` means Stripe has GIVEN UP retrying, so the period end is a date the card will
  // never be hit on either; showing it would promise the masjid money that isn't coming.
  if (
    state.status === 'canceled' ||
    state.status === 'incomplete_expired' ||
    state.status === 'incomplete' ||
    state.status === 'paused' ||
    state.status === 'unpaid'
  ) {
    return 0;
  }
  if (state.cancelAtPeriodEnd) return 0; // it ends at the period boundary instead of renewing
  if (state.cancelAtUnix && state.cancelAtUnix <= state.currentPeriodEndUnix) return 0;
  return state.currentPeriodEndUnix;
}

/** True when this plan is finished for good, so Stripe will never raise another invoice for
 *  it. Used to stop re-listing the invoices of dead plans for ever: a plan stopped while its
 *  final invoice was unpaid has a newest invoice that can never become paid, which would
 *  otherwise defeat the "has anything changed?" check on every single refresh. */
export function planIsOver(state: PlanState): boolean {
  return state.endedAtUnix > 0 || state.status === 'canceled' || state.status === 'incomplete_expired';
}

/** When the plan finishes (or finished), in unix seconds, or 0 for open-ended.
 *
 *  `ended_at` comes FIRST: a plan stopped by hand has an `ended_at` and no `cancel_at`, so
 *  reading only the schedule fields would report a plan that has already stopped as
 *  open-ended — the admin would stop a plan and be told in the next breath that it keeps
 *  going. */
export function endsAtUnix(state: PlanState): number {
  if (state.endedAtUnix) return state.endedAtUnix;
  if (state.cancelAtUnix) return state.cancelAtUnix;
  if (state.cancelAtPeriodEnd) return state.currentPeriodEndUnix;
  return 0;
}

/** One invoice of a plan, flattened out of Stripe's object. Money in MINOR units. */
export interface PlanInvoiceRaw {
  id: string;
  number: string;
  /** When it was paid, else when it was created (never 0 in practice). */
  momentUnix: number;
  amountDueMinor: number;
  amountPaidMinor: number;
  currency: string;
  /** Stripe's raw status, '' when null. */
  status: string;
  attempts: number;
  paid: boolean;
  /** '' when the invoice has no PaymentIntent — reconciliation must SKIP those (the
   *  payment_intent_id column is UNIQUE, so inventing a key would collide). */
  paymentIntentId: string;
  failureReason: string;
  hostedUrl: string;
}

/** Run `fn` over `items` with at most `limit` in flight. A Raspberry Pi syncing 200
 *  plans must not open 200 sockets at once; results stay in input order. */
export async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// ── (b) Stripe transport — never throws, returns null on failure ──────────────

/** Error text safe to log: the message only, never a request body. Stripe's messages are
 *  about cards and subscriptions, never our donor records. */
function why(err: unknown): string {
  return err instanceof Error ? err.message : 'error';
}

/** Read a plan's live state from Stripe. Null means "we couldn't reach Stripe" — the
 *  caller then renders the plan from local data with status 'unknown'. */
export async function fetchPlanState(secretKey: string, subscriptionId: string): Promise<PlanState | null> {
  try {
    // `latest_invoice` is expanded so we can see whether it was PAID, not just which one it
    // is — that is what lets a retried (same-invoice) renewal be noticed. Same one call.
    const sub = await stripeClient(secretKey).subscriptions.retrieve(subscriptionId, {
      expand: ['default_payment_method', 'latest_invoice'],
    });
    // Still `string | PaymentMethod | null` after expand — Stripe silently skips expansion
    // past its depth limit — so narrow before touching `.card` (which is itself optional).
    const pm = sub.default_payment_method && typeof sub.default_payment_method === 'object' ? sub.default_payment_method : null;
    const card = pm?.card ?? null;
    // `items.data[0]` is typed as present but is undefined at runtime for a 0-item
    // subscription, so guard it rather than trusting the type.
    const price = sub.items.data.length > 0 ? sub.items.data[0].price : null;
    const recurring = price?.recurring ?? null;
    const latest = sub.latest_invoice;
    // Narrow before reading `.paid` — Stripe skips expansion past its depth limit, and an
    // un-expanded invoice reads as "not paid", which makes us re-list. Erring that way is the
    // safe direction: an extra call, never missed money.
    const latestObj = latest && typeof latest === 'object' ? latest : null;
    return {
      status: sub.status,
      paused: sub.pause_collection != null,
      // null for a tiered/custom price — the caller falls back to the first donation.
      amountMinor: price && price.unit_amount != null ? price.unit_amount : null,
      currency: (price?.currency ?? '').toUpperCase(),
      interval: recurring?.interval ?? '',
      intervalCount: recurring?.interval_count ?? 0,
      cardBrand: card?.brand ?? '',
      cardLast4: card?.last4 ?? '',
      startDateUnix: sub.start_date,
      // In this SDK (17.7) the current period lives on the SUBSCRIPTION, not the item.
      currentPeriodEndUnix: sub.current_period_end,
      cancelAtUnix: sub.cancel_at ?? 0,
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
      endedAtUnix: sub.ended_at ?? 0,
      latestInvoiceId: typeof latest === 'string' ? latest : (latestObj?.id ?? ''),
      latestInvoicePaid: latestObj?.paid === true,
    };
  } catch (err) {
    log.warn(`couldn’t read plan ${subscriptionId} from Stripe: ${why(err)}`);
    return null;
  }
}

/** A plan's recent invoices, newest first (Stripe's own order). Null on failure.
 *  `limit` is clamped to 100 — it comes from PaginationParams, not InvoiceListParams,
 *  and the API rejects anything larger. */
export async function fetchPlanInvoices(secretKey: string, subscriptionId: string, limit = 24): Promise<PlanInvoiceRaw[] | null> {
  try {
    const res = await stripeClient(secretKey).invoices.list({
      subscription: subscriptionId,
      limit: Math.max(1, Math.min(100, Math.round(limit))),
      // Expanded so a decline reason is readable rather than a bare intent id.
      expand: ['data.payment_intent'],
    });
    return res.data.map((inv) => {
      const pi = inv.payment_intent;
      const piObject = pi && typeof pi === 'object' ? pi : null;
      return {
        id: inv.id,
        number: inv.number ?? '',
        momentUnix: inv.status_transitions.paid_at ?? inv.created,
        amountDueMinor: inv.amount_due,
        amountPaidMinor: inv.amount_paid,
        currency: inv.currency.toUpperCase(),
        status: inv.status ?? '',
        attempts: inv.attempt_count,
        paid: inv.paid === true,
        paymentIntentId: typeof pi === 'string' ? pi : (piObject?.id ?? ''),
        failureReason: failureReason(piObject?.last_payment_error?.message, inv.last_finalization_error?.message),
        hostedUrl: inv.hosted_invoice_url ?? '',
      };
    });
  } catch (err) {
    log.warn(`couldn’t list invoices for plan ${subscriptionId}: ${why(err)}`);
    return null;
  }
}

/** Pause collection. 'void' is the only honest behaviour for a donation: the donor is
 *  not charged AND is not billed for the missed months later. Returns false on failure. */
export async function pausePlan(secretKey: string, subscriptionId: string): Promise<boolean> {
  try {
    await stripeClient(secretKey).subscriptions.update(subscriptionId, { pause_collection: { behavior: 'void' } });
    return true;
  } catch (err) {
    log.warn(`couldn’t pause plan ${subscriptionId}: ${why(err)}`);
    return false;
  }
}

/** Resume a paused plan by clearing `pause_collection` (the param is Emptyable, and null
 *  serialises to the empty string the API reads as "clear"). NOT `subscriptions.resume`,
 *  which is for billing-cycle resumption and can raise a catch-up invoice. */
export async function resumePlan(secretKey: string, subscriptionId: string): Promise<boolean> {
  try {
    await stripeClient(secretKey).subscriptions.update(subscriptionId, { pause_collection: null });
    return true;
  } catch (err) {
    log.warn(`couldn’t resume plan ${subscriptionId}: ${why(err)}`);
    return false;
  }
}

/** Stop a plan, straight away.
 *
 *  There is deliberately no "stop at the end of the period" alternative. `cancel_at_period_end`
 *  does NOT take one more payment — Stripe raises no further invoice — and a donation has no
 *  service period left to run out, so the two are financially identical while the second one
 *  sounds like the masjid still receives a month's money. Offering it promised income that
 *  would never arrive. A masjid that genuinely wants one more payment and then a stop uses
 *  "When it ends → stop after 1 further payment", which really does take one. */
export async function cancelPlan(secretKey: string, subscriptionId: string): Promise<boolean> {
  try {
    await stripeClient(secretKey).subscriptions.cancel(subscriptionId);
    return true;
  } catch (err) {
    log.warn(`couldn’t stop plan ${subscriptionId}: ${why(err)}`);
    return false;
  }
}

/** Set (or clear, with null) the instant a plan finishes. `cancel_at_period_end` is
 *  always sent as false: the two ways of ending a plan are mutually exclusive, and it is
 *  not Emptyable, so false — never null — is how it gets cleared. */
export async function setPlanEnd(secretKey: string, subscriptionId: string, cancelAtUnix: number | null): Promise<boolean> {
  try {
    await stripeClient(secretKey).subscriptions.update(subscriptionId, { cancel_at: cancelAtUnix, cancel_at_period_end: false });
    return true;
  } catch (err) {
    log.warn(`couldn’t set the end date for plan ${subscriptionId}: ${why(err)}`);
    return false;
  }
}
