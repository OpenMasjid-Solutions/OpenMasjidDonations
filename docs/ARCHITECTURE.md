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

## Stripe (later slices)

- One-time donations must work with **no inbound webhook** (a masjid box is usually
  LAN-only): the server creates a PaymentIntent, the client confirms with the
  Payment Element, and on the donor's return the server **retrieves** the
  PaymentIntent to verify `succeeded` before recording it. Webhooks are an optional
  enhancement (recurring `invoice.paid`, resilience) for when the app is public.
- The **secret key is server-side only** — never sent to the browser, never logged,
  never committed. The browser sees only the publishable key.

## Build order (vertical slices)

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
9. Appearance/theming polish, animations, friendly errors.
10. README/screenshots/docs; tag `v0.1.0`; add the `registry.yaml` entry to
    OpenMasjidAPPS (move `donations` out of `coming_soon`).

## OpenMasjidOS Fabric: SSO, Stripe vault & restore resilience (v0.16.0)

The platform↔app integration ("Fabric") lives in `server/src/fabric.ts` and is always
optional — the app works fully standalone.

- **SSO** is server-to-server: `probePlatform()` validates the incoming `omos_session`
  cookie against `${OPENMASJID_BASE_URL}/api/auth/session`, presenting our per-app
  `OPENMASJID_APP_SECRET`. It returns `{ username, reachable }` — `reachable`
  distinguishes "not signed in" from "platform unreachable" so the panel can offer the
  local-password recovery instead of looping.
- **Stripe via the Fabric** (`stripe: true`): keys are configured **once** in OpenMasjidOS
  and fetched per-app with `fetchFabricStripe()` (the `STRIPE_ACCOUNT` setting names which
  vaulted account). They are cached **in memory only, never written to the data volume**, so
  they always track the OS vault — including after a restore onto a new machine. The
  resolvers `effectiveAccountFor()` (charging) and `accountById()` (webhook) prefer the
  Fabric account **only when it is fully configured**, otherwise fall back to locally-entered
  keys. Confirm-on-return resolves the account by the donation's **recorded** account id, so
  a config/reachability change between intent and confirm can't strand a succeeded payment.
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
  strategy:** Stripe's own `receipt_email` is suppressed **only** when our email is enabled *and*
  confirmed working (`emailStatus()==='ok'`), so a donor never ends up with zero receipts — until email
  is proven working, Stripe's receipt stays as the fallback; the state is self-correcting per donation.
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
