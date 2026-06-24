# OpenMasjid Donations

A beautiful, **self-hosted donation website** for your masjid, powered by **Stripe** —
part of the [OpenMasjid](https://github.com/hasan-ismail/OpenMasjidOS) family.

Put it on a screen by the door with a QR code, or open it on any phone. A supporter
picks a cause, chooses a **preset or custom amount** (one-time or monthly), and pays
securely by card on your masjid's own branded page. An admin manages everything —
appeals, amounts, theme, Stripe keys, and a donations log — from a polished,
login-protected panel. It runs as **one container** on a cheap mini-PC or a
Raspberry Pi, on your masjid's own network.

> **Status:** early development (v0.6.0). Working: OpenMasjidOS single sign-on (with a
> local admin-password fallback), the notifications relay, a guided first-run setup, a
> tabbed admin with a bottom **dock** (Overview · Campaigns · Donations · Payments ·
> Settings) like the rest of the family, a **metrics dashboard** (totals, this month,
> average gift, a per-appeal breakdown and a 6-month trend), **multiple Stripe accounts**
> (e.g. separate Zakat vs general funds), **campaigns** — each with **a clean link you
> choose** (e.g. `/zakat`), preset + custom amounts, optional goal/cover-fees/Gift-Aid,
> and **its own background image** (or the default look) — the **public donation page**
> with Stripe's Payment Element (one-time card payments, confirmed by server-side
> retrieve), a **donations log + CSV export**, and an optional **Cloudflare Tunnel** for
> public access (paste a tunnel token — secure HTTPS, no port-forwarding). Still to come:
> recurring (monthly) donations (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).

---

## Install (the easy way)

Install it from the **App Store inside [OpenMasjidOS](https://github.com/hasan-ismail/OpenMasjidOS)**
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
- **License: [AGPL-3.0](LICENSE).**

This is an OpenMasjidOS **app**; the platform that runs it lives in
[OpenMasjidOS](https://github.com/hasan-ismail/OpenMasjidOS), and apps are listed in
[OpenMasjidAPPS](https://github.com/hasan-ismail/OpenMasjidAPPS).
