<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Architecture & decisions — OpenMasjid Donations

This records the non-obvious decisions. The reference template is
[`OpenMasjidDisplay`](https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay); the
platform contract is [`OpenMasjidOS/docs/APP_MANIFEST_SPEC.md`](https://github.com/OpenMasjid-Solutions/OpenMasjidOS/blob/master/docs/APP_MANIFEST_SPEC.md)
and `OpenMasjidDisplay/docs/FABRIC.md`.

## Shape

One container, multi-stage `Dockerfile` (Node 22): a `web/` build stage, a `server/`
build stage, and a `node:22-slim` runtime that serves the built web app from
`/app/public` and the API on container port **8080**. Mirrors Display.

- `server/` — Node + TypeScript, **Fastify**, **better-sqlite3** (single file in the
  data volume, behind a thin repository layer), **zod** validation, **stripe** SDK.
  Password hashing uses Node's built-in **scrypt** (no native dependency), with a
  signed, HTTP-only session cookie.
- `web/` — **React + Vite + TypeScript**. Styling reuses Display's design tokens
  (`tokens.css`, `glass.css`) verbatim so the app matches the live dashboard, plus
  **Tailwind** (utilities only — preflight off — mapped to the CSS variables),
  **lucide-react**, **Motion**, and **@stripe/react-stripe-js**.

## Where this app intentionally differs from the platform contract / Display

Per the prime directive ("follow Display where it disagrees with the written spec"),
these are deliberate alignments to what Display and the platform *actually* ship:

- **No `com.openmasjid.*` compose labels.** The platform discovers an app by its
  compose project name `omos-<id>` (the automatic `com.docker.compose.project`
  label). Apps add no discovery labels.
- **Static published port** `"7870:8080"` (not `OMOS_HOST_PORT_*`). The platform
  rewrites the host port literal on conflict. No `default_host` in the manifest.
- **Named volume** `data:/data` (`DATA_DIR=/data`), not a host bind-mount. The
  platform manages where the volume's data physically lives.
- **No `uses_profile` / `MASJID_*` dependency.** The platform injects no masjid
  profile. Masjid details (name, currency, etc.) are collected in-app; if `MASJID_*`
  env vars are ever present they're read only as optional first-run seeds.
- **Palette = Display's shipped tokens** (cyan `#22D3EE` + amber `#F59E0B` on deep
  navy), not the emerald/gold described in the older spec docs. This is required so
  appearance-inherit matches the live dashboard and its wallpapers.
- **Version source = `manifest.yaml`** (`version:`), read by CI. No `VERSION` file.

## The OpenMasjidOS Fabric (platform↔app integration)

Optional and backwards-compatible — the app works fully standalone. Manifest opts in
with `sso: true` and `notifications: true`. Wire identifiers are a shared contract and
must not be renamed.

- **Env injected by the platform** (via `.env` + `docker compose --env-file` `${VAR}`
  substitution — the compose `environment:` block **must** reference them, or they
  never reach the container): `OPENMASJID_APP_ID`, `OPENMASJID_BASE_URL`,
  `OPENMASJID_APP_SECRET` (a per-app credential — never logged or exposed).
- **SSO (server→server).** The browser also sends the platform's `omos_session`
  cookie to this app (same host, different port = same-site). The app's backend reads
  that cookie **only** from the incoming request, then calls
  `GET ${OPENMASJID_BASE_URL}/api/auth/session` forwarding `Cookie: omos_session=…`
  **and** header `X-OpenMasjid-App-Secret: …`. The platform returns
  `{authenticated, username}` only when both check out (identity-bound, fails closed,
  not CORS-enabled). On success the app mints its own short-lived session and caches
  the positive result ~45s. Otherwise it falls back to its own admin password.
- **Appearance (client-side).** On open, the dashboard appends
  `#omos=<base64url(JSON{theme,wallpaper,…})>` to the URL; the web reads it, applies +
  persists it, clears the hash, and (while embedded) polls the public, CORS-enabled
  `GET ${OPENMASJID_BASE_URL}/api/public/appearance` to follow live theme changes.
  The fragment is treated as untrusted presentation input. See `web/src/prefs.ts`.
- **Notifications (server→server, optional).** `POST ${OPENMASJID_BASE_URL}/api/fabric/notify`
  with the app secret and `{text, title?, level?}` — e.g. "A new donation of £50 was
  received." Never sees the webhook URL; fails soft.

## Stripe — the two rules everything else hangs off

- One-time donations must work with **no inbound webhook** (a masjid box is usually
  LAN-only): the server creates a PaymentIntent, the client confirms with the
  Payment Element, and on the donor's return the server **retrieves** the
  PaymentIntent to verify `succeeded` before recording it. Webhooks are an optional
  enhancement (recurring `invoice.paid`, refunds made in Stripe's dashboard,
  resilience) for when the app is public — never a requirement. The renewal
  reconciliation and the lost-donation sweep exist because of this rule.
- The **secret key is server-side only** — never sent to the browser, never logged,
  never committed. The browser sees only the publishable key.

## Build order (vertical slices) — the original plan, all shipped

1. **Scaffold**: boots, themed shell, `/healthz`. ✅
2. **Platform SSO + theme + local-password fallback** (Fabric: SSO, notifications, appearance). ✅
3. **Guided first-run onboarding + Stripe/masjid config** (env + in-app, test-mode badge, verify, "not set up yet" states). ✅
4. **Multiple Stripe accounts** + **campaigns** (admin-chosen unique slug, preset/custom
   amounts, goal, → a chosen Stripe account). ✅
5. **Public donation page** (`/<slug>` — a clean link the admin picks, e.g. `/zakat`;
   legacy `/c/<slug>-<token>` links still resolve): preset/custom amounts, Stripe
   Payment Element, one-time PaymentIntent, retrieve-on-return confirm, thank-you,
   donation recorded. ✅
6. Cover-the-fees + Gift-Aid toggles. ✅ (Gift-Aid stores the opt-in; full
   declaration/address capture + optional email receipt are follow-ups.)
7. Recurring (monthly) subscriptions (Customer + Subscription, first invoice confirmed
   via Payment Element; ongoing months via an optional per-account `invoice.paid`
   webhook at `/api/stripe/webhook/:accountId`). ✅
8. Donations log + stats + CSV export, plus a **metrics dashboard** (totals, this
   month, average gift, per-appeal breakdown, 6-month trend). ✅
9. Cloudflare Tunnel helper (bundled `cloudflared`, in-app token, supervised) for
   public access — no port-forwarding. ✅
10. Appearance/theming polish, animations, friendly errors. ✅
11. README/screenshots/docs; tag `v0.1.0`; add the `registry.yaml` entry to
    OpenMasjidAPPS (move `donations` out of `coming_soon`). ✅

Everything after this list — tuition, alerts, email receipts, monthly plan management,
refunds, the donor stop link, per-appeal accounts — has its own section below, newest last.

## OpenMasjidOS Fabric: SSO, Stripe vault & restore resilience (v0.16.0)

The platform↔app integration ("Fabric") lives in `server/src/fabric.ts` and is always
optional — the app works fully standalone.

- **SSO** is server-to-server: `probePlatform()` validates the incoming `omos_session`
  cookie against `${OPENMASJID_BASE_URL}/api/auth/session`, presenting our per-app
  `OPENMASJID_APP_SECRET`. It returns `{ username, reachable }` — `reachable`
  distinguishes "not signed in" from "platform unreachable" so the panel can offer the
  local-password recovery instead of looping.
- **Stripe via the Fabric** (`stripe: true`): keys are configured **once** in OpenMasjidOS
  and fetched per-app with `fetchFabricStripe()`. They are cached **in memory only, never written to
  the data volume**, so they always track the OS vault — including after a restore onto a new
  machine. `resolveAccountFor()` (charging) honours an appeal's own account choice and otherwise
  prefers the vault account **only when it is fully configured**, falling back to locally-entered
  keys; `accountById()` (confirm, refunds, plans, webhook) resolves by the **recorded** account id,
  so a config or reachability change between intent and confirm can't strand a succeeded payment,
  and money taken on one account is never acted on with another's keys. See *Per-appeal Stripe
  accounts* below.
- **Restore/migration resilience** (required of every Fabric app): `OPENMASJID_BASE_URL` and
  `OPENMASJID_APP_SECRET` are read from env every start and never persisted; every Fabric
  call fails soft (short timeout, `redirect:'error'`); and **local setup can never be
  bricked** — `/api/setup` allows the recovery password when SSO is unconfigured or the
  platform is unreachable, and refuses it only while the platform is reachable (which also
  closes the pre-setup admin-claim window). See `docs/RESTORE_SSO_FIX.md`.

## Fabric remote access & base-path awareness (v0.17.0, manifest `domain: true`)

The OS owns Cloudflare now: the admin runs ONE tunnel in OpenMasjidOS (Settings → Remote
access) and each app is reached on one hostname under an admin-chosen **path** (default the
app id), e.g. `https://omos.<domain>/donate/…`. The app asks the platform for its public
address via `GET /api/fabric/site` → `{ enabled, domain, publicUrl, basePath }`
(`server/src/fabric.ts` `fetchFabricSite`; cached, last-good, fail-soft, never persisted).

Cloudflare forwards the **full** path prefix without stripping it, so the app is base-path
aware on **both** ends:

- **Server**: a Fastify `rewriteUrl` strips the current `basePath` prefix before routing, so
  every route stays written at the root and works identically on the LAN (no prefix) and
  behind the tunnel. `index.html` is served (not via static-index) with an injected
  `<base href="${basePath}/">` + `window.__OMOS_BASE__`. The base path is warmed before
  `listen` and refreshed every 15s, so the prefix is stripped from the first request and
  recovers quickly after a restart-during-outage.
- **Client**: Vite builds with `base:'./'` (assets resolve against the injected `<base href>`,
  so dynamic-import chunks follow the prefix via `import.meta.url`). `web/src/base.ts` exposes
  `BASE`/`withBase`/`asset`/`stripBase`; API/nav/asset/upload URLs are prefixed, the router
  strips the prefix off `location.pathname`, and share links / QR codes / the Stripe webhook
  URL use the Fabric `publicUrl`.

Standalone (or remote access off), `basePath`/`publicUrl` are empty and everything behaves
exactly as before (root paths, this device's address); the in-app Cloudflare tunnel
(`tunnel.ts`) stays only as the standalone fallback.

## In-app Stripe account picker + one-route remote access (v0.19.0)

Two Fabric refinements, tracking OpenMasjidOS v0.33.0 / v0.37.0:

- **In-app Stripe picker (no install setting).** The manifest declares no `settings`, so
  install stays one-click. On the admin Payments screen (when embedded) the app lists the
  masjid's vault accounts via `GET /api/fabric/stripe/accounts` (id + label, never keys —
  `fabric.ts` `fetchFabricStripeAccounts`), the admin picks one, and the chosen **id** is
  persisted (`store.getFabricStripeChoice`/`set`, kv key `fabric_stripe_account`; seeded
  from the `STRIPE_ACCOUNT` env for advanced installs). `fabricAccount()` fetches that
  account's keys (`GET /api/fabric/stripe?account=<id>`); blank = the only/first account.
  Keys stay in memory only; only the id is stored.
- **Remote access is now ONE Cloudflare route** (OS v0.37.0): the admin adds a single
  `omos.<domain>` hostname and the OS front door reverse-proxies each app path to its
  container, forwarding the **full path** unstripped. This needs **no app change** — our
  existing base-path handling (rewriteUrl strip + injected `<base href>`) already serves it.
  Cloudflare terminates TLS, so the donor's browser sees `https://` (Stripe Elements works)
  while the OS proxies to our plain-HTTP container. See `docs/REMOTE_ACCESS_INGRESS.md`.

## Tuition = a Students-billing shell over the Fabric broker (v0.26.0)

The `tuition` campaign type is **repurposed** (it was a card-fee variant in v0.24.0): it is now a
thin shell around the separate **OpenMasjid Students** app, reached through the OpenMasjidOS
**app-to-app broker** (OS v0.40.0). Students owns everything inside a tuition campaign — the label,
the lookup, balances, allocation, recording. We render the shell and charge the card. Authoritative
contract: `students/billing` **v2** in `OpenMasjidStudentManager/docs/FABRIC_BILLING_CONTRACT.md` §11
(mirrored locally in `docs/STUDENTS_INTEGRATION.md`).

- **Transport (`server/src/students.ts`).** We POST `${OPENMASJID_BASE_URL}/api/fabric/app/students/billing/<method>`
  with **our own** per-app secret; the OS core verifies our manifest declares
  `fabric.consumes: [students/billing]` (string form — the APPS catalog validator + OS `parseFabric`
  require it) and proxies to Students. `brokerCall` NEVER throws, 10 s timeout, and NEVER logs the
  body (the Student ID + family data). Every broker error → `unavailable` → the tuition campaign hides
  itself / shows a friendly notice (fail-soft doctrine). `info` is cached ~5 min.
- **Per-method wire version.** `identify` + `lookup` send `"v": 2`; `info`, `record-payment` and
  `check` are unchanged by v2 and deliberately keep sending `"v": 1` (which the provider still
  accepts), so a lookup-screen migration can never move the money path. `studentsFabric.test.ts`
  locks both halves of that, plus the fail-soft rules.
- **The PIN is gone (v2, provider 0.39.0 — §11.0).** The parent types a **Student ID alone**; we call
  `identify` (a first name + last initial, nothing else — no balance, no family, no ids), the parent
  confirms *"is this <child>?"*, and only then does `lookup` run. That confirmation **is** the
  safeguard the PIN used to be: it catches the realistic failure, a mistyped ID. A v1 `{name, pin}`
  body now **400s** — the flow can't silently half-work. Bills are also per child at v2, so `lookup`
  returns a balance per student (shown behind the household total) and tags each open invoice with
  the child it belongs to. Our `identify` + `lookup` routes share **one** per-peer rate-limit bucket
  (40/min — one honest flow is two calls), mirroring the provider's single per-code bucket, and both
  are uniform on not-found (unknown / withdrawn / locked / payments-off are indistinguishable).
- **No client trust (the security core).** On a successful `lookup` we stash the family + its open
  invoices in a **server-side session** (in-memory, 15 min, 128-bit id); the browser gets only display
  data + the opaque id — never the internal family/student ids (nor a sibling's Student ID). At pay
  time the client sends the session id + which invoices (or "full"); `computeTuitionAmount` (pure,
  unit-tested) recomputes the amount **and** the familyId server-side, so a crafted request can't
  attribute a charge to an arbitrary family or pay a tampered amount. The typed Student ID is
  body-only, never in a URL/log/metadata.
- **Itemised bills (Students 0.43.0, §11.0b).** `lookup`'s open invoices now carry `items[]` — the
  lines a bill is made of ($200 tuition + a $50 book fee) — and `record-payment` takes `lines[]`, the
  ids the parent ticked. The pick list groups lines under the bill label, offers only lines with a
  balance (settled lines read "already paid", a bursary reads "credit applied"), starts fully ticked so
  paying the lot stays one tap, and totals live on the pay button. `lines` goes on the wire **alone**:
  Students resolves one breakdown in the order `lines → allocations → students → derive`, and a line
  already resolves to its child. Itemisation is all-or-nothing **per family** (`itemised`), because that
  chain can't express a mixture of lines and whole bills in one call; an invoice whose lines lack ids or
  don't sum to the bill drops back to a single row. Ticked lines are persisted
  (`student_payments.payment_lines`) so an outbox retry settles the same line. Tuition stays out of
  donation reporting by construction — every donation query reads `FROM donations`, and itemising only
  added columns to `student_payments`.
- **A section per child, and per-child advances (v0.37.0).** The balance step renders one section per
  child — their balance or credit, their bills, their own "Add money" — since a household total can't
  say who is behind. An advance is **per child**: the whole amount goes as that child's `students[]`
  split, so it lands on their account rather than on whoever owns the family's oldest bill. The browser
  names a child by an opaque `ref` (`c0`, `c1`, …) issued in the lookup and resolved back to a
  `studentId` from the session, so no internal id ever reaches it. Bills read as a **statement** under
  "pay the balance" and only become a checklist once the parent chooses to pick.
- **Advance payments + credit (Students 0.41.0, §11.0a).** `info` advertises `allowAdvance` +
  `minAmountCents`; `lookup` reports `creditCents` for the household, the matched child and each
  sibling. The balance step shows *balance due* / *in credit* / *nothing due* rather than a bare zero
  (once an advance settles its invoice, credit is the only record left — `openInvoices` is empty), and
  offers a third **"Another amount"** mode. That typed amount is the one figure a parent names: it's
  safe because the session still fixes the family, the child and the currency, and any surplus becomes
  that family's own credit. The **floor** is `max(school's minAmountCents, MIN_TUITION_CENTS = $1)`,
  applied to every path — a provider advertising 25¢ can't drag us below a pound/dollar. A part payment
  within a real balance needs no `allowAdvance`; only money above it does. `allowAdvance` is advertised,
  never assumed, so a pre-0.41.0 Students keeps today's behaviour exactly.
- **Separate ledger (`student_payments` table).** Tuition payments are **not donations** — a distinct
  table, never joined into `metrics()`/`listDonations()`/`raisedForCampaign()`/the CSV, so they are
  excluded from every donation total, goal and year-end letter by construction (locked by a test).
  Tuition has **no card-fee** (`deriveFees` forces both flags off) — the parent pays the exact school
  balance; a gross-up would overpay an invoice and break Students' allocation.
- **Record + durable outbox.** The PaymentIntent carries §11.3 metadata (`purpose=students-billing`,
  `omos_app=donations`, `students_family_id`, optional `students_student_id`; description
  `School balance — <label>` — §11.3 bans a Student ID or a child's name from metadata/descriptions).
  On confirm/webhook we **retrieve** the PI (never trust the client) and push `record-payment`
  (idempotencyKey = the PI id). **The per-child `students[]` split is what books the ledger:**
  Students writes one row per child, taken from `students[]` or else **derived** from the *family's*
  oldest-due invoices — a derivation that ignores `allocations`. So picked months carry an explicit
  split, computed server-side from the ticked invoices (`computeTuitionAmount`) and **persisted**
  (`student_payments.students_split`) so an outbox retry books it identically; "pay the full balance"
  omits it, where the derived split is the same answer. A dropped response leaves
  `record_status:pending`;
  a 60 s outbox `check`s-before-retry so it never double-records; a permanent app error → `skipped`.
  Students' own daily reconciliation (it scans succeeded `students-billing` PIs) is the final backstop,
  so **money is never lost** even if our push never lands. Receipts/wording say "payment", not "donation".

## Fabric email + admin alerts (v0.27.0)

Two more OpenMasjidOS Fabric capabilities (platform v0.41.0+); both fail soft and never touch mail
credentials or the From address.

- **Donor email receipts (`email: true`).** The admin sets up ONE provider (SMTP/Resend) once in
  OpenMasjidOS → Settings → Email. We send a **branded receipt** via `POST /api/fabric/email`
  (`fabric.ts` `fabricEmail`). It's **opt-in** (admin toggle on the Thank-you tab, off by default) with
  an editable template (subject/heading/body + the `{name}{amount}{campaign}{masjid}` variables +
  header image + accent). The email is built + escaped **server-side** (`email.ts` `renderReceipt`,
  pure + unit-tested): the body/heading are treated as **plain text** and every value — including the
  donor's own `{name}` from the *unauthenticated* public intent — is HTML-escaped, so nothing can
  inject markup; images are embedded only from an http(s) URL (an uploaded `/uploads/…` header image is
  resolved to the Fabric public URL, and dropped when the app isn't publicly reachable). Sent
  non-blocking on the donation's first success (the donor's thank-you isn't delayed). **Receipt
  strategy:** Stripe's own `receipt_email` is suppressed only when our email is enabled *and* we hold
  no positive evidence that OpenMasjidOS email is unavailable (`emailLikelyAvailable()` — false only
  for `not_configured` / `no-fabric`, and persisted to the data volume via `store.setEmailStatus` so a
  restart doesn't forget). See *The receipt gate was a closed loop* below for why it is that way round.
  There's no OS "is email configured?" endpoint, so the admin UI shows the last send/test outcome and a
  **"send test"** button (admin-only) rather than probing.
- **Admin alerts (`alerts:`).** Declared ids: **`payment-failed`** (Stripe rejected a payment *setup* —
  the 502 path on donation + tuition intents; systemic, not per-donor declines) and
  **`tuition-record-failed`** (a succeeded tuition charge the Students ledger permanently rejected —
  money is safe via reconciliation, but the admin should verify). Fired with `POST /api/fabric/alert`
  (`fabricAlert`); the admin chooses the channel (email/webhook/off) per alert in OpenMasjidOS. We do
  **not** declare `reader-offline` — this is a web/Stripe-Elements app with no card reader (that alert
  belongs to the Kiosk). Alert text carries no PII (only a Stripe PI id + a reason code).

## Monthly plans: a local index over live Stripe state (v0.38.0)

The admin "Monthly plans" tab lists every recurring donation plan and lets the masjid pause,
resume or stop one, or give it an end. `server/src/plans.ts` holds the logic (pure half above,
fail-soft Stripe transport below); the six `/api/admin/plans…` routes and the sync/cache glue
sit in `index.ts`. Amounts cross the API in **major units**, dates as ISO strings (`''` for
"we don't know") — like every other route here.

The whole design follows from the LAN reality: **plan state cannot be mirrored in SQLite**,
because keeping a mirror correct would mean receiving `customer.subscription.updated`,
`invoice.paid` and `invoice.payment_failed` — inbound webhooks a LAN-only box may never get.
A mirror that silently stops updating is worse than no mirror: it would show "Active" for a
plan the donor's bank stopped paying months ago. So state (status, next payment, interval,
end date, card) is **read live from Stripe per plan** on an outbound call, which always works.

The **index**, however, is deliberately **local**: the `donations` rows with `recurring = 1`
and a non-empty `subscription_id` (`store.listRecurringDonations()`, oldest first), folded by
the pure `groupPlanSeeds()` into one seed per subscription — the earliest row being the plan's
origin (campaign, Stripe account, donor name/email, currency, cover-fees, Gift Aid, card).
Two security properties fall out of that and must be kept:

- a subscription **we did not create** can never appear, which matters because a
  Fabric-vaulted Stripe account is **shared** with the platform's other apps — listing
  Stripe's subscriptions instead would show (and let an admin cancel) someone else's;
- **tuition can never appear.** A tuition payment is written to `student_payments` and never
  to `donations` at all (§13 route isolation), so there is no row here to group. It is
  structurally absent, not filtered out.

Every action route resolves its plan through that same local index first and 404s
`{ error: 'Unknown plan.' }` otherwise — the guard is on the *write* path too, not just the list.

**The money is local.** "Collected so far", "payments" and "last payment" are sums over those
rows (succeeded only — a pending or failed row is not income), in the plan's own currency.

The two **headline** figures (`stats.monthlyTotal`, `stats.collected`) wear a single symbol —
`stats.currency`, the masjid currency — so only plans actually charged in that currency are
folded into them, and `message` says so when any plan was left out. A second Stripe account in
another currency would otherwise make the headline a sum of mixed units under one symbol, and
worse with a zero-decimal currency, where ¥1,000 and £10.00 are the same number of minor units.

### The 60-second cache and the `latest_invoice` change-detector

`syncPlan()` caches each plan's live state for **60 s** (`?refresh=1` bypasses it), so opening
and re-opening the tab doesn't hammer Stripe. The cached entry also keeps two markers about the
subscription's `latest_invoice` — **its id and whether it was paid** — and keeps them **past the
TTL**, on purpose: they are how the next sync knows whether new money can have landed. The
invoices are re-listed when any of these is true, and skipped otherwise (so the **steady state
is one Stripe call per plan**):

- we have never synced this plan;
- the newest invoice is a **different** one;
- **`?refresh=1`** — a forced refresh always re-lists and reconciles, it doesn't merely skip the
  TTL;
- the newest invoice was **not paid** last time we looked. This is the case an id comparison
  alone misses: when a renewal fails and Stripe **retries** it, the retry pays the *same*
  invoice, so the id never changes and the money would go unrecorded until the plan raised its
  next one (~30 days). Once an invoice *is* paid it can never gain money again, so "same id, and
  already paid" really does mean there is nothing to reconcile — which is why the paid flag is
  sufficient and no amount needs caching. `latest_invoice` is expanded on the same
  `subscriptions.retrieve` call, so this costs nothing; an un-expanded invoice reads as unpaid,
  erring toward an extra call rather than missed money.

The markers only move forward once we have actually caught up (we saw the invoice list, or knew
there was nothing new). If the list call failed, or the catch-up was deliberately skipped (see
below), the old markers are kept so the next sync does it — a marker running ahead of the money
would hide a renewal for a month.

Entries are swept only when the map exceeds 2000 (dropping those over 24 h old), so the
change-detector survives. The list refreshes at most **200 plans** per request, five in flight
(`mapWithLimit` — a Pi must not open 200 sockets), and says so in `message` plus a log line
rather than truncating silently. The order that cap is applied in is **`planSyncOrder()`:
plans that have taken money first**, newest-first within each group — see "abandoned sign-ups"
below for why newest-first alone was a denial of service on reconciliation.

A failed live read is **not** backfilled from a stale cached state: `status: 'unknown'` /
"Not known" is honest, a month-old status presented as current is not. It also matters *why* the
read failed, so `syncPlan` reports three outcomes — `ok`, **`no-keys`** (no Stripe account with a
secret key for this plan any more: removed from OpenMasjidOS, or the app lost the `stripe`
capability) and `unreachable` (Stripe itself didn't answer). Only `unreachable` sets
`stripeReachable: false` or says "please try again"; `no-keys` gets its own sentence pointing at
Payments / OpenMasjidOS → Settings → Payments, because retrying can never fix it. The detail
window and all four action routes use the same distinction.

### Abandoned monthly sign-ups

A recurring donation row is written at `/…/intent` — **before** the donor has entered a card —
so every monthly checkout somebody starts and walks away from leaves a row behind for a
subscription that never collected a penny, and a visitor on the masjid's own network can create
them without logging in. Two consequences, fixed in two places:

- **the refresh cap.** Filled newest-first, a burst of those sign-ups filled all 200 slots and
  every real plan silently stopped being reconciled. `planSyncOrder()` puts paid plans first, so
  the cap can no longer starve one.
- **the list.** After the sync + reconciliation, a seed with **no payments** whose `startedAt` is
  over **24 h** old (`isAbandonedSeed`, `ABANDONED_MS`) is omitted from `plans` and from
  `stats`, and `message` says how many — hidden, but never hidden *silently*. Only a plan this
  request actually **synced and was allowed to reconcile** may be hidden: one the cap left out
  hasn't had its chance to heal, and once hidden the admin can't open it either, which is the
  one route that would have reconciled it.

The **order is the whole point**. A plan whose first payment really did succeed but whose
`/confirm` never round-tripped (the donor closed the tab) *also* reads `payments === 0` locally,
and reconciliation is the only thing that can tell the two apart. So the predicate is applied
**after** syncing, to decide what to show — never as a filter inside `groupPlanSeeds()` or
`listRecurringDonations()`, which feed the sync. Filtering there would permanently hide exactly
the row that needed healing. Both halves are pure and unit-tested, including that trap case.

### A GET that writes

`GET /api/admin/plans` (and the detail route) reconcile, i.e. they **write**. The session cookie
is `SameSite=Lax`, so a cross-site **top-level navigation** to `/api/admin/plans?refresh=1`
carries it: a page an admin merely visits could force hundreds of outbound Stripe calls and
donation `INSERT`s. It cannot read the JSON back, so this is forced work rather than disclosure —
but the **write side only runs when the request looks like our own page's fetch**, i.e.
`sec-fetch-site` is absent or `same-origin` (a browser navigation sends `cross-site`/`same-site`;
`curl` and older browsers send nothing). The routes stay plain GETs and the read-only live state
is unaffected.

### Renewal reconciliation

The local money figures are only truthful if renewals are recorded — which, again, is what the
optional `invoice.paid` webhook would have done. So while syncing a plan (only when its newest
invoice changed) we list its invoices, oldest first, and for each:

- no PaymentIntent → **skip** (and log once). `payment_intent_id` is UNIQUE and defaults to
  `''`, so inventing a key would collide with the next such invoice.
- already have the row → if Stripe says paid and our row isn't `succeeded` (the donor closed
  the tab), `markDonation(pi, 'succeeded')`. Stripe is the truth.
- not paid, or `amount_paid <= 0` → skip. **A failed renewal is never recorded as a donation.**
- otherwise `createDonation(...)`, everything descriptive copied from the plan's first row (a
  renewal has no form of its own), stamped **`createdAt` = the date the money actually
  arrived** (`status_transitions.paid_at`, else `created`) — otherwise a year of caught-up
  renewals would all land in this month's total and wreck the 6-month trend chart.

Idempotent twice over: we check `getDonationByPaymentIntent` first, and the UNIQUE index
catches the concurrent-sync race (caught and logged, never breaking the tab).

It is a **catch-up, not an event**: no `notify()` and no receipt email, or a masjid would get a
dozen alerts the first time they opened the tab. Reconciled rows are written `receipt: 'stripe'`
so the receipt outbox owes them no letter. (The webhook path keeps its `notify` — there, the
money really did just arrive.) The one email that can still go out is the pre-existing outbox
reacting to a *first* donation being marked succeeded: that is the donor's own receipt for
their own payment, identical to a webhook confirm.

This needed **no new table and no migration**. The only store changes are `createDonation`
accepting optional `createdAt`/`cardBrand`/`cardLast4` (defaults unchanged for every existing
caller) and the one read method `listRecurringDonations()`.

### The manage actions, in Stripe terms

- **Pause** → `subscriptions.update(id, { pause_collection: { behavior: 'void' } })`. `'void'`
  is the only honest behaviour for a *donation*: the donor is not charged and is not billed for
  the missed months later. A paused plan is therefore **not** a Stripe status — the
  subscription stays `active` underneath — so `friendlyStatus()` checks `pause_collection`
  **before** `sub.status`, or a paused plan would read "Active".
- **Resume** → `pause_collection: null`. Not `subscriptions.resume`, which resumes the billing
  *cycle* and can raise a catch-up invoice.
- **Stop** → `subscriptions.cancel(id)`, always immediately. There is deliberately **no**
  "stop at the end of the period" option (it existed briefly and was removed):
  `cancel_at_period_end: true` does **not** take one more payment — Stripe raises no further
  invoice — and a donation has no service period left to run out, so it is financially
  identical to stopping now while *sounding* like the masjid still receives a month's money.
  Offering it promised income that would never arrive. A masjid that genuinely wants one more
  payment and then a stop uses **"stop after 1 further payment"** below, which really does take
  one. `POST /api/admin/plans/:id/cancel` therefore takes **no body** (like pause/resume).
  A cancelled subscription carries `ended_at` and **no** `cancel_at`, so `endsAtUnix()` reads
  `ended_at` first — otherwise a plan the admin had just stopped would report itself
  open-ended, one row under a "Stopped" pill.
- **End on a date** → `cancel_at` = the **end** of that calendar day, UTC (so "stop on the
  30th" includes the 30th), with `cancel_at_period_end: false` (the two ways of ending are
  mutually exclusive and that field isn't Emptyable, so `false` is how it clears).
  **Open-ended** clears both.
- **Stop after N further payments** (N is *further* payments, not the total, and is labelled
  that way in the UI; 1–120). Charges land at `nextPaymentAt`, then one interval later, so the
  last charge we're promising is at `nextPaymentAt + (N − 1)` intervals and `cancel_at` must
  fall strictly **after** it and strictly **before** the following one. We aim a day short of
  the following charge — never *on* a charge instant, which would race Stripe's billing job.
  For a very short interval a whole day would overshoot back past the last promised charge, so
  the clearance is capped at half the gap; monthly (all we create) is unaffected. Month
  arithmetic clamps the day to the target month's length (31 Jan + 1 month → 28/29 Feb),
  matching what Stripe does with a monthly anchor. `addIntervals` / `endOfDayUnix` /
  `cancelAtAfterCharges` are pure exports, unit-testable without Stripe.

Each refusal gets its own plain sentence (already stopped, not yet taken its first payment,
paused, no known next payment, an unworkable interval, out-of-range N, an invalid or past
date). A Stripe failure is a **502** with one friendly sentence and a warning logged **without
donor PII**. After a successful action we re-read the plan from Stripe and return it; if *that*
re-read fails we return the local row (`live: false`) rather than an error — the change *was*
applied, and a 502 there would invite the admin to do it twice.

### Webhooks and degradation

This feature needs **no webhook at all** — state is retrieved on demand and renewals are
reconciled on demand, which is precisely the point. The optional per-account `invoice.paid`
webhook stays as the faster path when the app *is* publicly reachable; the two write the same
row and are idempotent on `payment_intent_id`.

When Stripe is unreachable the tab still renders from local data — donor, campaign, amount,
started, collected, payments, last payment — with `status: 'unknown'` ("Not known"), no next
payment or end date, `live: false`, `stripeReachable: false` and a warm inline note. Never a
stack trace, never an empty screen. The manage actions are the only things that genuinely
can't work offline, and they say so. Nothing secret leaves the server: no keys, no webhook
secret, no Stripe customer id.

## Refunds: an amount on the donation, with Stripe as the truth (v0.42.0)

An admin can send a donation back from the **Donations** tab — all of it or part of it — with a
reason, and optionally an email to the donor. `POST /api/admin/donations/:id/refund`.

### A refund is an amount, not a status

`donations.status` stays the *payment's* outcome. A refund is recorded as
`refunded_amount` (a running total in minor units) plus `refunded_at`. Rewriting the status to
`'refunded'` was rejected twice over: it would lose the fact that the money really did arrive, and
it cannot express a part refund at all.

Everything the masjid — or a donor, via a campaign goal bar — is shown as money is therefore
`amount - refunded_amount`: `raisedForCampaign`, all three `metrics()` figures, the donations-tab
total, and a monthly plan's "collected so far". The **counts stay gross**: a refunded donation was
still a donation that arrived, and the ledger still lists its row, so deducting it from the count
would make the headline disagree with the list underneath it. `metrics()` reports `totalRefunded`
and `refundedCount` separately, and the Overview tile says "after £X refunded", so a total that
went down is explained on the same screen.

### How much is left to refund is Stripe's fact, not ours

Our `refunded_amount` is a *cache* of a fact about the Stripe charge, and it can go stale without
this app being involved at all: a masjid can refund straight from Stripe's dashboard, and a
LAN-only box may never receive the webhook that would have told it. So the route:

1. reads the charge (`fetchChargeRefundState` → `amount_captured`, `amount_refunded`);
2. writes back anything Stripe knows that we don't — **this is also the repair path** for a
   dashboard refund, reached simply by opening the donation;
3. computes what is left from Stripe's figures and validates the request against that;
4. refunds, and only then records — `'failed'`/`'canceled'` are reported to the admin as failures
   rather than quietly booked.

`setDonationRefund` is **monotonic and clamped**: it only ever rises, and never past the amount
charged. Both properties are load-bearing, because two things write to it (the route and the
webhook) and Stripe gives no ordering guarantee — a replayed event for the *first* of two refunds
would otherwise put money back into the totals.

The **idempotency key is derived, not random**: `refund:<pi>:<already refunded>:<amount>`. A
double-clicked button sends the money back once; a genuine second part refund of the same size has
a different "already refunded" figure, so it is a different key and goes through.

One residual race is accepted knowingly: two admins refunding *different* part amounts of the same
donation in the same second read the same "already refunded" figure, so both are accepted at Stripe
(correctly — the two refunds are genuinely different) but the second store write reports only its
own share. Stripe is still right, and both repair paths above — the next open of that donation, and
`charge.refunded` — correct our copy. Closing it properly would mean a second charge read on every
refund, which is not worth paying for a two-admin, same-second, different-amount collision.

### Three-decimal currencies

KWD/BHD/JOD/OMR/TND are quoted in thousandths and Stripe requires a multiple of ten, so a *typed*
part refund is snapped to the nearest 10 and then re-checked against the balance (snapping up must
never overshoot). A *full* refund needs no snapping — it is exactly what was charged, which already
satisfied the rule. This is the same trap as DONATIONS-001 on the charge side; `refunds.test.ts`
locks it.

### Who gets told

- **The donor**, only if the admin ticks the box and they left an address:
  `renderRefundNotice` → Fabric email. Deliberately **not** admin-editable (it is a factual notice
  about somebody's money, and it is the wording most likely to worry them if got wrong) but it
  carries the masjid's logo, accent and contact details. One attempt, no outbox — a refund notice
  arriving silently three days late is worse than none — and the panel says plainly whether it went.
- **The masjid**, via the declared `donation-refunded` **alert**, not `notify()`. An alert is the
  only channel that can reach the admin's own email (the platform owns the address) and
  OpenMasjidOS → Settings → Alerts lets them route it to email, webhook, both or off; `notify()`
  would post to the same webhook a second time with no email and no off switch. It fires even
  though an admin is standing at the screen, on purpose: a masjid's panel is shared, and "money
  left the account, and who sent it back" is exactly what a treasurer should hear without having
  been the one who pressed it.
- **The audit log** gets `donation.refund` with the actor and the donation id — and no amount, per
  the rule the `audit_log` DDL sets out; the row it names carries the figures.

### The webhook half

`charge.refunded` is handled in the existing optional per-account webhook, which is how a refund
made in the masjid's own Stripe dashboard reaches the ledger. `amount_refunded` is the charge's
running total, which is exactly what the store wants, and the alert fires **only when the figure
actually moved** — that is what stops a panel refund being announced twice. The donor is
deliberately *not* emailed from this path: Stripe sends its own notification for a dashboard
refund, and a second letter from us would confuse them.

A failed refund arriving later as `charge.refund.updated` is **not** handled: card refunds
effectively do not fail after acceptance, and un-recording money is the one direction the monotonic
guard forbids. If it ever matters it needs its own deliberate change, not a widened guard.

### Tuition

`/api/admin/donations/:id/refund` refuses a `tuition` campaign outright. A tuition payment
lives in `student_payments` and never in `donations` (§13 route isolation), so no such row should
exist — but refunding one from this side would leave the school's ledger claiming it was paid.

## The monthly donor's own stop link (v0.42.0)

A donor who sets up a monthly gift is emailed a letter confirming it, carrying a link to
`https://<public>/stop/<token>` where they can stop the payments themselves — no sign-in, nobody to
phone. This is the app's **only unauthenticated destructive capability**, so most of the design is
about keeping it narrow.

### The letter

Sent when the FIRST payment succeeds, never at intent — an abandoned monthly checkout leaves a
`donations` row behind (that is what `isAbandonedSeed` exists for) and must not be written to.

It reuses the existing receipt lifecycle rather than inventing a second one: `receipt = 'pending'`
means "we owe this donor a letter", and `sendDonationReceipt` picks WHICH letter from the row's own
`recurring` flag — the monthly setup letter, or the plain receipt. So the retry outbox, the
lost-donation sweep and the `sent`/`skipped` states all work unchanged, there is exactly one owed
letter per donation, and no new double-send hole. `recurring` is immutable on the row, so every
render (confirm, outbox three days later, sweep) picks the same letter.

**No admin toggle, deliberately.** Not the receipt toggle (off by default — the donor's only exit
would be off by default), and not a new one, whose honest label would be "don't tell monthly donors
how to stop". A payer who cannot stop a card mandate rings their bank instead, and on a shared
Fabric Stripe account that chargeback lands on the whole platform. The admin's control surface is
the letter's branding and the panel's own Stop button.

**The email-availability gate is skipped for monthly.** It exists to avoid suppressing Stripe's own
receipt in favour of one we cannot deliver; on the monthly branch there is nothing to suppress,
because `createSubscription` never sets `receipt_email`. So trying costs the donor nothing even when
we believe email is down, and the outbox keeps trying for three days.

Everything in the letter is a LOCAL fact (amount, first-payment date, fund, reference), so the
outbox can re-render it three days later without a Stripe call. Card details and the next payment
date are deliberately absent for that reason.

### The token

32 lowercase hex characters (128 bits), in `plan_links(token PRIMARY KEY, subscription_id NOT NULL
UNIQUE CHECK(length > 0), created_at)`. Hex rather than base64url because mail clients mangle case
and `-_`; the entropy is the defence, because a per-peer rate limit cannot be (behind the platform's
ingress every remote donor shares one bucket — DONATIONS-009).

Stored **plaintext**. Hashing would mean the letter could never be rendered twice, and it is rendered
up to three times for one donation — so a hash would either mail no link or re-mint one and silently
kill the link already in the donor's inbox. It would also buy little: the session secret lives in the
same file and mints admin session cookies, so anyone who can read this table can already reach the
panel's own Stop button. `ensurePlanLink` is get-or-create for the same reason, and a token is minted
only when there is a public URL to put it in.

Rows are **kept after a plan ends**, so an old link reads "these payments have already stopped"
rather than a frightening "this link doesn't work". A stale forwarded token is harmless precisely
because stopping is all it can ever do.

### The two routes, and five things that must not change

`POST /api/public/plan/lookup` and `POST /api/public/plan/cancel`, token in the **body**:

1. **Never `syncPlan`.** It lists invoices and INSERTs donation rows, and its only guard
   (`ownPageFetch`, a `Sec-Fetch-Site` check) is structurally unusable for a link in an email — a
   corporate mail scanner's prefetch would otherwise drive writes against the masjid's Stripe
   account. Use `fetchPlanState` alone: one subscription read, no invoices, no reconciliation, no
   cache write. (Cancel *deletes* the `planCache` entry, so the admin's Monthly tab doesn't show
   "Active" for 60 seconds after a donor stops.)
2. **Resolve through the local recurring index** (`findSeed(planSeeds(), …)`), exactly as the admin
   write routes do — the v0.38.0 invariant, now covering a fifth writer. `getDonationBySubscription`
   is not good enough: it lacks the `recurring = 1 AND subscription_id <> ''` filter.
3. **POST only, token in the body.** A GET that mutates is fired by every link-preview bot that
   touches the email; keeping the token out of the API URL also keeps it out of access logs. The
   page URL itself is unavoidably in the masjid's own Cloudflare logs — which is why the token
   authorises so little. `referrer-policy: no-referrer` (already global) stops it leaking onward.
4. **Every failure is the same 404** — unknown token, malformed token, no local row, a tuition
   campaign — so nothing is an oracle. Both routes are `no-store, private`.
5. **A fixed audit actor.** `audit(req, …)` reads the admin session and falls back to
   `local admin`, which would file a donor's cancellation as the masjid's own action in the one log
   they trust. It writes `store.recordAudit` with `'the donor, from their email link'`, and a
   `plan-stopped` alert — for an unauthenticated destructive write with no undo, the masjid hearing
   about it *is* the compensating control.

Cancel is **idempotent**: a finished plan is a success, not an error. Stripe refuses to cancel a
canceled subscription and `cancelPlan` would report that as "we couldn't reach Stripe" — which a
donor double-clicking would hit every time.

### What the donor is told

Amount, frequency, fund, reference, next payment (omitted, never guessed, when unknown), status,
and the masjid's name/logo/contact details. **Never** the donor's name or email, the card, any
Stripe or internal id, or any payment history — the token can be forwarded, sit in a shared family
inbox, or be pasted into a support ticket.

### When there is no public URL

The letter still goes, with no link and the "get in touch and we'll stop it for you" wording —
mirroring `resolveEmailImage`, which omits rather than fabricates a host. Never a LAN URL. On a
LAN-only box (the default posture) the panel is the real cancel mechanism; on a standalone non-SSO
box no letter is sent at all, because `fabricEmail` goes through the platform. `publicBaseUrl()`
also refuses the app's OWN tunnel hostname under SSO, where that tunnel is force-stopped at boot but
its stored `enabled` flag stays true — a link to a host nothing is listening on is worse than none,
and worst of all in an email to a stranger.

### Routing

`/stop/<token>` is two segments, and `parseCampaignPath` is anchored to one — so it can never be
mistaken for a campaign, and `stop` is deliberately **not** added to `RESERVED_SLUGS`. Reserving it
would buy only the bare `/stop` and would pay for it with `migrateCampaignSlugs` silently renaming
any existing campaign slugged `stop` on the next boot, breaking a link a masjid may have printed. A
bare or truncated `/stop` gets its own "this link looks incomplete" page, and the not-yet-onboarded
redirect to `/admin` explicitly excludes it — that `location.replace` would destroy the only copy of
the token. The page is its own lazy chunk (~8.7 kB, no Stripe.js).

## Per-appeal Stripe accounts (v0.42.0)

A masjid may hold several Stripe accounts — some vaulted in OpenMasjidOS (set up once in the
dashboard, shared with its other apps), some with keys on this device — and each appeal may name the
one its money goes into. A Zakat page can settle into a separate account from the general fund.

Before this, a vaulted account **shadowed every campaign**: `effectiveAccountFor` returned the one
globally-chosen vault account whenever it was configured, and `campaigns.stripe_account_id` was
ignored entirely on an embedded install. Per-campaign accounts existed only standalone.

### The migration rule

**An existing appeal's destination is a function only of data that existed before the upgrade.**

`campaigns.payment_account` defaults to `''`, there is **no backfill and no inference** from
`stripe_account_id`, and the `''` branch of the resolver is the old code path verbatim — the
globally-chosen vault account when `stripeConfigured`, else `store.getStripeAccount(c.stripeAccountId)`
read straight from the local table. Not through the widened `accountById`: a bare vault slug left in
`stripe_account_id` by an old create would otherwise start charging an account the admin never chose.

So an unattended overnight update cannot move anybody's money, and a masjid that wants per-appeal
accounts opts in per appeal. `accounts.test.ts` locks the storage half of this; the resolver's
default branch is a byte-for-byte copy of what it replaced.

### Namespacing

`''` | `fabric:<vault-slug>` | `local:<local-id>`. Vault ids are the platform's `slugify()` output
(lowercase, `[a-z0-9-]`, no underscore); local ids are `acct_<hex>`. **Provably disjoint on the
underscore**, which is what makes it safe for `accountById` to try the local table first.

Ids, never labels. The platform matches a label too, so a label would appear to work right up until
the admin renamed the account — and would also multiply the cache keys.

Anything that does not parse EXACTLY is `invalid`, and invalid **refuses**. That is not pedantry:
`fabric:` with an empty id would reach the platform as `?account=` omitted, which it answers with its
**first** account — so a Zakat appeal would quietly settle into the general fund and the ledger would
record the general fund's id, leaving nothing that looked wrong.

### Refuse, never substitute

An explicit choice is honoured or the appeal stops taking cards. It never falls back to the site
default, to another vault account, or to a local one. An admin who points Zakat at its own account
has made a statement about where that money must go; settling it elsewhere is worse than not taking
it. The three refusal causes are distinguished all the way to the surface — `no-account`,
`not-configured`, `unreachable` — because "try again in a minute" and "this account is gone" need
different words.

**A refusal is loud in three places**, or it would be an invisible 100% outage on one appeal:

- the donor sees a sentence (never "Stripe", never "account" — none of it is theirs to fix);
- the Campaigns list shows a **Not taking donations** pill with the cause, and the form explains it
  next to the picker, including the clause that answers the admin's real fear: *we won't quietly send
  the money to a different account instead*;
- the first refused intent per campaign per day fires the `payment-failed` alert.

### The two resolvers, and why they differ

| | reads | may it be re-pointed? |
|---|---|---|
| `resolveAccountFor(campaign)` | the appeal's current choice | yes — it decides where NEW money goes |
| `accountById(bareId)` | the id recorded on the row | **never** |

Money taken on account A is confirmed, refunded and cancelled on account A for ever, even after the
appeal moves to B. That asymmetry is what makes the feature safe, and it is why the confirm route
keeps resolving by the recorded id even though it has the Campaign in hand.

`accountById` is **bounded by a known-id set** (`store.knownAccountIds()`): the accounts campaigns
point at, the accounts money was taken on, and the site default. An unknown id returns `null` with
**no network call**. This is a security property, not an optimisation — `/api/stripe/webhook/:accountId`
is unauthenticated by necessity, so without the bound a stranger could name arbitrary accounts and
have us fetch each from the platform vault: an amplifier against the platform, and a way to flush the
in-memory keys that keep donations working through a blip.

It still keeps the old `fab.id === id` comparison as a last step, for rows written when the vault
reported the literal id `'fabric'`. The platform 404s that name, so those rows resolve only through
the globally-chosen account.

### Vault key caching

`fetchFabricStripe`'s cache is keyed **per account**. It was a single slot with the account name
stored alongside — correct, but two appeals on two accounts would evict each other on every donation,
including the last-good copy that exists precisely so a platform blip cannot stop donations.

The non-ok branch is **split by status**, and this is a precondition for "refuse rather than fall
back" being safe rather than fragile:

- **404 / 403** — the platform has answered: no such account. Cache it. (This is also how an account
  the admin deleted in the dashboard comes back as "nothing" rather than as somebody else's keys —
  the platform does not substitute its default for an unknown id.)
- **429 / 5xx / transport** — it has told us *nothing*. Don't cache, serve the last good copy. The
  Fabric rate limit is shared with every other app on the box, so negative-caching a 429 would turn
  one throttled request into a 60-second donation outage.

`fabricConfigSignature` therefore reports `reachable: false` when the lookup was non-authoritative.
Without that, a Fabric throttling storm would blank the fingerprint while the reachability probe
(which hits an unthrottled route) said "up" — and the watcher would restart a box in the middle of
taking live donations, repeatedly.

No vault account may **ever** be written into `stripe_accounts`. `accountById` is local-first, so a
stale copy would permanently shadow the real vault account and survive a restore.

### Deleting an account

Blocked when any campaign depends on it through **either** column, and blocked outright when
`donations` or `student_payments` reference it. The second guard is the important one: deleting an
account money was taken on would strand every refund and leave a monthly plan that neither the admin
nor the donor could ever stop — a card mandate nobody can cancel is a chargeback, and on a shared
vault account that lands on the whole platform.

### Known limitations

- **One currency.** `cur()` is charged on every account; an account that cannot accept it fails
  loudly at Stripe. Per-account currency is not built.
- **One webhook endpoint per account.** A masjid using two accounts registers the optional webhook
  twice (`/api/stripe/webhook/<id>` each). Webhooks remain optional — the retrieve-on-return and
  reconciliation paths do not need them.
- **Rename a vault account; never delete and re-add it.** The platform frees the slug on delete and
  re-derives it on create, so a re-added account with the same name silently re-points an appeal's
  reference at new keys with no 404 to notice.
- **Test-mode money is counted in the totals**, with the appeal badged `TEST` and the donor shown a
  `TEST MODE` notice. Excluding it would make the headline fall with no explanation.

## The receipt gate was a closed loop (v0.42.0)

A donation records, **once at intent**, which receipt it is owed:

| `donations.receipt` | meaning |
|---|---|
| `stripe` | Stripe sends its own built-in receipt; we send nothing. |
| `pending` | Stripe's receipt was suppressed; **we** owe a branded one (the outbox retries for 3 days). |
| `sent` / `skipped` | delivered, or permanently un-sendable (no/invalid address, recipient rejected). |

Deciding once is the point: re-evaluating at confirm was the original double/zero-receipt bug, because
the answer could differ from the one that decided whether to suppress Stripe's.

Going `pending` means switching off the receipt the donor would otherwise certainly have got, so it
needs a reason to believe we can deliver our own. That gate used to be `emailStatus() === 'ok'` — and
`'ok'` is set in exactly one place, inside `fabricEmail`, which is reached only when a donation
already owes a letter, which required `'ok'`. **A closed loop.** On any fresh container the branded
receipt (shipped in v0.29.0) could therefore never be sent at all, and a restart re-closed it —
including the restart the app performs on itself when remote access changes in OpenMasjidOS.

The gate is now `emailLikelyAvailable()`: true unless we hold **positive** evidence that email cannot
work — the platform answered `not_configured`, or there is no Fabric. Everything else (never tried, a
timeout, a 500, a rate limit) is "we don't know", and the honest response to not knowing is to try.
The status is persisted (`store.getEmailStatus` / `setEmailStatus`, mirrored from `fabric.ts` through
a small sink) so the negative survives a restart.

**The failure this direction is bounded and self-healing.** If email really is unconfigured, the first
donation after the admin turns receipts on loses its receipt — we suppressed Stripe's, ours failed —
the platform tells us `not_configured`, that is written down, and every donation after it falls back
to Stripe's own receipt. One donation, once, against every donation, for ever.

Do not tighten this back to "a previous send succeeded". If a cheap authoritative "is email set up?"
probe ever appears on the Fabric, that is the right way to close the remaining gap; a success
requirement is not.

## WhatsApp: an admin channel, deliberately (v0.43.0)

The masjid installs the OpenWA gateway and links **their own** phone number in OpenMasjidOS. We POST
`/api/fabric/whatsapp`; the platform sends. We never see the gateway, its credentials, or the number.

### Why it carries admin notifications and not donor receipts

The platform's alerts matrix has no WhatsApp column for an app, on the reasoning that it routes to
the admin's one number while an app's messages are generally for donors — so "which events, and to
whom" is a setting in the app. In Donations that setting resolves the other way: **the recipients are
the masjid's own people.**

That is not a smaller version of the donor feature; it is a different one, and it is the reason
nothing in this app collects a donor's phone number. A donation page asks for as little as it can —
name and email are already optional — and a phone number is the field most likely to make someone
abandon a gift. It would also put us one bug away from messaging a stranger on an unofficial client
that gets numbers banned for exactly that.

### Never load-bearing (and, from v0.43.0, not necessarily additive)

Until v0.43.0 this section claimed WhatsApp was always a *second* copy of something that had already
gone out by email or webhook. Per-event notification settings make that false: `{os: false,
whatsapp: '…'}` is one click, and an admin who wants refunds on WhatsApp and nowhere else is entitled
to that. The weaker claim is the one that was doing the real work, and it still holds — **nothing
depends on a WhatsApp message arriving.** The donation is in the database and in the panel either way,
no money movement and no donor outcome hangs on a notification, and every event is still reachable
through the alerts matrix if the admin wants it there. So:

- the send is fire-and-forget and never blocks a donor, a payment or a receipt;
- a failure is logged at warn and dropped — the alert that did go out is unaffected;
- nothing auth-critical rides on it, ever. It is an unofficial client whose number can be restricted
  or banned without notice, and email has a real provider behind it.

### `queued` is not `sent`, and the pacing is why

Ban risk attaches to the **number**, not to whoever sent a message — so one platform-wide queue paces
every app at once: randomised 6–20s gaps, per-recipient cooldowns, hourly and daily caps, a warm-up
ramp for a freshly linked number, and quiet hours that queue rather than drop. A success is
`202 {queued:true}` and there is no delivery receipt.

The panel therefore says **"Queued ✓ — … it may take a few minutes to arrive"** after a test, never
"Sent". An admin told "sent" who then watches a silent phone concludes the feature is broken, when
the truth is that it is working exactly as designed.

The shared daily cap is also why the "a donation was received" event has a **`minAmount` floor**
(default 0 = every donation, but prominent in the UI). A busy Friday of small gifts would otherwise
spend the masjid's entire allowance on good news and push the refund and payment-failure messages —
the ones that need someone to act — behind hours of queue.

### One recipient per call, and never a client-chosen target

The platform takes one `to` **or** one `group` per call and 400s on both or neither. The array it
does not accept is the point: the API shape is the first place a cold blast is discouraged, and a
cold blast is the single most reliable way to get a masjid's number banned. We loop, and the queue
paces the loop.

- **Numbers** go through `toWhatsAppDigits`, which mirrors the platform's own `toDigits`: strip to
  digits, require 8–15, and **refuse a number with no country code rather than guessing one.**
  "07700900123" is a real number in the UK and a different real number elsewhere; prefixing our guess
  would send a masjid's donation figures to a stranger. The admin is told to add the code instead.
- **Groups** come only from `GET /api/fabric/whatsapp/groups` — the ones the *platform* admin
  approved for this app, never the gateway's own list, which would name every group the masjid's
  phone is in, the imam's family chat included. The id is re-verified against that list before it is
  saved, because the platform's 403 for an unapproved id would otherwise arrive silently at send
  time, long after the admin left the screen believing it was set up.

### Three wire details that fail silently

Found by reading `packages/core/src/api/fabric.ts` rather than the summary this was built from, and
each one would have left a feature that looks correct and never messages anybody. All three are
pinned by `whatsapp.test.ts`:

| | The trap |
|---|---|
| `/groups` | Returns **`{ groups: [...] }`**, not a bare array. Parsed as an array it yields nothing, and the admin concludes no groups were approved. |
| `reason` | Always a word, never `null`; **`"ready"`** is what available looks like. Treating a null reason as "available" inverts the check. |
| `media` | **Absent means no.** An older platform omits it entirely. |

The availability probe is cached for a minute so the Settings screen is cheap, but an **outage is
never cached** — one dropped packet would otherwise hide the feature from the admin for a full
minute — and `?refresh=1` forces a re-probe, which is what the admin presses after linking the phone,
when watching the answer change is the whole point.

## Admin commands: stats only, and why that is the whole design (v0.43.0)

An admin messages the masjid's number with `!donations`; the platform renders the menu, authorises
the sender, and POSTs the chosen command to `/fabric/commands/run` on our own port. Five are
declared — `today`, `month`, `totals`, `appeal`, `monthly` — and every one of them only reads.

### Three constraints, and the design falls out of them

**It is an informal channel.** A WhatsApp message is typed on a phone, often one-handed, by whoever
happens to be holding it. So the blast radius of a mistake should be a wrong figure on a screen, not
a closed appeal or a refunded donation. `confirm: true` exists in the contract for exactly the
commands we chose not to have; the safer answer was to have none of them. Nothing here writes.

**A message is forwardable.** It gets screenshotted into a family group, quoted in a committee
thread, and backed up to somebody's cloud. The donor never agreed to any of that — so a command
answers *"£312 from 9 donations"* and never who gave it. This is structural rather than a habit: the
formatters in `commands.ts` are given counts and totals, and there is no parameter anywhere in that
surface that *could* carry a name, an email or a reference. `commands.test.ts` asserts it, so adding
one fails a test rather than shipping.

**Ten seconds, and somebody is waiting.** Every figure comes from SQLite. Nothing calls Stripe —
which is why `monthly` reports what the local recurring rows say (donors who have actually paid,
what they most recently gave, what arrived this month) rather than syncing plan state. A stat that
is a few minutes stale is fine; a command that times out is not.

### The two headers are the authentication

`/fabric/commands/run` is outside every `/api` guard and carries no cookie, by the platform's own
convention. `isPlatformCall` therefore checks **both** headers: the secret against our own, in
constant time, and the caller against exactly `omos:platform`.

That second check is not belt-and-braces. `omos:platform` is the one caller id **no app can ever
present**, because the colon is outside the charset app ids are validated against — so it is what
separates "the platform is asking" from "an app that learned our secret is asking through the
app-to-app broker", which is a different trust boundary sharing the `/fabric` prefix. The platform
refuses `commands` in `fabric.provides` for the same reason.

### The one conversation, and the thing that will bite

`appeal` is the only command that asks a follow-up, and it earns it: a treasurer will not remember
whether the appeal is called "Ramadan Appeal" or "Ramadan 2026". It accepts an argument on the first
message (`!donations appeal zakat`), answers immediately when there is only one appeal, and otherwise
posts a numbered list and keeps the exchange open with a token.

**The exchange can end without us** — three minutes idle, fifteen total, twelve turns, `cancel`, or
any new `!` command — with no notification; the answers simply stop arriving. The token therefore
carries a step name and an attempt counter and **nothing a later turn needs in order to be correct**.
Because every command is read-only, there is nothing that could be left half-applied either; that is
the strong form of the same guarantee, and it is a reason to keep commands read-only even if a
tempting write one is proposed later.

Two smaller decisions inside it:

- **The appeal list is re-derived on the second turn, not encoded in the token.** 128 characters will
  not hold a dozen campaign ids, and the failure it guards against — the admin reordering their
  appeals inside a three-minute window — is both vanishingly rare and *visible*, because **the reply
  always names the appeal it is reporting on.**
- **A miss re-asks once with `ok:true`, then gives up with `ok:false`.** Any `ok:false` ends the
  exchange, so it is the right answer for "I give up" and the wrong one for "try again" — but
  re-asking for ever would leave a confused sender captured until the platform's timeout, with their
  ordinary conversation being read as answers.

## Notification settings live in this app (v0.43.0)

Six events, three channels each, chosen per event: the OpenMasjidOS alert, a specific email address,
and a WhatsApp destination. One helper — `raise()` in `index.ts` — is the only door any of it leaves
through, and `NOTIFY_ALERT_ID` beside `NOTIFY_EVENTS` is the only place an event's manifest alert id
is written down.

### Why the settings are here and not only in OpenMasjidOS

The platform's alerts matrix is good at exactly one thing: reaching **the admin's own** address. It
cannot email the treasurer, it cannot send anybody a WhatsApp message, we can never read what it is
set to (it is tRPC-only, behind the admin's session), and it is not where a masjid would look for
"tell Yusuf about refunds". So the platform keeps owning *delivery* and this app owns the *choice*.

That is also why the first channel is labelled **"your OpenMasjidOS inbox"** and never "email me". It
is an **AND** with the admin's matrix: ticking it means *we will raise this*, never *this will
arrive*. Worse, a `delivered: false` comes back with no reason, so not-routed, no-address-configured
and attempted-but-failed are indistinguishable — `disabled_by_admin` is the one honest signal, and the
per-row test reports it in those words. An admin who reads the tick as a guarantee stops looking for
the real switch, which is the failure this wording exists to prevent.

### `notify()` is gone

"A donation arrived" used to go out through `POST /api/fabric/notify`, which reaches the masjid's
**webhook only**. So the notification every masjid actually wants could never reach an inbox, however
the alerts matrix was set. Two new declared alert ids — `donation-received` and `donation-recovered` —
are what make "email is on by default" true rather than aspirational, and the alert channel then
strictly dominates the relay: same webhook, plus the admin's email, per event, with an admin on/off.
Keeping both would have posted twice to one webhook for one event, so the relay and its diagnostic
route were removed.

### The OS channel is on by default for every event, and the volume risk that comes with it

This was decided explicitly, against a raised objection, so the reasoning is worth keeping.

`donation` fires on every transaction, and the platform **defaults a newly-declared alert id to
email+webhook ON**, persisting only non-defaults — so a masjid updating into this gets an email per
donation without having asked, and during a Ramadan appeal that is hundreds. Alert mail is also
rate-limited on a bucket shared with the platform's own alerts and with this app's, so a flood of good
news can push `payment-failed` — *nobody can give at all* — behind it.

The decision was to keep the default consistent (every event on) and rely on **`minAmount`**, which is
why the donation row carries "only if it's at least…" beside its switches rather than in a sub-menu.
If a masjid reports being buried, that field — or turning that one row off — is the answer. Changing
the default is not, without saying so in a release note.

WhatsApp is the opposite and is not a matter of taste: **off for every event**, always. An update must
never begin sending messages from a masjid's phone number on their behalf.

### The WhatsApp switch is separate from the number

`whatsappOn` is its own boolean rather than "a non-empty number means on". Two reasons: an admin can
mute the channel for a month without losing what they typed, and a tick box gets to mean what a tick
box normally means. Both must be true to send, clearing the number also clears the switch (so a tick
never sits beside an empty field), and a row written before the switch existed reads a stored number
as **on** — otherwise the upgrade that added the switch would have silently stopped the very messages
it was meant to make clearer.

### Two floods that were already there

`alertAccountRefusal` had a once-per-campaign-per-day guard. The two **intent-failure** sites had
nothing at all — one notification per failed attempt, from an unauthenticated public endpoint. That
was survivable at one channel and is not at three, so both are capped at one an hour. The email
channel also shares this app's mail budget with **donor receipts and refund notices**, and the refund
notice deliberately has no outbox — so it is what a flood would silently lose. That is the second
reason the per-donation event is opt-in.

### What the recipients may see

`raise()`'s `title` and `text` are read by somebody **outside** the masjid's admin account, whom the
platform never vetted. No body names a donor — §13 and §11.3 already required that, and this channel
makes it load-bearing for a third party. Adding `${donorName}` to a title would be the leak. The
audit line records counts only, never an address and **not a masked number either**: in a small
community the last two digits still name somebody.

### Refuse, never repair — including a leading zero

An address must be exactly one address: the platform's own check is a strict single-address regex and
a comma list comes back `bad_recipient`, which `raise()` swallows, so an admin who types
`treasurer@x, chair@x` would get total silence. And a number keeps the country-code rule, now with the
check that makes the error message honest: **a leading zero is a national trunk prefix, never a
country code.** The length floor alone accepts `07700900123` — eleven digits — and the platform would
address it as `07700900123@c.us`, somebody else's number or nobody's. Found by probing the live route,
not by reading the code.
