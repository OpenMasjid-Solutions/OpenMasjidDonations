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
5. **That push is a release.** When told, do the full runbook in §16: bump `manifest.yaml` + both `package.json` files, add the `web/src/changelog.ts` entry, merge `dev` into `main`, tag `vX.Y.Z`, let CI publish the stable image, digest-pin `docker-compose.yml`, then update the OpenMasjidAPPS `registry.yaml` entry.
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

No `changelog.ts` entry for a dev build — that file is the "What's new" list of *releases*, and the entry is written when the work ships to stable.

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
    ref: v0.1.0
  ```
- Container image published to **GHCR** (match Display's naming convention, e.g. `ghcr.io/openmasjid-solutions/openmasjiddonations:<version>`). Confirm Display's exact image path and mirror it.

---

## 4. Scope

### ✅ In scope (v1.0)
- **Public donation site** (no login): one or more donation pages/appeals, each with title, rich content, images, **preset amounts + a custom amount**, one-time and **monthly recurring** options, optional **cover-the-fees** and **Gift Aid** (UK) toggles, branded with the masjid's name/logo/colours.
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
- Additional payment providers; donor accounts; recurring-donation management portal for donors; multi-currency per appeal; webhook-driven recurring receipts when the box is publicly reachable.

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
Stripe keys + currency may arrive two ways; support both, with the data-volume copy as the source of truth:
1. **Install settings** (optional, via `manifest.yaml` `settings`): `STRIPE_PUBLISHABLE_KEY` (text), `STRIPE_SECRET_KEY` (password), `STRIPE_WEBHOOK_SECRET` (password, optional), `CURRENCY` (text/select, default from `MASJID_CURRENCY`).
2. **In the admin panel** — a "Connect Stripe" / payment-settings screen. This keeps install one-click (like Display) and lets the masjid set or rotate keys without reinstalling.

Rules: the **secret key is stored server-side only** (in the SQLite config on the data volume, tight file perms), **never sent to the browser**, **never logged**. Show a clear **"TEST MODE"** badge when a `sk_test_`/`pk_test_` key is in use. The site refuses to show the donate button until a valid publishable+secret pair is configured, with a friendly "Donations aren't set up yet" message for visitors and a clear setup prompt for the admin.

---

## 7. The donation experience (public site)

- **Appeals/pages:** the admin can create several (e.g. *General Fund, Zakat, Building Fund, Ramadan Appeal*). Each has: slug, title, rich body (text + images), hero image, preset amounts, allow-custom toggle, one-time/monthly options, optional goal + progress bar, active/inactive. A configurable default/home appeal.
- **Amounts:** **preset (static) buttons + a custom amount field**, both clearly shown; sensible min/max; currency from config. (This is the core "custom and static amounts" requirement.)
- **Checkout (embedded, on-brand):** use **Stripe Payment Element**. Server creates a **PaymentIntent** (one-time) or a **Subscription** (monthly) with the secret key; client confirms with the publishable key. Keep the donor on the masjid's branded page.
- **Cover-the-fees:** optional toggle so the donor can add the processing fee and the masjid receives the full intended amount. Compute transparently and show the donor the total.
- **Gift Aid (UK, optional per appeal):** if enabled, collect the declaration (UK taxpayer confirmation + name + home address) and store it with the donation for the masjid's records.
- **After paying:** a warm thank-you page; an **optional email receipt** (use Stripe's receipt emails, or send via configured SMTP if present — keep it optional and graceful if no mail is configured). Record the donation locally for the admin log.
- **Trust:** the payment area should feel secure and professional (clear amounts, Stripe's lock/badging, no jarring layout shift). It must be fast on a Raspberry Pi.

---

## 8. The admin panel

Login-protected (platform SSO when embedded; local password fallback). Sections:
- **Appeals** — list, create, edit (rich content + image upload), reorder, activate/deactivate, delete.
- **Appearance** — light/dark/follow-system, accent colour, masjid logo, wallpaper; live preview; matches the dashboard theme when launched from OpenMasjidOS.
- **Payments** — Stripe keys, currency, cover-the-fees default, Gift Aid default, test/live indicator, optional webhook secret + the webhook URL to paste into Stripe (only relevant if publicly exposed).
- **Donations** — a log of received donations (amount, appeal, date, donor name/email if given, one-time/recurring, status), totals and simple stats (this period, by appeal), and **CSV export**.
- **About** — version, links, and the **AGPL "Source code"** link to this repo.

Uploaded images and all settings/records live on the data volume (`/opt/openmasjid/apps/donations/data`). Validate and constrain uploads (type, size).

---

## 9. Stripe integration rules

- Use the official **`stripe`** Node SDK (server) and **`@stripe/stripe-js`** + **`@stripe/react-stripe-js`** (client). Pin versions and a fixed Stripe **API version**.
- **One-time:** create a PaymentIntent server-side (amount in the smallest currency unit, correct currency, metadata: appeal id, gift-aid, cover-fees). Confirm with Payment Element. On return, **retrieve** the PaymentIntent server-side to verify `succeeded` before recording — never trust the client's word.
- **Recurring (monthly):** create a Stripe **Customer + Subscription** (or a Checkout Session in `subscription` mode). Ongoing charge confirmation ideally uses the `invoice.paid` **webhook**, which requires public ingress — so treat ongoing recurring tracking as best-effort and document the dependency. Creating the subscription works fine on a LAN (outbound only).
- **Idempotency:** use idempotency keys on PaymentIntent/Subscription creation to avoid duplicates on ret␣ies.
- **Webhooks (optional):** if `STRIPE_WEBHOOK_SECRET` is set, expose `/api/stripe/webhook`, **verify the signature**, and handle `payment_intent.succeeded`, `checkout.session.completed`, `invoice.paid`. If not set, the app relies on the retrieve-on-return flow.
- **Amounts & currency:** always compute in integer minor units server-side; never trust client-sent amounts beyond appeal min/max validation. Default currency from `MASJID_CURRENCY`.
- **Rate-limit** the donation-creation and webhook endpoints. Validate all inputs (zod).

---

## 10. Manifest, compose & registry (follow APP_MANIFEST_SPEC + Display)

**`manifest.yaml`** (root of this repo) — fields per the spec:
```yaml
id: donations
name: OpenMasjid Donations
tagline: Take card donations on your masjid's network with Stripe
category: donations
version: 0.1.0
author: hasan-ismail
license: AGPL-3.0
icon: icon.svg
screenshots:
  - screenshots/1.png
  - screenshots/2.png
uses_profile: [name, address, email, phone, website, currency, timezone, language]
settings:
  - { key: STRIPE_PUBLISHABLE_KEY, label: Stripe publishable key, type: text,     required: false, description: "Starts with pk_. You can also set this inside the app." }
  - { key: STRIPE_SECRET_KEY,      label: Stripe secret key,      type: password, required: false, description: "Starts with sk_. Stored on your device, never shared." }
  - { key: STRIPE_WEBHOOK_SECRET,  label: Stripe webhook secret,  type: password, required: false, description: "Optional. Only needed if you expose donations publicly." }
  - { key: CURRENCY,               label: Currency,               type: text,     required: false, description: "ISO code, e.g. GBP. Defaults to your masjid currency." }
ports:
  - { container: 8080, label: Donations site, default_host: 7870 }
resources:
  memory_hint: 128M
  cpu_hint: 0.25
  storage_hint: 200M
  arch: [amd64, arm64]
```
(Keep install settings optional so install stays one-click; Stripe can be configured in-app.)

**`docker-compose.yml`** — obey the spec's conventions exactly: required labels `com.openmasjid.app: donations`, `com.openmasjid.service: <name>`, `com.openmasjid.managed: "true"`; do **not** set a top-level `name:` (platform uses project `omos-donations`); map the platform-assigned port `"${OMOS_HOST_PORT_8080:-7870}:8080"`; bind the data volume under `/opt/openmasjid/apps/donations/data`; `restart: unless-stopped`; `env_file` the platform `.env`; **no** `privileged`, **no** docker.sock, **no** `network_mode: host`/`pid: host`; `cap_drop: [ALL]`; run as a **non-root** user; `read_only` root fs + `tmpfs` for `/tmp` where possible. The server listens on container port **8080** (non-root friendly). Copy Display's compose as the starting point and adapt.

---

## 11. Tech stack (match Display)

- **TypeScript everywhere.** `strict` on, no `any` without a justifying comment.
- **`server/`** — Node 20+ + **Fastify** REST API (WebSocket only if you actually need live updates; donations probably don't). **better-sqlite3** for storage. **`stripe`** SDK. **scrypt** (Node built-in, N=2^16) for the fallback admin password — no external crypto dependency. Validate input with **zod**.
- **`web/`** — **React + Vite + TypeScript + Tailwind**, **shadcn/ui** components, **Motion** for animation, **lucide-react** icons, **@stripe/react-stripe-js** for the Payment Element. One app serving the public site and the `/admin` panel.
- **One container** via a multi-stage **Dockerfile** (build web, build server, final runtime serves the web build + API), exactly like Display. `docker compose up -d` runs it.
- Keep it **lean and Pi-friendly**; lazy-load the admin bundle so the donor page stays light.

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
- Admin behind auth (platform SSO server-to-server, verified with the platform — never trust the browser — with a local argon2 password fallback). Sessions: signed, HTTP-only, SameSite cookies.
- **Rate-limit** donation creation and webhook endpoints; validate/limit uploads; sanitise rich content to prevent stored XSS on the public page.
- Least-privilege container (per §10). Outbound HTTPS to Stripe only; assume no inbound by default.
- Note for admins (in docs): taking donations from outside the masjid network means exposing the app publicly — recommend doing so only behind HTTPS (e.g. the platform's remote-access/tunnel helper).

**Security invariants — DO NOT REGRESS** (v0.39.0 sweep):
- **CSV/spreadsheet injection:** donor name/email come from the *unauthenticated* public intent endpoint. Any cell exported to CSV must be run through `csvCell`, which prefixes a leading formula trigger (`= + - @` tab CR) with a quote. Never write donor-controlled values to an export without it.
- **First-run `/api/setup` under SSO:** when SSO is configured and the platform is **reachable**, refuse an anonymous local-admin claim (only allow the local-password recovery when the platform is *unreachable*). Under SSO the local admin is never set, so an unguarded setup stays open forever = permanent unauthenticated takeover. Keep the `probePlatform` guard.
- Behind the OS proxy you may trust `X-Forwarded-Proto`/`-Host`/`-For` **only because the platform's ingress now sanitises them** — never trust them when reached directly.
- **Tuition ⇄ donation route isolation (v0.26.0):** a `tuition` campaign is a Students-billing shell, NOT a donation. The generic donation routes (`intentHandler` for `/…/intent`, and `/api/public/confirm`) must **reject `c.type === 'tuition'`** (404), and the dedicated Students routes (`/…/students/{identify,lookup,intent,confirm}`) must reject `c.type !== 'tuition'`. Without the donation-side guard a crafted/stale POST files a client-chosen amount into the `donations` table (counted in totals/CSV/Gift-Aid) and orphans it from the Students ledger. Tuition payments live ONLY in `student_payments` (never joined into `metrics()`/`listDonations()`/`raisedForCampaign()`); the typed Student ID is body-only (never logged/URL/metadata — §11.3 also bans a Student ID or a child's name from Stripe metadata and descriptions); the charge amount + `familyId` come only from the server-side lookup session, never the client.
- **Tuition itemised bills: send ONE breakdown, and price ticked lines from the session (v0.36.0):** Students resolves exactly one breakdown per `record-payment`, in the order `lines → allocations → students → derive-it-itself`. So `lines[]` (the ticked bill lines, §11.0b) is sent **alone** — never alongside `allocations` or `students[]`. A ticked line's amount comes from the session's own copy of `items[]`, never the browser's, and a line that isn't in the session or has no balance (settled, or a credit line) is refused rather than silently dropped — dropping one would charge less than the parent was shown. Itemisation is all-or-nothing **per family** (`itemised`), since that chain cannot express a mixture of lines and whole bills in one call; an invoice whose lines lack ids or don't sum to its balance must fall back to a single un-itemised row. Ticked lines are persisted (`student_payments.payment_lines`) so an outbox retry settles the same line. `allocations[]` was silently ignored before 0.43.0 and works now, so the `students[]` belt-and-braces on that path stays for pre-0.43.0 schools.
- **Tuition advance payments: the amount may come from the parent, everything else may not (v0.35.0):** an advance/part payment (§11.0a) is the one tuition figure the client names — there's no invoice to derive it from. It stays safe only because the server-side lookup session still fixes the **familyId, the child, the currency, `allowAdvance` and the floor**, so a crafted request can at most overpay the family it looked up (surplus becomes that family's own credit). Never take the floor, the family or the child from the request body. The floor is `max(MIN_TUITION_CENTS = $1, the school's advertised minAmountCents)` — a provider advertising 25¢ must not be able to drag us under a pound/dollar — and it applies to **every** path (full balance, picked months, typed amount), matching "the smallest card payment a parent may start, wherever they start it". `allowAdvance` is advertised, never assumed (false against a pre-0.41.0 Students); paying *part* of a real balance needs no permission, only money *above* it does.
- **Tuition `record-payment` MUST carry the per-child `students[]` split for picked months (v0.34.0):** Students books a tuition charge as one ledger row **per child**, taken from `students[]` if sent and otherwise **derived** by walking the *family's* open invoices oldest-due-first — a derivation that **ignores `allocations`** (the provider parses that field and drops it). Sending only `allocations` therefore credits whichever child owns the family's oldest bill, not the child whose month the parent ticked: money stays in the family but the wrong child's invoice is paid down. Derive the split server-side from the session's ticked invoices (`computeTuitionAmount`), persist it (`student_payments.students_split`) so the outbox retry books it identically, and omit it only for "pay the full balance" (there the derived split is the same answer). It must sum to `amountCents` exactly or Students returns 422 — if any invoice lacks a `studentId`, send no split rather than a partial one.
- **Tuition lookup is the v2 (PIN-free) flow (contract §11.0, provider 0.39.0):** `lookup` takes the **Student ID alone** at `"v": 2` — a v1 `{name, pin}` body **400s**, so it cannot half-work. `identify` must be called first and the parent must confirm the echoed name *before* `lookup` runs: that confirmation is the safeguard that replaced the PIN. `identify` and `lookup` share ONE per-peer rate-limit bucket (as the provider shares one per-code bucket) so switching endpoints can't launder attempts, and both are uniform on not-found (unknown / withdrawn / locked / payments-off are indistinguishable — no enumeration oracle). `info`, `record-payment` and `check` are unchanged and deliberately still send `"v": 1`: never migrate the money path as a side effect of a lookup change.
- **Monthly plans act only on subscriptions WE created, and their catch-up may only add real money (v0.38.0):** the plans index is the LOCAL `donations` rows (`recurring = 1` + a `subscription_id`), and every `/api/admin/plans…` route — the list *and* all four write routes — resolves the id through that index before touching Stripe. Never widen it to `subscriptions.list`: a Fabric-vaulted Stripe account is **shared** with the platform's other apps, so that would show (and let an admin cancel) another app's subscriptions, and it is also the mechanism that keeps tuition out (tuition is written to `student_payments`, never `donations` — structurally absent, not filtered). Renewal **reconciliation** may only INSERT a donation for a **paid** invoice, keyed on its PaymentIntent (UNIQUE = idempotent), stamped with the date the money actually arrived; never for a failed/open one, and it must stay **silent** (no receipt email, no `notify`) — it is a catch-up, not an event. Abandoned monthly sign-ups (a `/intent` row whose card was never entered) may only be **hidden after** a sync that was allowed to reconcile — never filtered out of the index that *feeds* the sync, because a first payment that succeeded but was never confirmed looks identical locally and reconciliation is the only thing that can rescue it. And `cancel_at_period_end` is not a "take one more payment" option (Stripe raises no further invoice) — never reintroduce it as one.

---

## 14. Coding conventions
- Clarity over cleverness; comment the *why*. Small commits, conventional-commit messages.
- Everything builds and runs via the documented commands and `docker compose up -d`.
- Share types between server and web where practical; validate all external input at the boundary (zod).
- All user-facing strings via i18n; all colours/spacing via tokens.
- Never copy umbrelOS/PolyForm code (see §2).

---

## 15. Build & run (mirror Display)
```bash
# server (API + Stripe + storage)
cd server && npm install && npm run build && npm test

# web (donor site + admin)
cd web && npm install && npm run build

# everything together (Docker; also what the App Store runs)
docker compose up -d
```
For local dev: run the server, run `cd web && npm run dev` (Vite proxies `/api` to the server). Use Stripe **test keys** and Stripe's test cards; optionally `stripe listen` to forward webhooks to localhost while developing the optional webhook path.

---

## 16. CI & versioning
- **Check `README.md` still describes the app when you ship a user-visible feature.** It is the first thing anyone sees, and nothing else in this runbook forces it to be touched — which is exactly how it once drifted to describing v0.13.0 while the app was at v0.40.0. Deliberately it carries **no** version number or test count (the release badge and the changelog cover that), so only a real feature change should require an edit: a new admin tab, a new donor-facing capability, a new platform integration.
- **Add a `web/src/changelog.ts` entry with every release** — it's what the "What's new" item in the account menu shows. Plain, non-technical, what changed *for the masjid*; same voice as the App Store note in OpenMasjidAPPS `registry.yaml`, since they see both. It is loaded on demand, so never import it eagerly (that would put admin-only text in the donation page's bundle).
- **`VERSION`** file at the root is the single source of truth; stamp it into the build.
- **Semver, `0.x` = pre-release.** Start at `0.1.0`. Tag releases `vX.Y.Z`.
- **GitHub Actions:** on a `v*` tag, build the multi-arch (amd64 + arm64) image and **push to GHCR** with the version tag (mirror Display's workflow). Then the app is added/updated in OpenMasjidAPPS `registry.yaml` with the new `ref`.
- **Two channels.** The same workflow also publishes the moving `:dev` (+ immutable `:dev-<sha>`) pair from the `dev` branch. Stable tags come only from `main`/`v*`. See **Branching policy** at the top of this file — a release is the *only* thing that moves `main`, and only on Hasan's explicit "merge to main".
- **On `dev`, the manifest `version:` is the last release, not the dev build.** It is bumped at release time, so a dev box reports the previous version while running newer code. Deliberate: bumping it on `dev` would make every `dev` → `main` merge conflict on that line, and a version number is meaningless on a moving channel. Use the `:dev-<sha>` tag to identify a dev build.

---

## 17. Definition of done (per feature)
Builds via the documented commands and `docker compose up -d`; `tsc`/lint clean; works in light + dark and matches the dashboard theme when embedded; honours `prefers-reduced-motion`; admin behind auth; **Stripe secret never reaches the client**; one-time donations work **with no public ingress**; manifest + compose pass the APP_MANIFEST_SPEC rules; friendly wording; no raw error reaches the user.

---

## 18. Working agreement for Claude (the coding agent)
- **First, read the three repos** (OpenMasjidOS, OpenMasjidAPPS, OpenMasjidDisplay). Treat Display as the template and APP_MANIFEST_SPEC.md as the contract. When this file and Display's real code disagree, follow Display and flag it.
- Build in **vertical slices**, each end-to-end (server + web + theme):
  1. Repo scaffold: `server/` + `web/` + `Dockerfile` + `docker-compose.yml` + `manifest.yaml` + `icon.svg` + `LICENSE` (AGPL-3.0) + `VERSION` + CI, copying Display's structure; container boots and serves an empty themed shell + `/healthz`.
  2. **Platform SSO + theme** (server-to-server) with local-password fallback — port Display's mechanism.
  3. Admin **Payments** screen + Stripe config (env + in-app), test-mode badge, "not set up yet" states.
  4. **Appeals** model + admin CRUD with rich content + image upload (SQLite + data volume).
  5. **Public donation page**: preset + custom amounts, Payment Element, **one-time** PaymentIntent, retrieve-on-return confirmation, thank-you page, donation recorded.
  6. Cover-the-fees + Gift Aid; optional email receipt.
  7. **Recurring (monthly)** subscriptions (+ optional webhook path).
  8. Donations log + stats + CSV export.
  9. Appearance/theming polish, animations, empty/edge states, friendly errors.
  10. README.md (user-facing, in Display's style), screenshots, docs/ARCHITECTURE.md; tag `v0.1.0`; add the `registry.yaml` entry to OpenMasjidAPPS.
- **Never** put the Stripe secret in the client or logs. **Never** assume inbound webhooks for the core flow. Ask before adding heavy dependencies or deviating from the contract.
