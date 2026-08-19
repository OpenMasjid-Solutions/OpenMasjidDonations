<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# CLAUDE.md — OpenMasjidDonations

> This file is the single source of truth for the **OpenMasjidDonations** app. Read it fully before writing any code. When in doubt, follow this document, then the two references in §2, over your own assumptions. If something is ambiguous, ask before guessing.

---

## Branching policy

**This section comes before everything else in this file, and overrides anything below it that assumes work lands on `main`.**

### Session-start check (do this before making any change)

```bash
git branch --show-current    # MUST print: dev
```

If it prints anything else, `git checkout dev` first. If you are on `main`, you are in the wrong place — stop and switch. Do not "just make this one small change" here.

### The two branches

| Branch | What it is | Who moves it |
|---|---|---|
| `dev` | Where **all** development happens. Every feature, fix, experiment, docs edit and dependency bump. | You, freely. |
| `main` | The stable channel. Its tip is always the last release. | **Only Hasan, by saying "push to main" / "merge to main".** |

### Rules

1. **All development happens on `dev`** — this session and every future one. Commit and push to `dev` as normal work. This is the default and needs no permission: finish the work, commit it, push it to `dev`.
2. **Never commit to `main`.** Not for a hotfix, not for a typo, not for a one-line docs fix, not because something is urgent. There is no exception that does not start with Hasan saying so.
3. **Never merge, rebase onto, cherry-pick into, or fast-forward `main` autonomously.** Not even when `dev` is green and `main` is behind. Being obviously-correct is not authorisation.
4. **`main` moves only on the explicit words "push to main"** (or "merge to main") from Hasan. Nothing else counts — not "ship it", not "release it", not approving a diff, not merging a PR into `dev`. If you think a release is due, *say so and wait*.
5. **That push is a release.** When told, do the full runbook in **§16.1**, whose step order is load-bearing: bump the version, let CI publish the image, commit the `@sha256` digest, and **tag the digest-pin commit — not the commit before it.** Then open a **pull request** against the catalog's `dev`, never a push to the catalog's `main`.
6. **Restore the pinned image line when merging to `main`.** On `dev`, `docker-compose.yml` points at the moving `:dev` tag with no digest. `main` must always carry `:<version>@sha256:<digest>`. A merge that carries the `:dev` line into `main` would point every stable install at a development build — check this line explicitly, every time.

### After every push to `dev`, ask (required)

Whenever a turn ends with a change committed and pushed to `dev`, **close the reply by asking whether it should go to `main`** — the last line, so it is never buried:

> **Do you want me to push this to `main`?** Until you say so, I'll keep pushing to `dev`.

Rules for the ask:

- It is a **question, not a step you then take**. Ask, stop, and wait. Never read your own suggestion, silence, a thumbs-up, or the next unrelated instruction as a yes.
- Ask **once per turn that pushed**, at the end. Not mid-reply, not several times.
- **Don't ask when nothing was pushed** — a question you answered, an investigation, a review, a turn whose work is still uncommitted. The ask exists to offer a *release*, so there must be something on `dev` to release.
- A "no", a changed subject, or no answer at all means **carry on pushing to `dev`**. Work simply accumulates there until Hasan says the words; several pushes then release together, which is normal and fine.
- When he does say it, follow rule 5 in full — and re-read rule 6 before merging.

### Update channels (how the two branches reach a masjid)

OpenMasjidOS has an Update Channel toggle. The OpenMasjidAPPS catalog resolves this app per channel:

| Channel | Git ref | `manifest.yaml` version | Image tag the compose pins | Moving alias |
|---|---|---|---|---|
| stable | the `vX.Y.Z` tag (registry `ref:` + immutable `commit:`) | `X.Y.Z` | `:X.Y.Z@sha256:…` | `:latest` |
| dev | the `dev` branch (registry `dev_ref: dev`) | `X.Y.Z-dev.N` | `:X.Y.Z-dev.N` | `:dev` |

### Publishing a dev build

**The version is the whole mechanism.** OpenMasjidOS spots an update by comparing the catalog's `version` with the installed one. A dev build that reuses the stable version is *invisible* to the platform however many times it is published — nothing to notify, nothing to update to. So:

- **Dev versions are semver prereleases: `X.Y.Z-dev.N`.** `X.Y.Z` is the release being worked toward; `N` increments on **every published dev build**. It must never equal the stable version. Ordering is `0.40.1 < 0.41.0-dev.1 < 0.41.0` — ahead of the last release, behind the next.
- When that work ships to stable the version becomes `X.Y.Z` (drop the suffix), and `dev` then starts the next one at `X.(Y+1).0-dev.1`.
- CI enforces both directions and fails the build rather than publishing something undetectable: a **dev** build without a `-dev.N` is refused, and a **stable** build *with* one is refused.

**Bump the version and the image reference together, in ONE commit:**

1. Set `manifest.yaml` + `server/package.json` + `web/package.json` to `X.Y.Z-dev.N`, **and** point `docker-compose.yml`'s `image:` at `…:X.Y.Z-dev.N` — **every service**, if this app ever grows a second one. Never a bare `:dev` here.
2. Commit and push `dev`. CI publishes `:X.Y.Z-dev.N`, moves the `:dev` alias, and then — only after that push succeeds — signals the catalog to rebuild (`repository_dispatch` → `rebuild-catalog`).

This used to be two steps, compose second, so that the compose could never name a tag that did not exist yet. **The catalog dispatch is what made one commit correct**, and two commits wrong: the dispatch fires *after* the image is published, so a single commit gets the catalog rebuilt at a moment when the version, the compose and the published image all agree. Splitting it would fire the dispatch while the compose still named the *previous* tag, publishing a catalog entry whose version and image disagree — and the follow-up compose push does not rebuild (it is in `paths-ignore`), so nothing would correct it until the next cron. A wrong version pointing at a real image is worse than a brief gap, because nothing about it looks broken.

The remaining gap is small and self-healing: between the push and the build going green (~10 min) the tip of `dev` names a tag that does not exist yet, so a catalog rebuild landing in that window (the hourly cron) would offer an image that cannot be pulled. That fails visibly, and the dispatch at the end of the build corrects it.

**Every push to `dev` that touches anything outside `paths-ignore` needs a fresh `-dev.N`** — including a workflow-only change. The build republishes whatever version the manifest says, so reusing `N` would quietly replace the contents of an already-published tag and leave every masjid on that version with no update to find.

**`web/src/changelog.ts` carries an `Unreleased` entry on `dev`, and never on `main`.** That file is the "What's new" list a masjid reads, and the two channels want different things from it:

- On **`dev`**, the first entry is `{ version: 'Unreleased', unreleased: true, … }` — a running, *properly detailed* account of what has landed since the last release. Not just the headline features: the security fixes, the corrections, the removals. It is what somebody on the Development channel needs in order to know what changed under them, and the working notes the release entry is later distilled from. Add to it as part of the same commit as the work; it needs no version bump of its own.
- On **`main`**, there is no `Unreleased` entry at all, and the release entry carries **only the major changes** — what a masjid would actually notice. Detail that matters to a developer and not to a treasurer belongs on `dev` and in `docs/`.

At release time you therefore *distil*, you don't move: write the `X.Y.Z` entry from the `Unreleased` notes keeping only what is major, and leave `dev`'s `Unreleased` to be emptied and started again for the next cycle. The `dev` → `main` merge will conflict on this file; resolving it means **taking `main`'s shape** (release entry, no `Unreleased`) and letting `dev` keep its own.

`Release.unreleased` is what makes this safe to ship: the dialog renders that entry as "Unreleased — on the Development channel" instead of pretending to be a version, so a dev box never claims to be running a release that does not exist.

`.github/workflows/build-image.yml` decides the channel from the git ref, not the event, so a manual run on `dev` can never publish `:latest`. Every dev build also gets an immutable `:dev-<12-char sha>` tag — `:dev` means "newest", `:dev-<sha>` identifies exactly which commit a box is running, which is what makes a bad dev build diagnosable and rollback-able despite the moving tag.

The catalog build's digest-pin check is a **warning, not a failure** (`scripts/build-catalog.mjs`), so the dev entry builds fine and warns. **That warning is expected on `dev` — do not silence it by pinning a digest there**, which would freeze the channel and defeat its purpose.

---

## 1. What we are building (one paragraph)

**OpenMasjidDonations** is an app for [OpenMasjidOS](https://github.com/OpenMasjid-Solutions/OpenMasjidOS) that gives a masjid a beautiful, self-hosted **donation website** powered by **Stripe**. A donor opens the page (on the masjid's network via a kiosk/QR code, or publicly if the masjid chooses to expose it), picks a cause, chooses a **preset or custom amount** (one-time or monthly), and pays by card. An admin manages everything from a polished, login-protected panel: create multiple **donation pages/appeals**, write rich content, upload images, set preset amounts, theme the site, enter Stripe keys, and review donations. On startup the app **receives the masjid's details** (name, address, contact, currency) from the platform and is configured for Stripe. It runs as **one Docker container**, is **AGPL-3.0**, and looks and feels like the rest of the OpenMasjid family.

---

## 2. Prime directives — read the references first

You are building an OpenMasjidOS app. Two repositories define how that is done. **Read them before and during the build; mirror them.**

1. **`OpenMasjid-Solutions/OpenMasjidDisplay`** — the reference implementation and your structural template. It is a completed, shipped OpenMasjidOS app. **Copy its shape**: the `server/` + `web/` split, the one-container `Dockerfile`, the `docker-compose.yml` conventions, the `manifest.yaml`, the `icon.svg`/`screenshots/` layout, the platform **single-sign-on + theme/wallpaper matching done server-to-server** (never trusting the browser, with a local-password fallback), the least-privilege posture, and the CI that builds and publishes the image. When this CLAUDE.md and Display's real files disagree on a mechanism, **read Display's actual code and follow it.**

2. **`OpenMasjid-Solutions/OpenMasjidAPPS`** — the catalog contract. Read **`OpenMasjidOS/docs/APP_MANIFEST_SPEC.md`** for the manifest, the `docker-compose.yml` rules (labels, project naming, volumes, ports, restart policy, banned settings), and validation. The app is registered by adding an entry to **`registry.yaml`** in OpenMasjidAPPS: `id`, `repo`, `ref` (a git tag). **Do not** hand-build a `catalog.json` — the registry model supersedes the older folder/catalog model in places; follow what Display does.

**Hard rules that override everything except safety:**
- **License: AGPL-3.0 + CLA (hard rule for all future code).** The full AGPL-3.0 `LICENSE` plus a **Contributor License Agreement** (`CLA.md`, enforced by `.github/workflows/cla.yml`): contributions are AGPL-3.0 inbound and grant OpenMasjid-Solutions the right to **also** offer commercial/dual licenses (public tree stays AGPL-3.0; contributors keep copyright). *Every line written here is AGPL-3.0 and CLA-covered.* **Every new file must start with the SPDX header** in its comment syntax — `// SPDX-License-Identifier: AGPL-3.0-only` (ts/tsx/js/css), `# …` (yml/sh/Dockerfile), `<!-- … -->` (md/html) — followed by `Copyright (C) 2026 OpenMasjid-Solutions`. Never strip an existing header; never add AGPL-incompatible code/assets/deps. Include a visible "Source code" link to this repo in the admin UI. See `CONTRIBUTING.md`.
- **Never copy code from umbrelOS / `umbrel-apps` (PolyForm-Noncommercial)** — incompatible with AGPL. Reimplement from behaviour.
- **Stripe secret keys are server-side only.** They must never reach the browser, never be logged, never be committed. The browser only ever sees the **publishable** key.
- **Never touch raw card data.** Card entry happens inside Stripe's own elements/hosted pages (PCI scope SAQ-A). We only handle tokens/IDs.

---

## 3. Repository & identity

- This is its **own repository** named **`OpenMasjidDonations`** (separate from the platform and the catalog).
- App **`id`: `donations`** (kebab-case, used in the manifest, compose labels, and the OpenMasjidAPPS registry entry).
- Registered in OpenMasjidAPPS `registry.yaml` as:
  ```yaml
  - id: donations
    repo: OpenMasjid-Solutions/OpenMasjidDonations
    ref: vX.Y.Z          # the human label
    commit: <40-char SHA> # what is actually fetched
    dev_ref: dev          # the development channel, tracked automatically
  ```
  That entry is changed **only by a pull request against the catalog's `dev` branch** — see **§16.1**. Never a push to the catalog's `main`.
- Container image published to **GHCR** (match Display's naming convention, e.g. `ghcr.io/openmasjid-solutions/openmasjiddonations:<version>`). Confirm Display's exact image path and mirror it.

---

## 4. Scope

### ✅ In scope (v1.0)
- **Public donation site** (no login): one or more donation pages/appeals, each with title, rich content, images, **preset amounts + a custom amount**, one-time and **monthly recurring** options, an optional **cover-the-fees** toggle, branded with the masjid's name/logo/colours.
- **Card payments via Stripe**, on-brand (Stripe **Payment Element**, embedded), with a clean success/thank-you page and optional emailed receipt.
- **Admin panel** (login-protected): create/edit/reorder/delete donation pages; rich-text + image editor; manage preset amounts; theme options (light/dark, accent, logo, wallpaper); Stripe configuration; **donations log + simple stats** (totals, by appeal, recent, CSV export).
- **Startup configuration:** receive masjid details from the platform profile (see §6); accept Stripe keys + currency (via install settings and/or in the admin).
- **Platform integration:** auto sign-in via OpenMasjidOS SSO (server-to-server) and match the dashboard's light/dark theme + wallpaper, with a **local admin password fallback** for standalone use (mirror Display).
- **One container**, least-privilege, Pi-friendly, with a `/healthz` endpoint.

### ❌ Out of scope (v1.0)
- Storing or processing raw card numbers (Stripe handles all card data).
- Non-Stripe processors (PayPal, etc.) — design cleanly so a second provider *could* be added later, but build Stripe only.
- Full accounting/CRM, donor logins, tax-receipt PDFs beyond a simple email receipt.
- Modifying the OpenMasjidOS platform or the OpenMasjidAPPS contract.

### 🔭 Later (design for, don't build now)
- Additional payment providers; donor accounts; multi-currency per appeal; webhook-driven recurring receipts when the box is publicly reachable.
- **Gift Aid (UK) — half-built, and be honest about it.** The data model carries the flag (`campaigns.gift_aid`, `donations.gift_aid`, and a `giftAid` value in the Stripe metadata), but **nothing collects the declaration** — no UK-taxpayer confirmation, no name-and-home-address capture — and neither the admin form nor the donor page exposes the toggle at all. So it is a column, not a feature. Do not describe it as shipped (the README correctly doesn't), and do not delete the column: the shape is right and the missing half is the declaration form. See `docs/ARCHITECTURE.md` → Build order, item 6.

---

## 5. Architecture

Mirror Display: everything in **one container** — the API server, the static web build, and the SQLite data store.

```
   Donor's phone / kiosk ─▶  Donation site (React)         Admin (React, same app, /admin)
                                  │  REST (+ Stripe.js Payment Element)        │
                                  ▼                                            ▼
                         OpenMasjidDonations server (Node + TypeScript, Fastify)
                          • REST API: appeals, content, settings, donations
                          • Stripe: create PaymentIntent / Subscription (server-side secret)
                          • Confirm on return via Stripe retrieve (no inbound webhook needed)
                          • Optional Stripe webhook endpoint (when publicly reachable)
                          • Platform SSO + theme (server-to-server) with local-password fallback
                          • SQLite (better-sqlite3) + uploaded images on the data volume
                                  │                         │
                                  ▼ outbound HTTPS          ▼
                            api.stripe.com           /opt/openmasjid/apps/donations/data
```

**Self-hosted reality — this is critical:** a masjid box is usually only reachable on the **LAN**, so **do not depend on inbound Stripe webhooks** for the core flow. Confirm payments by having the server **retrieve** the PaymentIntent/Checkout Session from Stripe (outbound call, always works) when the donor returns, and record the donation then. Treat webhooks as an **optional enhancement** (resilience + recurring `invoice.paid`) that only works when the masjid has exposed the app publicly. The app must work fully for one-time donations with **no public ingress**.

---

## 6. Startup configuration & secrets

### Masjid details (from the platform profile)
Declare the fields the app needs via **`uses_profile`** in `manifest.yaml`. The platform injects them as `MASJID_*` environment variables (see APP_MANIFEST_SPEC §4). Use them to pre-fill the site branding, receipts, and default currency:
- `name → MASJID_NAME`, `address → MASJID_ADDRESS`, `email → MASJID_EMAIL`, `phone → MASJID_PHONE`, `website → MASJID_WEBSITE`, `currency → MASJID_CURRENCY`, `timezone → MASJID_TIMEZONE`, `language → MASJID_LANGUAGE`.

**Be resilient:** if any `MASJID_*` var is absent (the platform's central-profile feature is still being finalised), fall back to values the admin enters in-app. **Never hard-fail because a profile var is missing.** Admin-entered values, once set, take precedence and persist to the data volume.

### Stripe configuration
**`manifest.yaml` declares NO `settings:` block** — install is genuinely one-click, with no dialog. Everything is chosen inside the app, and Stripe keys reach it three ways:

1. **The OpenMasjidOS vault** (`stripe: true`, the normal case when embedded). The admin sets Stripe up once in OpenMasjidOS → Settings → Payments; the app lists the accounts on its own Payments screen (`GET /api/fabric/stripe/accounts`) and fetches the chosen one's keys server-to-server. Those keys are held **in memory only** and never written to the data volume, so they track the vault across a restore.
2. **Keys typed into the admin panel** — the standalone path, stored in SQLite on the data volume.
3. **Environment variables** (`STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CURRENCY`), read by `config.ts` as **first-run seeds only**. They are vestigial — no manifest setting produces them and the platform never injects them — but `docker-compose.yml` still references them, so an operator running the container by hand can use them. Once the admin saves a value in-app it wins.

Since **v0.42.0 each appeal may name its own account** (`campaigns.payment_account`), so a Zakat page can settle somewhere separate from the general fund; `''` means "follow the site default", which is exactly the pre-v0.42.0 behaviour. See §13 and `docs/ARCHITECTURE.md` → Per-appeal Stripe accounts.

Rules: the **secret key is stored server-side only**, **never sent to the browser**, **never logged**. Show a clear **"TEST MODE"** badge when a `sk_test_`/`pk_test_` key is in use — on the donor page as well as the panel. The site refuses to show the donate button until a valid publishable+secret pair is configured, with a friendly "Donations aren't set up yet" message for visitors and a clear setup prompt for the admin.

---

## 7. The donation experience (public site)

- **Appeals/pages:** the admin can create several (e.g. *General Fund, Zakat, Building Fund, Ramadan Appeal*). Each has: slug, title, rich body (text + images), hero image, preset amounts, allow-custom toggle, one-time/monthly options, optional goal + progress bar, active/inactive. A configurable default/home appeal.
- **Amounts:** **preset (static) buttons + a custom amount field**, both clearly shown; sensible min/max; currency from config. (This is the core "custom and static amounts" requirement.)
- **Checkout (embedded, on-brand):** use **Stripe Payment Element**. Server creates a **PaymentIntent** (one-time) or a **Subscription** (monthly) with the secret key; client confirms with the publishable key. Keep the donor on the masjid's branded page.
- **Cover-the-fees:** optional toggle so the donor can add the processing fee and the masjid receives the full intended amount. Compute transparently and show the donor the total.
- **Gift Aid (UK):** not built — see §4 "Later". The flag exists in the data model and nothing collects a declaration.
- **After paying:** a warm thank-you page; an **optional email receipt** through the OpenMasjidOS email provider (`email: true`), so the app never sees the masjid's mail credentials. Graceful when email isn't set up: the donation is still recorded and thanked on screen, and Stripe's own receipt is used instead. Record the donation locally for the admin log.
- **Trust:** the payment area should feel secure and professional (clear amounts, Stripe's lock/badging, no jarring layout shift). It must be fast on a Raspberry Pi.

---

## 8. The admin panel

Login-protected (platform SSO when embedded; local password fallback). **Eight tabs** behind a bottom dock, as shipped — keep this list and the README's table in step:

- **Overview** — total raised, this month, count, live appeals, average gift, per-appeal breakdown, 6-month trend.
- **Campaigns** — list, create, edit (content + image upload), reorder, activate/deactivate, delete; live preview; presets/min/max/goal, monthly option, fee rule, widget, and **which Stripe account this appeal pays into**.
- **Donations** — the ledger (amount, appeal, date, donor if given, one-time/recurring, status, refund state), a per-donation detail window with that donor's history, **refunds** (full or part, with a reason and an optional donor email), and **CSV export**.
- **Monthly** — every recurring plan, its live Stripe state and payment history, and pause/resume/stop/end-date controls.
- **Thank-you** — the on-screen thank-you and the emailed receipt's design, with "send me a test".
- **Large gifts** — the threshold, wording and QR image for the bank-transfer suggestion.
- **Payments** — Stripe accounts (local and vaulted), the site default, currency, test/live indicator, and the optional per-account webhook URL.
- **Settings** — masjid details, appearance, notifications, email receipts on/off, **WhatsApp** (admin notifications, hidden unless the platform says it is available), public access.

Plus a guided first-run setup, and an account menu carrying the version, **"What's new"**, and the AGPL **"Source code"** link to this repo.

Uploaded images and all settings/records live on the data volume (`/data` in the container — see §10). Validate and constrain uploads (type, size).

---

## 9. Stripe integration rules

- Use the official **`stripe`** Node SDK (server) and **`@stripe/stripe-js`** + **`@stripe/react-stripe-js`** (client). Pin versions and a fixed Stripe **API version**.
- **One-time:** create a PaymentIntent server-side (amount in the smallest currency unit, correct currency, metadata: appeal id, gift-aid, cover-fees). Confirm with Payment Element. On return, **retrieve** the PaymentIntent server-side to verify `succeeded` before recording — never trust the client's word.
- **Recurring (monthly):** create a Stripe **Customer + Subscription** (or a Checkout Session in `subscription` mode). Ongoing charge confirmation ideally uses the `invoice.paid` **webhook**, which requires public ingress — so treat ongoing recurring tracking as best-effort and document the dependency. Creating the subscription works fine on a LAN (outbound only).
- **Idempotency:** use idempotency keys on PaymentIntent/Subscription creation to avoid duplicates on retries. A **refund**'s key is *derived* — `refund:<pi>:<already-refunded>:<amount>` — not random, so a double-clicked button gives the money back once while a genuine second part-refund of the same size still goes through.
- **Webhooks (optional, per account):** `POST /api/stripe/webhook/:accountId`, gated on that account having a webhook secret, signature **always verified**. Handles `payment_intent.succeeded`, `invoice.paid` / `invoice.payment_succeeded` (renewals only) and `charge.refunded` (which is how a refund made in the masjid's own Stripe dashboard reaches this app's totals). Without a webhook the app relies on retrieve-on-return plus the renewal reconciliation and the lost-donation sweep, which is the supported LAN configuration.
- **Amounts & currency:** always compute in integer minor units server-side; never trust client-sent amounts beyond appeal min/max validation. Default currency from `MASJID_CURRENCY`.
- **Rate-limit** the donation-creation and webhook endpoints. Validate all inputs (zod).

---

## 10. Manifest, compose & registry

> **The files on disk are the specification; this section describes them.** `manifest.yaml` and `docker-compose.yml` are read verbatim by the OpenMasjidAPPS catalog, and both **deliberately deviate from APP_MANIFEST_SPEC where Display and the platform actually differ from it** (the §2 prime directive). Those deviations are enumerated once, with reasons, in `docs/ARCHITECTURE.md` → *Where this app intentionally differs from the platform contract / Display*. Read that before "fixing" either file to match the spec — the last audit raised the mismatch as DONATIONS-049 and the answer was that the spec had drifted, not the app.

**`manifest.yaml`** — as shipped: `id: donations`, `author: OpenMasjid-Solutions`, `license: AGPL-3.0-only`, `icon: icon.svg`, `screenshots: [screenshots/1.svg]`, a long `description`, and the capability flags `sso`, `notifications`, `https`, `stripe`, `domain`, `email`, `whatsapp`, plus `fabric.consumes: [students/billing]`, `alerts:` (**seven** declared ids — the six events in §8's Settings tab, plus `test`) and `commands:` (**five**, all read-only: `today`, `month`, `totals`, `appeal`, `monthly`).

Two of those lists are contracts with code, not decoration, and a rename that misses a file fails **silently** — the platform 400s an alert id it was not told about, so the switch says on and nothing ever arrives. `server/src/notify.test.ts` reads this file and fails when an event has no declared id, which is the only thing that makes that loud. `commands:` must **never** appear in `fabric.provides` (§13).

Three absences are deliberate and each is load-bearing:

- **No `settings:`** — install is one-click with no dialog (§6).
- **No `uses_profile` / no `MASJID_*` dependency** — the platform injects no masjid profile. Those env vars are read as optional first-run seeds and nothing hard-fails without them.
- **No `resources:` / no `default_host`** — the platform assigns the host port itself.

**`docker-compose.yml`** — one service, `image:` pinned per channel (see the Branching policy), `restart: unless-stopped`, an `environment:` block that **must** reference every `${VAR}` the platform injects (compose `--env-file` only does substitution — an unreferenced var never reaches the container), a **named volume** `data:/data`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `tmpfs: [/tmp]`, and a static `"7870:8080"` mapping. **Never** `privileged`, the docker socket, `network_mode: host` or `pid: host`. No top-level `name:` (the project is `omos-donations`).

Known gap, recorded not hidden: the container still **runs as root** and the root filesystem is not `read_only`. Both need an entrypoint that chowns the volume plus one real container start to prove the database is still writable — see `docs/audit/ACTION_REQUIRED.md` §4d.

**Registry.** The app is listed in OpenMasjidAPPS `registry.yaml` with `ref:` (the stable `vX.Y.Z` tag) plus the `commit:` that is actually fetched, and `dev_ref: dev`. That entry is changed by **a pull request against the catalog's `dev`** — the last step of the release runbook, **§16.1**. A catalog maintainer, not us, moves the catalog's `main`.

---

## 11. Tech stack (match Display)

- **TypeScript everywhere.** `strict` on, plus `noUnusedLocals`/`noUnusedParameters`; no `any` without a justifying comment.
- **`server/`** — **Node 22** (what the image runs) + **Fastify 5**. **better-sqlite3** for storage. **`stripe`** SDK (the API version is pinned by the SDK version in `package.json` — we never pass `apiVersion`, so it cannot silently drift). **scrypt** (Node built-in, N=2^16) for the fallback admin password — no external crypto dependency. Validate every external input with **zod**. No WebSockets: nothing here needs a live channel.
- **`web/`** — **React 18 + Vite + TypeScript**, styled with **Display's own design tokens** (`tokens.css`, `glass.css`, copied verbatim so the app matches the live dashboard) plus **Tailwind utilities only, preflight off**, mapped onto those CSS variables. **Motion** for animation, **lucide-react** icons, **qrcode.react** for share codes, **@stripe/react-stripe-js** for the Payment Element. No component library — there is no shadcn/ui here and adding one would fight the tokens. One app serving the public site and the `/admin` panel.
- **Tests** are `node --test` with `tsx`, listed explicitly in `server/package.json`'s `test` script. **A new `*.test.ts` file must be added to that list or it silently never runs.**
- **One container** via a multi-stage **Dockerfile** (build web, build server, final runtime serves the web build + API), exactly like Display. `docker compose up -d` runs it.
- Keep it **lean and Pi-friendly**; lazy-load the admin bundle, the donor stop page and the release notes so the donation page stays light.

---

## 12. Design & theming

Match the OpenMasjid family — the polish must equal Display and the dashboard.
- **Tokens via CSS variables.** Dark is default; light + follow-system supported. Primary **emerald** (`#1FA37A` family), **gold** (`#D4AF37`) accent used sparingly, deep night-green dark base. Never hardcode hex in components.
- **When launched from OpenMasjidOS**, match the dashboard's theme + wallpaper (server-to-server, like Display). Standalone, use the app's own appearance settings.
- Subtle Islamic-geometric texture; respectful, serene, trustworthy — this is a payments page, so clarity and calm beat flashiness.
- **Motion** for gentle entrances, button/press springs, and a satisfying (understated) success state after a donation. **Always honour `prefers-reduced-motion`.**
- **i18n + RTL ready** (English first; logical CSS properties; structure strings for translation). Do not put Quranic/sacred text into decorative chrome.
- Plain, warm, non-technical wording everywhere (donor- and admin-facing). Friendly errors; never a raw stack trace.

---

## 13. Security

- Stripe **secret key server-side only**; never to the client, never logged, never committed. Publishable key is the only key the browser sees.
- **Never handle raw card data** — Stripe Elements only (PCI SAQ-A).
- **Verify Stripe webhook signatures**; verify payment status by server-side **retrieve**, never by trusting client claims.
- Admin behind auth (platform SSO server-to-server, verified with the platform — never trust the browser — with a local **scrypt** password fallback). Sessions: signed, HTTP-only, SameSite=Lax cookies that gain `Secure` when the request arrived over TLS.
- **Rate-limit** donation creation, monthly sign-ups, the webhook, the tuition lookup, the donor stop link and every outbound platform call; validate/limit uploads (raster only — never SVG, which can carry script and is served from our own origin); render all user-supplied text as React nodes, never `dangerouslySetInnerHTML`.
- Least-privilege container (per §10). Outbound HTTPS to Stripe only; assume no inbound by default.
- Note for admins (in docs): taking donations from outside the masjid network means exposing the app publicly — recommend doing so only behind HTTPS (e.g. the platform's remote-access/tunnel helper).

**Security invariants — DO NOT REGRESS** (v0.39.0 sweep):
- **CSV/spreadsheet injection:** donor name/email come from the *unauthenticated* public intent endpoint. Any cell exported to CSV must be run through `csvCell`, which prefixes a leading formula trigger (`= + - @` tab CR) with a quote. Never write donor-controlled values to an export without it.
- **First-run `/api/setup` under SSO:** when SSO is configured and the platform is **reachable**, refuse an anonymous local-admin claim (only allow the local-password recovery when the platform is *unreachable*). Under SSO the local admin is never set, so an unguarded setup stays open forever = permanent unauthenticated takeover. Keep the `probePlatform` guard.
- Behind the OS proxy you may trust `X-Forwarded-Proto`/`-Host`/`-For` **only because the platform's ingress now sanitises them** — never trust them when reached directly.
- **Tuition ⇄ donation route isolation (v0.26.0):** a `tuition` campaign is a Students-billing shell, NOT a donation. The generic donation routes (`intentHandler` for `/…/intent`, and `/api/public/confirm`) must **reject `c.type === 'tuition'`** (404), and the dedicated Students routes (`/…/students/{identify,lookup,intent,confirm}`) must reject `c.type !== 'tuition'`. Without the donation-side guard a crafted/stale POST files a client-chosen amount into the `donations` table (counted in totals/CSV/Gift-Aid) and orphans it from the Students ledger. Tuition payments live ONLY in `student_payments` (never joined into `metrics()`/`listDonations()`/`raisedForCampaign()`); the typed Student ID is body-only (never logged/URL/metadata — §11.3 also bans a Student ID or a child's name from Stripe metadata and descriptions); the charge amount + `familyId` come only from the server-side lookup session, never the client.
- **Tuition itemised bills: send ONE breakdown, and price ticked lines from the session (v0.36.0):** Students resolves exactly one breakdown per `record-payment`, in the order `lines → allocations → students → derive-it-itself`. So `lines[]` (the ticked bill lines, §11.0b) is sent **alone** — never alongside `allocations` or `students[]`. A ticked line's amount comes from the session's own copy of `items[]`, never the browser's, and a line that isn't in the session or has no balance (settled, or a credit line) is refused rather than silently dropped — dropping one would charge less than the parent was shown. Itemisation is all-or-nothing **per family** (`itemised`), since that chain cannot express a mixture of lines and whole bills in one call; an invoice whose lines lack ids or don't sum to its balance must fall back to a single un-itemised row. Ticked lines are persisted (`student_payments.payment_lines`) so an outbox retry settles the same line. `allocations[]` was silently ignored before 0.43.0 and works now, so the `students[]` belt-and-braces on that path stays for pre-0.43.0 schools.
- **Tuition processing fee: charge the gross, store and report the TUITION (v0.44.0).** Students 0.51.0 lets a madrasah pass Stripe's cut to the payer (`info.fee`, additive at `"v": 2` — do **not** bump the version). `fee.enabled: false` is what almost every school returns and it means *change nothing*. When it is on, four things are load-bearing:
  - **The gross is a DIVISION and it rounds UP**, in integer arithmetic: `gross = ceil((tuition + fixedCents) / (1 − percentBps/10000))`. A markup on the tuition quotes $103.20 where the answer is $103.30, Stripe then takes $3.29, and the school banks $99.91 — so a $100 invoice never settles and shows a family as unpaid over ten cents. A `capCents` is applied last (over it, the answer is `tuition + cap`).
  - **`student_payments.amount` is the TUITION, never the gross**, with the fee in its own column. The contract's failure directions are lopsided: a missing metadata key over-credits one family slightly, while a gross in `record-payment.amountCents` credits Stripe's cut as an overpayment and silently eats the next bill for as long as the setting is on. Storing the net means the money path does no arithmetic, so no bug in the fee code can reach the ledger.
  - **`students_fee_cents` goes on the PaymentIntent whenever we grossed up** (§11.3). Reconciliation runs a day later on a job that never saw the request and may find the setting off — without it, a $103.30 charge covering $100 of tuition is indistinguishable from a family who paid $103.30. An amount identifies nobody; the ban on a **typed** Student ID or a child's name in metadata is untouched.
  - **The payer is told whose money it is, in words, before they commit** — three lines and the sentence, not a total that first appears on Stripe's form. And we quote the **card** rate, never `fee.bank`: the fee is fixed before the payer chooses a method (`automatic_payment_methods`), so quoting the bank rate would under-collect the moment somebody used a card. The rate is captured into the session at **lookup** so the charge matches what was shown, and the minimum-payment floor applies to the tuition, not the grossed-up total.
- **Tuition advance payments: the amount may come from the parent, everything else may not (v0.35.0):** an advance/part payment (§11.0a) is the one tuition figure the client names — there's no invoice to derive it from. It stays safe only because the server-side lookup session still fixes the **familyId, the child, the currency, `allowAdvance` and the floor**, so a crafted request can at most overpay the family it looked up (surplus becomes that family's own credit). Never take the floor, the family or the child from the request body. The floor is `max(MIN_TUITION_CENTS = $1, the school's advertised minAmountCents)` — a provider advertising 25¢ must not be able to drag us under a pound/dollar — and it applies to **every** path (full balance, picked months, typed amount), matching "the smallest card payment a parent may start, wherever they start it". `allowAdvance` is advertised, never assumed (false against a pre-0.41.0 Students); paying *part* of a real balance needs no permission, only money *above* it does.
- **Tuition `record-payment` MUST carry the per-child `students[]` split for picked months (v0.34.0):** Students books a tuition charge as one ledger row **per child**, taken from `students[]` if sent and otherwise **derived** by walking the *family's* open invoices oldest-due-first — a derivation that **ignores `allocations`** (the provider parses that field and drops it). Sending only `allocations` therefore credits whichever child owns the family's oldest bill, not the child whose month the parent ticked: money stays in the family but the wrong child's invoice is paid down. Derive the split server-side from the session's ticked invoices (`computeTuitionAmount`), persist it (`student_payments.students_split`) so the outbox retry books it identically, and omit it only for "pay the full balance" (there the derived split is the same answer). It must sum to `amountCents` exactly or Students returns 422 — if any invoice lacks a `studentId`, send no split rather than a partial one.
- **Tuition lookup is the v2 (PIN-free) flow (contract §11.0, provider 0.39.0):** `lookup` takes the **Student ID alone** at `"v": 2` — a v1 `{name, pin}` body **400s**, so it cannot half-work. `identify` must be called first and the parent must confirm the echoed name *before* `lookup` runs: that confirmation is the safeguard that replaced the PIN. `identify` and `lookup` share ONE per-peer rate-limit bucket (as the provider shares one per-code bucket) so switching endpoints can't launder attempts, and both are uniform on not-found (unknown / withdrawn / locked / payments-off are indistinguishable — no enumeration oracle). `info`, `record-payment` and `check` are unchanged and deliberately still send `"v": 1`: never migrate the money path as a side effect of a lookup change.
- **Monthly plans act only on subscriptions WE created, and their catch-up may only add real money (v0.38.0):** the plans index is the LOCAL `donations` rows (`recurring = 1` + a `subscription_id`), and **every plan write path — admin *or donor* —** resolves the id through that index before touching Stripe: the `/api/admin/plans…` list and all four write routes, **and the donor's own `/api/public/plan/{lookup,cancel}` (v0.42.0), which must use `findSeed(planSeeds(), …)` and NOT `getDonationBySubscription` — the latter lacks the `recurring = 1 AND subscription_id <> ''` filter that makes the index trustworthy.** That donor path is unauthenticated (a 128-bit token emailed to the donor), so it must also never reach `syncPlan` — that helper lists invoices and INSERTs donation rows, and its only guard is a `Sec-Fetch-Site` check that cannot hold for a link in an email, so a mail scanner's prefetch would drive writes against the masjid's Stripe account. Read state with `fetchPlanState` alone, and never write an audit line with `audit(req, …)` there (its actor falls back to `local admin`, which would file a donor's cancellation as the masjid's own action). Never widen it to `subscriptions.list`: a Fabric-vaulted Stripe account is **shared** with the platform's other apps, so that would show (and let an admin cancel) another app's subscriptions, and it is also the mechanism that keeps tuition out (tuition is written to `student_payments`, never `donations` — structurally absent, not filtered). Renewal **reconciliation** may only INSERT a donation for a **paid** invoice, keyed on its PaymentIntent (UNIQUE = idempotent), stamped with the date the money actually arrived; never for a failed/open one, and it must stay **silent** (no receipt email, no `notify`) — it is a catch-up, not an event. Abandoned monthly sign-ups (a `/intent` row whose card was never entered) may only be **hidden after** a sync that was allowed to reconcile — never filtered out of the index that *feeds* the sync, because a first payment that succeeded but was never confirmed looks identical locally and reconciliation is the only thing that can rescue it. And `cancel_at_period_end` is not a "take one more payment" option (Stripe raises no further invoice) — never reintroduce it as one.
- **Refunds: Stripe owns how much is left, and nothing is written until it confirms (v0.42.0).** A refund is recorded as an **amount** (`donations.refunded_amount`), never as a status — `status` stays the *payment's* outcome, because the money really did arrive and a status cannot express a part refund. Every money figure the masjid sees is therefore `amount - refunded_amount`. The route must **read the charge from Stripe first** and sync our row to it before deciding anything: a masjid can refund from Stripe's own dashboard and a LAN-only box may never see the `charge.refunded` webhook, so our row is not evidence. `setDonationRefund` is monotonic and clamped to `amount`, which is what makes a replayed or out-of-order webhook harmless. The idempotency key is **derived** (`refund:<pi>:<already>:<amount>`), never random. And the account is resolved by the id **recorded on the donation** (`accountById`), never by the campaign's current choice — money taken on account A is refunded on account A for ever.
- **Per-appeal Stripe accounts: an existing appeal's destination depends only on data that existed before the upgrade (v0.42.0).** `campaigns.payment_account` defaults to `''` with **no backfill and no inference** from `stripe_account_id`, and the `''` branch of `resolveAccountFor` is the pre-v0.42.0 resolver verbatim — the globally-chosen vault account when configured, else the campaign's legacy local account read *straight from the local table*, not through the widened `accountById`. An explicit choice is **honoured or refused**, never substituted: an unresolvable or unparseable reference stops that appeal taking cards rather than quietly settling elsewhere (`fabric:` with an empty id would reach the platform as `?account=` omitted, which it answers with its **first** account, and the ledger would then record the substitute's id — nothing would look wrong). `accountById` is **bounded by `store.knownAccountIds()`**: `/api/stripe/webhook/:accountId` is unauthenticated by necessity, so without the bound a stranger could name arbitrary accounts and make us fetch each from the platform vault. A vault account must **never** be written into `stripe_accounts` (local resolves first, so a stale copy would shadow the real one for ever). And `fetchFabricStripeDetailed` must keep splitting non-ok by status — 404/403 is an answer worth caching, 429/5xx is *no information* and must serve the last-good copy, or one throttled request becomes a donation outage and the reboot watcher restarts a box mid-donation.
- **WhatsApp is an ADMIN channel and never LOAD-BEARING (v0.43.0).** The masjid links their own number via the OpenWA gateway in OpenMasjidOS; we POST `/api/fabric/whatsapp` and never see the gateway, its credentials or the number. Three rules, and none is ours to relax because the risk lands on the masjid's phone number:
  - **Never anything auth-critical, and never a donor.** No codes, no password resets, no payment confirmation a donor is waiting on. It is an unofficial client whose number can be restricted or banned at any moment. This app deliberately **collects no donor phone number at all**, so there is nothing here that could message one even by mistake.
  - **WhatsApp is OFF by default for every event, and that one is not a matter of taste.** The OS alert channel defaults on; WhatsApp never does. An update must not begin sending messages from a masjid's own phone number on their behalf — the ban risk is theirs, not ours. `whatsappOn` is a separate boolean from the number so the switch means what it says, and a row predating it reads a stored number as on rather than silently going quiet.
  - **This invariant was rewritten in v0.43.0, deliberately.** It used to say WhatsApp is "only ever a *second* copy of something that already went out" — which per-event notification settings make false, because `{os: false, whatsapp: '…'}` is now one click and an admin is entitled to choose it. The claim that survives, and the one that actually matters, is that **nothing depends on the message arriving**: the donation is in the database and in the panel regardless, no donor outcome and no money movement hangs on a notification, and every event remains reachable through the alerts matrix. Do not "restore" the old wording by forbidding the combination; the honest version is the one above.
  - **`202 {queued:true}` is the only success, and it means QUEUED.** Never "sent", never a delivery receipt. The platform paces every message for every app at once — randomised 6–20s gaps, per-recipient cooldowns, hourly/daily caps, quiet hours that defer for hours — because ban risk attaches to the NUMBER rather than to the sender. So nothing may block on a send, retry a 4xx, or tell an admin a message was delivered. The daily cap is shared, which is why the "a donation was received" event has a `minAmount` floor: a Friday of £2 gifts would otherwise spend the masjid's whole allowance and push the refunds and failures behind it.
  - **One recipient per call, and never a client-chosen target.** A group id comes only from `GET /api/fabric/whatsapp/groups` (the ones the *platform* admin approved — not the gateway's own list, which names every group the masjid's phone is in) and is re-verified against that list before we save it. A phone number is normalised with `toWhatsAppDigits`, which **refuses a number with no country code rather than guessing one** — a guess would send the masjid's donation figures to a stranger who happens to hold that number in the platform's default country.

  Three wire details are easy to get backwards and every one of them fails *silently* — `whatsapp.test.ts` pins all three: `/groups` returns **`{ groups: [...] }`, not a bare array**; `reason` is always a word and is **`"ready"`** when available, never null; and `media` **absent means no**.
- **WhatsApp admin commands are read-only, aggregate, and authenticated by two headers (v0.43.0).** `POST /fabric/commands/run` sits **outside every `/api` guard and carries no cookie** — the headers *are* the authentication, so `isPlatformCall` must keep checking **both**: `x-openmasjid-app-secret` equal to our own secret in **constant time**, and `x-openmasjid-caller-app` **exactly `omos:platform`**. That value is the one caller id no app can present (the colon is outside the charset app ids are validated against), and without it any app that learned our secret could reach this handler through the app-to-app broker — a different trust boundary sharing the `/fabric` prefix. For the same reason `commands` must **never** appear in `fabric.provides`; the platform refuses it at install.
  - **Every command is read-only and aggregate, and that is a security property, not a scope decision.** In a channel this informal the blast radius of a mistake should be a wrong figure on a screen, never a closed appeal or a refunded donation. **No donor is ever named** — no name, email or reference — because a WhatsApp message is forwardable and screenshottable and the donor never agreed to be in one. The formatters in `commands.ts` are given counts and totals and nothing else, which makes that structural rather than a habit; `commands.test.ts` fails loudly if a parameter that could carry a donor is ever added.
  - **Local data only.** Ten-second timeout, someone holding a phone: every figure comes from SQLite. Nothing here may call Stripe — `monthly` deliberately reports what the local recurring rows say rather than syncing plans. **Which is exactly why `monthlyGiving` takes a recency window:** nothing local records that a plan ENDED (that happens at Stripe, and a LAN box may never see the webhook), so counting every subscription that ever took money would tell a masjid three years in that it had fifty monthly donors giving £2,000 a month when the truth was ten and £400. A live plan is charged monthly, so "nothing in two months" is the one local signal that it stopped; those are reported as dormant rather than dropped, because a figure that quietly shrank is unexplainable from a phone.
  - **The menu may be capped; the SEARCH may not.** One WhatsApp message has to stay readable, so `appeal` lists twelve — but a name is matched against every appeal the masjid has, and the reply says how many did not fit. Capping the list that gets *searched* made the thirteenth appeal unanswerable by every route at once: not by number (never printed) and not by name (not in the list being matched). A number, conversely, may only ever index a line that was actually shown.
  - **A follow-up exchange can end without us** (3 minutes idle, 15 total, 12 turns, `cancel`, or any new `!` command) and we are not told. So the token carries a step and an attempt and **nothing a later turn needs to be correct**, and nothing is ever left half-applied waiting for a reply that may not come — which read-only commands guarantee outright. Any `ok:false` also ends the exchange, so it is the right answer for "I give up", never for "try again".
- **Suppressing Stripe's receipt requires believing we can send our own (v0.42.0).** `receipt` is decided ONCE at intent and never re-evaluated at confirm (re-deciding was the double/zero-receipt bug). Going branded suppresses Stripe's built-in receipt, so it is gated on `emailLikelyAvailable()` — true unless we hold *positive* evidence email cannot work (`not_configured` / `no-fabric`), persisted across restarts via `store.setEmailStatus`. It must **not** be tightened back to "a previous send succeeded": that was a closed loop (only a permitted send could set `'ok'`, and only `'ok'` permitted a send) which made the branded receipt unsendable on every fresh container. The monthly setup letter deliberately bypasses this gate *and* the receipts toggle — there is no Stripe receipt to suppress on that branch, and that letter carries the donor's only self-service way to stop a charge on their card.

---

## 14. Coding conventions
- Clarity over cleverness; comment the *why*. Small commits, conventional-commit messages.
- Everything builds and runs via the documented commands and `docker compose up -d`.
- Share types between server and web where practical; validate all external input at the boundary (zod).
- All user-facing strings via i18n; all colours/spacing via tokens.
- Never copy umbrelOS/PolyForm code (see §2).

---

## 15. Build & run

Node 22 (what the image uses).

```bash
# server (API + Stripe + storage). `build` is tsc; `test` is node --test via tsx.
cd server && npm install && npm run build && npm test

# web (donor site + admin). `build` runs tsc --noEmit, then vite build.
cd web && npm install && npm run build

# everything together (Docker; also what the App Store runs)
docker compose up -d
```

Two extra scripts exist and are worth knowing: `server/npm run dev` (tsx watch) and `server/npm run typecheck` (tsc --noEmit, the fast inner loop).

For local dev run the server on :8080 and `cd web && npm run dev` on :5173 (Vite proxies `/api` to the server). Use Stripe **test keys** and Stripe's test cards; the app shows a **TEST MODE** badge whenever one is in use. Optionally `stripe listen` to forward webhooks to localhost while developing the optional webhook path.

---

## 16. CI & versioning
- **Check `README.md` still describes the app when you ship a user-visible feature.** It is the first thing anyone sees, and nothing else in this runbook forces it to be touched — which is exactly how it once drifted to describing v0.13.0 while the app was at v0.40.0. Deliberately it carries **no** version number or test count (the release badge and the changelog cover that), so only a real feature change should require an edit: a new admin tab, a new donor-facing capability, a new platform integration.
- **Add a `web/src/changelog.ts` entry with every release** — it's what the "What's new" item in the account menu shows. Plain, non-technical, what changed *for the masjid*; same voice as the App Store note in OpenMasjidAPPS `registry.yaml`, since they see both. **Only the major changes go in a release entry**; the running detail lives in `dev`'s `Unreleased` entry — see the Branching policy. It is loaded on demand, so never import it eagerly (that would put admin-only text in the donation page's bundle).
- **The version lives in FOUR files and they must agree**: `manifest.yaml` `version:` (the one CI reads and the catalog publishes), `server/package.json`, `web/package.json`, and the image tag in `docker-compose.yml`. There is deliberately **no `VERSION` file** (see `docs/ARCHITECTURE.md`); the server reports its version by reading the `package.json` shipped beside the runtime.
- **Semver, `0.x` = pre-release.** Tag releases `vX.Y.Z`.
- **GitHub Actions:** builds the multi-arch (amd64 + arm64) image and pushes it to GHCR. Both channels publish the exact `manifest.yaml` version as an immutable tag; only the moving alias differs (`:latest` for stable, `:dev` for development). The channel is decided by the git **ref**, not the event, so a manual run on `dev` can never publish `:latest`.
- **A `v*` tag push publishes NOTHING**, on purpose (corrected in v0.43.0). The tag names a commit `main` has already built, so a tag build would rebuild the same source and push it again — and because a Docker build is not reproducible, `:X.Y.Z` would land on a *new* digest and stop resolving to the one `docker-compose.yml` pins at that very commit. Masjids stay safe either way (a digest pin is resolved by digest), but the tag and the pin disagree, which is the sort of quiet inconsistency §16.1 exists to prevent. `workflow_dispatch` is the escape hatch for a tag that genuinely needs building.
- **Two channels.** The same workflow publishes the moving `:dev` (+ immutable `:dev-<sha>`) pair from the `dev` branch. Stable comes only from `main`/`v*`. See **Branching policy** at the top of this file — a release is the *only* thing that moves `main`, and only on Hasan's explicit "merge to main".
- **A push to `dev` that touches only documentation needs no version bump.** `build-image.yml`'s `paths-ignore` covers `**/*.md`, `docs/**`, `screenshots/**`, `LICENSE` and `docker-compose.yml`, so those pushes publish nothing and there is no tag to collide with. Anything else — including a workflow-only change — needs a fresh `-dev.N`.

---

## 16.1 Getting a stable release into the OpenMasjidOS catalog

**You cannot push to the catalog's `main`. Stable moves only through a catalog release, run by a catalog maintainer.** This section is the whole job; do not improvise around it.

### The three things this runbook forgot, and what they cost

Recorded here because each one was learned the expensive way, on 2026-08-18:

1. **A tag is not a release.** `git tag` + `git push` leaves GitHub's Releases page empty. This repo
   had **eight tags and zero published releases** — every one of them a release nobody could read the
   notes for. Step 5 below now exists.
2. **A release is not a catalogue entry.** OpenMasjidOS installs from
   `OpenMasjidAPPS/main/catalog.json` **and nothing else**. Until a catalogue maintainer releases,
   masjids keep getting the previous version however green this repo looks. Step 7 is the only check
   that answers *"did it ship?"* — and it is not ours to make pass.
3. **`commit:` must be the COMMIT sha, not the tag object's.** An annotated tag is its own object, so
   `gh api …/git/ref/tags/vX.Y.Z --jq .object.sha` returns the **tag**, and the catalogue build then
   404s. Use `git rev-parse vX.Y.Z^{commit}`. For v0.43.0 those were `2a1f947…` (tag) and `298702f…`
   (commit) — one of them fetches nothing.

### Step order in THIS repo — the order is the point

1. **Bump `manifest.yaml`** to the release version (plus both `package.json` files, and the image tag in `docker-compose.yml`).
2. **Let CI build and publish the image.** Wait for it to go green.
3. **Commit `docker-compose.yml` with the published image's `@sha256` digest.**
4. **Tag the digest-pin commit — not the commit before it.** `git tag -a vX.Y.Z` on the step-3 commit itself. The tag goes on the commit that *contains* the `@sha256`, never on the merge commit that precedes it.

> **Why the tag push must publish nothing.** This order only works because pushing the tag does not rebuild. It used to: `build-image.yml` triggered on `tags: ['v*']`, so the tag push republished `:X.Y.Z` at a fresh digest and the tag stopped resolving to the digest its own commit had just pinned. Every release before v0.43.0 hid this by tagging *first* and pinning after — which is the mistake in the box below, so the two faults were covering for each other. The trigger was removed in v0.43.0; if it ever comes back, this step order silently breaks again.
>
> **v0.43.0 was published under the old trigger, so it carries the divergence — and the diagnosis is worth keeping, because the obvious guess is wrong.** `:0.43.0` resolves to `sha256:a9aed99…`; the compose pins `sha256:285ce87…`. The two indexes name the **same amd64 manifest** and **different arm64 manifests**, which looks like a Raspberry Pi getting different code. It is not. Fetched and compared blob by blob:
>
> | | pinned `285ce87…` | tagged `a9aed99…` |
> |---|---|---|
> | amd64 manifest | `c528ccc6…` | `c528ccc6…` — identical |
> | arm64 manifest | `e2223dfb…` | `aed1a1f7…` — differs |
> | arm64: all 12 layer digests | | **identical** |
> | arm64: `rootfs.diff_ids` | | **identical** |
> | arm64: runtime config (env, entrypoint, cmd) | | **identical** |
> | arm64: top-level `created` | | **identical** |
> | arm64: `history[13].created` | `…40.5628424Z` | `…40.56031202Z` |
>
> **The entire difference is 2.5 milliseconds in one build-step timestamp**, which changes the config blob's digest, which changes the arm64 manifest digest, which changes the index digest. The filesystem a Pi runs is byte-for-byte the same. So nothing shipped wrong and there is nothing to re-cut — but the tag and the pin do name different indexes, and making them agree needs a **retag, not a rebuild** (a rebuild produces a third digest):
>
> ```bash
> # needs a token with write:packages — the gh CLI's default scopes do NOT include it
> docker buildx imagetools create \
>   --tag ghcr.io/openmasjid-solutions/openmasjiddonations:0.43.0 \
>   --tag ghcr.io/openmasjid-solutions/openmasjiddonations:latest \
>   ghcr.io/openmasjid-solutions/openmasjiddonations@sha256:285ce876721785a43e488fa963185c36d84547963902f9327236a4b18c06fa0e
> ```

> ### Tag the digest-pin commit, not the commit before it
>
> This is the single most-repeated mistake in this repo's release history, so it gets its own box.
>
> The merge commit and the digest-pin commit look interchangeable — the merge is where the version number changes, so it feels like "the release". It is not. **A tag on the merge commit names a `docker-compose.yml` that carries the *previous* release's digest, or no digest at all**, so anyone pinning your tag ships the wrong code under the new version number.
>
> ```bash
> # WRONG — the tag names the merge; the digest lands in the NEXT commit
> git merge --no-ff dev && git tag -a v0.12.0 && <CI publishes> && git commit -m "digest-pin"
>
> # RIGHT — the digest is already in the commit the tag names
> git merge --no-ff dev && <CI publishes> && git commit -m "digest-pin" && git tag -a v0.12.0
> ```
>
> **Verify before pushing the tag — it takes one command and there is no excuse for skipping it:**
>
> ```bash
> git show vX.Y.Z:docker-compose.yml | grep image:   # MUST already contain @sha256:
> git rev-list -n1 vX.Y.Z                            # MUST equal the digest-pin commit
> ```
>
> If the tag is already pushed and wrong, **do not paper over it in the catalog PR**: `git tag -f` it onto the digest-pin commit, force-push the tag, and say so — or, if the tag cannot be moved, pin the correct `commit:` in the PR *and* flag in the PR description that `ref:` and `commit:` disagree and why.
>
> **This has already happened twice** — and a third time on **v0.42.0**, where the tag landed on the merge commit (compose reading a bare `:0.42.0`) and the digest pin went into the commit after it. Only the registry's `commit:` pointing at the right SHA kept masjids fetching correct content.

5. **Publish the GitHub release for that tag.** Notes in the masjid's language — an admin reads
   these, not a changelog. Distil them from the `X.Y.Z` changelog entry you just wrote, since that is
   already in the right voice.

   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z — <the headline>" --notes-file notes.md --verify-tag
   ```

   `--verify-tag` refuses to invent a tag that does not exist, which is the failure mode worth
   guarding: a release created against a missing tag silently makes one at the current branch tip.

### Step 2 — a PR against the catalog's `dev`

Open a pull request against **`OpenMasjid-Solutions/OpenMasjidAPPS`, base branch `dev`, never `main`.** Change **only this app's own entry** in `registry.yaml` — never another app's, never `catalog.json`:

```yaml
  - id: donations
    ref: v0.12.0        # the tag you just published — the human label
    commit: <40-char SHA of the tagged commit>
```

**`commit:` is what actually gets fetched; `ref:` is only the human label.** Get it with:

```bash
git rev-list -n1 v0.12.0
```

If you followed the step order above, `ref` and `commit` are the same commit. **If they are not, pin the commit that has the correct digest** — the fetched content matters more than the label — and say so in the PR, because it means the tag is wrong and wants moving.

### Step 3 — stop

**A catalog maintainer runs the release that moves `main`.** Do not commit to the catalog's `main`, and **do not merge the catalog's `dev` into its `main`**: the two branches legitimately hold different builds of `catalog.json`, and merging them corrupts the stable column. Open the PR, say it is ready, and wait.

### Step 7 — check the only thing that answers "did it ship?"

Not the tag, not the release, not the merged PR. **The live stable catalogue.**

```bash
curl -s https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidAPPS/main/catalog.json \
  | python -c "import json,sys; print([a['version'] for a in json.load(sys.stdin)['apps'] if a['id']=='donations'])"
```

Until that prints the new version, **no masjid has it**, whatever this repo says. It flips when a
catalogue maintainer releases the stable column — which is step 3's "stop", so expect a gap, and
expect to have to ask. Do not read a merged PR against the catalogue's `dev` as shipped: `dev` and
`main` legitimately carry different builds of `catalog.json`.

### The dev channel needs none of this

`dev_ref: dev` tracks this repo's `dev` branch automatically and the catalog rebuilds hourly, so **a dev build never needs a catalog PR**. Just keep the prerelease version (`X.Y.Z-dev.N`) and the version-tagged image current, and make sure **the image is published before the catalog can read the version that names it**.

That last clause is the one thing our current flow only approximates. Version and compose move in ONE commit (see *Publishing a dev build*), so between the push and the build going green (~10 min) the tip of `dev` names a tag that does not exist yet; an hourly-cron rebuild landing in that window offers an image that cannot be pulled. It fails visibly and the post-publish `repository_dispatch` corrects it. If that window ever needs closing properly, the fix is to publish first via `workflow_dispatch` and push the bump after — not to split the commit, which breaks the dispatch (see the reasoning under *Publishing a dev build*).

---

## 17. Definition of done (per feature)
Builds via the documented commands and `docker compose up -d`; `tsc`/lint clean; works in light + dark and matches the dashboard theme when embedded; honours `prefers-reduced-motion`; admin behind auth; **Stripe secret never reaches the client**; one-time donations work **with no public ingress**; manifest + compose pass the APP_MANIFEST_SPEC rules; friendly wording; no raw error reaches the user.

---

## 18. Working agreement for Claude (the coding agent)
- **First, read the three repos** (OpenMasjidOS, OpenMasjidAPPS, OpenMasjidDisplay). Treat Display as the template and APP_MANIFEST_SPEC.md as the contract. When this file and Display's real code disagree, follow Display and flag it.
- Build in **vertical slices**, each end-to-end (server + web + theme):
  1. Repo scaffold: `server/` + `web/` + `Dockerfile` + `docker-compose.yml` + `manifest.yaml` + `icon.svg` + `LICENSE` (AGPL-3.0) + CI, copying Display's structure; container boots and serves an empty themed shell + `/healthz`.
  2. **Platform SSO + theme** (server-to-server) with local-password fallback — port Display's mechanism.
  3. Admin **Payments** screen + Stripe config (env + in-app), test-mode badge, "not set up yet" states.
  4. **Appeals** model + admin CRUD with rich content + image upload (SQLite + data volume).
  5. **Public donation page**: preset + custom amounts, Payment Element, **one-time** PaymentIntent, retrieve-on-return confirmation, thank-you page, donation recorded.
  6. Cover-the-fees + Gift Aid; optional email receipt.
  7. **Recurring (monthly)** subscriptions (+ optional webhook path).
  8. Donations log + stats + CSV export.
  9. Appearance/theming polish, animations, empty/edge states, friendly errors.
  10. README.md (user-facing, in Display's style), screenshots, docs/ARCHITECTURE.md; tag `v0.1.0`; open a catalog PR for the `registry.yaml` entry (§16.1).
- **Never** put the Stripe secret in the client or logs. **Never** assume inbound webhooks for the core flow. Ask before adding heavy dependencies or deviating from the contract.
