<p align="center">
  <img src="assets/Donations - rounded corners.png" alt="OpenMasjidDonations" width="280"/>
</p>

<h1 align="center"><b>OpenMasjid Donations</b></h1>

<p align="center">
  <a href="#install-the-easy-way">Install Guide</a> |
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
securely by card on your masjid's own branded page. An admin manages everything —
appeals, amounts, theme, Stripe keys, and a donations log — from a polished,
login-protected panel. It runs as **one container** on a cheap mini-PC or a
Raspberry Pi, on your masjid's own network.

> **Status:** early development (v0.13.0). Working: OpenMasjidOS single sign-on (with a
> local admin-password fallback) and a **top-right account menu** (theme · settings · sign
> out) plus a live clock, the notifications relay, a guided first-run setup, a **masjid or
> per-campaign logo** (upload or link) on the donation pages, a tabbed admin with a bottom **dock** (Overview · Campaigns · Donations ·
> Payments · Settings) like the rest of the family, a **dashboard of metric widgets** (totals, this
> month, average gift, a per-appeal breakdown and a 6-month trend), **multiple Stripe
> accounts** (e.g. separate Zakat vs general funds), **campaigns** — each with **a clean
> link you choose** (e.g. `/zakat`), a **live preview** while you edit (plus a list
> thumbnail), preset + custom amounts, **one-time *or* monthly** giving, optional
> goal/cover-fees, and **its own background image** (upload or link; text colour adapts
> for readability) — a **shareable link with a QR code** that uses your Cloudflare domain
> when public access is on, the **public donation page** with Stripe's Payment Element
> (**one-time and monthly** card payments via Subscriptions, confirmed by server-side
> retrieve, with an optional per-account webhook for ongoing months), a **full-page
> donations ledger** (each transaction has a unique ID — click it for a window with full
> details and that donor's other gifts) with **CSV export**, and an optional **Cloudflare
> Tunnel** for public access (paste a tunnel token + your public domain — secure HTTPS,
> no port-forwarding). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

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

## Install (standalone, without the platform)

```bash
docker compose up -d
```

Then open `http://<this-machine>:7870`. The app works fully on its own (with its own
admin password); the OpenMasjidOS sign-in and theme-matching simply switch on when
it's launched from the platform.

> **Privacy & security:** your Stripe **secret key never leaves the server** and is
> never shown in the browser. Supporters' card details are entered in Stripe's own
> secure field and go **straight to Stripe** — they never pass through this app.
> Taking donations from outside your masjid's network means exposing the app
> publicly; only do so behind HTTPS.

---

## Develop

You need Node 20+ (the image uses Node 22). In two terminals:

```bash
# 1) the server (API + static host) on :8080
cd server && npm install && npm run dev

# 2) the web app (donor site + admin) on :5173, proxying /api to the server
cd web && npm install && npm run dev
```

Open `http://localhost:5173`. Build everything the way the image does:

```bash
cd web && npm install && npm run build      # → web/dist
cd server && npm install && npm run build    # → server/dist
# or build the whole container:
docker build -t openmasjiddonations:dev .
```

For Stripe work (later slices) use **test keys** and Stripe's test cards.

---

## How it's built

- **One container.** A multi-stage `Dockerfile` builds the web app and the server,
  then a small `node:22-slim` runtime serves the built site **and** the API on
  container port **8080**.
- **`server/`** — Node + TypeScript + **Fastify**. Stores data in **SQLite**
  (better-sqlite3) on the data volume; talks to Stripe server-side; reimplements the
  OpenMasjidOS **Fabric** (single sign-on + appearance + notifications).
- **`web/`** — **React + Vite + TypeScript**, styled with the OpenMasjidOS design
  tokens (so it matches the dashboard) plus Tailwind utilities, Motion for gentle
  animation, and Stripe's Payment Element for card entry.
- **License: [AGPL-3.0](LICENSE).** Contributions are under AGPL-3.0 + a **Contributor License
  Agreement** ([CLA.md](CLA.md)) that allows commercial/dual licensing while the public tree stays
  AGPL-3.0; it's signed automatically on your first PR. See [CONTRIBUTING.md](CONTRIBUTING.md).

This is an OpenMasjidOS **app**; the platform that runs it lives in
[OpenMasjidOS](https://github.com/OpenMasjid-Solutions/OpenMasjidOS), and apps are listed in
[OpenMasjidAPPS](https://github.com/OpenMasjid-Solutions/OpenMasjidAPPS).
