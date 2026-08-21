<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Contributing to OpenMasjid Donations

Thanks for helping! A few ground rules.

## Licensing

This project is licensed **AGPL-3.0-only** (see [`LICENSE`](LICENSE)) and contributions are
governed by the **Contributor License Agreement** ([`CLA.md`](CLA.md), the canonical text). By
submitting a contribution you agree it is licensed under **AGPL-3.0-only**, you certify the
[Developer Certificate of Origin](https://developercertificate.org/) (the work is yours to
contribute), and you accept the CLA. Sign your commits off:

```
git commit -s -m "..."
```

**Signing the CLA.** You sign **once**, automatically, on your first pull request: the CLA bot
comments with a link to [`CLA.md`](CLA.md) and asks you to reply with the exact sentence

> I have read the CLA Document and I hereby sign the CLA

The CLA keeps the public tree AGPL-3.0 while letting OpenMasjid-Solutions also offer
commercial/dual licenses; you keep your copyright. If you cannot accept the relicensing grant
(§2 of the CLA), say so in your PR and we'll take it AGPL-only or discuss.

## Getting set up

You need **Node 22** (what the container image runs) and, optionally, Docker.

```bash
git clone https://github.com/OpenMasjid-Solutions/OpenMasjidDonations
cd OpenMasjidDonations
git checkout dev            # all work happens on dev; main only ever moves for a release

cd server && npm install    # API + Stripe + SQLite + the static host
cd ../web  && npm install   # donor site + admin panel
```

Two terminals for the inner loop:

```bash
cd server && npm run dev    # tsx watch, on :8080
cd web    && npm run dev    # Vite on :5173, proxying /api to the server
```

Open `http://localhost:5173`. Use Stripe **test keys** and Stripe's
[test cards](https://docs.stripe.com/testing) — never a live key in development. The app
shows a **TEST MODE** badge whenever a test key is in use.

You do **not** need OpenMasjidOS to develop: with no `OPENMASJID_*` environment variables the
app runs fully standalone behind its own admin password, and every platform integration
(sign-in, theme, vaulted Stripe keys, email, alerts, WhatsApp, admin commands, tuition) fails
soft — the donation site works regardless, which is the property to preserve.

| Variable | What it does |
|---|---|
| `PORT` | Listen port (default 8080) |
| `DATA_DIR` | Where the SQLite file and uploaded images live (default `/data` in the image) |
| `PUBLIC_DIR` | The built web app to serve (default the image's own copy) |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `OPENMASJID_BASE_URL` + `OPENMASJID_APP_SECRET` | Injected by the platform. Both present = "embedded": SSO, the Stripe vault, email, alerts, WhatsApp and the tuition broker switch on |
| `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CURRENCY` | **First-run seeds only**, for running the container by hand. Nothing injects them, and a value saved in the app always wins |

### The platform-only features, without a platform

Anything behind the Fabric (WhatsApp, admin commands, email receipts, vaulted Stripe keys) needs
`OPENMASJID_BASE_URL` + `OPENMASJID_APP_SECRET`. Point the base URL at a real OpenMasjidOS to
exercise them properly; point it at a dead address to check the fail-soft path, which is the one
that actually ships to a masjid whose platform is briefly down.

**Admin commands** (`POST /fabric/commands/run`) are the easy exception — they read only local
SQLite, so a dead base URL is fine. The two headers **are** the authentication, so both are
required:

```bash
curl -X POST http://localhost:8080/fabric/commands/run \
  -H 'content-type: application/json' \
  -H "x-openmasjid-app-secret: $OPENMASJID_APP_SECRET" \
  -H 'x-openmasjid-caller-app: omos:platform' \
  -d '{"command":"totals","requestId":"dev-1"}'
```

Drop either header and it must be a flat `403`. Every command is read-only and aggregate, and
**no reply may ever name a donor** — see `CLAUDE.md` §13 and `server/src/commands.test.ts`, which
fails if a parameter that could carry one is added to the reply surface.

**WhatsApp** cannot be exercised without a real gateway, and that is deliberate: the number
belongs to a masjid and the ban risk is theirs. `server/src/whatsapp.test.ts` pins the wire
contract (the three details that otherwise fail silently) against a stubbed `fetch`, which is the
right place to work on it.

## Before you open a PR

```bash
cd server && npm run build && npm test   # tsc, then the node --test suite
cd web    && npm run build               # tsc --noEmit, then vite build
docker build -t openmasjiddonations:dev .   # optional: the whole container
```

All three must be clean. If you add a `*.test.ts` file, **add it to the `test` script in
`server/package.json`** — the list is explicit, so a new file otherwise silently never runs.

## Code

- Keep it **AGPL-3.0-only** — every source file carries an SPDX header
  (`// SPDX-License-Identifier: AGPL-3.0-only` for ts/tsx/js/css, `#` for yml/sh/Dockerfile,
  `<!-- -->` for md/html), followed by `Copyright (C) 2026 OpenMasjid-Solutions`. Add one to
  new files; never strip an existing one.
- **Conventional-commit messages**, small commits, and comment the *why* rather than the what.
- Match the surrounding style; the UI follows the OpenMasjidOS design language
  (dark default, WCAG AA, RTL-ready, honors `prefers-reduced-motion`). Colors and spacing
  come from the design tokens — never a hardcoded hex in a component.
- **Never** put a Stripe secret key in the browser or a log, and never handle raw card data:
  entry happens inside Stripe's own Payment Element (PCI SAQ-A).
- Don't weaken the security invariants — they are enumerated in
  [`CLAUDE.md`](CLAUDE.md) §13 ("Security invariants — DO NOT REGRESS") and each one is
  written with the failure it prevents. If a change looks like it needs to cross one, say so
  in the PR rather than working around it.

## Where things are

| Path | What it is |
|---|---|
| [`server/src/index.ts`](server/src/index.ts) | Every route, the `raise()` notification door, and the background jobs |
| [`server/src/store.ts`](server/src/store.ts) | SQLite schema + the whole data layer |
| [`server/src/fabric.ts`](server/src/fabric.ts) | The OpenMasjidOS integration (SSO, Stripe vault, email, alerts, public URL) |
| [`server/src/whatsapp.ts`](server/src/whatsapp.ts) | The WhatsApp channel — status, approved groups, and one queued message at a time |
| [`server/src/commands.ts`](server/src/commands.ts) | Admin commands: the two-header check, and every reply, as pure functions |
| [`server/src/plans.ts`](server/src/plans.ts) · [`server/src/refunds.ts`](server/src/refunds.ts) | Monthly plans over live Stripe state; refunds as an amount |
| [`server/src/students.ts`](server/src/students.ts) | The tuition (Students-billing) contract |
| [`web/src/donate.tsx`](web/src/donate.tsx) · [`web/src/admin.tsx`](web/src/admin.tsx) | The donor page and the admin panel |
| [`web/src/changelog.ts`](web/src/changelog.ts) | "What's new" — and it has a different shape per branch (see `CLAUDE.md` → Branching policy) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Why things are the way they are |
| [`docs/audit/`](docs/audit/) | The audits, and what is still open |
