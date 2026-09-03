// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Refunds — giving a donation back to the donor from the admin panel.
 *
 * WHERE THE TRUTH LIVES. Not here. How much of a charge has already been given back is a fact
 * about the Stripe charge (`amount_refunded`), and it can change without this app being involved
 * at all: a masjid can refund from Stripe's own dashboard, and a LAN-only box may never receive
 * the webhook that would have told it. So every refund we perform reads the charge FIRST and
 * computes what is left to refund from Stripe's own figures — never from our stored row, which is
 * a cache of that fact and may be behind. Our row is then brought into line with what Stripe
 * says (store.setDonationRefund), which is also the repair path for a dashboard refund.
 *
 * The file is in two halves, like plans.ts: everything above "Stripe transport" is PURE and
 * unit-tested (no client, no I/O, no clock), and everything below fails SOFT — it returns a
 * result object with a friendly message instead of throwing, so an unreachable Stripe leaves the
 * donation exactly as it was and the admin is told to try again.
 */
import type Stripe from 'stripe';
import { makeLog } from './logger';
import { requiresMultipleOfTen, stripeClient } from './stripe';
import type { StripeConfig } from './store';

const log = makeLog('refunds');

// ── (a) PURE, testable logic ──────────────────────────────────────────────────

/** The smallest refund we will send: one minor unit. Below that there is nothing to give back
 *  and Stripe would reject it anyway. (For a three-decimal currency the real floor is 10 —
 *  `resolveRefundAmount` applies it, because only it knows the currency.) */
export const MIN_REFUND_MINOR = 1;

/** Why the money is going back. These are Stripe's own three reasons and no others — the API
 *  rejects anything else — so the admin picks from exactly this set.
 *
 *  'fraudulent' is not a synonym for the other two: it marks the charge as fraud in Stripe, which
 *  feeds Radar and the masjid's dispute record. It is offered because a masjid taking public
 *  donations does meet card testing, but it is never the default. */
export const REFUND_REASONS = ['requested_by_customer', 'duplicate', 'fraudulent'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];


/** How much of a charge can still be given back, in minor units. Never negative: an
 *  `amount_refunded` that somehow exceeds the amount captured means there is nothing left,
 *  not that we owe the donor money. */
export function refundableMinor(capturedMinor: number, alreadyRefundedMinor: number): number {
  const captured = Math.max(0, Math.round(capturedMinor || 0));
  const refunded = Math.max(0, Math.round(alreadyRefundedMinor || 0));
  return Math.max(0, captured - refunded);
}

/** How a donation should READ, given what was charged and what has come back. Used for the
 *  badge in the donations list and for the wording in every alert. */
export type RefundState = 'none' | 'partial' | 'full';
export function refundState(amountMinor: number, refundedMinor: number): RefundState {
  if (refundedMinor <= 0) return 'none';
  return refundedMinor >= amountMinor ? 'full' : 'partial';
}

/** Work out the amount to refund, in minor units.
 *
 *  `requestedMinor` undefined means "all of it" — the whole remaining balance, which is both the
 *  common case and the one that must be exact to the penny (a full refund that leaves 1p behind
 *  is a support conversation). A number means a part refund and is checked against what is
 *  actually left, using STRIPE's figure for what is left, not ours.
 *
 *  The three-decimal currencies (KWD, BHD, …) are quoted in thousandths and Stripe requires the
 *  minor amount to be a MULTIPLE OF TEN — the same rule that made charges wrong by a factor of
 *  ten before DONATIONS-001. A typed part refund is therefore snapped to the nearest 10 and
 *  clamped to what is left; a full refund needs no snapping, since it is exactly what was
 *  charged and that already satisfied the rule.
 *
 *  Discriminated on `ok` rather than on the presence of `error`, so the caller can use `amount`
 *  without a non-null assertion (an empty-string error is not something TypeScript can rule out). */
export type ResolvedRefund = { ok: true; amount: number } | { ok: false; error: string };
export function resolveRefundAmount(requestedMinor: number | undefined, refundable: number, currency: string): ResolvedRefund {
  const step = requiresMultipleOfTen(currency) ? 10 : MIN_REFUND_MINOR;
  if (refundable < step) return { ok: false, error: 'This donation has already been fully refunded.' };
  if (requestedMinor === undefined) return { ok: true, amount: refundable };
  if (!Number.isFinite(requestedMinor)) return { ok: false, error: 'Please enter an amount to refund.' };
  let amount = Math.round(requestedMinor);
  if (amount <= 0) return { ok: false, error: 'Please enter an amount above zero.' };
  if (step > 1) amount = Math.max(step, Math.round(amount / step) * step);
  if (amount > refundable) return { ok: false, error: 'That’s more than is left to refund on this donation.' };
  if (amount < step) return { ok: false, error: 'That amount is too small to refund.' };
  return { ok: true, amount };
}

/** ONE plain sentence for a refund that Stripe refused, or '' when there is nothing to say.
 *
 *  Stripe's own `.message` is written for humans ("Insufficient funds in your Stripe account…"),
 *  and for a refund it is usually the single most useful thing the admin can be told, so it is
 *  passed through. But a masjid must never read a bare machine code, and never a multi-paragraph
 *  dump, so anything that isn't a sentence becomes our own words. Mirrors plans.ts failureReason;
 *  kept separate because the fallback wording is about refunds, not declines. */
const GENERIC_REFUND_FAILURE = 'Stripe wouldn’t process this refund. Please check the payment in your Stripe dashboard.';
export function refundFailureMessage(raw?: string | null): string {
  const s = (raw ?? '').trim();
  if (!s) return GENERIC_REFUND_FAILURE;
  // A single token, or a snake_case identifier, is a code and not a sentence.
  if (!/\s/.test(s) || /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(s)) return GENERIC_REFUND_FAILURE;
  const first = s.split('\n')[0].split(/(?<=[.!?])\s+/)[0].slice(0, 200).trim();
  if (!first) return GENERIC_REFUND_FAILURE;
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

// ── (b) Stripe transport — never throws ───────────────────────────────────────

/** What Stripe says about a charge's refunds right now. `capturedMinor` is what the donor was
 *  actually charged (the captured amount on the charge, which is the only thing refundable). */
export interface ChargeRefundState {
  capturedMinor: number;
  refundedMinor: number;
  currency: string;
  chargeId: string;
}

/** The outcome of asking Stripe to refund. `refundedTotalMinor` is the charge's new RUNNING
 *  TOTAL (what to store), not the size of this one refund — that is `amountMinor`. */
export type RefundOutcome =
  | { ok: true; amountMinor: number; refundedTotalMinor: number; refundId: string; pending: boolean }
  | { ok: false; error: string; retry: boolean };

/** Read a PaymentIntent's refund position from Stripe. Null = we couldn't reach Stripe, or the
 *  payment has no charge to refund (an intent that never completed). */
export async function fetchChargeRefundState(secretKey: string, paymentIntentId: string): Promise<ChargeRefundState | null> {
  try {
    const pi = await stripeClient(secretKey).paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const charge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;
    if (!charge) return null; // nothing was captured, so there is nothing to give back
    return {
      // `amount_captured` is the figure that can be refunded — not `pi.amount`, which is only
      // what we ASKED for, and not `charge.amount`, which for a partial capture is more than
      // the donor actually paid.
      capturedMinor: charge.amount_captured ?? charge.amount ?? pi.amount,
      refundedMinor: charge.amount_refunded ?? 0,
      currency: (charge.currency ?? pi.currency ?? '').toUpperCase(),
      chargeId: charge.id,
    };
  } catch (err) {
    log.warn(`couldn’t read the refund position of ${paymentIntentId}: ${err instanceof Error ? err.message : 'error'}`);
    return null;
  }
}

/**
 * Refund `amountMinor` of a PaymentIntent. `alreadyRefundedMinor` is the running total Stripe
 * reported a moment ago, used only to work out the new running total to store.
 *
 * The idempotency key must be supplied by the caller and must be STABLE for one intended refund
 * (see the route: it is derived from the payment, the amount and the amount already refunded), so
 * a double-clicked button or a retried request sends the money back once. A genuinely separate
 * second part refund has a different "already refunded" figure and so a different key.
 *
 * Never throws. `retry: true` marks a failure that could plausibly succeed later (Stripe
 * unreachable, a timeout); `retry: false` means Stripe has answered and refused.
 */
export async function createRefund(
  account: StripeConfig,
  paymentIntentId: string,
  amountMinor: number,
  reason: RefundReason | undefined,
  alreadyRefundedMinor: number,
  idempotencyKey: string,
): Promise<RefundOutcome> {
  try {
    const refund = await stripeClient(account.secretKey).refunds.create(
      {
        payment_intent: paymentIntentId,
        amount: amountMinor,
        ...(reason ? { reason } : {}),
        // So the masjid can tell, in Stripe's own dashboard, that this came from the panel
        // rather than from someone clicking around in Stripe.
        metadata: { app: 'donations', via: 'admin-panel' },
      },
      { idempotencyKey },
    );
    // 'failed' and 'canceled' mean the money did NOT go back. Recording them would put a refund
    // in the masjid's ledger that never happened, so they are reported as failures.
    if (refund.status === 'failed' || refund.status === 'canceled') {
      return { ok: false, error: refundFailureMessage(refund.failure_reason), retry: false };
    }
    return {
      ok: true,
      amountMinor: refund.amount,
      refundedTotalMinor: Math.max(0, Math.round(alreadyRefundedMinor)) + refund.amount,
      refundId: refund.id,
      // 'pending' / 'requires_action': Stripe has accepted it and the money is on its way, which
      // is normal for some payment methods. It counts as refunded — Stripe will not let us
      // refund it twice — but the admin is told it may take a few days to show.
      pending: refund.status !== 'succeeded',
    };
  } catch (err) {
    const e = err as Partial<Stripe.errors.StripeError> & { message?: string };
    // A connection/timeout error is the only kind worth retrying; anything Stripe answered with
    // (an invalid request, an already-refunded charge, an insufficient balance) will answer the
    // same way again, and inviting a retry would invite a double refund.
    const retry = e.type === 'StripeConnectionError' || e.type === 'StripeAPIError';
    log.warn(`refund of ${paymentIntentId} failed: ${e.message ?? 'error'}`);
    return {
      ok: false,
      error: retry ? 'We couldn’t reach Stripe to make this refund. Please try again in a moment.' : refundFailureMessage(e.message),
      retry,
    };
  }
}
