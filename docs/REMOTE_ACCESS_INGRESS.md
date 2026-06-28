<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Remote-access path ingress — IMPLEMENTED platform-side

**TL;DR:** OpenMasjidOS **v0.37.0** now reverse-proxies each app's path to its container, so the
public donation link works through one Cloudflare route. No manual Cloudflare per-app rules needed.
Donations already does the right thing (you strip the prefix via `rewriteUrl` + inject `<base href>`),
so it keeps working — just confirm the points below.

## What the platform now does

- The admin adds **ONE** Cloudflare Public Hostname: `omos.<domain>` → **HTTP `localhost:<OS port>`**.
- The OS front door **reverse-proxies by first path segment** to the matching app's **`ports[0]`**
  (`system/ingress.ts`, v0.37.0), **keeping the full path** (no strip), HTTP + WebSocket.
- `https://omos.<domain>/donate/...` → Cloudflare → OS front door → your container at `/donate/...`.
- `GET /api/fabric/site` returns `{ publicUrl, basePath }`; `basePath` is the **admin-chosen path**
  (default your id `donations`, but they may set `donate`). **Read it — don't hardcode.**

## What Donations must do (you already do)

1. **Be base-path aware.** The OS forwards the full prefix; your `rewriteUrl` strip + `<base href>`
   handle it. Good — keep it.
2. **Build absolute URLs from `publicUrl`** for the Stripe `success_url`/`cancel_url`, the **webhook
   endpoint** you register with Stripe, and QR codes — these must be the public `omos.<domain>/<path>`,
   not the LAN host, when remote access is on.
3. **Secure context for Stripe:** Cloudflare terminates TLS, so the browser sees `https://` even though
   the OS proxies to your container over HTTP — Stripe Elements works. Trust `X-Forwarded-Proto` for
   any server-side "am I https" checks.

## Acceptance test

With remote access on + Donations installed + the single Cloudflare route:

```
curl https://omos.<domain>/<basePath>/            →  the donations page
curl https://omos.<domain>/<basePath>/api/...      →  your API
```

(`<basePath>` = `/api/fabric/site`'s value. 404? Confirm the path in **Settings → Remote access**.)

## Getting a 502 from `omos.<domain>`?

The single Cloudflare route's **Service Type must be HTTP** (URL `localhost:<OS port>`, default 80) —
that's the OS plain-HTTP front door. **HTTPS** there makes cloudflared do TLS against a non-TLS port →
**502**, and every app's path-routing probe then fails. Set Type **HTTP**; "No TLS Verify" isn't needed.
(Stripe still gets its secure context — Cloudflare serves the public side over HTTPS.)

## To pick it up

Admin: update OpenMasjidOS to **v0.37.0**; **Settings → Remote access** shows the one route to add +
each app's address. Remove any old per-app Cloudflare routes in favour of the single route.

See also `docs/USING_THE_FABRIC.md` (Stripe vault + `/api/fabric/site`).
