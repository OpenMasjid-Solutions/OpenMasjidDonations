<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Remediation — what changed, and how it was verified

Audit of 2026-08-03. Baseline `6fc4ca272cf412b8d04eeaf3eddce752b072c8b7` (tag
`pre-audit-2026-08-03`).

**Nothing was pushed to `main`.** A push to `main` triggers
[`build-image.yml`](../../.github/workflows/build-image.yml), which republishes
`ghcr.io/openmasjid-solutions/openmasjiddonations:0.38.0` **and `:latest`** — the live production tag
that the App Store catalog's digest pin resolves to. That is a published artifact, so autonomous push
was disabled per the audit mandate. Everything is on two branches, delivered as two pull requests.

| Branch | Contains | Mergeable? |
|---|---|---|
| `audit/security-2026-08-03` | 13 fixes + the audit report | **Yes** — ordinary review |
| `audit/money-2026-08-03` | 3 money-correctness fixes (branched off the above) | **Not until `ACTION_REQUIRED.md` §0 is done** |

---

## Read this first — the Tier 2 changes

These ship behaviour changes. If something feels wrong in the next few days, look here.

1. **The admin session cookie is now `Secure` on HTTPS** (`70d5457`, DONATIONS-012). It follows the
   request scheme, so a plain-HTTP LAN install is unaffected — that was the whole design constraint,
   because always-`Secure` would lock a masjid out of its own panel. If an admin on an HTTPS
   deployment reports being unable to stay signed in, this is the change to revert first.
2. **Session tokens now carry the admin's username** (`87033d3`) so the audit log can say who acted.
   Additive: a token minted before this still verifies. Cookies are unchanged in every other respect.
3. **New `audit_log` table** (`87033d3`). Additive `CREATE TABLE IF NOT EXISTS`, no data migration,
   no existing column touched. Reverse migration below.
4. **New global `onSend` hook** setting two headers on every response (`8137bef`). `nosniff` could in
   principle break a client relying on content sniffing; nothing in this app does.
5. **Three new rate limits** (`23a4a30`) on `/api/session`'s SSO branch (120/min), the Stripe webhook
   (300/min) and monthly intents (5/min per peer). All well above real traffic, but they are new 429s
   that did not exist before. Note the known limitation: behind the platform ingress every remote
   visitor shares one bucket (DONATIONS-009, deferred).
6. **`unhandledRejection` no longer kills the process** (`2924f79`). Previously Node's default
   terminated it; now it logs at error level and keeps serving. `uncaughtException` still exits so
   the container restarts clean.
7. **Dependency bumps** (`73cc072`): `fast-uri` 3.1.4→3.1.5, `find-my-way`→9.6.1, `brace-expansion`
   →5.0.9 (server, all transitive under fastify), and `postcss`→8.5.23 (web, devDependency). No major
   upgrades. Server advisories 4 High → 1 High; web 1 High → **0**.
8. **The outboxes no longer overlap themselves** (`decfaab`). A pass slower than its 60s interval used
   to start a second pass over the same rows; now the tick is skipped. Skipping loses nothing — the
   rows are still pending next tick.

And on the money branch, both of which change what donors are charged or what is recorded:

9. **Three-decimal currencies now charge the intended amount** (`91767c6`, DONATIONS-001).
10. **A sweep now recovers one-time donations Stripe took but we never recorded** (`8db58af`,
    DONATIONS-002). On first run this adds donations and sends backdated receipts.

---

## Shipped fixes

### Branch `audit/security-2026-08-03`

| Commit | Finding | What changed | Why it works |
|---|---|---|---|
| `249e8e5` | DONATIONS-003 (High) | `cache-control: no-store, private`, `pragma: no-cache`, `vary: cookie` on `/api/admin/donations` and `donations.csv` | The response body is every donor's name and email. `.csv` is in Cloudflare's default cached-extension list, and a static-extension response with no cache directives is an edge-cache candidate — after which the cached copy can be served to a request with no session cookie. `no-store` removes it from every cache, browser and proxy alike, so the fix does not depend on knowing the masjid's Cloudflare config. |
| `8137bef` | DONATIONS-014, -030 | Global `onSend`: `x-content-type-options: nosniff`, `referrer-policy: no-referrer` | An upload's content type comes from the client-declared multipart header, so a file claiming `image/png` can hold anything, and it is served from our own origin — `nosniff` is what stops a sniffing browser executing it as script. `no-referrer` stops an unlisted campaign's token (it appears in the path) leaking to any site an admin or donor clicks through to. CSP deliberately excluded: it would break Stripe Elements. |
| `23a4a30` | DONATIONS-019, -020, -010 | Per-peer limiters on the two unauthenticated platform-probe routes, the webhook, and monthly intents | The first two make an outbound call to the OpenMasjidOS core on *every* request, so without a cap the box is an unmetered amplifier against the platform. The monthly limit is separate and tighter (5/min) because a monthly intent creates **five** persistent Stripe objects (Customer, Price, Subscription, Invoice, PaymentIntent) where a card payment creates one — it is checked after validation but *before* anything is created at Stripe. |
| `41f8b44` | DONATIONS-017 | `LoginLimiter` sweep rewritten with a `seen` timestamp | The old condition `lockedUntil < now - 1h && fails === 0` was **unsatisfiable**: an entry only exists after `fail()`, which always sets `fails >= 1`, and `succeed()` deletes it. So nothing was ever swept and the map grew one entry per attacking IP for the process lifetime. The new sweep also requires `lockedUntil <= now`, so it can never release a live lockout — which would have been a rate-limit bypass introduced by the fix. |
| `64f037d` | DONATIONS-018, -021 | `refresh=1` now requires the same-origin check; `requestTimeout: 120_000` | Gating only the *write* side left the amplification the guard existed to stop: forcing the cache open is what turns one cross-site navigation into up to 200 outbound Stripe calls. `connectionTimeout` was deliberately **not** set — it maps to Node's socket-inactivity timeout and would reap idle keep-alive sockets Fastify holds by design, buying TCP churn for no security. |
| `84bcae6` | DONATIONS-023 | Receipt subject flattened (`\r \n U+2028 U+2029 U+0085 \v \f \0`) before the length cap | The subject is the admin's template with the **donor's own name** substituted in, and the donor is an unauthenticated stranger. The finished subject becomes an SMTP header at the platform, so CR/LF in a name is header injection (`Bcc:`, a forged `From:`). Flattened before the 200-char slice so the cut can never land mid-escape. Platform-side counterpart in `ACTION_REQUIRED.md` §3a. |
| `70d5457` | DONATIONS-012 | `secureForRequest(req)`; cookie `Secure` when the request arrived over TLS | Nothing ever set `COOKIE_SECURE`, so the cookie was never `Secure` — including in the normal deployment, where the manifest declares `https: true`. Always-`Secure` was not an option (it locks out plain-HTTP LAN admins), so it follows the actual scheme. Reading `x-forwarded-proto` is safe here specifically because a spoofed value can only add `Secure` to the response to *that same request* — it can only restrict the spoofer's own cookie. |
| `87033d3` | DONATIONS-011 | `audit_log` table + writes on donor export, plan pause/resume/stop/schedule, Stripe account create/update/delete, campaign delete | There was no answer to "who exported the donor list / cancelled that plan / rotated the key". Records field *names* on a key change, never values. `recordAudit` never throws — an audit write must not be able to fail the action it describes. |
| `ad80f17` | DONATIONS-044 | New `stripe.test.ts` — 17 tests over every money conversion | `stripe.ts` had **zero** tests, and it converts every amount the product charges. Two tests deliberately pinned the *wrong* behaviour so it was visible and would fail loudly when fixed — which is exactly what happened on the money branch. |
| `73cc072` | -041, -042, -027, -028 | `npm audit fix` (non-major only); `.env`/`*.pem`/`*.key` added to `.dockerignore`; data dir chmod `0700` | `COPY server/ ./` would have baked a developer's local `.env` — with real Stripe keys — into an image layer. On the perms: SQLite creates `-wal`/`-shm` sidecars lazily, and in WAL mode the newest committed data (a freshly saved Stripe key) is in the `-wal` file, not the `0600` database; chmod'ing sidecars is a race, so `0700` on the directory covers every present and future file. |
| `73086c5` | DONATIONS-004 | All five Actions in the publishing job pinned to commit SHAs | The job holds `packages: write` and a GHCR credential for the image every masjid Pi pulls. An upstream owner repointing `v6` would run their code beside a live publish token. Each SHA is exactly what the tag resolved to on 2026-08-03 — **frozen, not upgraded** — verified via `gh api repos/<owner>/git/ref/tags/<tag>`. `cla.yml` already did this; this file did not. |
| `2924f79` | DONATIONS-043, -029 | New read-only weekly `audit.yml`; `unhandledRejection`/`uncaughtException` handlers | The only workflow was the release build, so a new advisory went unnoticed until someone ran `npm audit` by hand. The new workflow holds no secrets, opens no PR, pushes nothing. The fault handlers matter because the codebase uses fire-and-forget `void fn().catch()` widely and Node's default is to kill the process — one missed `.catch()` in an alert path would take the donation page down. |
| `decfaab` | DONATIONS-052, -046 | `nonOverlapping()` wrapper on both outbox timers; `CLAUDE.md` argon2→scrypt | Each outbox item makes a network call with an 8s timeout, so 8 pending receipts outlast the 60s interval; a second pass then read the same rows and sent again. Also corrected the docs: §11 specified argon2, the implementation has always used scrypt (which is fine — the *docs* were wrong). |

### Branch `audit/money-2026-08-03` — **do not merge yet**

| Commit | Finding | What changed | Why it works |
|---|---|---|---|
| `91767c6` | DONATIONS-001, -008 (High) | `THREE_DECIMAL` set added to `currencyDecimals`; three-decimal amounts rounded to the nearest 10; fixed fee floored at 1 minor unit for zero-decimal currencies | Stripe quotes BHD/JOD/KWD/OMR/TND in thousandths and requires a multiple of 10. Treating them as two-decimal sent 1/10 of the shown amount while the ledger recorded the full figure — self-consistent, so nothing ever disagreed except Stripe. Verified: all five now charge the intended amount, and GBP/USD/EUR/JPY/KRW are **bit-identical**. |
| `8db58af` | DONATIONS-002 (High) | `listUnconfirmedDonations()` + a 10-minute sweep that retrieves pending one-time intents from Stripe | A one-time payment is marked succeeded only by the donor's own `/confirm` callback, so a closed tab left money taken and nothing recorded, for ever. Conservative by design: only ever promotes `pending → succeeded` (never writes `failed` from a transient read); a 5-minute age floor so it cannot race the donor's own confirm and double-send a receipt; a 30-day ceiling; bounded to 25 rows; stops on the first unreachable account. |

---

## Verification

Per-commit: typecheck + full suite after **every** commit, not at the end.

### Before (baseline, `6fc4ca27`)

```
> tsc -p tsconfig.json --noEmit          (clean)
ℹ tests 130
ℹ pass 130
ℹ fail 0
web: ✓ built in 2.85s                    (tsc --noEmit + vite, clean)
server npm audit: 4 high    web npm audit: 1 high
```

### After (`audit/money-2026-08-03`, all fixes)

```
> tsc -p tsconfig.json --noEmit          (clean)
> tsc -p tsconfig.json                   (build clean)
ℹ tests 179
ℹ suites 0
ℹ pass 179
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

web: ✓ built in 2.44s
  dist/assets/donate-BabYbuUK.js   41.51 kB │ gzip: 12.62 kB   (donor bundle unchanged)
  dist/assets/admin-Dg9qyaLR.js   115.48 kB │ gzip: 31.43 kB

server npm audit: 1 high (@fastify/static — major bump, refuted as exploitable, deferred)
web npm audit:    found 0 vulnerabilities
```

**130 → 179 tests. 49 added, 0 failures, no test removed or weakened.** Four new test files:
`auth.test.ts` (10), `rateLimit.test.ts` (5), `stripe.test.ts` (19), plus 15 added to `store.test.ts`.

### Regression tests proven to fail before the fix

Not "tests pass" — each was run against the pre-fix code and observed failing.

**DONATIONS-017** (login limiter sweep) — restored the pre-fix `rateLimit.ts` with minimal shims so
the new tests could execute against the *old* sweep condition:

```
ℹ pass 3
ℹ fail 2      ← the two sweep tests
```
and after restoring the fix: `ℹ pass 5  ℹ fail 0`.

**DONATIONS-023** (email header injection) — restored the pre-fix `email.ts`:

```
ℹ tests 13
ℹ pass 12
ℹ fail 1      ← 'a donor name cannot inject an email header'
```
and after restoring: `ℹ pass 13  ℹ fail 0`.

**DONATIONS-001 / -008** — the pins in `stripe.test.ts` fired exactly as designed when the arithmetic
changed on the money branch:

```
✖ currencyDecimals: DONATIONS-001 — three-decimal currencies are WRONG today (charges 1/10)
✖ withCoveredFees: DONATIONS-008 — the fixed fee VANISHES for zero-decimal currencies
ℹ pass 15  ℹ fail 2
```
Both were then rewritten to assert the correct arithmetic.

### End-to-end money verification (DONATIONS-001, -008)

Run against the real `stripe.ts` exports after the fix:

```
=== DONATIONS-001: what a 10-unit donation now charges ===
BHD: minor=10000 -> Stripe reads 10.000 BHD (intended 10.000)  multipleOf10=true
JOD: minor=10000 -> Stripe reads 10.000 JOD (intended 10.000)  multipleOf10=true
KWD: minor=10000 -> Stripe reads 10.000 KWD (intended 10.000)  multipleOf10=true
OMR: minor=10000 -> Stripe reads 10.000 OMR (intended 10.000)  multipleOf10=true
TND: minor=10000 -> Stripe reads 10.000 TND (intended 10.000)  multipleOf10=true
=== unchanged currencies (regression check) ===
GBP: decimals=2 toMinor(10)=1000 roundTrip=10
USD: decimals=2 toMinor(10)=1000 roundTrip=10
EUR: decimals=2 toMinor(10)=1000 roundTrip=10
JPY: decimals=0 toMinor(10)=10 roundTrip=10
KRW: decimals=0 toMinor(10)=10 roundTrip=10
=== DONATIONS-008: covered-fee gross-up on a 10-unit donation ===
GBP: net=1000 gross=1061 legal=true
USD: net=1000 gross=1061 legal=true
JPY: net=10 gross=11 legal=true
KWD: net=10000 gross=10610 legal=true
```

The same script against the **pre-fix** code produced `factor 0.10x` for all five three-decimal
currencies and `toMinor(0.30,'JPY') = 0`.

### Two defects my own tests caught in my own fixes

Recorded because they are the argument for writing the tests at all:

1. **`listAudit()` ordered by `at DESC, id DESC`.** Two actions in the same millisecond share `at`,
   and `id` is random hex — so "newest first" was arbitrary. Caught by
   `audit log: records an action and reads it back newest-first`, fixed to `ORDER BY rowid DESC`
   (insertion order, also immune to the clock stepping backwards, which an unattended Pi syncing NTP
   after an outage really does).
2. **`connectionTimeout: 10_000`** in my first cut of DONATIONS-021 would have reaped idle keep-alive
   sockets Fastify holds for 72s by design. Caught on re-reading my own diff; removed before commit,
   `requestTimeout` alone does the job.

### Not verified — deferred rather than shipped

Per the mandate, an unshipped fix costs nothing; a shipped fix that is silently wrong does damage.

- **DONATIONS-015** (non-root container) — no Docker here; cannot prove the app can still write
  `/data`. Shipping blind risks bricking every install on update.
- **DONATIONS-016** (digest-pin base images) — a wrong digest fails the build, and the build workflow
  does not run on pull requests.
- **DONATIONS-026** (tunnel token via `TUNNEL_TOKEN`) — cannot run `cloudflared` to confirm it reads
  the variable; a mistake silently breaks public access.
- **The Action SHA pins (`73086c5`) were verified by API, not by execution** — the workflow only runs
  on `main`, `v*` tags and `workflow_dispatch`, so the first real run is post-merge.
  **Recommended: `workflow_dispatch` it once on the branch before merging.**

---

## Rollback

### Revert one fix

Each commit is self-contained and individually revertable:

```bash
git revert 249e8e5    # DONATIONS-003  donor-data cache headers
git revert 8137bef    # DONATIONS-014  nosniff + no-referrer
git revert 23a4a30    # DONATIONS-019/-020/-010  rate limits
git revert 41f8b44    # DONATIONS-017  login limiter sweep
git revert 64f037d    # DONATIONS-018/-021  refresh gate + requestTimeout
git revert 84bcae6    # DONATIONS-023  email header injection
git revert 70d5457    # DONATIONS-012  cookie Secure
git revert 87033d3    # DONATIONS-011  audit log
git revert ad80f17    # DONATIONS-044  money conversion tests
git revert 73cc072    # DONATIONS-041/-042/-027/-028  deps, dockerignore, perms
git revert 73086c5    # DONATIONS-004  Action SHA pins
git revert 2924f79    # DONATIONS-043/-029  audit workflow + fault handlers
git revert decfaab    # DONATIONS-052/-046  outbox overlap + docs

# money branch
git revert 8db58af    # DONATIONS-002  lost-donation sweep
git revert 91767c6    # DONATIONS-001/-008  currency arithmetic
```

Two ordering notes: revert `87033d3` (audit log) **before** `70d5457` (cookie) if you revert both,
since the audit log reads the username the cookie commit's `makeToken` writes. And `8db58af` uses
`nonOverlapping()` from `decfaab`, so don't revert `decfaab` alone while the money branch is merged.

### Reverse the one schema change

`audit_log` is additive — no existing table or column was touched, so nothing needs migrating back.
To remove it entirely (after reverting `87033d3`):

```sql
-- against the masjid's data volume: /data/donations.db
DROP INDEX IF EXISTS idx_audit_log_at;
DROP TABLE IF EXISTS audit_log;
```

Leaving the table in place with the code reverted is also safe: nothing reads it, and
`CREATE TABLE IF NOT EXISTS` makes re-applying idempotent.

### Revert the entire run

Nothing reached `main`, so the run is undone by not merging. To discard the branches:

```bash
git checkout main                                   # already at pre-audit state
git branch -D audit/security-2026-08-03 audit/money-2026-08-03
git push origin --delete audit/security-2026-08-03 audit/money-2026-08-03
```

And if either branch *has* been merged, to return `main` to the pre-audit commit:

```bash
git revert --no-commit pre-audit-2026-08-03..HEAD && git commit -m "revert: back out the 2026-08-03 audit"
```

A revert, never a reset — `main` is protected, force-pushing is disabled, and history must not be
rewritten. `pre-audit-2026-08-03` = `6fc4ca272cf412b8d04eeaf3eddce752b072c8b7`.
