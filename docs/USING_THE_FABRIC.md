<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# How to use the OpenMasjidOS Fabric (Donations)

The **Fabric** is the platform↔app integration layer. Everything here is **optional + backwards-
compatible**: when the platform isn't present the app runs fully standalone (own login, own keys, own
appearance). When it *is* present, prefer the Fabric. The canonical spec is OpenMasjidAPPS
`docs/BUILDING_AN_APP.md` §7.

**Wire identifiers (never rename):** env `OPENMASJID_BASE_URL`, `OPENMASJID_APP_ID`,
`OPENMASJID_APP_SECRET`; header `X-OpenMasjid-App-Secret`; cookie `omos_session`.
**Golden rule:** read those env vars **every process start**, never persist them or anything fetched
from the Fabric (keys, URLs) to `db.json` — the platform changes them across restarts/migrations.

## Capabilities Donations should declare (`manifest.yaml`)

```yaml
sso: true            # sign in with the dashboard login
notifications: true  # relay "new donation" alerts to the masjid's webhook
stripe: true         # fetch shared Stripe keys from the OS vault  (v0.29.0+)
domain: true         # learn the public URL for return/webhook/QR  (v0.30.0+)
https: true          # Stripe needs a secure context
settings:
  - key: STRIPE_ACCOUNT
    label: Which Stripe account (the name you gave it in OpenMasjidOS → Settings → Payments)
    type: text
```

## 1. Single sign-on (already implemented — keep it)

Forward the request's `omos_session` cookie to `${OPENMASJID_BASE_URL}/api/auth/session` with the
app secret; a `true` mints a local admin session. See `server/src/fabric.ts`. **Resilience fix
required** — never brick when the platform is unreachable: see `docs/RESTORE_SSO_FIX.md`.

## 2. Appearance (already implemented — keep it)

Match the dashboard's theme/wallpaper via the `#omos=` hash + `GET /api/public/appearance`.

## 3. Notifications

Relay a "new donation of £50" alert: `POST ${OPENMASJID_BASE_URL}/api/fabric/notify` with the app
secret + `{ text, title?, level? }`. Fails soft; never depend on it.

## 4. Stripe keys from the OS vault — `stripe: true`

The admin stores named Stripe accounts once in **Settings → Payments**; fetch the one this app uses
instead of storing your own:

```ts
// server→server. { id, label, publishableKey, secretKey, webhookSecret }
const r = await fetch(
  `${config.omosBaseUrl}/api/fabric/stripe?account=${encodeURIComponent(process.env.STRIPE_ACCOUNT ?? '')}`,
  { headers: { 'x-openmasjid-app-secret': config.omosAppSecret }, redirect: 'error' },
);
```

Use `secretKey` for charges, `publishableKey` for the client, `webhookSecret` for signature checks.
**Cache in memory only.** Keep your local Stripe fields as the standalone fallback (Fabric absent).

## 5. Public URL + base path — `domain: true`

Card flows need absolute, internet-reachable URLs (Stripe `success_url`/`cancel_url`, the webhook
endpoint, QR codes). The OS serves every app under **one subdomain `omos`** at a **path the admin
chooses** in OS → Settings → Remote access (defaults to the app id — e.g. they can set `donate`, giving
`https://omos.example.org/donate`). **Don't assume the path; read `basePath`:**

```ts
// { enabled, domain, publicUrl, basePath }   e.g. publicUrl="https://omos.example.org/donations", basePath="/donations"
const s = await (await fetch(`${config.omosBaseUrl}/api/fabric/site`,
  { headers: { 'x-openmasjid-app-secret': config.omosAppSecret }, redirect: 'error' })).json();
```

- `success_url = `${s.publicUrl}/thank-you``, Stripe webhook URL = `${s.publicUrl}/webhook`, QR → `s.publicUrl`.
- When `enabled` is false (no remote access, or opened directly on the LAN), fall back to the request host.

**IMPORTANT — be base-path aware.** Cloudflare forwards the full path (it does **not** strip the
prefix), so behind the tunnel your server receives requests under `basePath` (e.g. `/donations/...`).
Mount your routes and emit asset/link URLs under `basePath` (set your SPA's base href / router
basename from it). When `basePath` is `""`, serve at root as today. The admin's one-time Cloudflare
setup (subdomain `omos`, path, Service `HTTP localhost:<port>`) is shown to them in
**OpenMasjidOS → Settings → Remote access**.

## 6. Retire the self-managed Stripe + Cloudflare (after the Fabric paths are verified)

The app's own Stripe-account UI and Cloudflare-tunnel token become the **standalone fallback**; the
admin no longer touches them when running under OpenMasjidOS. Don't delete them until confirmed.

See also `docs/RESTORE_SSO_FIX.md` (required sign-in lockout fix).
