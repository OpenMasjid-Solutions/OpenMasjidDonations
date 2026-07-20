<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Students integration — the `tuition` campaign type

> **One line:** when a campaign's type is **`tuition`**, this app does **not** run its own donation
> flow. It becomes a thin shell around the **OpenMasjid Students** app: a parent types their **child's
> name + PIN**, we verify + fetch the balance from Students over the Fabric, they pay all or pick which
> months, and we record the payment back into the Students ledger. **Students owns everything inside
> the tuition campaign** — the label, the lookup, the balance, the allocation, the recording. We only
> render the shell and charge the card.

The contract is **`students/billing` v1**, defined verbatim in the Students repo:
`OpenMasjidStudentManager/docs/FABRIC_BILLING_CONTRACT.md` (§11). That file is the source of truth for
every request/response shape below; if it and this brief ever disagree, the contract wins. Every
response carries `"v": 1`.

---

## 0. What the parent sees (the required flow)

A `tuition` campaign renders **exactly this**, nothing more:

1. **Two fields:** *Student name* and *PIN*. Nothing else — no amount box up front.
2. Parent presses **Enter / “Find my balance”** → we call `lookup` (name + PIN).
   - Not found → one friendly line (“We couldn’t find that — please check the name and PIN, or ask the
     office”). **No hint about which part was wrong** (Students returns a uniform `found:false`).
3. **Verified** → show the **family label**, the **current balance due**, and the **open invoices**
   (one row per month/term, each with its own amount + due date).
4. **Pay:** two choices —
   - **Pay the full balance** (the whole `balanceCents`), or
   - **Choose what to pay** — tick one or more invoices (e.g. one or two months) and pay just those.
   Card entry (Stripe Elements) appears for the chosen amount.
5. On success → we record it into Students and show a receipt that says **“payment”**, never
   “donation”. Done.

No account, no login — it’s the same anonymous, name+PIN model as the rest of the kiosk/donations
public flow.

---

## 1. Manifest — declare that we consume the capability

Add to `manifest.yaml` (this is what lets the OS broker grant our calls — without it every call is
`403 not_granted`):

```yaml
fabric:
  consumes:
    - capability: billing
      # the provider app id + capability the OS broker routes us to
      provider: students
```

(Exact key spelling follows `OpenMasjidAPPS/docs/BUILDING_AN_APP.md`; match whatever the OS validator
expects — the OS work order `FABRIC_APP_LINK_AND_TUNNEL.md` owns it. The capability name is
`students/billing`.) We already inject `OPENMASJID_BASE_URL` + `OPENMASJID_APP_SECRET`, which is all
the transport needs.

---

## 2. Transport — always through the OS broker (never the Students app directly)

For each method:

```
POST ${OPENMASJID_BASE_URL}/api/fabric/app/students/billing/<method>
Header:  X-OpenMasjid-App-Secret: <OUR OWN app secret>     # proves who we are to the OS
Body:    application/json, { "v": 1, ... }, ≤ 256 KB, respond < 10 s
```

The OS core verifies **our** secret, checks our manifest declares `fabric.consumes: [students/billing]`,
then proxies to the Students app (adding proof-of-platform + `X-OpenMasjid-Caller-App: donations`). We
never hold the Students app’s secret and never reach it directly.

**Errors — always fail soft:**
- App errors: HTTP status + `{ "error": { "code", "message" } }`.
- Broker errors: `{ "fabric_error": { "code", "message" } }` — `target_not_installed`,
  `target_unreachable`, `timeout`, `not_granted`, `rate_limited`. On ANY of these: hide/disable the
  tuition campaign (or show “tuition payments are temporarily unavailable”), never crash the donation
  site.

---

## 3. The methods (see the contract for full shapes)

### `info` — should this tuition campaign show at all?
```jsonc
{ "v": 1 }
→ { "v": 1, "enabled": true, "schoolName": "An-Noor Weekend School",
    "currency": "usd", "tagline": "Pay tuition with your child's name and PIN" }
```
Call it when rendering the campaign shell. `enabled:false` (school not set up / external payments
turned off) → **hide the tuition campaign**. Use `schoolName` / `tagline` for the heading.

### `lookup` — name + PIN → family + balance (step 2→3)
```jsonc
{ "v": 1, "name": "Yusuf Ismail", "pin": "482913" }
// found:
→ { "v": 1, "found": true,
    "matchedStudent": { "id": "stu_1" },
    "family": { "id": "fam_x1", "label": "Ismail family",
      "students": [{ "firstName": "Yusuf", "lastInitial": "I" }],
      "balanceCents": 35000, "currency": "usd",
      "openInvoices": [{ "id": "inv_9", "label": "Tuition — Jul 2026",
                         "dueDate": "2026-07-01", "balanceCents": 15000 }] } }
// not found (identical shape + latency whatever mismatched):
→ { "v": 1, "found": false }
```
Render the balance from `family.balanceCents`; render one selectable row per `openInvoices[]`
(that’s the “pay specific months” list). **Never display more than the contract returns** — no full
last names, DOB, or contact info. Keep `family.id` + `matchedStudent.id` in memory for the pay step.

### The charge (our job — Stripe Elements)
Create a PaymentIntent on the Stripe account **the school uses for tuition** (see §4) for either the
full `balanceCents` or the sum of the ticked invoices. Put the **§11.3 metadata on the PaymentIntent**:
```
purpose             = students-billing        (REQUIRED — the reconciliation discriminator)
omos_app            = donations
students_family_id  = fam_x1                   (REQUIRED, from lookup)
students_student_id = stu_1                     (optional, matchedStudent.id)
```
Description: `School balance — <family label>`. **Never** put the PIN or the typed name in metadata,
description, or the URL. Confirm with Elements exactly like a normal donation (confirm-on-return).

### `record-payment` — book it in the Students ledger (idempotent)
After the PaymentIntent succeeds, call:
```jsonc
{ "v": 1,
  "idempotencyKey": "pi_3PabcDEF",        // the Stripe PaymentIntent id
  "familyId": "fam_x1",
  "studentId": "stu_1",                   // optional
  "amountCents": 15000, "currency": "usd",
  "channel": "donations-web",
  "occurredAt": "2026-07-15T18:03:22Z",
  "externalRef": { "stripePaymentIntentId": "pi_3PabcDEF", "stripeChargeId": "ch_...", "stripeAccountId": "acct_..." },
  "allocations": [{ "invoiceId": "inv_9", "amountCents": 15000 }],   // OMIT for “pay full balance” → auto oldest-due-first
  "payerNote": "paid by grandmother" }    // optional, ≤200 chars
→ { "v": 1, "recorded": true, "paymentId": "pay_71", "duplicate": false }
```
- **Full balance** → omit `allocations` (Students auto-allocates oldest-due-first; any surplus → family
  credit).
- **Specific months** → send one `allocations[]` entry per ticked invoice (its `id` + the amount you
  charged for it). Students validates them (same family, not overpaying an invoice).
- Idempotent on `idempotencyKey` (= the PI id): a replay returns the original `paymentId` with
  `duplicate:true`.

### `check` — outbox retry
If `record-payment` didn’t get a confirmed response (network blip after the card succeeded), retry with
`check`:
```jsonc
{ "v": 1, "idempotencyKey": "pi_3PabcDEF" } → { "v": 1, "recorded": true, "paymentId": "pay_71" } | { "v": 1, "recorded": false }
```
Keep a tiny outbox: on `false`, re-POST `record-payment`. Students’ **daily reconciliation** is the
final backstop (it scans succeeded `purpose=students-billing` PIs), so **money is never lost even if
our record call never lands** — as long as the PI was on the right account (§4).

---

## 4. Which Stripe account? — the tuition account, not a donations one

Tuition must be charged on the **same OpenMasjidOS-vault Stripe account the school picked in
OpenMasjid Students → Settings → Payments**. Two reasons:
- The money should land in the school’s tuition account, not the masjid’s general-donations account.
- Students’ reconciliation safety net scans **that** account for `purpose=students-billing` PIs; a
  tuition PI charged on a different account would never be reconciled if our push call was missed.

We already let the admin pick a vault account **per campaign** (`stripeAccountId`, chosen from
`GET /api/fabric/stripe/accounts`). So: **for a `tuition` campaign, the admin selects the same account
Students uses.** Surface a hint on the tuition-campaign editor: *“Use the same Stripe account as
OpenMasjid Students.”*

---

## 5. Wording + tax (§11.3 — non-negotiable)

- Receipts, buttons, and confirmation say **“payment”**, never **“donation.”** Tuition is generally not
  tax-deductible.
- **Exclude** `purpose=students-billing` payments from donation totals, metrics, Gift Aid, and
  year-end tax letters. They are not gifts.

---

## 6. Security (§14)

- **Rate-limit the lookup per IP** on our side (it takes a PIN). Students additionally locks a PIN after
  repeated failures and returns a uniform `found:false` — but we must not be the open relay that lets an
  attacker grind PINs, so cap attempts per IP + a honeypot as on the rest of the public flow.
- The PIN is **inert input**: send it in the JSON body only — **never** in a URL, a log line, Stripe
  metadata, a description, or an email. Store nothing about the lookup.
- Treat every `lookup` field as hostile text; render family/student data as text, never HTML.
- On `found:false`, show the same message + timing regardless — no enumeration.

---

## 7. Definition of done

- `manifest.yaml` declares `fabric.consumes: [students/billing]`; the broker call returns 200 (not
  `not_granted`) once the OS grants it.
- A `tuition` campaign renders the **name + PIN** shell (no amount box), verifies via `lookup`, shows
  the balance + per-month invoices, and offers **pay-all** and **pick-months**.
- A successful card payment calls `record-payment` (allocations for picked months; omitted for full
  balance) and is idempotent; a dropped confirmation is retried via `check`.
- The tuition campaign charges the **school’s tuition Stripe account** (§4).
- Copy says **“payment”**; tuition is excluded from donation totals + year-end letters.
- Everything **fails soft** when Students is unreachable / `enabled:false` / a `fabric_error` arrives.
- Lookup is per-IP rate-limited; the PIN never appears in logs/URLs/metadata.
