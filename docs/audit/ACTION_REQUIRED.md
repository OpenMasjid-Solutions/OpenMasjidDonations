<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Action required — only you can do these

From the 2026-08-03 security and code-health audit. Ordered by urgency.

> ### Where this stands as of 2026-08-18 (the v0.43.0 sweep)
>
> | Item | Status |
> |---|---|
> | §4g `@fastify/static` major upgrade (DONATIONS-040) | **Done.** 8.x → 10.1.3 in the v0.43.0 sweep, clearing all four advisories rather than continuing to argue they are unreachable. Verified by a real container start: the SPA, an asset, an uploaded image, the SPA fallback and a 401 all behave, and five traversal shapes (`../`, `%2e%2e`, `..%2f`, `%2e%2e%2f`, `....//`) return 404 with no file body. Both `npm audit` runs are now clean. |
> | §4a `/api/setup` during an outage (DONATIONS-005) | **Still your decision, but no longer unmetered.** The reachability probe on that route is now behind the same 120/min per-peer cap as the other two unauthenticated platform-callers; the trade-off between recovery and takeover is unchanged and still yours. |
> | §0a three-decimal currencies (DONATIONS-001) | **Fixed and shipped** in v0.39.0. Steps 1–4 below are still yours if any masjid runs BHD/JOD/KWD/OMR/TND — the fix does not rewrite historical rows. |
> | §0b lost one-time donations (DONATIONS-002) | **Fixed and shipped** in v0.39.0. The sweep runs every 10 minutes; expect the ledger to have grown. |
> | §1 credentials to rotate | Still none. Re-checked on 2026-08-13. |
> | §3c compose deviates from the spec (DONATIONS-049) | **Answered, not changed.** The deviations are deliberate and now documented once, with reasons, in [`../ARCHITECTURE.md`](../ARCHITECTURE.md) → *Where this app intentionally differs*; `CLAUDE.md` §10 was rewritten to describe the shipped files instead of contradicting them. The spec had drifted, not the app. |
> | §4f no CSP | **Still open.** Unchanged reasoning. |
> | §4d root container · §4e digest-pinned base images · §4h session revocation | **Still open**, all needing a real container start or an auth-model change. |
> | §4a `/api/setup` during an outage · §4b limiters behind the ingress · §4c anonymous de-anonymisation | **Still open** — these are the three decisions in §4 that are genuinely yours, and none has been made. |
>
> The 2026-08-13 sweep's own findings are in [`AUDIT_2026-08-13.md`](AUDIT_2026-08-13.md).

---

## 0. READ FIRST — money may have been mischarged

### 0a. Three-decimal currencies charge one tenth (DONATIONS-001)

**Do this before merging the money PR.**

If any masjid running this app is configured in **BHD, JOD, KWD, OMR or TND**, every donation it has
ever taken charged **one tenth** of the amount the donor was shown, while the local ledger recorded
the full amount. The app agreed with itself, so nothing looked wrong; only the Stripe dashboard has
the true figures.

**What I need you to do, in order:**

1. **Find out whether this is live.** Check each installation's configured currency (Settings →
   currency, or the `CURRENCY` / `MASJID_CURRENCY` env var). If none is one of those five, this is
   latent — merge the fix and move on.
2. **If any masjid IS in one of those five**, before merging: export their donation history from the
   **Stripe dashboard** and compare it with the app's CSV. Stripe is the truth. Expect app figures to
   be 10× the real amounts.
3. **Decide what happens to the historical rows.** The fix changes only future conversions; it does
   not rewrite stored amounts, so after merging, old rows (stored as 1/10 scale) and new rows (full
   scale) will mean different things in the same column. Options, all yours: leave them and annotate
   the period; or write a one-off migration multiplying affected rows by 10. **I have not written
   that migration** — it edits historical financial records and needs someone who can confirm the
   affected date range against Stripe first.
4. **Talk to the community if donors were undercharged.** A donor who gave "100 KWD" of Zakat paid
   10. That is a religious obligation they may believe is discharged. Whether and how to tell them is
   not a decision code should make.

Fix is written and tested on branch `audit/money-2026-08-03`, commit `91767c6`. Two-decimal
currencies are bit-identical — verified.

### 0b. One-time donations have been silently lost (DONATIONS-002)

A card payment that succeeded at Stripe while the donor's `/confirm` callback failed (closed tab,
lost signal, box briefly unreachable) was **never recorded, never receipted, and never counted**. The
row sits at `pending` for ever, indistinguishable from an abandoned checkout.

**What I need you to do:**

1. **Find out whether it has happened.** For each installation, compare succeeded PaymentIntents in
   Stripe against the app's ledger for the same period. Any Stripe `succeeded` intent with no
   corresponding donation is a lost donation. The app-side signal is a `pending` row more than a few
   minutes old.
2. **Expect the ledger to grow when the fix merges.** The sweep will find those payments and add
   them, backdated. Totals, the CSV, the trend chart and any Gift Aid claim will all increase. That
   is correct — the money did arrive — but if a masjid has already filed accounts or a Gift Aid claim
   on the old figures, they need to know before the numbers move.
3. **Expect receipt emails to go out** to donors whose payment was recovered and who never got one.
   Some may be months old. If that is not wanted, disable receipts in Settings before deploying, or
   ask me to gate the sweep's receipt behind an age limit.

Fix is written and tested on `audit/money-2026-08-03`, commit `8db58af`.

---

## 1. Credentials to rotate

**None found — and that is a real result, not an absence of looking.**

I searched all 107 commits on every branch for `sk_live`, `sk_test_51`, `pk_live_51`, `whsec_`,
`BEGIN PRIVATE KEY`, `BEGIN RSA`, `BEGIN OPENSSH`, and for any commit ever *adding* a file matching
`.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.sqlite`, `*.db`, or anything named like a dump or
backup. The only `whsec_` hits in the entire history are three commits' worth of UI labels, a form
placeholder and a validation regex. No credential has ever been committed to this repository.

**So there is nothing to rotate from this repo's history.** The credentials that exist at runtime —
Stripe secret and webhook keys, the Cloudflare tunnel token, the OpenMasjidOS per-app secret, the
admin password hash — live only in the SQLite file on each masjid's data volume, or in the platform
vault.

Two related items that are *not* rotations but are worth your attention:

- **Anyone with shell access to a masjid box can read the Stripe secret key.** It is stored in the
  SQLite database with `0600` perms, but the container **runs as root** (DONATIONS-015) and the app
  runs as root inside it, so the file perms protect against nothing that matters. Treat host access
  to a masjid box as equivalent to holding their Stripe key.
- **The Cloudflare tunnel token appears in the host process table** (DONATIONS-026), so any
  unprivileged local user on the box can read it with `ps`. Fix is a one-line change to pass it via
  `TUNNEL_TOKEN` in the child environment instead of argv — **I did not ship it because I cannot run
  `cloudflared` here to confirm it reads that variable**, and getting it wrong silently breaks public
  access. Worth doing next time someone can test a tunnel.

---

## 2. The git-history decision

**No action needed.** History is clean (see §1). No `filter-repo`, no BFG, no force-push. I would
have recommended against it anyway on a public repo with a live tag and a catalog pin.

---

## 3. Cross-repo changes needed in sibling repos

Five sibling repos talk to this one and are being audited in parallel, so I implemented only the
safe half here — validate, sanitise, log — and left the counterpart to you.

### 3a. OpenMasjidOS — sanitise the email subject before it becomes an SMTP header
**Relates to:** DONATIONS-023 (fixed on this side, commit `84bcae6`).
This app now flattens CR/LF and exotic line separators out of the receipt subject before POSTing it
to `/api/fabric/email`. But **any** app on the Fabric can send a subject, and the platform is what
turns it into a real header. The platform must sanitise `subject` (and `to`) independently rather
than trusting callers. I could not verify whether it currently does.

### 3b. OpenMasjidOS — confirm the ingress sanitises `X-Forwarded-*`, then let apps use it
**Relates to:** DONATIONS-009 (deferred here — see §4).
`CLAUDE.md` §13 asserts the platform ingress sanitises these headers, but **no code in this repo
reads them**, so the claim is currently untested. Behind the ingress every remote visitor shares one
rate-limit bucket, which makes a trivial donation-DoS possible. To fix it safely this app needs a
guarantee it can rely on. What I need from the platform side: a documented statement of which
forwarded headers the ingress strips and rewrites, and ideally a header an app can trust as "this
request came through the ingress" (a signed value, not a boolean anyone can send).

### 3c. OpenMasjidAPPS — `docker-compose.yml` deviates from the catalog contract
**Relates to:** DONATIONS-049. `CLAUDE.md` §10 requires the labels `com.openmasjid.app`,
`com.openmasjid.service` and `com.openmasjid.managed`, and a platform-assigned port mapping
(`"${OMOS_HOST_PORT_8080:-7870}:8080"`). This repo's compose has **none of the three labels** and
hardcodes `"7870:8080"`. It evidently installs fine today, so either the spec or the platform's
tolerance has drifted. Someone should decide which is authoritative and align them — I did not touch
it, because compose is part of the published catalog contract.

### 3d. OpenMasjidOS — what identity is allowed to become a Donations admin?
**Relates to:** DONATIONS-051. `GET /api/session` mints a **full local admin session** for any
identity the platform confirms; the username is recorded but never checked against a role. If
OpenMasjidOS ever gains non-admin users, every one of them silently becomes a donations
administrator with access to the Stripe keys and the donor ledger. Whether that is correct is a
platform decision. If a role or scope claim exists (or should), this app should check it.

---

## 4. Decisions I need from you (deferred findings)

### 4a. `/api/setup` during a platform outage (DONATIONS-005) — High
Under SSO the local admin is never set, so `hasAdmin()` is false for ever, and the only guard on
anonymous admin claiming is "is the platform reachable?". **During any platform outage, anyone who
can reach the box can POST `/api/setup` and own the panel** — Stripe keys, donor ledger, everything.

`CLAUDE.md` §13 documents this as the deliberate price of never bricking the panel, so I did not
override it. Every obvious hardening breaks the escape hatch it exists for (a recovery code printed
to the container log defeats a volunteer with no shell; restricting to private IPs doesn't help
because a LAN attacker is already there; a boot-time window can be waited out).

**My recommendation:** keep the hatch, make abuse loud. Fire a Fabric alert on every anonymous
setup claim, and show "a local password was set on `<date>`" permanently in the panel until
dismissed. Say the word and I'll implement it.

### 4b. Rate limiters collapse behind the ingress (DONATIONS-009) — Medium
See §3b. Needs the platform guarantee first. Symptom today: one attacker can exhaust the 30/min
donation-intent budget for **all** remote donors, and lock out every remote admin login.

### 4c. Anonymous donations are de-anonymised (DONATIONS-024) — Medium
A donor who deliberately leaves name and email blank gets them **backfilled from Stripe's billing
details** at confirm, so the cardholder name ends up in the ledger and the CSV. Is a blank name
"I wish to be anonymous" or "I couldn't be bothered"? The masjid wants names for Gift Aid; the donor
may have meant it. I won't guess — tell me which and I'll make it consistent everywhere.

### 4d. Container runs as root (DONATIONS-015) — Medium
Needs `USER node` **plus** an entrypoint that chowns `/data`, and **one real container start to
prove the app can still write its database**. I have no Docker here. Shipping it unverified risks
bricking every install on update. `docker-compose.yml`'s own comment already says this is pending
CI validation.

### 4e. Base images pinned by tag, not digest (DONATIONS-016) — Medium
Same reason: a wrong digest fails the build, and the build workflow doesn't run on pull requests, so
a mistake wouldn't surface until after merge. The change itself is mechanical once someone can run
`docker build`.

### 4f. No Content-Security-Policy (part of DONATIONS-014) — Medium
I shipped `nosniff` and `no-referrer`, and deliberately **not** a CSP: Stripe's Payment Element
loads `js.stripe.com` and its own frames, and a CSP that is even slightly wrong stops donors paying
with no obvious error. It needs writing against a real Stripe Element in a browser. Highest-value
missing header on the admin panel, and worth doing properly.

### 4g. `@fastify/static` major upgrade (DONATIONS-040) — ~~Low~~ **DONE (v0.43.0)**
Four High advisories, all originally **refuted as exploitable in this configuration** (both
registrations use `index: false`, never `list: true`, and both roots hold only already-public
assets). Deferred twice on that reasoning, and then done anyway in the v0.43.0 sweep: 8.x → 10.1.3.

Being right about unreachability is not the same as being clean, a fourth advisory had arrived on
the same package, and "we reasoned it was fine" is a worse answer to a masjid than "we upgraded it".
Two majors, but the API surface used here is four options across two registrations, so the diff is
one line in `package.json`. Verified by a real container start rather than by tests alone — see the
status table at the top of this file. The one behavior change: a request for the `/uploads/`
directory is now a 403 from the plugin rather than a 404, which the error handler no longer logs at
error level (a client 4xx is not this box's problem).

### 4h. Session revocation and password change (DONATIONS-013) — Medium
There is no way to change the admin password and no way to invalidate a stolen 30-day cookie short
of deleting the database. Needs a token-version scheme (bump a counter in the store, include it in
the token, check it on verify) plus a change-password route. Straightforward, but it is an auth-model
change with no existing auth-route tests, so it wants a human eye.

---

## 5. Assumptions I made

State these back to me if any is wrong — several fixes rest on them.

1. **Plain-HTTP LAN installs are still supported.** The whole design of the cookie `Secure` fix
   (DONATIONS-012) is "follow the request scheme" rather than "always Secure", specifically so a
   masjid on `http://box.local:7870` is not locked out. If HTTPS is now mandatory everywhere, the
   simpler fix is `COOKIE_SECURE: "1"` in compose.
2. **`x-forwarded-proto` may be read for the cookie flag** even though `trustProxy` is off, because
   a spoofed value can only restrict the spoofer's own cookie. I am confident in this reasoning, but
   it is reasoning, not a test.
3. **Cloudflare may cache a `.csv` response** with no cache directives, since `.csv` is in its
   default cached-extension list. The fix (`no-store`) is correct regardless, so this assumption
   doesn't need to hold — but it is why I rated DONATIONS-003 High rather than Low.
4. **Stripe's three-decimal set is exactly BHD, JOD, KWD, OMR, TND**, and those require a
   multiple-of-10 minor amount. From Stripe's documented currency rules; I could not call the API to
   confirm.
5. **A one-minor-unit fixed fee is better than zero** for zero-decimal currencies (DONATIONS-008).
   It is an approximation, not an FX conversion — the honest fix is an admin-visible per-account fee
   model, which is a product decision.
6. **`restart: unless-stopped` is in effect**, which is why `uncaughtException` now exits rather
   than limping on (DONATIONS-029).
7. **Nobody depends on `:latest`.** The catalog pins a commit and the compose pins a digest, so my
   reading is that republishing `:latest` on a `main` push is untidy rather than dangerous. If
   anything does track `:latest`, the push veto matters even more than I've described.
