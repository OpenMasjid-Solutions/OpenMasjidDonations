<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

<p align="center">
  <img src="assets/Donations - rounded corners.png" alt="OpenMasjidDonations" width="280"/>
</p>

<h1 align="center"><b>OpenMasjid Donations</b></h1>

<p align="center">
  <a href="#install-the-easy-way">Install Guide</a> |
  <a href="#what-it-does">Features</a> |
  <a href="#develop">Develop</a> |
  <a href="#how-its-built">How it's built</a>
</p>

<div align="center">
  <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidDonations/releases">
    <img src="https://img.shields.io/github/v/release/OpenMasjid-Solutions/OpenMasjidDonations?style=flat-square&color=blue" alt="Latest Release" />
  </a>
  <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidDonations">
    <img src="https://img.shields.io/github/stars/OpenMasjid-Solutions/OpenMasjidDonations?style=flat-square&color=blue" alt="Stars" />
  </a>
  <a href="https://discord.gg/MpPDbyQfaF">
    <img src="https://img.shields.io/badge/Discord-Join-blue?style=flat-square&logo=discord" alt="Discord" />
  </a>
</div>

<h5 align="center">
Leave a star if you like the project! ⭐️
</h5>

A beautiful, **self-hosted donation website** for your masjid, powered by **Stripe** —
part of the [OpenMasjid](https://github.com/OpenMasjid-Solutions/OpenMasjidOS) family.

Put it on a screen by the door with a QR code, or open it on any phone. A supporter
picks a cause, chooses a **preset or custom amount** (one-time or monthly), and pays
securely by card on your masjid's own branded page. You manage everything —
appeals, amounts, monthly plans, receipts, theme, Stripe keys and a full donations
ledger — from a polished, login-protected panel. It runs as **one container** on a
cheap mini-PC or a Raspberry Pi, on your masjid's own network.

> **Status:** active development. Under semver, `0.x` still means pre-release, but the
> donation, Zakat, monthly-giving and tuition flows are complete and in use. The badge
> above always shows the current release; what changed in each one is in the
> [changelog](web/src/changelog.ts) (and in-app under **What's new**). For how it all
> fits together, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## What it does

The full feature set, as it stands.

### The donation page

- **As many appeals as you like** — General Fund, Zakat, Building Fund, Ramadan
  Appeal — each with **a link you choose** (e.g. `/zakat`), checked for availability
  as you type, and each independently switched live or hidden.
- **Three kinds of page**, set per appeal:
  - **Donation** — an ordinary gift.
  - **Zakat** — the card fee is always added, with no opt-out, so the full Zakat
    amount reaches the masjid.
  - **Tuition** — a school-fees desk (see below).
- **Preset *and* custom amounts.** Any number of suggested buttons, plus a "choose
  your own" field with a **minimum and maximum** you set.
- **One-time or monthly**, per appeal. Monthly is a real Stripe subscription.
- **Give anonymously.** Name and email are optional for a one-time gift (email only
  to get a receipt). Both are required for monthly, because a plan has to be
  identifiable later.
- **Cover the card fee** — an optional tick that grosses the amount up so the masjid
  nets the whole gift, computed transparently and shown before paying.
- **An optional goal**, with a progress bar showing how much has been raised.
- **Your own look per appeal** — a hero image, a full-page background image, and the
  appeal's own logo or your masjid's. Text contrast adapts so it stays readable on any
  image.
- **A quiet word on large gifts.** Above a threshold you set, the page first suggests a
  cheaper way to give — your own wording plus an optional QR image (bank details, for
  instance) — so a big donation isn't eaten by card fees. The supporter can still
  choose to pay by card.
- **Card payment on your own page** via Stripe's Payment Element, including **bank
  verification (3-D Secure)** when the card asks for it. Card numbers are entered in
  Stripe's own field and go straight to Stripe.
- **A thank-you screen in your words**, per appeal or site-wide, with `{name}`,
  `{amount}`, `{campaign}` and `{masjid}` filled in, and its own background image and
  accent colour if you want one.
- **An optional emailed receipt**, branded with your logo, accent and contact details,
  with the amount, date, payment method and fund filled in automatically.
- **A shareable link and a QR code** for the door — using your public domain when
  remote access is on, and this device's address otherwise.
- **An embeddable widget** (`/w/<appeal>`) to drop into your own website, one per
  appeal and off until you enable it.
- **Light and dark**, matching the masjid's dashboard, laid out with logical CSS so
  it's ready for right-to-left languages, and it honours "reduce motion".

### Monthly gifts, and stopping them

When someone sets up a monthly donation, they're emailed a confirmation of what they've
set up — the amount, the fund, the date of the first payment — with **their own link to
stop the payments whenever they like**. No account, no password, nobody to phone. The
email asks them to keep it, since that link lives only there; if they lose it, you can
stop the gift from the **Monthly** tab in a moment, and the email says so too.

You're told (by email or webhook, your choice) whenever a donor uses their link, so a
stopped gift is never a surprise you find out about a month later. The link is reachable
from anywhere through the remote-access hostname OpenMasjidOS gives you (see **Built into
OpenMasjidOS** below). On a masjid network with no public access there's no link to send, so the email
asks them to get in touch instead, and stopping it stays your job.

### School fees, if you run a school

A **Tuition** appeal turns the site into a payment desk for
[OpenMasjid Students](https://github.com/OpenMasjid-Solutions/OpenMasjidStudents),
which owns all the data:

- A parent types their child's **Student ID** — no PIN to remember or reissue — and
  **confirms the name shown back to them** before any balance appears, so a mistyped
  ID is caught rather than exposing another family's details.
- The page is laid out **child by child**: each child's own balance or credit, their
  own bills beneath it, and their own "Add money" button.
- They can pay **a whole bill**, **only the months they tick**, or **individual lines
  of a bill** — just the £50 book fee out of a £250 February bill. Lines already paid
  say so, and a bursary shows as the deduction it is.
- They can **pay ahead** when nothing is due — a term or a year up front — and money
  paid ahead lands on **the child they picked**, not a sibling's older bill.
- Any credit on the family is shown rather than a bare zero, and a child with nothing
  due says so instead of vanishing.
- A minimum payment of £1/$1 matches the school's own portal, so nobody meets a card
  decline instead of a friendly message.
- Tuition is deliberately kept **out of your donation totals, stats, charts and CSV** —
  it's a payment, not a gift. Itemised bills need OpenMasjid Students v0.43.0; older
  versions simply pay each bill as one thing.

### Your admin panel

Eight tabs behind a login, with a bottom dock like the rest of the family:

| Tab | What's in it |
|---|---|
| **Overview** | Total raised · this month (amount and count) · number of donations · live appeals · average gift · a per-appeal breakdown · a 6-month trend |
| **Campaigns** | Create, edit, reorder, activate/deactivate and delete appeals, with a **live preview** as you type and a thumbnail in the list. Upload images or link them, set the presets, minimum, maximum, goal, monthly option, fee rule, widget, and **which Stripe account this appeal pays into** — the same one as the rest of the site, or an account of its own |
| **Donations** | The full ledger. Every transaction has its own reference — click it for a window with the amount, status, appeal, card, whether fees were covered, the donor and the Stripe payment reference, plus **that donor's other gifts and their lifetime total**. **Refund** a donation from that window — all of it or part of it, with a reason, and optionally an email to the donor telling them it's on its way; refunded rows are marked in the list and come off your totals. **CSV export** |
| **Monthly** | Every recurring plan: the donor and how to reach them, amount and frequency, which appeal, **what the plan has raised so far**, when it started, the last and next payment, the card and its last four digits, and the status in plain words. Donors also get **their own link to stop the payments**, emailed when the gift is set up — they don't need to ring you, and you're told when one of them uses it. **Pause** (nothing is taken while paused, and the missed months are never billed afterwards), **resume**, **stop**, or set an **end date** or **"stop after N more payments"** — it tells you which payment will be the last before you save. Each plan keeps its own **payment history**: every attempt with its date, amount, status, how many tries Stripe made, and why a card was declined, in a sentence rather than a code |
| **Thank-you** | Write the on-screen thank-you, and design the emailed receipt — subject, heading, body, accent — with a **"send me a test"** |
| **Large gifts** | The threshold, your wording, and the QR image for the bank-transfer suggestion |
| **Payments** | **Several Stripe accounts** — add, edit, test the keys and remove accounts whose keys live on this device, and pick which **vaulted OpenMasjidOS account** is the default for the site. Any appeal can then be pointed at a different one, so Zakat and general funds settle separately; the currency; a clear **TEST MODE** badge; and the optional per-account webhook with the URL to paste into Stripe |
| **Settings** | **Your masjid** (name, address, email, phone, website, currency) · **Appearance** (light/dark/follow-system, accent, logo, wallpaper, or mirror the dashboard) · **Notifications** · **Email receipts** on/off · **Public access** via a Cloudflare Tunnel |

Plus a **guided first-run setup**, a top-right account menu (theme · settings · sign
out) with a live clock, and a **What's new** dialog that tells you what changed after
an update — with a quiet dot on the account button until you've read it. It ships with
the app, so it works with no internet.

### Built into OpenMasjidOS

- **One-click install and single sign-on.** Press **Open** and you're signed in with
  your OpenMasjidOS login — verified server-to-server, never trusting the browser —
  and the app matches your dashboard's light/dark theme, accent and wallpaper. A
  **local admin password** works when running standalone, and as recovery if the
  platform is ever unreachable.
- **Stripe configured once.** Use the keys vaulted in OpenMasjidOS → Settings →
  Payments, fetched server-to-server and never stored here, or paste keys into the app.
- **Email without credentials.** Receipts go out through the platform's email provider,
  so this app never sees your mail password or From address.
- **Notifications and alerts.** A relay for "a donation was received", plus five
  alerts you can route to email or a webhook: **a payment couldn't be started**, **a
  tuition payment wasn't recorded**, **a donation was refunded**, **a monthly donation
  was stopped by the donor**, and a **test**. You choose the channel in OpenMasjidOS;
  this app never sees the address.
- **Public access without port-forwarding**, through the platform's Cloudflare Tunnel
  on a single hostname, or the app's own tunnel when standalone. Share links, QR codes
  and the Stripe webhook URL then use your public domain automatically.
- Everything **fails soft**: if the platform is absent or a capability is off, the
  donation site carries on working.

### Looking after your records

- **Donations that never landed are found and added.** If a supporter's card went
  through but their page never finished loading, the money was taken and nothing here
  knew. Those are found, recorded with the date the money actually arrived, and the
  receipt that was never sent goes out.
- **Monthly payments after the first are picked up on their own**, with no Stripe
  webhook needed — so your totals, charts and CSV include every month.
- **Nothing is lost to a temporary failure.** Receipts and tuition records that don't
  go through the first time are retried in the background.
- **An activity record** of things worth checking later: who exported the donor list,
  who refunded a donation, who paused or stopped a monthly plan, who changed the Stripe
  keys, and when.
- **A refund made in Stripe's own dashboard finds its way here** too, so your totals
  never go on counting money that has already gone back.
- **No inbound connection needed.** Payments are confirmed by asking Stripe directly,
  outbound, so one-time giving works on a masjid network with no public access at all.
  Webhooks are an optional extra, never a requirement.

### Built to be safe with money

- Your **Stripe secret key is server-side only** — never sent to the browser, never
  written to a log, never committed. The browser only ever sees the publishable key.
- **Card numbers never touch this app.** Entry happens in Stripe's own field
  (PCI SAQ-A).
- **A payment is only ever recorded after asking Stripe** whether it really succeeded.
  The browser's word is never taken for it. Webhook signatures are verified.
- **Idempotency keys** on every payment and subscription, so a retry or a double-tap
  can't charge twice.
- **Amounts are computed server-side** in whole minor units, with the right number of
  decimals for the currency — including the zero-decimal ones (JPY) and the
  three-decimal ones (BHD, JOD, KWD, OMR, TND).
- **Rate limiting** on sign-in (a growing lockout per device), on payment creation, on
  the webhook, and on platform calls.
- **Exports are safe to open.** A donor name can't smuggle a spreadsheet formula into
  your CSV, and donor records are kept out of every cache.
- **A hardened container**: no privileges at all (`cap_drop: ALL`,
  `no-new-privileges`), a temporary filesystem for `/tmp`, a private data directory,
  and the published image **pinned by digest** so a moved tag can't repoint an install
  at different content.
- The admin password is stored as a **scrypt hash**; sessions are signed, HTTP-only,
  SameSite cookies that become `Secure` over HTTPS.
- Full [security and code-health audits](docs/audit/) were carried out on 2026-08-03 and
  2026-08-13 — the reports, the remediation notes, what was fixed and what is still open
  are all in the repo rather than in someone's head.

---

## Acknowledgements

Created by **Hasan Ismail**, with immense help from **Qari Ijaz** and **Osman Sayed**.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <a href="https://github.com/hasan-ismail">
          <img src="https://github.com/hasan-ismail.png?size=100" width="100px;" alt="Hasan Ismail"/><br />
          <sub><b>Hasan Ismail</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://github.com/ijazshare">
          <img src="https://github.com/ijazshare.png?size=100" width="100px;" alt="Qari Ijaz"/><br />
          <sub><b>Qari Ijaz</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://github.com/osayed0001">
          <img src="https://github.com/osayed0001.png?size=100" width="100px;" alt="Osman Sayed"/><br />
          <sub><b>Osman Sayed</b></sub>
        </a>
      </td>
    </tr>
  </table>
</div>

Resources for this project were generously sponsored by **[An-Noor Institute](https://www.annoorusa.org/)**, **[Rihlatul Ilm Foundation](https://rifusa.org/)**, and **[AsmaTec Inc.](https://asmatec.com/)**.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <a href="https://www.annoorusa.org/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/An-noor2.png" width="120px;" alt="An-Noor Institute"/><br />
          <sub><b>An-Noor Institute</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://rifusa.org/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/RIFbetter.png" width="120px;" alt="Rihlatul Ilm Foundation"/><br />
          <sub><b>Rihlatul Ilm Foundation</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://asmatec.com/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/Asmatec.png" width="120px;" alt="AsmaTec Inc."/><br />
          <sub><b>AsmaTec Inc.</b></sub>
        </a>
      </td>
    </tr>
  </table>
</div>

May Allah reward everyone who made it possible.

---

## Install (the easy way)

Install it from the **App Store inside [OpenMasjidOS](https://github.com/OpenMasjid-Solutions/OpenMasjidOS)**
with one click. When it's running, press **Open** — it signs you in with your
OpenMasjidOS login and matches your dashboard's light/dark theme and wallpaper.
There's nothing to fill in at install time; add your Stripe keys and your first
appeal inside the app.

OpenMasjidOS offers two **update channels**. **Stable** is the default and is what a
masjid should run. **Dev** tracks this repo's `dev` branch and gets changes as they
land — useful for testing, not for taking real donations.

## Install (standalone, without the platform)

```bash
docker compose up -d
```

Then open `http://<this-machine>:7870`. The app works fully on its own (with its own
admin password); the OpenMasjidOS sign-in, theme-matching, vaulted Stripe keys, email
receipts and alerts simply switch on when it's launched from the platform.

> **Privacy & security:** your Stripe **secret key never leaves the server** and is
> never shown in the browser. Supporters' card details are entered in Stripe's own
> secure field and go **straight to Stripe** — they never pass through this app.
> Taking donations from outside your masjid's network means exposing the app
> publicly; only do so behind HTTPS.

---

## Develop

> **All work happens on the `dev` branch.** `main` is the stable channel and its tip
> is always the last release; it moves only for a release. Check with
> `git branch --show-current` before you start, and see the **Branching policy** at
> the top of [CLAUDE.md](CLAUDE.md).

You need Node 22 (what the image uses). In two terminals:

```bash
# 1) the server (API + static host) on :8080
cd server && npm install && npm run dev

# 2) the web app (donor site + admin) on :5173, proxying /api to the server
cd web && npm install && npm run dev
```

Open `http://localhost:5173`. Use Stripe **test keys** and Stripe's
[test cards](https://docs.stripe.com/testing) — the app shows a **TEST MODE** badge
whenever a test key is in use.

Build and test everything the way the image does:

```bash
cd server && npm install && npm run build && npm test   # → server/dist, then the test suite
cd web    && npm install && npm run build               # → web/dist (tsc --noEmit + vite)
docker build -t openmasjiddonations:dev .               # the whole container
```

---

## How it's built

- **One container.** A multi-stage `Dockerfile` builds the web app and the server,
  then a small `node:22-slim` runtime serves the built site **and** the API on
  container port **8080**, multi-arch (amd64 + arm64) so it runs on a Raspberry Pi.
- **`server/`** — Node + TypeScript + **Fastify**. Stores settings, appeals,
  donations and uploaded images in **SQLite** (better-sqlite3) on the data volume;
  talks to Stripe server-side; validates every incoming request with zod; and
  reimplements the OpenMasjidOS **Fabric** (single sign-on, appearance,
  notifications, alerts, the Stripe vault, email, and the app-to-app broker used for
  tuition). A `/healthz` endpoint for the platform.
- **`web/`** — **React + Vite + TypeScript**, styled with the OpenMasjidOS design
  tokens (so it matches the dashboard) plus Tailwind utilities, Motion for gentle
  animation, and Stripe's Payment Element for card entry. The admin bundle and the
  release notes are loaded on demand so the donation page stays light on a Pi.
- **License: [AGPL-3.0](LICENSE).** Contributions are under AGPL-3.0 + a **Contributor License
  Agreement** ([CLA.md](CLA.md)) that allows commercial/dual licensing while the public tree stays
  AGPL-3.0; it's signed automatically on your first PR. See [CONTRIBUTING.md](CONTRIBUTING.md).

### Documentation

| Document | What it covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the pieces fit together |
| [`docs/USING_THE_FABRIC.md`](docs/USING_THE_FABRIC.md) | The OpenMasjidOS Fabric integration |
| [`docs/FABRIC_STRIPE_AND_DOMAIN.md`](docs/FABRIC_STRIPE_AND_DOMAIN.md) | Vaulted Stripe keys and the public URL |
| [`docs/REMOTE_ACCESS_INGRESS.md`](docs/REMOTE_ACCESS_INGRESS.md) | Public access, tunnels and base paths |
| [`docs/STUDENTS_INTEGRATION.md`](docs/STUDENTS_INTEGRATION.md) | The tuition flow and the billing contract |
| [`docs/RESTORE_SSO_FIX.md`](docs/RESTORE_SSO_FIX.md) | Recovering admin access after a restore |
| [`docs/audit/`](docs/audit/) | The security and code-health audits, and what's still open |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setting up, building, testing, and the ground rules |

This is an OpenMasjidOS **app**; the platform that runs it lives in
[OpenMasjidOS](https://github.com/OpenMasjid-Solutions/OpenMasjidOS), and apps are listed in
[OpenMasjidAPPS](https://github.com/OpenMasjid-Solutions/OpenMasjidAPPS).
