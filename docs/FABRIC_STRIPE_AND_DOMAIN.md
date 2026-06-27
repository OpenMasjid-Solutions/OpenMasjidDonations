<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Adopt the OS Fabric for Stripe + public URL (stop managing your own)

> **Status: IMPLEMENTED.** Stripe-via-Fabric shipped in **v0.16.0**; the public-URL /
> base-path capability (`domain: true`) shipped in **v0.17.0**. For `domain`: `manifest.yaml`
> sets `domain: true`; the server fetches `GET /api/fabric/site` (`server/src/fabric.ts`
> `fetchFabricSite`, cached/last-good/fail-soft, never persisted) and is **base-path aware** —
> Fastify `rewriteUrl` strips the admin-chosen prefix (e.g. `/donate`) that Cloudflare
> forwards, and `index.html` is served with an injected `<base href>` + `window.__OMOS_BASE__`
> (Vite `base:'./'`). The web reads the base (`web/src/base.ts`) and prefixes API/nav/asset
> URLs; share links, QR codes and the Stripe webhook URL use the Fabric `publicUrl`. The
> in-app Cloudflare tunnel remains only as the **standalone fallback**. Verified end-to-end
> against the real built UI by `scratchpad/verify-domain.mjs`.

**Status (original brief):** ready to integrate. Platform support is live — **Stripe vault (OpenMasjidOS v0.29.0)**
and **Cloudflare Tunnel / remote access (v0.30.0)**.
**Why:** the admin now configures Stripe **once** in OpenMasjidOS (Settings → Payments) and runs the
tunnel/domain **once** (Settings → Remote access). Every app shares them via the Fabric — so the
admin never re-enters keys per app, and the values are backed up / migrated with the platform. The
Donations app currently stores its **own** Stripe accounts (`server/src/index.ts` ~line 360) and its
**own** Cloudflare token (~line 331); both should move to the Fabric, keeping the local versions only
as a **standalone fallback** (when the app runs without OpenMasjidOS).

> Keep all existing behaviour working standalone. The rule is: **if the Fabric is present, prefer it;
> otherwise use your own local config.** Never persist Fabric-fetched secrets/URLs to `db.json`.

---

## 1. Stripe — `stripe: true`

**Manifest:** add `stripe: true` (the platform issues your per-app `OPENMASJID_APP_SECRET`). You also
already set `https: true` — keep it. Add an install setting so the admin picks **which** named account
this app uses:

```yaml
# manifest.yaml
stripe: true
settings:
  - key: STRIPE_ACCOUNT
    label: Which Stripe account (name it in OpenMasjidOS → Settings → Payments)
    type: text
```

**Backend — fetch the keys instead of reading your own store when the Fabric is present:**

```ts
// server→server. Returns { id, label, publishableKey, secretKey, webhookSecret }.
async function fabricStripe() {
  if (!config.omosBaseUrl || !config.omosAppSecret) return null; // standalone → use local store
  const r = await fetch(
    `${config.omosBaseUrl}/api/fabric/stripe?account=${encodeURIComponent(process.env.STRIPE_ACCOUNT ?? '')}`,
    { headers: { 'x-openmasjid-app-secret': config.omosAppSecret }, redirect: 'error' },
  );
  if (!r.ok) return null;
  return r.json(); // cache in memory briefly; DO NOT write to db.json
}
```

Use these keys for charges (`secretKey`), the client (`publishableKey`), and webhook signature
verification (`webhookSecret` — your existing `constructWebhookEvent(...)` at ~line 812). Where you
read your local account today, try `fabricStripe()` first and fall back to the local account.

## 2. Public URL — `domain: true`

Card flows need **absolute** URLs that work from outside the LAN: Stripe `success_url` / `cancel_url`,
the **public webhook endpoint** you register with Stripe, and QR codes to the donation page. Ask the
platform instead of guessing the host:

```yaml
# manifest.yaml
domain: true
```

```ts
// → { enabled, domain, publicUrl }  e.g. publicUrl = "https://omos.example.org/donations"
async function publicBase(req) {
  if (config.omosBaseUrl && config.omosAppSecret) {
    const r = await fetch(`${config.omosBaseUrl}/api/fabric/site`,
      { headers: { 'x-openmasjid-app-secret': config.omosAppSecret }, redirect: 'error' });
    if (r.ok) { const s = await r.json(); if (s.enabled && s.publicUrl) return s.publicUrl; }
  }
  return originFromRequest(req); // fallback: build from the incoming request host (today's behaviour)
}
```

Then `success_url = `${base}/thank-you``, the Stripe webhook URL = `${base}/webhook`, QR target = `base`.

## 3. Retire the self-managed copies (later)

Once the Fabric paths are in and tested, you can drop the app's own **Stripe account UI** and
**Cloudflare token UI** — or leave them as the standalone fallback. Don't remove them until the Fabric
versions are confirmed working on a real OpenMasjidOS install.

## Also read

- `docs/RESTORE_SSO_FIX.md` in this repo — the **sign-in lockout** fix (required; same class of bug).
- OpenMasjidAPPS `docs/BUILDING_AN_APP.md` §7 — the canonical Fabric contract for `stripe` + `domain`,
  and the **Restore & migration resilience (REQUIRED)** rules (read env at runtime, never persist it).
