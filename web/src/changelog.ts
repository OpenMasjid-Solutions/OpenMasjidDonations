// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * What's new — the release notes the "What's new" item in the account menu shows.
 *
 * Written for the masjid, not for us: plain, non-technical, what changed FOR YOU. Same voice as
 * the App Store entry in OpenMasjidAPPS `registry.yaml`, and worth keeping consistent with it,
 * since a masjid sees both. Newest first.
 *
 * Shape matches OpenMasjid Kiosk's CHANGELOG.md, so a masjid running both reads the same kind of
 * note in both panels: a bold lead-in that says what changed, then the detail behind it.
 *
 * This module is loaded on demand (a dynamic import when the dialog opens), so it never weighs on
 * the donation page — keep that in mind before importing it from anywhere eagerly. Add an entry as
 * part of the release runbook (CLAUDE.md §16), alongside the version bump.
 */
export interface Release {
  /** Semver, no leading "v" — matched against the running version to mark the current release. */
  version: string;
  /**
   * ISO date (YYYY-MM-DD) the version was tagged. Kept as the record in source; the dialog doesn't
   * show it, and neither does Kiosk's — a date tells a masjid nothing they need.
   */
  date: string;
  /**
   * One note per change, in full sentences. `**bold**` marks the lead-in clause — what changed, in
   * one breath, before the detail behind it — and `` `code` `` renders as code. Nothing else is
   * interpreted, and nothing is ever rendered as raw HTML. A short note with no headline to split
   * off stays plain.
   */
  notes: string[];
}

export const RELEASES: Release[] = [
  {
    version: '0.40.1',
    date: '2026-08-05',
    notes: [
      '**Nothing about the app itself changes in this release** — no new features, nothing to set up again, and your donations, appeals and monthly plans are all exactly as they were.',
      '**There is now a development channel, if you ever want it.** OpenMasjidOS → Update channel can follow changes as they are made, which is useful for trying something before it reaches everyone. **Stable** is the default and is the one to stay on for taking real donations.',
      'Behind the scenes: the project’s own documentation was brought up to date.',
    ],
  },
  {
    version: '0.40.0',
    date: '2026-08-04',
    notes: [
      '**“What’s new” now tells you when there is something new.** A small gold dot sits on your account button after OpenMasjidOS has updated this app, and goes as soon as you have opened the notes. Updates happen quietly in the background, so nothing used to say that the panel had changed under you.',
      '**The notes themselves read better.** Each one now leads with what changed, then the detail behind it, and every release shows the date it came out.',
      'They are laid out the same way as the notes in OpenMasjid Kiosk, so both apps read alike.',
      '**Fixed: the notes could open underneath the row of buttons at the foot of the screen**, which covered their last few lines.',
      'Nothing else about the app changes, and nothing you have set up needs redoing.',
    ],
  },
  {
    version: '0.39.0',
    date: '2026-08-04',
    notes: [
      '**Donations that were paid but never landed in your records are now found and added by themselves.** If a donor’s card went through but their page never finished loading — they closed the tab, or the wifi dropped at the wrong second — the money was taken and nothing here ever knew about it.',
      'So your totals may go up the first time this runs, and a donor may receive the receipt they never got. Both are money that already reached your bank.',
      '**New: the app keeps a record of the things worth being able to check later.** Who exported the donor list, who paused or stopped a monthly plan, who changed the Stripe keys, and when.',
      '**Your donor records are now kept out of every cache**, so an export can’t be left sitting anywhere it shouldn’t.',
      '**A safety review went through the whole app.** Signing in is protected properly when your site is served over HTTPS, the pages that talk to OpenMasjidOS can no longer be flooded by someone on your network, and a donor’s name can no longer interfere with the receipt email it appears in.',
      'Nothing about how you take donations changes, and nothing you have set up needs redoing.',
    ],
  },
  {
    version: '0.38.0',
    date: '2026-08-01',
    notes: [
      '**New “Monthly” tab.** Every donor who gives every month, in one place: who set the plan up and how to reach them, how much and how often, which appeal it goes to, what it has given so far, when they last paid, when the next payment is due, and which card it is on.',
      '**Open a plan to manage it.** Pause it — nothing is taken from the donor’s card while it is paused, and the months missed are never billed to them afterwards — start it again, or stop it for good.',
      '**You can say when a plan should end**: on a day you choose, or after a set number of further payments. It tells you in plain words which payment will be the last one before you save.',
      '**Every plan keeps its own payment history**, so a card that was declined reads as a sentence you can act on rather than a code, and you can see how many times it was tried.',
      '**Fixed: after a donor’s first monthly payment, the ones that followed were only recorded if you had set up a Stripe webhook** — something most masjids never did, because it needs your donation page to be reachable from the internet. They are now picked up by the app itself, each with the date the money actually arrived, so your donations list, your CSV export and your charts include every month.',
      'If you have been taking monthly gifts for a while, expect those totals to grow the first time you look: that money did reach your bank, your records simply didn’t know about it.',
    ],
  },
  {
    version: '0.37.0',
    date: '2026-07-31',
    notes: [
      '**The tuition page is now laid out child by child.** Each child has their own line with what they owe or have paid ahead, their own bills beneath it, and their own “Add money” button.',
      '**Money paid ahead now goes to the child you picked**, so it lands on their account instead of settling a brother or sister’s older bill.',
      '**A child with nothing due says so**, rather than disappearing from a page that only listed debts.',
      '**Bills read as a statement until you choose to pay part of one** — the tick boxes only appear after you tap “Choose what to pay”.',
      'Each bill is its own card with its lines indented underneath, so a month reads as one thing.',
    ],
  },
  {
    version: '0.36.0',
    date: '2026-07-30',
    notes: [
      '**A tuition bill can now be paid line by line.** A February bill is often £200 of monthly tuition plus a £50 book fee, and until now a parent could only pay the whole £250; the page lists what a bill is made of, so they can pay just the book fee.',
      'Lines already paid say so, and a bursary shows as the deduction it is — both there for information, neither payable.',
      'Everything starts ticked, so paying a whole bill is still one tap, and the running total sits on the pay button. A bill with a single line looks exactly as it did.',
      '**Needs OpenMasjid Students v0.43.0** for itemised bills; older versions keep paying each bill as one thing.',
      '**New “What’s new” in the account menu** (top right) — these notes, so you can see what changed after an update. It works with no internet, since the notes ship with the app.',
    ],
  },
  {
    version: '0.35.0',
    date: '2026-07-28',
    notes: [
      '**Parents can pay tuition ahead, even with nothing due** — a term up front, or the year in one go.',
      '**The balance page now says which is true**: what is owed, what has already been paid ahead, or nothing due.',
      'With several children, each child is listed as owing, in credit, or clear.',
      '**The smallest card payment is £1/$1**, matching the school’s own parent portal, so nobody meets a card decline instead of a friendly message.',
    ],
  },
  {
    version: '0.34.0',
    date: '2026-07-28',
    notes: [
      '**Fixed: paying one particular month of tuition now lands on the right child’s bill.** It could previously settle a sibling’s oldest month instead — the money stayed in the family, but on the wrong child.',
      'Paying a whole balance was never affected.',
    ],
  },
  {
    version: '0.33.0',
    date: '2026-07-28',
    notes: [
      '**Tuition now takes only the child’s Student ID** (e.g. YUS1234) — no PIN to remember or reissue.',
      'The page shows the child’s name back and waits for a “yes” before any balance appears, so a mistyped ID is caught.',
      'Each child’s own balance is shown behind the household total, and every open month says whose it is.',
    ],
  },
  {
    version: '0.32.0',
    date: '2026-07-21',
    notes: [
      '**The emailed receipt is designed on the Thank-you tab**; the on/off switch and “send me a test” live in Settings.',
      '“Send me a test” reaches you, the admin, through your OpenMasjidOS alert settings.',
    ],
  },
  {
    version: '0.29.0',
    date: '2026-07-20',
    notes: [
      '**Branded, Stripe-style receipt emails for donors**, sent through OpenMasjidOS — this app never sees your mail password.',
      'Receipts are off until you turn them on, and a donation is still recorded and thanked on screen if email isn’t set up.',
    ],
  },
  {
    version: '0.28.0',
    date: '2026-07-20',
    notes: ['A new OpenMasjid Donations logo, and honest feedback when an email test cannot be delivered.'],
  },
  {
    version: '0.27.0',
    date: '2026-07-19',
    notes: [
      '**Admin alerts through OpenMasjidOS**: you’re told if a payment can’t be started, or if a tuition payment wasn’t recorded.',
      'You choose the channel (email or webhook) in OpenMasjidOS — this app never sees the address.',
    ],
  },
  {
    version: '0.26.0',
    date: '2026-07-18',
    notes: [
      '**A campaign can be a Tuition page**, powered by OpenMasjid Students: parents look up their child and pay the school balance by card.',
      'Tuition is kept out of your donation totals, Gift Aid and year-end letters — it is a payment, not a gift.',
    ],
  },
  {
    version: '0.25.0',
    date: '2026-07-17',
    notes: ['**An embeddable donation widget** you can drop into your own website, one per campaign.'],
  },
  {
    version: '0.24.0',
    date: '2026-07-17',
    notes: [
      '**Every campaign now has a type** — Donation, Zakat or Tuition — and Zakat always covers the card fee, so the full amount reaches the masjid.',
      'An optional note for very large donations, offering a bank transfer instead.',
    ],
  },
  {
    version: '0.21.0',
    date: '2026-07-15',
    notes: ['Write your own thank-you message for after a donation, per campaign or for the whole site.'],
  },
];
