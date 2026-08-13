<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# The OpenMasjidOS Fabric, as this app uses it

The **Fabric** is the platform↔app integration layer. Every part of it is **optional and
backwards-compatible**: with no platform present the app runs fully standalone — its own login, its
own Stripe keys, its own appearance, its own tunnel. When the platform *is* present, prefer it. The
canonical spec is OpenMasjidAPPS `docs/BUILDING_AN_APP.md` §7; this page records what Donations
actually does.

**Wire identifiers (never rename):** env `OPENMASJID_BASE_URL`, `OPENMASJID_APP_ID`,
`OPENMASJID_APP_SECRET`; header `X-OpenMasjid-App-Secret`; cookie `omos_session`.

**Golden rule:** read those env vars **every process start**, and never persist them — or anything
fetched with them — to the data volume. The platform changes them across restarts and migrations, so
a cached copy is how you brick a panel after a restore (see [`RESTORE_SSO_FIX.md`](RESTORE_SSO_FIX.md)).
The one thing it *is* fine to persist is a non-secret **id**, such as which vault account was chosen.

Everything below lives in [`server/src/fabric.ts`](../server/src/fabric.ts) unless noted. Every
outbound call sets `redirect: 'error'` (so a redirect cannot walk us to some other internal host) and
a 3–8 second `AbortController` timeout, and **never throws** — a Fabric failure must never be able to
stop a donation.

## What the manifest declares

```yaml
sso: true            # sign in with the dashboard login
notifications: true  # relay "a donation was received" to the masjid's webhook
https: true          # Stripe's Payment Element needs a secure context
stripe: true         # fetch vaulted Stripe keys from the OS               (v0.16.0)
domain: true         # learn our public URL + base path                     (v0.17.0)
email: true          # send a donor a receipt through the OS provider       (v0.29.0)
alerts:              # five declared ids, each routable to email/webhook    (v0.27.0)
  - payment-failed | tuition-record-failed | donation-refunded | plan-stopped | test
fabric:
  consumes:
    - students/billing   # tuition, via the app-to-app broker               (v0.26.0)
# NO `settings:` block — install is one-click, with no dialog. Everything is
# chosen inside the app.
```

## 1. Single sign-on

Forward the request's `omos_session` cookie (read **only** from the incoming `Cookie` header — never
a query, header or body) to `GET ${OPENMASJID_BASE_URL}/api/auth/session` with the app secret. The
platform is identity-bound and fails closed. On `authenticated: true` we mint our own short-lived
local session (1 hour, against 30 days for a password login) so every other route stays a cheap
synchronous cookie check; positive results are cached ~45 s.

`probePlatform` returns `reachable` as well as `username`, and the difference matters: "you are not
signed in" and "OpenMasjidOS is unreachable" need different screens, and conflating them is what
locks an admin out after a restore.

## 2. Appearance

The dashboard appends `#omos=<base64url(JSON)>` on open; the web reads it, applies and persists it,
then clears the hash. While embedded it polls `GET /api/public/appearance` — through **our** server
(`/api/public/appearance` here relays it), because our page is HTTPS and the platform's endpoint is
plain HTTP, so a direct browser fetch would be blocked as mixed content. The fragment is untrusted
presentation input and is sanitised before use (`web/src/prefs.ts`, `Scene` in `web/src/ui.tsx`).

## 3. Notifications and alerts — two different things

- **`POST /api/fabric/notify`** — the masjid's configured **webhook** only. Used for ordinary news:
  "a donation of £50 was received".
- **`POST /api/fabric/alert`** — a **declared** alert id. The admin chooses per alert, in
  OpenMasjidOS → Settings → Alerts, whether it goes to email, webhook, both or nowhere. This is the
  **only** way the app can reach the admin's own email address, which it never learns.

So an alert id must exist in `manifest.yaml` or the platform refuses it, and `disabled_by_admin` is a
normal answer, not an error.

## 4. Stripe keys from the vault

See [`FABRIC_STRIPE_AND_DOMAIN.md`](FABRIC_STRIPE_AND_DOMAIN.md) — the account picker, the
per-account cache, why a 429 must not be cached, and how per-appeal accounts resolve.

## 5. Public URL + base path

Also in [`FABRIC_STRIPE_AND_DOMAIN.md`](FABRIC_STRIPE_AND_DOMAIN.md). The short version: read
`basePath` from `GET /api/fabric/site`, never hardcode it, and strip the prefix before routing
because Cloudflare forwards the full path. [`REMOTE_ACCESS_INGRESS.md`](REMOTE_ACCESS_INGRESS.md)
covers the admin's side of it.

## 6. Email

`POST /api/fabric/email` with `{ to, subject, text, html? }`. The masjid sets up one provider (SMTP
or Resend) once; this app never sees the credentials or the From address. `not_configured` is a
normal answer — the donation is still recorded and thanked on screen, and Stripe's own receipt
covers the donor.

The subject is flattened of CR/LF before sending, because the platform turns it into a real mail
header. Whether the platform *also* sanitises it independently is
[`audit/ACTION_REQUIRED.md`](audit/ACTION_REQUIRED.md) §3a.

## 7. The app-to-app broker (tuition)

`POST ${OPENMASJID_BASE_URL}/api/fabric/app/students/billing/<method>`, server→server with our
per-app secret. The `consumes` grant here plus the target's matching `provides` are what let the OS
broker route the call; without both, every call is `403 not_granted`. Fails soft in the strongest
sense: any broker error hides the tuition campaign entirely and the donation site carries on.
See [`STUDENTS_INTEGRATION.md`](STUDENTS_INTEGRATION.md).

## What is deliberately still local

The app's own **Cloudflare tunnel** and its own **Stripe accounts** are not dead code awaiting
removal — they are the standalone path, and a masjid running this app without OpenMasjidOS depends on
them. When embedded, the in-app tunnel is force-stopped at boot so two tunnels never race, and the
local Stripe accounts sit behind the vault unless an appeal names one explicitly.
