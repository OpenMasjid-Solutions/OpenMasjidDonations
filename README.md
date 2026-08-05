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

### For your supporters

- **Appeals you control.** As many as you like — General Fund, Zakat, Building Fund,
  Ramadan Appeal — each with **a clean link you choose** (e.g. `/zakat`), its own
  wording, its own background image, and an optional **goal with a progress bar**.
- **Preset *and* custom amounts.** Clear suggested buttons plus a "choose your own"
  field, with sensible minimums and maximums per appeal.
- **One-time or monthly.** Monthly giving is a real Stripe subscription, set up in the
  same few taps.
- **Three kinds of page.** A **Donation** page, a **Zakat** page (which always covers
  the card fee, so the full amount reaches the masjid), or a **Tuition** page (below).
- **Cover the fees.** An optional tick so a supporter can add the processing fee and
  the masjid receives the whole gift.
- **A quiet word on large gifts.** Above a threshold you set, the page can suggest a
  bank transfer instead, so a big donation isn't reduced by card fees — the supporter
  can still pay by card.
- **A warm thank-you**, in your own words, per appeal or for the whole site.
- **An optional emailed receipt**, branded to your masjid. It's sent through
  OpenMasjidOS, so this app never sees your mail password.
- **Share it anywhere.** Every appeal has a shareable link and a **QR code** for the
  door, and can be **embedded in your own website** as a small widget.

### School fees, if you run a school

A **Tuition** page turns the donation site into a payment desk for
[OpenMasjid Students](https://github.com/OpenMasjid-Solutions/OpenMasjidStudents):

- A parent types their child's **Student ID** — no PIN to remember — and confirms the
  name shown back to them before any balance appears.
- The page is laid out **child by child**: each child's own balance or credit, their
  own bills, and their own "Add money" button.
- They can pay a whole bill, **only the months they choose**, or **individual lines of
  a bill** (just the £50 book fee out of a £250 February bill).
- They can **pay ahead** when nothing is due, and money paid ahead lands on the child
  they picked rather than a sibling's older bill.
- Tuition is deliberately kept **out of your donation totals, stats and CSV** — it's a
  payment, not a gift.

### Your admin panel

Eight tabs behind a login, with a bottom dock like the rest of the family:

| Tab | What's in it |
|---|---|
| **Overview** | Total raised, this month, number of donations, average gift, a per-appeal breakdown and a 6-month trend |
| **Campaigns** | Create, edit, reorder, activate/deactivate — with a **live preview** as you type |
| **Donations** | The full ledger. Every transaction has its own ID — click it for a window with full details and that donor's other gifts. **CSV export.** |
| **Monthly** | Every recurring plan: who set it up, the amount and frequency, which appeal, what it has raised so far, when it started, last and next payment, the card and its last four digits, and the status in plain words. **Pause, resume or stop** a plan, give it an **end date** or tell it to **stop after N more payments**, and read its **payment history** — a declined card reads as a sentence you can act on, not a code |
| **Thank-you** | Write the on-screen thank-you and design the emailed receipt |
| **Large gifts** | The threshold and the wording of the bank-transfer suggestion |
| **Payments** | Stripe keys or a vaulted OpenMasjidOS payment account, currency, a clear **TEST MODE** badge, optional webhook |
| **Settings** | Appearance (light/dark/follow, accent, logo, wallpaper), the email-receipt switch and a "send me a test", and public access |

### Built into OpenMasjidOS

- **One-click install and single sign-on.** Press **Open** and you're signed in with
  your OpenMasjidOS login; the app matches your dashboard's light/dark theme and
  wallpaper. A **local admin password** works when running standalone.
- **Stripe configured once.** Use the keys vaulted in OpenMasjidOS → Settings →
  Payments and this app fetches them server-to-server, or paste keys in the app.
  **Several accounts** are supported, so Zakat and general funds can be kept apart.
- **Notifications and alerts.** You're told if a payment can't be started, or if a
  tuition payment couldn't be recorded — by email or webhook, your choice, configured
  once in OpenMasjidOS.
- **Public access without port-forwarding**, via the platform's Cloudflare Tunnel.
  Share links and QR codes then use your public domain automatically.

### Quietly looking after your records

- **Donations that never landed are found and added.** If a supporter's card went
  through but their page never finished loading, the money was taken and nothing knew
  about it. The app now finds those, records them with the date the money actually
  arrived, and sends the receipt that was never sent.
- **Monthly payments after the first are picked up on their own**, without needing a
  Stripe webhook — so your totals, charts and CSV include every month.
- **An activity record** of the things worth checking later: who exported the donor
  list, who paused or stopped a monthly plan, who changed the Stripe keys, and when.
- **No inbound connection needed.** Payments are confirmed by asking Stripe directly
  (outbound only), so one-time giving works on a masjid network with no public access
  at all. Webhooks are an optional extra, not a requirement.

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
  The published image is digest-pinned in `docker-compose.yml`, so a moved tag can't
  repoint an install at different content.
- **`server/`** — Node + TypeScript + **Fastify**. Stores data in **SQLite**
  (better-sqlite3) on the data volume; talks to Stripe server-side; reimplements the
  OpenMasjidOS **Fabric** (single sign-on, appearance, notifications, alerts, the
  Stripe vault, email, and the app-to-app broker used for tuition).
- **`web/`** — **React + Vite + TypeScript**, styled with the OpenMasjidOS design
  tokens (so it matches the dashboard) plus Tailwind utilities, Motion for gentle
  animation, and Stripe's Payment Element for card entry. The admin bundle is loaded
  on demand so the donation page stays light.
- **Money is handled in integer minor units** server-side, with the right number of
  decimals for the currency — including the zero-decimal ones (JPY) and the
  three-decimal ones (BHD, JOD, KWD, OMR, TND).
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
| [`docs/audit/`](docs/audit/) | The 2026-08-03 security and code-health audit |

This is an OpenMasjidOS **app**; the platform that runs it lives in
[OpenMasjidOS](https://github.com/OpenMasjid-Solutions/OpenMasjidOS), and apps are listed in
[OpenMasjidAPPS](https://github.com/OpenMasjid-Solutions/OpenMasjidAPPS).
