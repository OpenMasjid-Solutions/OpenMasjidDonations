// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Pure text helpers for the notifications this app raises.
 *
 * Here rather than inline in `index.ts` because the sentence a masjid reads is worth a test: it is
 * the whole product of the notification, an admin acts on it, and a wrong figure or a missing appeal
 * name is not something a typecheck can catch. `index.ts` keeps the fan-out and the gates (they close
 * over `store` and the budgets); this keeps the wording, which needs nothing.
 *
 * The money formatter is passed IN rather than imported: currency formatting lives with the server's
 * own `formatMoney`, and taking it as an argument keeps these functions pure and testable without
 * duplicating a second copy of that logic — the mistake this codebase has already made once with a
 * mirror test.
 */

/** One donation the lost-donation sweep found and added. */
export interface Recovered {
  amountMinor: number;
  currency: string;
  /** The appeal's title, already defaulted by the caller — never an id. */
  campaign: string;
}

/** Recoveries collapsed to one row per appeal and currency, biggest money first. */
export interface RecoveryGroup {
  campaign: string;
  currency: string;
  /** How many donations. */
  n: number;
  minor: number;
}

/**
 * Group a sweep's recoveries by appeal.
 *
 * Grouped by appeal AND currency: an appeal settles in one currency, but two appeals on two Stripe
 * accounts need not, and summing across them would print a total that is true of no money anywhere.
 *
 * Sorted biggest first, so that when the rendered list has to be cut the money a masjid most wants to
 * know about is what survives.
 */
export function groupRecoveries(found: readonly Recovered[]): RecoveryGroup[] {
  const by = new Map<string, RecoveryGroup>();
  for (const f of found) {
    // JSON rather than a delimiter: an appeal title is admin-typed, so any separator character could
    // appear inside one and silently merge two appeals into a single row.
    const key = JSON.stringify([f.campaign, f.currency]);
    const g = by.get(key) ?? { campaign: f.campaign, currency: f.currency, n: 0, minor: 0 };
    g.n += 1;
    g.minor += f.amountMinor;
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => b.minor - a.minor);
}

/**
 * "By appeal: “Zakat” — 2 donations, $90.00; “General Fund” — 1 donation, $50.00."
 *
 * WHY THIS EXISTS: the batched recovery notification used to report only a count and a total, which
 * answers "how much" and not "which fund went up" — and the second question is the one a treasurer
 * reconciling a Zakat account actually has. The single-recovery message has always named its appeal;
 * the batch is the one that dropped it.
 *
 * Capped, because the sweep is bounded to 25 rows and a WhatsApp message that long stops being read.
 * What does not fit is COUNTED rather than hidden — a truncated list that looked complete would be
 * the same class of mistake as a suspect window implying it named every lost message.
 *
 * Returns '' for an empty list, so a caller can concatenate it unconditionally.
 */
export function recoveryBreakdown(
  found: readonly Recovered[],
  money: (minor: number, currency: string) => string,
  shown = 6,
): string {
  const groups = groupRecoveries(found);
  if (groups.length === 0) return '';
  const listed = groups
    .slice(0, shown)
    .map((g) => `“${g.campaign}” — ${g.n} ${g.n === 1 ? 'donation' : 'donations'}, ${money(g.minor, g.currency)}`)
    .join('; ');
  const rest = groups.length - Math.min(groups.length, shown);
  return `\n\nBy appeal: ${listed}${rest > 0 ? `; and ${rest} other ${rest === 1 ? 'appeal' : 'appeals'}` : ''}.`;
}
