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
contract: `students/billing` v1 in `OpenMasjidStudentManager/docs/FABRIC_BILLING_CONTRACT.md` §11
(mirrored locally in `docs/STUDENTS_INTEGRATION.md`).

- **Transport (`server/src/students.ts`).** We POST `${OPENMASJID_BASE_URL}/api/fabric/app/students/billing/<method>`
  with **our own** per-app secret; the OS core verifies our manifest declares
  `fabric.consumes: [students/billing]` (string form — the APPS catalog validator + OS `parseFabric`
  require it) and proxies to Students. `brokerCall` NEVER throws, 10 s timeout, and NEVER logs the
  body (the PIN + family data). Every broker error → `unavailable` → the tuition campaign hides
  itself / shows a friendly notice (fail-soft doctrine). `info` is cached ~5 min.
- **No client trust (the security core).** On a successful `lookup` we stash the family + its open
  invoices in a **server-side session** (in-memory, 15 min, 128-bit id); the browser gets only display
  data + the opaque id — never the internal family/student ids. At pay time the client sends the
  session id + which invoices (or "full"); `computeTuitionAmount` (pure, unit-tested) recomputes the
  amount **and** the familyId server-side, so a crafted request can't attribute a charge to an
  arbitrary family or pay a tampered amount. The PIN/name are body-only, never in a URL/log/metadata.
- **Separate ledger (`student_payments` table).** Tuition payments are **not donations** — a distinct
  table, never joined into `metrics()`/`listDonations()`/`raisedForCampaign()`/the CSV, so they are
  excluded from every donation total, goal and year-end letter by construction (locked by a test).
  Tuition has **no card-fee** (`deriveFees` forces both flags off) — the parent pays the exact school
  balance; a gross-up would overpay an invoice and break Students' allocation.
- **Record + durable outbox.** The PaymentIntent carries §11.3 metadata (`purpose=students-billing`,
  `omos_app=donations`, `students_family_id`, optional `students_student_id`; description
  `School balance — <label>`). On confirm/webhook we **retrieve** the PI (never trust the client) and
  push `record-payment` (idempotencyKey = the PI id). A dropped response leaves `record_status:pending`;
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
