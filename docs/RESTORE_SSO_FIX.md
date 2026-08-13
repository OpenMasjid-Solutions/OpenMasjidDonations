<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Bug: the panel locks you out after an OpenMasjidOS backup is restored / the box is migrated

> **Status: FIXED in v0.16.0.** Both fixes below are implemented. What shipped, precisely:
>
> **Fix #1 — never brick.**
> - `GET /api/session` now returns `sso: { enabled, reachable, username }`. `reachable` is
>   false only when SSO is configured but the platform couldn't be contacted
>   (`server/src/fabric.ts` `probePlatform` / `platformReachable`).
> - `POST /api/setup` no longer hard-`403`s whenever SSO is configured. The local password
>   is allowed as a recovery when SSO is **not configured** *or* the platform is **currently
>   unreachable**; it is still refused (with a friendly "sign in through OpenMasjidOS"
>   message) only when the platform **is reachable** — which both keeps the panel
>   un-brickable *and* closes the pre-setup window where a LAN passer-by could otherwise
>   claim the admin password before the real admin.
> - The web admin (`SsoGate` in `web/src/admin.tsx`) leads with a "Can't reach OpenMasjidOS
>   — Try again / Set a password to get in" recovery when `reachable` is false, instead of
>   dead-ending on "open from the dashboard".
> - `OPENMASJID_BASE_URL` / `OPENMASJID_APP_SECRET` are still read from env every start and
>   never persisted (`server/src/config.ts`).
>
> **Fix #2 — Stripe via the Fabric.** `manifest.yaml` sets `stripe: true`. The server fetches
> the vaulted keys server-to-server (`server/src/fabric.ts` `fetchFabricStripe`, in-memory
> cache only, never persisted), and `resolveAccountFor` / `accountById`
> (`server/src/index.ts`) use the Fabric account when it's configured, falling back to
> locally-entered keys when the Fabric is absent or unreachable. Confirm-on-return resolves
> the account by the donation's recorded id (never re-resolves), so a config/reachability
> change can't strand a payment. The admin Payments screen shows "Connected through
> OpenMasjidOS" instead of asking for keys.
>
> **Superseded in two places since.** The `STRIPE_ACCOUNT` install setting this brief proposed
> was never shipped — the manifest declares **no** `settings:` at all and the account is chosen
> in-app (v0.19.0), which is what keeps install one-click. And the account resolver was
> rewritten in **v0.42.0** so each appeal may name its own account; `effectiveAccountFor` no
> longer exists. See `docs/ARCHITECTURE.md` → *Per-appeal Stripe accounts*.
>
> Cloudflare/domain was also taken over by the platform in v0.17.0 (`domain: true`); the app's
> own tunnel is now only the standalone fallback. See `docs/REMOTE_ACCESS_INGRESS.md`.

**Severity:** high (no way into the admin panel until fixed).
**Where:** `server/src/index.ts` — `GET /api/session` and `POST /api/setup`.
**Applies to:** any OpenMasjidOS-integrated app; the same trap exists in OpenMasjid Display.

---

## Symptom

After the admin restores an OpenMasjidOS backup (especially onto a **new machine**), opening the
Donations admin shows the OpenMasjidOS sign-in screen, but SSO never completes and **"Set a password
instead"** fails with **"This panel signs in through OpenMasjidOS."** → no way in.

## Root cause

The local-password path is gated on `ssoConfigured()`:

```ts
// server/src/index.ts
needsSetup: !store.hasAdmin() && !ssoConfigured(),                  // /api/session (~169)
...
if (ssoConfigured()) return reply.code(403).send({ error: 'This panel signs in through OpenMasjidOS.' }); // /api/setup (~182)
```

`ssoConfigured() = !!omosBaseUrl && !!omosAppSecret` (platform-injected env). After a restore those
env vars are still set, so `ssoConfigured()` stays `true` — but the SSO probe
(`GET ${OPENMASJID_BASE_URL}/api/auth/session`) **fails** when the platform is unreachable (the OS
injected the **old machine's IP** after a migration, or the platform is briefly down). SSO can't
complete **and** local setup is refused → bricked.

> Platform-side migration fix shipped in **OpenMasjidOS v0.27.0** (re-resolves `OPENMASJID_BASE_URL`
> to the current machine on restore) + **v0.28.0** ("Reset sign-in" recovery). Ask the admin to update
> OpenMasjidOS — **but the app must still never brick** when the platform is momentarily unreachable.

## Fix #1 — never let the panel get bricked (do this)

> ⚠️ **Read this before the numbered list.** The original brief said "drop the `403` in
> `/api/setup`" outright. **That is wrong and shipping it would be a permanent unauthenticated
> takeover.** Under SSO the local admin is never set, so `hasAdmin()` stays false for ever and an
> unguarded `/api/setup` never closes — anyone who can reach the box could claim the panel, the
> Stripe keys and the donor ledger, at any time, for the life of the install. What actually shipped,
> and what must stay, is the **narrower** guard in step 1 below: refuse only while the platform is
> *reachable*. It is listed in `CLAUDE.md` §13 as a security invariant.

1. **Allow the local-password recovery when — and only when — SSO cannot sign you in.** Keep the
   `if (admin exists) 409` guard, and refuse the anonymous claim with a 403 whenever SSO is
   configured **and `probePlatform()` says the platform is reachable**. Allow it when SSO is not
   configured at all (standalone) or the platform is currently unreachable. That is both
   un-brickable *and* closed to a passer-by on the LAN while the platform is up.
2. **Surface platform reachability** in `/api/session` (`sso: { enabled, reachable, username }`) so
   the web app can show "Can't reach OpenMasjidOS — [Retry] or [Set a password to get in]" instead of
   a dead loop.
3. **Never persist `OPENMASJID_BASE_URL` / `OPENMASJID_APP_SECRET` to the data volume** — read them
   from `process.env` every start (your `config.ts` already does; keep it). The platform changes the
   base URL across restarts/migrations, so a cached copy would re-introduce this bug.

The residual risk — that the escape hatch is open to anyone during a genuine platform outage — is
recorded as DONATIONS-005 in [`audit/ACTION_REQUIRED.md`](audit/ACTION_REQUIRED.md) §4a, with a
recommendation (make abuse loud rather than closing the hatch) awaiting a decision.

### Verify

Run with `OPENMASJID_BASE_URL=http://10.255.255.1` (unreachable) + any `OPENMASJID_APP_SECRET` →
you must still be able to get in via **"Set a password instead."**

## Fix #2 — move Stripe (and Cloudflare) into the OS Fabric

> **Done.** Kept here as the record of why. The current, accurate description is
> [`FABRIC_STRIPE_AND_DOMAIN.md`](FABRIC_STRIPE_AND_DOMAIN.md) — read that instead of the sketch
> below, which proposes a `STRIPE_ACCOUNT` install setting that was deliberately never shipped.

At the time, Donations stored its **own** Stripe accounts and Cloudflare-tunnel token. The platform
now centralizes both so the admin configures them **once in OpenMasjidOS** and every app shares them
— and they're backed up/migrated with the OS, not per-app.

**Stripe via the Fabric (available now — OpenMasjidOS v0.29.0):**

- Set `stripe: true` in `manifest.yaml` → the platform issues this app the per-app secret.
- Add an install setting like `STRIPE_ACCOUNT` (the account *name* the admin picks for this app).
- At runtime fetch the keys instead of storing them:

  ```ts
  // server→server; the per-app secret proves identity. Returns:
  //   { id, label, publishableKey, secretKey, webhookSecret }
  const res = await fetch(
    `${config.omosBaseUrl}/api/fabric/stripe?account=${encodeURIComponent(process.env.STRIPE_ACCOUNT ?? '')}`,
    { headers: { 'x-openmasjid-app-secret': config.omosAppSecret }, redirect: 'error' },
  );
  ```

  Keep your existing local Stripe fields as the **standalone fallback** (when `ssoConfigured()` is
  false). When the Fabric is present, prefer the Fabric account; don't store the fetched secret keys in
  `db.json` (fetch per process start / cache in memory only) so they always track the OS vault.

**Cloudflare/domain:** the platform is taking over the Cloudflare tunnel + domain (path-based, e.g.
`omos.xyz.org/donate`). Once that ships, the app won't need its own tunnel token — it'll just be
reachable at its assigned path. Until then your local tunnel still works; no rush to remove it, but
plan to drop it.

See the OpenMasjidAPPS contract (`docs/BUILDING_AN_APP.md` → Fabric capabilities + Restore resilience)
for the canonical spec.
