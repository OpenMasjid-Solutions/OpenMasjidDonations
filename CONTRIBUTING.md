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
(sign-in, theme, vaulted Stripe keys, email, alerts, tuition) fails soft.

Useful environment variables: `PORT` (8080), `DATA_DIR` (where the SQLite file and uploads
go), `PUBLIC_DIR` (the built web app), `LOG_LEVEL` (`debug`/`info`/`warn`/`error`).

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
  (dark default, WCAG AA, RTL-ready, honors `prefers-reduced-motion`). Colours and spacing
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
| [`server/src/index.ts`](server/src/index.ts) | Every route, and the background jobs |
| [`server/src/store.ts`](server/src/store.ts) | SQLite schema + the whole data layer |
| [`server/src/fabric.ts`](server/src/fabric.ts) | The OpenMasjidOS integration (SSO, Stripe vault, email, alerts, public URL) |
| [`web/src/donate.tsx`](web/src/donate.tsx) · [`web/src/admin.tsx`](web/src/admin.tsx) | The donor page and the admin panel |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Why things are the way they are |
