<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Security & code-health audit — OpenMasjidDonations

**Date:** 2026-08-03
**Commit audited:** `6fc4ca272cf412b8d04eeaf3eddce752b072c8b7` (tag `v0.38.0` + digest pin), branch `main`
**Rollback point:** tag `pre-audit-2026-08-03`
**Method:** 10 parallel read-only auditors (one per audit phase, plus a payments-specific pass),
then an adversarial verifier per Critical/High finding whose job was to *refute* it. 97 raw
findings → 52 unique after dedupe. Three High findings were refuted and are recorded as such.
Every finding below was re-read against the source by the author of this report.

---

## Executive summary

**Posture: good, and better than most self-hosted payment apps — with one class of exception
that matters more than any of the security findings.**

The security fundamentals here are genuinely solid, and I want to say that plainly before the
findings, because the findings list is long and would otherwise mislead. Specifically:

- **No credential has ever been committed.** 107 commits, no `.env`, `.pem`, `.key`, DB file or
  dump ever added in any commit on any branch. The only `whsec_` strings in all of history are UI
  labels, a placeholder and a validation regex.
- **Every one of the 33 `/api/admin/*` and `/api/settings*` routes carries `preHandler:
  requireAdmin`.** No route is unauthenticated by accident. I enumerated all 56 routes.
- **No SQL injection is possible.** Every query is a `better-sqlite3` prepared statement with
  bound parameters. The one dynamic-identifier site (`PRAGMA table_info(${table})`) takes only
  hard-coded literals.
- **No XSS.** There is no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval` anywhere in
  `web/`. Campaign rich text renders as a React text child, so it is escaped by construction.
- **The Stripe secret key never reaches the browser**, and card data never touches this server
  (PCI SAQ-A holds).
- **Upload handling is correct**: server-generated filename, extension from a MIME allowlist, no
  SVG, size cap, truncation check. No path traversal.
- The brute-force and tuition-lookup limiters correctly key on the real TCP peer rather than a
  spoofable `X-Forwarded-For`, and `trustProxy` is off.

**The single most important issue is not a vulnerability — it is arithmetic.**
[`DONATIONS-001`](#donations-001): Stripe has five **three-decimal** currencies (BHD, JOD, KWD,
OMR, TND). This app treats every non-zero-decimal currency as two-decimal, so a masjid configured
in one of those five charges **one tenth** of the amount the donor is shown, while recording the
full amount locally. A donor who believes they have paid 100 KWD of Zakat has paid 10. It is
latent — it needs one of those five currencies to be configured — but the configuration path is a
documented install setting, and nothing warns.

Second most important, and in the same family: [`DONATIONS-002`](#donations-002) — a card charge
that succeeds at Stripe while the browser's `/confirm` round-trip fails is **never recorded, never
receipted, and invisible to the masjid forever**. There is no reconciliation sweep for one-time
payments (monthly plans got one in v0.38.0; one-time payments did not).

Neither of those may be fixed autonomously. Both are written, tested and left in a separate PR.

**Nothing shipped to `main` in this run.** See "Deployment veto" below.

---

## Deployment veto (why nothing was pushed to `main`)

[`.github/workflows/build-image.yml:15-18`](../../.github/workflows/build-image.yml#L15-L18) runs
on `push: branches: [main]` and performs `push: true` to GHCR, tagging the image
`:${manifest version}` **and `:latest`**:

```yaml
on:
  push:
    branches: [main]
    tags: ['v*']
```

`manifest.yaml` currently reads `version: 0.38.0`, so **any code commit on `main` republishes the
live production tag** `ghcr.io/openmasjid-solutions/openmasjiddonations:0.38.0`, moving it off the
digest `sha256:62165d3f…` that the App Store catalog pins and every installed masjid box resolved.
Existing installs are protected by the digest pin; the published tag would then disagree with its
own digest, and `:latest` moves for anyone tracking it.

That is a published artifact. Per the audit mandate, **autonomous push was disabled** and all work
is delivered as pull requests off `main`.

---

## Phase 0 — What this is, and who attacks it

**What.** A self-hosted donation website for a single masjid, distributed as one Docker container
through the OpenMasjidOS App Store. `server/` is Node 20 + Fastify + better-sqlite3 + the Stripe
SDK (17.7, API `2025-02-24.acacia`) + zod. `web/` is React 18 + Vite, one bundle serving both the
public donation site and the `/admin` panel. State lives in SQLite plus uploaded images on a
volume at `/data`.

**Runs on.** Usually a Raspberry Pi on the masjid's own LAN, unattended for months, often behind
no reverse proxy at all. Optionally published to the internet through a Cloudflare Tunnel the
admin configures in-app, or through the OpenMasjidOS ingress on a shared hostname with a path
prefix. `restart: unless-stopped`, `cap_drop: ALL`, `no-new-privileges`, but **root inside the
container with a writable root filesystem**.

**Who uses it.** Donors (anonymous public, no account, often on a kiosk or via a QR code on the
masjid's guest wifi); one masjid admin — a volunteer, not an engineer; parents paying school fees
through the tuition campaign type; and the OpenMasjidOS platform itself, server-to-server.

**Entry points.** 56 HTTP routes. Unauthenticated by design: `/healthz`, `/api/app`,
`/api/public/appearance`, `/api/session`, `/api/setup`, `/api/login`, `/api/logout`, the six
`/api/public/campaign/*` routes (campaign read, intent, confirm), the four
`/api/public/campaign/:slug/students/*` tuition routes, `/api/stripe/webhook/:accountId`, the
widget at `/w/:slug`, and static assets. Everything else is behind `requireAdmin`. Non-HTTP entry
points: the Stripe webhook (signed), the OpenMasjidOS Fabric (server-to-server, app-secret
header), a supervised `cloudflared` child process, and three in-process outbox timers.

**Trust boundaries.** untrusted → trusted crossings are: (1) the public donation body → a Stripe
amount; (2) the Stripe webhook body → the donations ledger; (3) the tuition Student ID → the
Students provider over the Fabric broker; (4) the multipart upload → the data volume; (5) the
admin's browser → every `/api/admin/*` route, gated only by a signed cookie.

**Sensitive data.** Donor name + email; card brand + last 4 (no PAN); Gift Aid declarations
(name + home address + a taxpayer claim); a **child's** first name, last initial and school
balance in the tuition flow; the Stripe **secret** key and webhook secret; the Cloudflare tunnel
token; the OpenMasjidOS per-app secret; the admin password hash.

**Threat model — who realistically attacks this, for what.**

1. **Someone on the masjid's LAN or guest wifi** (the documented kiosk/QR surface) — the most
   realistic attacker by far. Wants: the admin panel (→ Stripe keys → redirect donations), or the
   donor ledger. Unauthenticated reach to every public route and to the LAN-facing admin login.
2. **The open internet**, when the admin turns on public access. Same goals plus payment fraud
   and card testing against the intent endpoints.
3. **A malicious or compromised upstream** — a GitHub Action tag, an npm package, a base image.
   Wants: a backdoored image on every masjid box. This is the highest-leverage path and the one
   the repo defends least consistently.
4. **A curious or careless insider** — a second volunteer with panel access. Wants nothing;
   causes harm by exporting donor data or cancelling plans, with no record that it happened.
5. **Not in the model:** a nation-state, physical theft of the Pi (assume game over), and the
   masjid admin themselves as an attacker (they own the box).

---

## Findings

Severity is rated by **actual impact in this system**, not by category name. `T` = fix tier
(1 = shippable unreviewed, 2 = shippable but flagged, 3 = never autonomous).

| ID | Title | Sev | Conf | T | File:line | Status |
|---|---|---|---|---|---|---|
| DONATIONS-001 | Three-decimal currencies charged at 1/10 of the displayed amount | High | Confirmed | 3 | `server/src/stripe.ts:80` | **PR (money)** |
| DONATIONS-002 | A succeeded charge is never recorded when `/confirm` doesn't land | High | Confirmed | 3 | `server/src/index.ts:1618` | **PR (money)** |
| DONATIONS-003 | Donor-PII CSV export has no `Cache-Control` at a `.csv` URL Cloudflare caches | High | Confirmed | 1 | `server/src/index.ts:836` | **Fixed** |
| DONATIONS-004 | Image-publishing job runs unpinned third-party Actions while holding GHCR write | Med | Likely | 1 | `.github/workflows/build-image.yml:39` | **Fixed** |
| DONATIONS-005 | Unauthenticated admin takeover via `/api/setup` during a platform outage | High | Confirmed | 2 | `server/src/index.ts:261` | Deferred — ask |
| DONATIONS-006 | No refund or chargeback handling: local totals permanently overstate income | Med | Confirmed | 3 | `server/src/index.ts:2044` | **PR (money)** |
| DONATIONS-007 | Changing the masjid currency rescales every stored amount and misreports history | Med | Confirmed | 3 | `server/src/index.ts:320` | Report only |
| DONATIONS-008 | Cover-the-fees drops the fixed fee for zero-decimal currencies; hardcoded US rate | Med | Confirmed | 3 | `server/src/stripe.ts:109` | **PR (money)** |
| DONATIONS-009 | All rate limiters collapse to one shared bucket behind the OS ingress | Med | Confirmed | 2 | `server/src/index.ts:277` | Deferred — ask |
| DONATIONS-010 | Unauthenticated `/intent` creates real Stripe objects with no monthly-specific limit | Med | Confirmed | 1 | `server/src/index.ts:1576` | **Fixed** (limit) |
| DONATIONS-011 | No audit log for any admin financial or donor-data action | Med | Confirmed | 2 | `server/src/index.ts:826` | **Fixed** |
| DONATIONS-012 | Admin session cookie never gets `Secure`, including on HTTPS deployments | Med | Confirmed | 2 | `server/src/auth.ts:83` | **Fixed** |
| DONATIONS-013 | No session revocation, no password-change route, 30-day cookie | Med | Confirmed | 2 | `server/src/auth.ts:14` | Deferred |
| DONATIONS-014 | No security response headers at all (no nosniff, Referrer-Policy, CSP) | Med | Confirmed | 2 | `server/src/index.ts:2125` | **Partly fixed** |
| DONATIONS-015 | Container runs as root with a writable root filesystem | Med | Confirmed | 2 | `Dockerfile:33` | Deferred — unverifiable |
| DONATIONS-016 | Base images pinned by mutable tag, not digest | Med | Confirmed | 1 | `Dockerfile:12` | Deferred — unverifiable |
| DONATIONS-017 | `LoginLimiter`'s sweep condition is unreachable, so the map never shrinks | Med | Confirmed | 1 | `server/src/rateLimit.ts:24` | **Fixed** |
| DONATIONS-018 | `?refresh=1` bypasses the same-origin guard on the plans sync | Med | Confirmed | 1 | `server/src/index.ts:1080` | **Fixed** |
| DONATIONS-019 | No rate limit on the two unauthenticated routes that call the platform outbound | Med | Confirmed | 1 | `server/src/index.ts:228` | **Fixed** |
| DONATIONS-020 | Stripe webhook route is unauthenticated with no rate limit (§9 requires one) | Low | Confirmed | 1 | `server/src/index.ts:2035` | **Fixed** |
| DONATIONS-021 | No `requestTimeout` / `connectionTimeout` — slowloris holds sockets open | Med | Confirmed | 1 | `server/src/index.ts:117` | **Fixed** |
| DONATIONS-022 | Donations log and CSV materialise the whole table with no pagination | Med | Confirmed | 2 | `server/src/store.ts:1022` | Deferred |
| DONATIONS-023 | Donor name reaches the receipt Subject with CR/LF intact | Low | Confirmed | 1 | `server/src/email.ts:83` | **Fixed** |
| DONATIONS-024 | Anonymous donations are de-anonymised by the Stripe billing-name backfill | Med | Likely | 2 | `server/src/index.ts:1639` | Deferred — ask |
| DONATIONS-025 | No retention limit, deletion path or subject-access export for donor records | Med | Confirmed | 3 | `server/src/store.ts:897` | Report only |
| DONATIONS-026 | Cloudflare tunnel token passed in argv, visible in the host process table | Low | Confirmed | 1 | `server/src/tunnel.ts:99` | Deferred — unverifiable |
| DONATIONS-027 | `.dockerignore` does not exclude `.env` | Low | Likely | 1 | `.dockerignore:1` | **Fixed** |
| DONATIONS-028 | SQLite `-wal`/`-shm` sidecars escape the 0600 chmod | Low | Confirmed | 1 | `server/src/store.ts:362` | **Fixed** |
| DONATIONS-029 | No `unhandledRejection` / `uncaughtException` handler | Low | Confirmed | 2 | `server/src/index.ts:2188` | **Fixed** |
| DONATIONS-030 | Upload trusts the client-declared MIME type with no `nosniff` backstop | Low | Confirmed | 1 | `server/src/index.ts:575` | **Fixed** (via 014) |
| DONATIONS-031 | Duplicate receipt + duplicate alert on concurrent `/confirm` | Low | Likely | 3 | `server/src/index.ts:1636` | **PR (money)** |
| DONATIONS-032 | `invoice.paid` reads Invoice fields Stripe removed in `2025-03-31.basil` | Med | Likely | 3 | `server/src/index.ts:2060` | Report only |
| DONATIONS-033 | Gift Aid is dead plumbing, and the flag is client-settable with no declaration | Low | Confirmed | 3 | `server/src/index.ts:1542` | Report only |
| DONATIONS-034 | Idempotency keys are freshly random per request, so they dedupe nothing | Low | Confirmed | 3 | `server/src/index.ts:1554` | Report only |
| DONATIONS-035 | The 99,999,999 ceiling is validated pre-fee, so the gross-up can exceed it | Info | Confirmed | 3 | `server/src/index.ts:1535` | Report only |
| DONATIONS-036 | The per-currency minimum charge is a stub — both ternary branches are 50 | Info | Confirmed | 3 | `server/src/index.ts:1532` | Report only |
| DONATIONS-037 | The monthly confirm dialog states the pre-fee amount as the recurring charge | Low | Confirmed | 3 | `web/src/donate.tsx:322` | Report only |
| DONATIONS-038 | Months are grouped in UTC but windowed in local time; `MASJID_TIMEZONE` unused | Med | Confirmed | 3 | `server/src/store.ts:1075` | Report only |
| DONATIONS-039 | Historical amounts are formatted with the *current* currency's decimals | Med | Confirmed | 3 | `server/src/index.ts:821` | Report only |
| DONATIONS-040 | `@fastify/static` 8.3.0 carries four High advisories — **not exploitable here** | Low | Confirmed | 2 | `server/package.json:17` | Report only |
| DONATIONS-041 | Three transitive High advisories, all unreachable, non-major fixes available | Low | Confirmed | 1 | `server/package.json:19` | **Fixed** |
| DONATIONS-042 | `postcss` advisory is build-time only (devDependency, never shipped) | Info | Confirmed | 1 | `web/package.json:26` | **Fixed** |
| DONATIONS-043 | No scheduled dependency-audit workflow; the only CI is the release build | Low | Confirmed | 1 | `.github/workflows/build-image.yml:16` | **Fixed** |
| DONATIONS-044 | `stripe.ts` — every money conversion in the product — has zero tests | Med | Confirmed | 1 | `server/package.json:12` | **Fixed** |
| DONATIONS-045 | i18n/RTL is aspirational: no `dir` handling, inline English, `lang` ignored | Low | Confirmed | 2 | `web/src/prefs.ts:93` | Report only |
| DONATIONS-046 | `CLAUDE.md` specifies argon2; the implementation is scrypt | Info | Confirmed | 1 | `CLAUDE.md` §11 | **Fixed** (docs) |
| DONATIONS-047 | Uploaded images are never deleted when a campaign is deleted | Info | Confirmed | 2 | `server/src/store.ts:896` | Report only |
| DONATIONS-048 | `/api/app` discloses the platform's internal LAN address to the public | Low | Confirmed | 2 | `server/src/index.ts:176` | Report only |
| DONATIONS-049 | `docker-compose.yml` deviates from the catalog contract (§10 labels, host port) | Low | Confirmed | 3 | `docker-compose.yml:42` | Cross-repo |
| DONATIONS-050 | Code health: 2,262-line route file, duplicated logic, two dead exports | Info | Confirmed | 1 | `server/src/index.ts` | Report only |
| DONATIONS-051 | Any platform-authenticated identity becomes full local admin (no role check) | Low | Likely | 3 | `server/src/index.ts:230` | Cross-repo |
| DONATIONS-052 | Outbox passes have no overlap guard, so a slow provider causes duplicate sends | Med | Likely | 2 | `server/src/index.ts:2252` | **Fixed** |

### Refuted findings (recorded so they are not re-raised)

| Claimed | Verdict |
|---|---|
| `@fastify/static` path traversal / route-guard bypass is exploitable here (claimed High, twice) | **REFUTED.** Both registrations set `index: false` and never `list: true`, and both roots (`/app/public`, `/data/uploads`) contain only assets already public. There is no static-served route guard to bypass — every protected route is a Fastify route with a `preHandler`. Downgraded to Low: worth the major bump on its own schedule, not urgent. |
| Every release tag's `docker-compose.yml` pins the previous release's digest, so masjids run one version behind (claimed High) | **REFUTED.** The catalog pins the **commit** (`6fc4ca27`, the digest-pin commit *after* the tag), not the tag, so installs resolve the correct digest. The tag-vs-pin ordering is a runbook artefact, not a version skew. |

---

## Finding details

Only findings whose detail adds something beyond the table are expanded. The rest are fully
described by their row plus the linked source.

### DONATIONS-001

**Three-decimal currencies are charged at one tenth of the amount the donor is shown.**
High · Confirmed · Tier 3 · money-correctness · [`server/src/stripe.ts:80-88`](../../server/src/stripe.ts#L80-L88)

```ts
const ZERO_DECIMAL = new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG',
                              'RWF','UGX','VND','VUV','XAF','XOF','XPF']);
export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;   // ← every other currency
}
```

Stripe defines three exponents, not two. **BHD, JOD, KWD, OMR and TND are three-decimal**: the API
amount is in thousandths (fils/millimes), and Stripe additionally requires the value to be a
multiple of 10. This code returns `2` for all five.

Reproduced with the repo's own functions:

```
BHD: app sends 1000 -> Stripe reads that as 1.000 BHD | intended 10.000 | factor 0.10x
JOD: app sends 1000 -> Stripe reads that as 1.000 JOD | intended 10.000 | factor 0.10x
KWD: app sends 1000 -> Stripe reads that as 1.000 KWD | intended 10.000 | factor 0.10x
OMR: app sends 1000 -> Stripe reads that as 1.000 OMR | intended 10.000 | factor 0.10x
TND: app sends 1000 -> Stripe reads that as 1.000 TND | intended 10.000 | factor 0.10x
```

**Attack path / failure path.** No attacker needed. A masjid in Bahrain, Jordan, Kuwait, Oman or
Tunisia sets `CURRENCY=KWD` as an install setting, or receives `MASJID_CURRENCY=KWD` from the
platform profile, or picks it in Settings. Every donation from then on charges a tenth of the
displayed figure. Because `toMajor` uses the same wrong exponent, the admin panel, the CSV and the
goal progress bar all display the *intended* amount, so the app's own records overstate real
income by 10× and nothing ever disagrees with itself. Only the Stripe dashboard tells the truth.

**Why it matters more than an accounting error.** Zakat is a religious obligation with a
calculated amount. A donor paying 100 KWD of Zakat through a Zakat campaign pays 10 and is told
they paid 100.

**Fix** (written, tested, in the money PR): add the three-decimal set to `currencyDecimals`, and
round three-decimal amounts to the nearest 10 as Stripe requires. **Not shipped autonomously** —
this changes how an amount is calculated. See `ACTION_REQUIRED.md`; if any masjid is live in one of
these five currencies, past donations need reconciliation against Stripe before the fix lands, or
the ledger's historical rows will silently become inconsistent with the new arithmetic.

### DONATIONS-002

**A card charge that succeeds while `/confirm` fails is never recorded, never receipted, and
invisible forever.** High · Confirmed · Tier 3 · money-correctness ·
[`server/src/index.ts:1618-1660`](../../server/src/index.ts#L1618-L1660)

The one-time flow is: create a PaymentIntent → the browser confirms it with Stripe directly →
**the browser then calls `POST /api/public/confirm`**, and only that call marks the local row
`succeeded`, fires the admin alert and sends the receipt.

If the donor closes the tab, loses signal, or the box is briefly unreachable in the window between
Stripe's confirmation and that callback, the money is taken and the local row stays `pending`
forever. There is no sweep. Monthly plans gained exactly this reconciliation in v0.38.0
(`reconcileRenewals`); one-time payments — the overwhelming majority — did not. The optional
webhook covers it *only* for masjids that configured one, which requires public ingress.

**Consequences:** the donation is missing from the ledger, the CSV, `metrics()`, the goal progress
bar and any Gift Aid claim; the donor gets no receipt; and a `pending` row is indistinguishable
from an abandoned checkout, so nobody investigates.

**Fix** (written, tested, in the money PR): a periodic sweep that retrieves `pending` one-time
intents from Stripe — the same retrieve-on-demand doctrine already used for plans — and marks
them succeeded, alerting once. **Not shipped autonomously**: it changes how a donation is
recorded, and on first run it will add previously-missing donations to the ledger and totals of
any masjid that has lost payments this way.

### DONATIONS-003

**Donor-PII CSV export is served with no `Cache-Control` at a `.csv` URL.**
High · Confirmed · Tier 1 · [`server/src/index.ts:836`](../../server/src/index.ts#L836) · **Fixed**

```ts
reply.header('content-type', 'text/csv; charset=utf-8')
     .header('content-disposition', 'attachment; filename="donations.csv"');
```

No `Cache-Control`, no `Vary`. The response body is every donor's name, email, amount and
PaymentIntent id. When the admin has enabled public access, this URL is served through Cloudflare,
and **`.csv` is in Cloudflare's default cached-extension list** — a static-extension response with
no cache directives is a candidate for edge caching, after which the cached copy can be served to
a request that carries no session cookie.

**Attack path.** Admin exports the ledger over the public hostname → the edge caches
`https://give.masjid.org/api/admin/donations.csv` → an unauthenticated attacker requests the same
URL and receives the cached donor list without ever authenticating. Marked *Confirmed* for the
missing headers and the PII content; the edge-caching step depends on the masjid's Cloudflare
configuration, which is why the fix is defence that does not rely on knowing it.

**Fixed** by sending `cache-control: no-store, private`, `pragma: no-cache` and `vary: cookie` on
both the CSV and the JSON donations route.

### DONATIONS-005

**Unauthenticated admin takeover through `/api/setup` during any platform outage.**
High · Confirmed · Tier 2 · [`server/src/index.ts:251-269`](../../server/src/index.ts#L251-L269) ·
**Deferred, needs your decision**

```ts
if (store.hasAdmin()) return reply.code(409).send({ error: 'This app is already set up.' });
if (ssoConfigured() && (await probePlatform(req.headers.cookie)).reachable) {
  return reply.code(403).send({ error: 'Sign in through your OpenMasjidOS dashboard…' });
}
// …anyone may now claim the admin password
```

Under SSO the local admin is **never set**, so `hasAdmin()` stays false for the life of the
install. The only thing standing between an anonymous LAN caller and permanent admin ownership is
`probePlatform().reachable`. Whenever the platform is down, restarting, upgrading, or simply
unreachable from this container, anyone who can reach the box can `POST /api/setup` with a password
of their choosing and own the panel — Stripe keys, campaigns, the donor ledger.

This is **not an oversight**: `CLAUDE.md` §13 describes the guard precisely and treats the
outage-window claim as the deliberate price of never bricking the panel (`docs/RESTORE_SSO_FIX.md`).
I am not overriding a documented, deliberate tradeoff without you.

The obvious hardenings each break something real:
- *Require a recovery code printed to the container log.* Strongest, but a volunteer without
  shell access can no longer recover, which is the exact scenario the escape hatch exists for.
- *Restrict to loopback/private peers.* A LAN attacker is already in the private range.
- *Only allow setup in the first N minutes after boot.* An attacker can wait for a reboot; the
  real admin may not be at the keyboard during one.

**My recommendation:** keep the escape hatch, and make abuse loud rather than silent — fire a
Fabric alert on every anonymous `/api/setup` claim, and surface "a local password was set on
`<date>` from `<peer>`" permanently in the panel. That is a change to auth behaviour, so it is
your call. See `ACTION_REQUIRED.md`.

### DONATIONS-009

**All three rate limiters collapse to a single shared bucket behind the OS ingress.**
Med · Confirmed · Tier 2 · [`server/src/index.ts:277`](../../server/src/index.ts#L277) ·
**Deferred, needs your decision**

`trustProxy` is off (correctly, for a directly-exposed box) and every limiter keys on
`req.socket.remoteAddress`. When the app is reached through the OpenMasjidOS path-ingress or the
Cloudflare tunnel, that address is the **proxy**, identical for every visitor on earth. So:

- the donation-intent limit of 30/min becomes 30/min *for all donors combined* — one attacker
  denies donations to everyone;
- the tuition lookup limit of 40/min likewise;
- the login limiter locks out **every** remote admin after one attacker's six failures.

The fix requires deciding *when* `X-Forwarded-For` may be trusted. `CLAUDE.md` §13 asserts the OS
ingress sanitises those headers, which would make trusting them safe when embedded — but no code
in this repo reads them today, and I could not verify the platform's sanitisation from here.
Getting this wrong in either direction is bad: trust it too readily and the login limiter becomes
bypassable with one header; trust it never and public deployments have a trivial donation-DoS.
That is a cross-repo assumption about the platform's ingress, so it is Tier 2/3 territory and
yours. See `ACTION_REQUIRED.md` → Cross-repo.

### DONATIONS-011

**No audit log for any admin financial or donor-data action.** Med · Confirmed · Tier 2 · **Fixed**

Before this run, nothing recorded that a donor-PII export happened, that a monthly plan was
cancelled, that a Stripe key was rotated, or that a campaign (and its attribution) was deleted.
For an app whose own `CLAUDE.md` §8 promises a financial record, and where a second volunteer with
panel access is in the threat model, there was no answer to "who did this, and when".

**Fixed** by an append-only `audit_log` table plus writes on: donor export (JSON and CSV), plan
pause/resume/cancel/schedule, Stripe account create/update/delete, and campaign delete. Reverse
migration is a single `DROP TABLE` — see `REMEDIATION.md`.

### DONATIONS-012

**The admin session cookie can never receive `Secure`.** Med · Confirmed · Tier 2 · **Fixed**

`cookieOptions()` sets `secure: COOKIE_SECURE`, and nothing in the repo ever sets that variable —
not the Dockerfile, not `docker-compose.yml`, not the manifest. Meanwhile `manifest.yaml` declares
`https: true` (the platform fronts the app with TLS, required for Stripe) and `domain: true`
(publishable on a public hostname). So the *normal* deployment hands out a 30-day admin token with
no transport restriction.

The naive fix — always `Secure` — locks every plain-HTTP LAN admin out of their own panel, which
is why this sat unfixed. **Fixed** instead by making the flag follow the scheme the request
actually arrived on: `Secure` when the request came over TLS (directly, or via
`x-forwarded-proto: https`), plain otherwise. Spoofing that header can only ever *restrict the
spoofer's own* cookie, so trusting it here is safe even though `trustProxy` is off — reasoning
recorded in the code comment.

### DONATIONS-015 / DONATIONS-016 — deferred as unverifiable

Both are real and both are ordinarily Tier 1/2, and I am not shipping either, for the same reason:
**I cannot run Docker in this environment**, so I cannot verify that the change still produces a
working image.

- **015 (root in container).** Adding `USER node` without also fixing `/data` ownership breaks
  every write the app makes — the database, uploads, the lot. It needs an entrypoint that chowns
  the volume, and one real container start to prove it. Shipping it blind risks bricking every
  install on update. `docker-compose.yml`'s own comment says the same.
- **016 (base images by tag).** A wrong digest fails the build. The build workflow does not run on
  pull requests (only `main`, `v*` tags and `workflow_dispatch`), so a mistake would not surface
  until after merge.

Both are written up in `ACTION_REQUIRED.md` with the exact change to make once someone can run a
build.

### DONATIONS-032

**The renewal handler reads Invoice fields Stripe removed in a later API version.**
Med · Likely · Tier 3 · [`server/src/index.ts:2060`](../../server/src/index.ts#L2060)

```ts
const inv = event.data.object as { billing_reason?: string; subscription?: string;
                                  payment_intent?: string; amount_paid?: number; currency?: string };
```

The cast is to a hand-written shape, so TypeScript cannot catch drift. In Stripe's
`2025-03-31.basil` API version, `invoice.payment_intent` was replaced by
`invoice.payments[].payment.payment_intent`, and `invoice.subscription` moved to
`invoice.parent.subscription_details.subscription`. Today the pinned SDK (17.7) speaks
`2025-02-24.acacia`, so both still exist and renewals record correctly — **this is latent, not
live**. But a routine `npm update stripe` to 18.x would silently stop recording monthly renewals:
`piId` becomes `''`, the `if` never fires, no error is logged, and money quietly stops reaching the
ledger. Same cast pattern at the `payment_intent.succeeded` branch.

**Recommendation** (not shipped — it touches how money is recorded): pin `apiVersion` explicitly
when constructing the Stripe client so an SDK bump cannot change the wire shape underneath, and
replace the hand-written casts with the SDK's own `Stripe.Invoice` type so the compiler fails
instead of the ledger.

---

## Coverage and gaps

**Assessed statically, in full:** all 56 routes and their guards; the SQL layer; the auth and
session implementation; the Stripe integration and every money conversion; the tuition Fabric
client; the upload path; the CSV export; both workflows; the Dockerfile and compose; every
lockfile; the whole git history for secrets; the web bundle for client-side leakage and XSS.

**What I could not assess, and why:**

1. **No runtime.** Nothing was executed against a live server, a real Stripe account (even test
   mode) or a running container. So: no dynamic auth testing, no verification that the webhook
   signature path accepts a genuine Stripe event, no confirmation of the actual response headers
   as served, no proof that a `USER node` container can write `/data`, and no load or slowloris
   testing. Every "Confirmed" here means *confirmed by reading the code*, not *observed*.
2. **No Docker.** Base-image digest pinning and the non-root change are unverifiable here
   (DONATIONS-015, -016).
3. **The platform side is a black box.** I could not verify that the OpenMasjidOS ingress
   sanitises `X-Forwarded-*` (which DONATIONS-009's fix depends on), that `/api/fabric/email`
   sanitises the subject before building SMTP headers (DONATIONS-023's real fix), or what
   `probePlatform` will accept as a valid identity (DONATIONS-051).
4. **Cloudflare's cache behaviour** for the masjid's actual zone (DONATIONS-003) — the fix is
   written so it does not depend on the answer.
5. **Whether any masjid is live in a three-decimal currency** (DONATIONS-001) or has already lost
   one-time donations to a failed `/confirm` (DONATIONS-002). Both need a look at real Stripe data
   and are the first two items in `ACTION_REQUIRED.md`.
6. **`cloudflared`'s `TUNNEL_TOKEN` support** could not be exercised, so DONATIONS-026 is deferred
   rather than fixed.

**Classes checked and found clean** (the auditors returned 206 such statements; the ones worth
recording): no committed secrets in tree or history; no SQL injection; no XSS sink; no
`eval`/`Function`; no prototype-pollution sink; no unsafe deserialization; no template injection;
no archive extraction; no path traversal in the upload or static paths; no CORS wildcard with
credentials; no JWT (so no algorithm confusion); no `Math.random()` in any security context; no
MD5/SHA1 password hashing; no ECB or static IV; no TLS verification disabled anywhere; no
`NODE_TLS_REJECT_UNAUTHORIZED`; no `docker.sock`, `privileged`, host networking or host PID; no
secrets in Docker layers or CI logs; no source maps in the production bundle; no debug routes or
`/metrics`; no default credentials; no admin route missing its guard; the Stripe secret key never
crosses to the browser; card data never touches the server; `csvCell` is applied to every exported
cell; the tuition/donation route isolation invariants of §13 all hold; and `pull_request_target`
in `cla.yml` never checks out or executes PR code (it runs only a SHA-pinned action).
