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

## 7. WhatsApp — `whatsapp: true` (platform v0.51.0+)

The masjid installs the **OpenWA** gateway from the App Store and links **their own** phone number.
We never see the gateway, its URL, its key, or which number is linked: we POST to the platform and
it does the sending, which is the only way the anti-ban pacing can be enforced across every app at
once.

**In this app WhatsApp is an admin channel.** The masjid's own numbers (or an approved group) are
entered on our Settings screen and they choose which donation events go out. We never collect a
donor's phone number, so there is nothing here that could message one. That choice lives here
because the platform's alerts matrix deliberately has **no WhatsApp column** for an app — it routes
to the admin's one number, whereas an app's messages are usually for donors.

```
GET  /api/fabric/whatsapp          → { available, reason, media, maxMediaBytes }
GET  /api/fabric/whatsapp/groups   → { groups: [{ id, label }] }
POST /api/fabric/whatsapp          → 202 { queued: true }
       { "to": "447700900123", "text": "…" }   // or { "group": "…@g.us", … }
```

Three things about this contract are easy to assume wrongly, and each fails **silently** — the app
looks fine and simply never messages anybody. `server/src/whatsapp.test.ts` pins all three:

| | |
|---|---|
| **Groups** | `{ groups: [...] }`, **not** a bare array. Parsing it as an array yields nothing, so the picker is empty and the admin concludes no groups were approved. |
| **`reason`** | Always a word, never `null` — it is **`"ready"`** when available. It is one of `ready`, `not-configured`, `not-linked`, `unreachable`, and each needs a different sentence because each has a different fix. |
| **`media`** | **Absent means no.** An older platform omits the field, and reading absence as yes means base64-ing half a megabyte into a request that was never going to work. |

And two rules the channel itself imposes:

- **`202 {queued:true}` is the only success, and it means queued — never sent.** Ban risk attaches to
  the *number*, so the platform paces everything: randomised 6–20s gaps, per-recipient cooldowns,
  hourly and daily caps shared with every other app, and quiet hours that defer rather than drop.
  There is no delivery receipt. Nothing may block on it, and the panel says "queued", not "sent".
- **Nothing auth-critical, ever.** It is an unofficial client and the number can be restricted or
  banned. Every event we send over it has already gone out by email or webhook; WhatsApp is a second
  copy, never the only one.

A number is normalised with `toWhatsAppDigits`, which mirrors the platform's own rule: strip to
digits, require 8–15, and **refuse a number with no country code rather than guessing one** — a
guess would send the masjid's donation figures to whoever holds that number in the default country.
A group id is only ever taken from the approved list and re-verified before it is saved; an
unapproved one is a 403 at the platform, which would otherwise surface silently at send time.

Images (`media`) are supported by the contract and **not used here** — an admin notification is a
sentence. The capability check is still read honestly, so adding one later is a small change.

## 8. Admin commands (`commands:`, platform v0.51.0+)

An authorised admin messages the masjid's number — `!donations` — and the platform renders the
numbered menu, decides who may run what, and POSTs the chosen one to **our** web port:

```
POST /fabric/commands/run
  X-OpenMasjid-App-Secret: <our OWN OPENMASJID_APP_SECRET>
  X-OpenMasjid-Caller-App: omos:platform
  { "command": "appeal", "text": "zakat", "requestId": "…", "locale": "en", "followUpToken": "…" }

→ { "ok": true,  "text": "…" }                       done
  { "ok": true,  "text": "…", "followUp": { "token": "…" } }   ask one more thing
  { "ok": false, "error": "…" }                      failed, and we can say why
  404 { "ok": false, "code": "unknown_command" }
  503 { "ok": false, "code": "not_ready" }
```

**Note the path.** `/fabric/*`, not `/api/*` — LAN-only, never served over the tunnel, and outside
every `/api` guard. There is no cookie: **the two headers are the authentication**, so both are
checked and the secret is compared in constant time. `omos:platform` is the one caller id no app can
present, since the colon is outside the charset app ids are validated against — which is also why
`commands` must never go in `fabric.provides` (the platform refuses it at install: it would let
another app reach this same handler through the broker).

The five we declare are **stats, and nothing else**: `today`, `month`, `totals`, `appeal`,
`monthly`. Read-only and aggregate, on purpose — see `docs/ARCHITECTURE.md` → *Admin commands*.

### Holding a conversation

Return `followUp.token` and the platform treats the sender's next message as an answer — no `!`
prefix — and posts it back with that token. The token is ours; the platform stores it against that
one sender and keeps no other state. Charset `A-Za-z0-9._:-`, ≤128 characters, validated before it
is echoed because it lands in a later request body.

**The exchange can end without us** — three minutes idle, fifteen minutes total, twelve turns, the
sender typing `exit`/`cancel`/`done`, or starting any new `!` command. We are not told; the answers
simply stop. So never leave anything half-applied waiting on a reply that may not come. Here that is
free, because every command is read-only.

Any `ok:false` also ends the exchange, so it is the right answer for "I give up" and the wrong one
for "try again" — the `appeal` picker re-asks once with `ok:true` and only then gives up.

## 9. The app-to-app broker (tuition)

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
