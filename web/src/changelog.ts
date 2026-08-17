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
 *
 * TWO SHAPES, ONE PER CHANNEL (see CLAUDE.md → Branching policy):
 *  • On `dev` the first entry is `unreleased: true` — a running, properly DETAILED account of
 *    everything that has landed since the last release, including the corrections and removals a
 *    release note would leave out. It is what somebody on the Development channel needs to know
 *    what changed under them.
 *  • On `main` there is no unreleased entry, and a release carries ONLY the major changes — what a
 *    masjid would actually notice. At release time you distil from the one to the other; you don't
 *    move it wholesale.
 * The `dev` → `main` merge conflicts here on purpose. Resolve it by taking main's shape.
 */
export interface Release {
  /** Semver, no leading "v" — matched against the running version to mark the current release.
   *  For an unreleased entry this is the version being worked toward, and is never matched. */
  version: string;
  /**
   * ISO date (YYYY-MM-DD) the version was tagged. Kept as the record in source; the dialog doesn't
   * show it, and neither does Kiosk's — a date tells a masjid nothing they need. Ignored (and shown
   * as "not released yet") on an unreleased entry.
   */
  date: string;
  /**
   * Development-channel only: this work has NOT been released. The dialog labels it as such rather
   * than letting it pose as a version, so a dev box never appears to be running a release that does
   * not exist. Absent on every entry that reaches `main`.
   */
  unreleased?: boolean;
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
    // DEVELOPMENT CHANNEL ONLY — never merged to `main`. See the note at the top of this file.
    version: '0.43.0',
    date: '',
    unreleased: true,
    notes: [
      '**These changes are in v0.42.0 as well — they just weren’t big enough for its release notes.** The list below is the fuller account, for anyone following the Development channel who wants to know exactly what moved. Nothing here needs anything from you.',
      '**Fixed: your receipt emails were never actually branded, no matter how you set them up.** If you turned receipts on and designed one on the Thank-you tab, donors were still sent Stripe’s plain receipt instead — a supporter always got *a* receipt, so nothing looked broken, but it was never yours. Your design has been sitting there unused since it was added in July. It now goes out.',
      '**Fixed: a payment in a Gulf currency could be turned away as “too small” by your card processor** instead of by us, with no friendly explanation. Affects Bahraini, Jordanian, Kuwaiti, Omani and Tunisian dinars only.',
      '**Fixed: removing a Stripe account that had already taken donations told you the wrong reason.** It said a campaign was using it, sending you to look for one that wasn’t there. It now explains the real problem — those donations would lose the ability to be refunded, and any monthly gifts on that account could no longer be stopped by anyone.',
      '**Fixed: a request the app couldn’t read reported itself as our fault** (“something went wrong”) rather than saying the request was malformed. Invisible in normal use; it mattered when something else on your network was talking to the app.',
      'A monthly donor’s stop link is now checked for its shape before anything is looked up, so the automatic scanners that follow links in email cost nothing.',
      '**A full security and code-health review went over the whole app**, including the three features added this month. No new weakness was found. What it did find, and everything still outstanding, is written up in the project’s own `docs/audit/` folder.',
      'Housekeeping with no effect on how the app runs: the project’s documentation was brought back in line with the code after a few months of drift, an old unused logo file was removed, and a page of internal notes that would have told a future contributor to remove a security check was corrected.',
      'Anything new that lands on the Development channel from here on will be added to this list, and the headline items will become the next release’s notes.',
      '**New: WhatsApp notifications, if your masjid runs the WhatsApp gateway in OpenMasjidOS.** Settings → WhatsApp lets you add your own number — or pick a group your OpenMasjidOS admin has approved — and choose what you want to hear about: a donation arriving, a refund, a monthly donor stopping their gift, donations failing altogether, or a tuition payment that didn’t reach Students. **Donors are never messaged, and this app never asks anyone for a phone number.** If WhatsApp isn’t set up on your server the section tells you which step is missing rather than offering a switch that quietly does nothing.',
      'Messages are queued and spaced out by OpenMasjidOS to keep your number safe, so they arrive within minutes rather than instantly — which is why the test button says “queued” rather than “sent”. Because there’s a daily limit shared with everything else on your server, you can also set a smallest amount worth messaging about, so a busy Friday of small gifts doesn’t use it all up before something needs your attention. Your email and webhook alerts are untouched and carry on exactly as they do now.',
      '**You can also ask for figures over WhatsApp.** Message your masjid’s number with `!donations` and pick from the menu: what has come in today, this month next to the whole of last month, your overall totals, how a particular appeal is doing against its goal, or how many people give every month. If you ask about an appeal without naming one it lists them and you reply with a number.',
      'Everything it answers is a **total** — no donor is ever named, because a WhatsApp message gets forwarded and screenshotted and that was never theirs to agree to. And nothing you can send it changes anything: it reads your figures back, it cannot close an appeal or refund a donation. Who is allowed to use it is set in OpenMasjidOS, not here.',
    ],
  },
  {
    version: '0.42.0',
    date: '2026-08-13',
    notes: [
      '**You can now refund a donation from the panel.** Open any donation in the Donations tab and send back all of it or part of it, with a reason, and — if the supporter left an email — a note telling them it’s on its way. Refunded gifts are marked in the list and come off your totals, your charts and your appeal progress bars, so what you see raised is what you actually kept. A refund made in Stripe’s own dashboard finds its way here too.',
      '**Monthly donors are emailed their own link to stop their payments.** When someone sets up a monthly gift they now get a confirmation of what they’ve arranged — the amount, the fund, the date of the first payment — with a link they can use at any time to stop it themselves. No account, no password, nobody to ring. The email asks them to keep it safe, since the link lives only there; if they lose it you can still stop the gift from the Monthly tab in a moment. You’re told whenever a donor uses their link, so a stopped gift is never something you discover a month later.',
      '**Each appeal can now pay into its own Stripe account.** Zakat can settle somewhere separate from the general fund, and you choose it per appeal on the Campaigns tab — either an account set up in OpenMasjidOS or one whose keys are on this device. **Nothing changes unless you change it:** every appeal you already have carries on paying into exactly the account it always has. If an appeal’s chosen account ever becomes unavailable, that page stops taking cards and tells you plainly — it will never quietly send the money somewhere else instead.',
      '**Your emailed receipts now actually look like yours.** The branded receipt you can design on the Thank-you tab was never being sent — donors got your card processor’s plain one instead. If you have receipts turned on, your own design goes out from now on.',
      'Nothing you have set up needs redoing, and your donations, appeals and monthly plans are all exactly as they were.',
    ],
  },
  {
    version: '0.41.0',
    date: '2026-08-10',
    notes: [
      '**The app has a new logo.** The crescent and dome now carry the word “Donations” curved around them, with the card tucked in at the front. It is a square badge, so the tile in the App Store, the icon in your browser tab and the mark in the top corner of this panel are all the same picture — where before a wide one had to be squeezed into each of those places.',
      'It is sharper as well, at every size: the lettering and the card are drawn rather than photographed, so they stay clean whether they end up as a tiny tab icon or a full-size tile.',
      'Nothing else about the app changes, and nothing you have set up needs redoing — your donations, appeals and monthly plans are all exactly as they were.',
    ],
  },
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
