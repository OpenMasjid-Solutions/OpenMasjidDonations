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
    version: '0.44.0',
    date: '',
    unreleased: true,
    notes: [
      '**A full review of the whole app, and one thing it caught before you saw it.** The notification grid had a fault: adding a WhatsApp number worked, but ticking any of its boxes silently failed, so a number could be added and then never told about anything. That is fixed and checked against a running copy of the app rather than only on paper. Everything else the review looked at — how your card keys are protected, what leaves the app and to whom, the parts that handle refunds and tuition — came back clean, and all your documentation has been brought back in line with what the app actually does.',
      '**Every notification now says which appeal it was about.** A donation, a refund and a stopped monthly gift always named the appeal; the ones that didn’t were the problem messages. If a payment can’t be started you are now told which page it happened on, and when the app finds donations that were paid but never recorded, the message breaks them down by appeal — “Zakat — 2 donations, $90.00; General Fund — 1 donation, $50.00” — so you can see which fund went up rather than only how much. A tuition payment that OpenMasjid Students refused now names the page too.',
      'One thing worth knowing about the payment-failure message: it names the page where the problem was noticed, and says so, because the usual cause — your card keys expiring, or Stripe itself having trouble — breaks every appeal at once. The app deliberately sends one of those an hour rather than one per person who tried to give, so the appeal named may not be the only one affected. The exception is an appeal whose own Stripe account is misconfigured: that one gets its own message and correctly tells you the others are fine.',
      '**If WhatsApp ever stops delivering without saying so, you will be told — and told what actually went wrong.** OpenMasjidOS found a fault where a masjid’s WhatsApp connection could expire quietly — the way being signed out of WhatsApp on a computer does — and messages would keep being accepted, and reported as sent, while none of them arrived. It went unnoticed for over a day. OpenMasjidOS now spots it within about ten minutes and holds messages until you reconnect your phone, and this app checks once an hour whether any of its own messages fell into a period like that. If any did, you get one message telling you when it was, how many, and which of the four things went wrong — your phone signed itself out, the phone needs linking again, the gateway’s credentials were refused (which is not about your phone at all, so re-linking it would not help), or something OpenMasjidOS could not identify. Where we can tell, it also says what kind of notification was caught in it, so “one of them was a refund notice” is something you can act on rather than a bare number. It stays on the Notifications screen so you can look it up later.',
      'Two things we chose deliberately. **Nothing is lost when this happens** — every donation, refund and monthly change from that period is in your records exactly as it should be; it was only the notifications that went missing, so there is nothing to put right. And **we do not re-send them**, because they were all notices about things already in your records, and a burst of old messages to a phone you have only just reconnected is the quickest way to get that number blocked. One message telling you there was a gap is more use than fifty telling you about donations you can already see.',
      'Also worth knowing: a WhatsApp message can now sit waiting much longer than before, on purpose. If your connection is down the messages are held rather than thrown away, and they go out once you have reconnected the phone and released them in OpenMasjidOS.',
      '**You can now tell as many people as you like, and choose what each of them hears about.** Settings → Notifications is a grid: add an email address or a WhatsApp number, then tick the things that person should be told about — a donation arriving, a refund, a monthly donor stopping, donations breaking altogether, a tuition payment that did not reach OpenMasjid Students, or a donation that was found and added. So refunds can reach whoever keeps the accounts while a broken payment setup reaches whoever fixes things, and the treasurer does not have to read about every gift to hear about the one that came back. Before this you could name one address and one number per alert, and anyone else had to be reached by a forwarding address.',
      'Adding somebody grants them no access to the app whatsoever — it is an address on a list, not an account. Alerts can name an appeal and an amount, but **never a donor**, so nobody you add ever learns who gave. A new email address starts on the alerts that cost money or hide a problem, and you tick the rest yourself.',
      '**WhatsApp is kept separate from the email list, on purpose, and nothing is ever switched on for you.** It sends from your masjid’s own linked number, that number is shared with every other app on your server, and if WhatsApp ever blocks it nobody can undo that. So every box on the WhatsApp grid starts empty and stays empty until you tick it. The app also holds itself to about twenty messages an hour to any one number and forty an hour in total; if anything is held back it says so, with the count.',
      '**Phone numbers are now entered with the country picked from a list, and format themselves as you type.** Choose “US / CA (+1)” and type 3135550142 and the field shows (313) 555-0142. This fixes something worth being straight about: a number typed as ten digits with no country code used to be accepted and sent to the wrong country entirely — the same digits read as a Dutch number — with nothing on screen looking wrong. Picking the country makes that impossible. If you already have a number saved it still works and needs no attention.',
      '**The “only tell me about donations of at least…” box has gone.** Who hears about a donation is now a tick per person, which is a better answer for most masjids — the treasurer can be left off it entirely rather than given a threshold. If you were using it to keep a busy Friday out of your inbox, untick “a donation was received” for the people who do not need each one.',
      '**If you run a school and use OpenMasjid Students, you can now ask parents to cover the card fee.** Turn it on in Students (Payments → who pays the processing fee) and the tuition page starts showing it as its own line: the tuition, the card fee, and the total — with a plain sentence saying the fee is not the masjid’s, it is what Visa, Mastercard and American Express charge to accept a card, and paying by cash or check at the office avoids it. **It is off unless your school switches it on**, and if it is off nothing about the page changes at all.',
      'The child’s balance still goes down by the **tuition** — the card fee is never treated as money towards their fees, so a family can’t end up with a stray credit that quietly comes off their next bill. The fee is worked out the way your card processor works it out, so the school receives the full tuition rather than being a few pence short on every payment.',
      '**WhatsApp messages should actually arrive now, and you can see when one doesn’t.** OpenMasjidOS had a fault that could hold up every app’s WhatsApp messages behind one stuck message — for up to half an hour — and lose anything still waiting whenever it restarted. That is fixed on their side, and messages now go out within seconds. On ours: if OpenMasjidOS **refuses** a message, the reason now appears next to that notification in Settings instead of disappearing into a log. So “that group is no longer approved”, “that number needs a country code”, or “that is the number WhatsApp itself is linked to” are things you can read and fix, rather than a phone that just stays quiet.',
      'One consequence worth knowing: OpenMasjidOS used to limit how much could be sent, and no longer does — so this app now limits itself, to about twenty messages an hour per number or group. Ban risk attaches to your **phone number**, it is shared with every other app on your server, and a blocked number is not something anyone can undo. If anything is ever held back you will be told, with the number of messages and what to do about it — usually turning off “a donation was received” for that number, which is the one that fires on every single gift.',
      '**Wording is now American English throughout, and amounts show in dollars by default** — “check” rather than “cheque”, “color” rather than “colour”. Your own wording, your appeals and your currency setting are untouched; if your masjid uses pounds or another currency, amounts still show in it exactly as before.',
      '**Fixed: a bad afternoon could bury you in identical messages.** If your card keys expire, or Stripe has an outage, every single person who tries to give fails — and you were told about each one. On a Friday that is one message per attempt, all afternoon, on every channel you had switched on. You now get the first one straight away, and the next one an hour later tells you how many times it happened in between (“this has happened 41 more times”), so you can still tell one unlucky donor from everybody. The same applies to tuition payments your school’s system rejects.',
      '**And the donations we find for you are now reported together.** When the app finds card payments that went through but never reached your records, it used to send one message per donation — up to twenty-five at a time, which is exactly what happens the first time it runs. Now it tells you once: “3 donations totalling $140 were found and added”. Every one of them is in your donations list as before; only the number of messages changed.',
      'Anything else that reaches the Development channel from here on will be listed here, and the headline items will become the next release’s notes.',
    ],
  },
  {
    version: '0.43.0',
    date: '2026-08-18',
    notes: [
      '**New: WhatsApp, for the people who look after the money.** If your masjid runs the WhatsApp gateway in OpenMasjidOS, the app can now send a message to a number you enter — or to a group your OpenMasjidOS admin has approved — when something happens worth knowing about. **Donors are never messaged, and this app never asks anyone for a phone number**: every number here is one of your own people. It is never switched on for you either, since it sends from your masjid’s own number, so that has to be your choice.',
      '**You can also ask it for figures.** Message your masjid’s number with `!donations` and pick from the menu: what has come in today, this month next to the whole of last month, your overall totals, how a particular appeal is doing against its goal, or how many people give every month. Everything it answers is a **total** — no donor is ever named, because a WhatsApp message gets forwarded and screenshotted and that was never theirs to agree to. And nothing you can send it changes anything: it reads your figures back, it cannot close an appeal or refund a donation. Who is allowed to use it is set in OpenMasjidOS.',
      '**All your notification settings are now in this app, under Settings → Notifications.** Six things you can be told about — a donation arriving, a refund, a monthly donor stopping their gift, donations breaking altogether, a tuition payment that didn’t reach OpenMasjid Students, and a donation that was found and added — and for each one you choose who hears it: your OpenMasjidOS inbox, a specific email address, a WhatsApp number, or an approved group. Any combination, or none, with a **Test** on every line. So refunds can reach whoever keeps the accounts while a broken payment setup reaches whoever fixes things.',
      'Beside “a donation was received” there is a *only if it’s at least…* figure, worth setting if you would rather not hear about every $2 gift — it is the one notification that happens every single time somebody gives. Remember that OpenMasjidOS has its own switches too (Settings → Alerts) and both have to be on, which is why the panel says “your OpenMasjidOS inbox” rather than promising you an email.',
      '**Light mode looks like it should now.** The page behind your panel stayed dark when you switched to light, so the panel was pale cards floating on a near-black background, with text that was hard to read. Light mode now has a light background of its own, and each of the nine wallpapers has a light version that keeps its color: ocean is still blue, forest still green. Dark mode is untouched.',
      '**A full security and code-health review went over the whole app**, including everything above. No new weakness was found; what it did find is fixed, and everything still outstanding is written up in the project’s own `docs/audit/` folder rather than kept in somebody’s head.',
      'Nothing you have set up needs redoing, and your donations, appeals and monthly plans are all exactly as they were.',
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
      '**A tuition bill can now be paid line by line.** A February bill is often $200 of monthly tuition plus a $50 book fee, and until now a parent could only pay the whole $250; the page lists what a bill is made of, so they can pay just the book fee.',
      'Lines already paid say so, and a bursary shows as the deduction it is — both there for information, neither payable.',
      'Everything starts ticked, so paying a whole bill is still one tap, and the running total sits on the pay button. A bill with a single line looks exactly as it did.',
      '**Needs OpenMasjid Students v0.43.0** for itemized bills; older versions keep paying each bill as one thing.',
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
      '**The smallest card payment is $1/$1**, matching the school’s own parent portal, so nobody meets a card decline instead of a friendly message.',
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
