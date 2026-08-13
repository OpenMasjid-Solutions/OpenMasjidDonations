<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Vaulted Stripe keys and the public URL

> **Status: shipped.** Stripe-via-Fabric in **v0.16.0**, the account picker in **v0.19.0**, the
> public-URL / base-path capability (`domain: true`) in **v0.17.0**, per-appeal accounts in
> **v0.42.0**. This page is a short record of *what the app does and why*; the original
> implementation brief it replaced had drifted far enough to be misleading (it still proposed an
> install setting that was never shipped, and pointed at line numbers that had moved by hundreds).

The problem both capabilities solve is the same one: a masjid should configure a thing **once, in
OpenMasjidOS**, and every app should share it — so keys are never re-pasted per app, and they are
backed up and migrated with the platform rather than stranded on one app's data volume.

## Stripe — `stripe: true`

The admin stores named Stripe accounts once in **OpenMasjidOS → Settings → Payments**. This app:

1. lists them for its own Payments screen — `GET /api/fabric/stripe/accounts`, returning
   `{ accounts: [{ id, label }] }` and **never** keys;
2. remembers which one the admin picked (the **id**, which is not a secret, in `kv`);
3. fetches that account's keys when it needs them — `GET /api/fabric/stripe?account=<id>` →
   `{ id, label, publishableKey, secretKey, webhookSecret }`.

Both calls are server→server with `X-OpenMasjid-App-Secret`, `redirect: 'error'`, and a 4-second
timeout. See `server/src/fabric.ts` (`fetchFabricStripeAccounts`, `fetchFabricStripeDetailed`).

Four rules, each with a failure behind it:

- **The keys are cached in memory and never written to the data volume.** A persisted copy would
  survive a restore onto a new machine and permanently shadow the real vault account.
- **There is no `STRIPE_ACCOUNT` install setting.** An earlier draft of this document proposed one;
  it was never shipped, because the manifest declaring *any* `settings:` block turns a one-click
  install into a dialog. The account is chosen inside the app instead.
- **A non-ok response is split by status.** `404`/`403` is the platform answering "no such account"
  and is cached; `429`/`5xx`/a transport failure is *no information*, so we serve the last good copy
  (10 minutes) and do not cache. Conflating them turns one rate-limited request into a donation
  outage — the Fabric budget is shared with every other app on the box.
- **Local keys remain the standalone fallback**, and since v0.42.0 an appeal may name either kind
  explicitly. See `docs/ARCHITECTURE.md` → *Per-appeal Stripe accounts*.

## Public URL + base path — `domain: true`

Card flows need absolute, internet-reachable URLs: the webhook endpoint the masjid registers with
Stripe, QR codes for the door, and the stop link in a monthly donor's email. Ask the platform rather
than guessing from a `Host` header (which is attacker-controlled, and absent in a background job):

```
GET /api/fabric/site  →  { enabled, domain, publicUrl, basePath }
```

`basePath` is the **admin-chosen** first path segment (default the app id, but they may set
`donate`) — read it, never hardcode it. Cloudflare and the OS front door forward the **full** path
without stripping the prefix, so the server is base-path aware: Fastify's `rewriteUrl` strips it
before routing, and `index.html` is served with an injected `<base href>` plus
`window.__OMOS_BASE__` for the web app (`web/src/base.ts`). When `enabled` is false the app falls
back to its own Cloudflare tunnel, and failing that reports no public address at all — which callers
must handle honestly rather than emit a LAN URL a stranger cannot resolve.

## See also

- [`USING_THE_FABRIC.md`](USING_THE_FABRIC.md) — every Fabric capability this app uses.
- [`REMOTE_ACCESS_INGRESS.md`](REMOTE_ACCESS_INGRESS.md) — the single Cloudflare route, and the
  502 that a wrong Service Type causes.
- [`RESTORE_SSO_FIX.md`](RESTORE_SSO_FIX.md) — the sign-in lockout this work grew out of.
- OpenMasjidAPPS `docs/BUILDING_AN_APP.md` §7 — the canonical Fabric contract.
