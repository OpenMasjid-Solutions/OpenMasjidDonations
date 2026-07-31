// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * What's new — the release notes the "What's new" item in the account menu shows.
 *
 * Written for the masjid, not for us: plain, non-technical, what changed FOR YOU. Same voice as
 * the App Store entry in OpenMasjidAPPS `registry.yaml`, and worth keeping consistent with it,
 * since a masjid sees both. Newest first.
 *
 * This module is loaded on demand (a dynamic import when the dialog opens), so it never weighs on
 * the donation page — keep that in mind before importing it from anywhere eagerly. Add an entry as
 * part of the release runbook (CLAUDE.md §16), alongside the version bump.
 */
export interface Release {
  /** Semver, no leading "v" — matched against the running version to mark the current release. */
  version: string;
  /** ISO date (YYYY-MM-DD) the version was tagged. */
  date: string;
  /** One line per change. Sentence case, no trailing full stops needed. */
  notes: string[];
}

export const RELEASES: Release[] = [
  {
    version: '0.37.0',
    date: '2026-07-31',
    notes: [
      'The tuition page is now laid out child by child: each child shows their own balance or credit, their own bills, and an “Add money” button of their own',
      'Money paid ahead now goes to the child you choose, so it lands on their account even when a brother or sister has an older unpaid bill',
      'Bills read as a statement until you choose to pay part of one — the tick boxes only appear once you tap “Choose what to pay”',
      'Each bill is its own card with its lines indented underneath, so a month reads as one thing',
    ],
  },
  {
    version: '0.36.0',
    date: '2026-07-30',
    notes: [
      'Tuition bills can now be paid line by line: a February bill of £200 tuition plus a £50 book fee shows both, so a parent can pay just the book fee',
      'Lines already paid are shown as paid, and a bursary shows as the deduction it is — both for information, neither payable',
      'Everything starts ticked, so paying a whole bill is still one tap, and the running total sits on the pay button',
      'Needs OpenMasjid Students v0.43.0 for itemised bills; older versions keep paying each bill as one thing',
      'New “What’s new” in the account menu (top right) — these notes, so you can see what changed after an update',
    ],
  },
  {
    version: '0.35.0',
    date: '2026-07-28',
    notes: [
      'Parents can pay tuition ahead, even with nothing due — a term up front, or the year in one go',
      'The balance page now says which is true: what is owed, what has already been paid ahead, or nothing due',
      'With several children, each child is listed as owing, in credit, or clear',
      'The smallest card payment is £1/$1, matching the school’s own parent portal, so nobody meets a card decline instead of a friendly message',
    ],
  },
  {
    version: '0.34.0',
    date: '2026-07-28',
    notes: [
      'Paying one particular month of tuition now lands on the right child’s bill (it could previously settle a sibling’s oldest month instead)',
      'Paying a whole balance was never affected',
    ],
  },
  {
    version: '0.33.0',
    date: '2026-07-28',
    notes: [
      'Tuition now takes only the child’s Student ID (e.g. YUS1234) — no PIN to remember or reissue',
      'The page shows the child’s name back and waits for a “yes” before any balance appears, so a mistyped ID is caught',
      'Each child’s own balance is shown behind the household total, and every open month says whose it is',
    ],
  },
  {
    version: '0.32.0',
    date: '2026-07-21',
    notes: [
      'The emailed receipt is designed on the Thank-you tab; the on/off switch and “send me a test” live in Settings',
      '“Send me a test” reaches you, the admin, through your OpenMasjidOS alert settings',
    ],
  },
  {
    version: '0.29.0',
    date: '2026-07-20',
    notes: [
      'Branded, Stripe-style receipt emails for donors, sent through OpenMasjidOS — this app never sees your mail password',
      'Receipts are off until you turn them on, and a donation is still recorded and thanked on screen if email isn’t set up',
    ],
  },
  {
    version: '0.28.0',
    date: '2026-07-20',
    notes: ['A new OpenMasjid Donations logo, and honest feedback when an email test cannot be delivered'],
  },
  {
    version: '0.27.0',
    date: '2026-07-19',
    notes: [
      'Admin alerts through OpenMasjidOS: you’re told if a payment can’t be started, or if a tuition payment wasn’t recorded',
      'You choose the channel (email or webhook) in OpenMasjidOS — this app never sees the address',
    ],
  },
  {
    version: '0.26.0',
    date: '2026-07-18',
    notes: [
      'A campaign can be a Tuition page, powered by OpenMasjid Students: parents look up their child and pay the school balance by card',
      'Tuition is kept out of your donation totals, Gift Aid and year-end letters — it is a payment, not a gift',
    ],
  },
  {
    version: '0.25.0',
    date: '2026-07-17',
    notes: ['An embeddable donation widget you can drop into your own website, one per campaign'],
  },
  {
    version: '0.24.0',
    date: '2026-07-17',
    notes: [
      'Every campaign now has a type — Donation, Zakat or Tuition — and Zakat always covers the card fee so the full amount reaches the masjid',
      'An optional note for very large donations, offering a bank transfer instead',
    ],
  },
  {
    version: '0.21.0',
    date: '2026-07-15',
    notes: ['Write your own thank-you message for after a donation, per campaign or for the whole site'],
  },
];
