<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Students integration — the `tuition` campaign type

> **One line:** when a campaign's type is **`tuition`**, this app does **not** run its own donation
> flow. It becomes a thin shell around the **OpenMasjid Students** app: a parent types their **child's
> Student ID**, confirms the name we echo back, we fetch the balances from Students over the Fabric,
> they pay all or pick which months, and we record the payment back into the Students ledger.
> **Students owns everything inside the tuition campaign** — the label, the lookup, the balance, the
> allocation, the recording. We only render the shell and charge the card.

The contract is **`students/billing` v2**, defined verbatim in the Students repo:
`OpenMasjidStudentManager/docs/FABRIC_BILLING_CONTRACT.md` (§11). That file is the source of truth for
every request/response shape below; if it and this brief ever disagree, the contract wins. Responses
carry `"v": 2`.

---

## 0a. v1 → v2: the PIN is gone (breaking, `lookup` only) — §11.0

Provider 0.39.0 removed student PINs. `lookup` no longer takes `name` or `pin`; it takes the
**Student ID alone**, and a v1-shaped body now returns **400** — it cannot silently half-work. What
replaces the PIN is a confirmation step: **`identify` first**, echo the matched child's first name
back, and only look up a balance once the parent says that's the right child. (That catches the
realistic failure — a mistyped ID — which a PIN never did. A Student ID buys nothing but *seeing a
balance and paying it*, so a secret that cost every parent friction at a kiosk keypad was a bad
trade.) Invoices and balances are also **per child** at v2. `info`, `record-payment` and `check` are
unchanged and still accept `"v": 1`, so **the money path did not move** — only the lookup screen.

Where this lives here: `server/src/students.ts` (`studentsIdentify` / `studentsLookup`, the per-method
wire version), the `/api/public/campaign/:slug/students/{identify,lookup}` routes in
`server/src/index.ts`, `TuitionShell` in `web/src/donate.tsx`, and `server/src/studentsFabric.test.ts`
(which locks the wire shapes, including that the money path still speaks v1).

## 0. What the parent sees (the required flow)

A `tuition` campaign renders **exactly this**, nothing more:

1. **One field:** *Student ID* — the code printed on the statement (first 3 letters of the child's
   first name + 4 digits, e.g. `YUS1234`). Nothing else — no PIN, no amount box up front.
2. Parent presses **Enter / “Find my balance”** → we call `identify` (the ID alone).
   - Not found → one friendly line (“We couldn’t find that Student ID — please check it, or ask the
     office”). **No hint about why** (Students returns a uniform `found:false` for an unknown code, a
     withdrawn student, a locked code, or payments switched off).
3. **Confirm the child:** *“Is this Yusuf I.?”* with the ID shown back, and a way to go correct it.
   **No balance is shown yet** — this confirmation is the safeguard that replaced the PIN, so we never
   call `lookup` before it.
4. **Confirmed** → we call `lookup` and show the **family label**, the **current balance due** (plus a
   per-child split when there are siblings), and the **open invoices** (one row per month/term, each
   tagged with the child it's for, with its own amount + due date).
5. **Pay:** two choices —
   - **Pay the full balance** (the whole household `balanceCents`), or
   - **Choose what to pay** — tick one or more invoices (e.g. one or two months) and pay just those.
   Card entry (Stripe Elements) appears for the chosen amount.
6. On success → we record it into Students and show a receipt that says **“payment”**, never
   “donation”. Done.

No account, no login — it’s the same anonymous model as the rest of the kiosk/donations public flow.

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
{ "v": 1 }   // unchanged at v2 — we still send v1
→ { "v": 2, "enabled": true, "schoolName": "An-Noor Weekend School",
    "currency": "usd", "tagline": "Pay tuition with your child's Student ID" }
```
Call it when rendering the campaign shell. `enabled:false` (school not set up / external payments
turned off) → **hide the tuition campaign**. Use `schoolName` / `tagline` for the heading.

### `identify` — whose Student ID is this? (step 2→3) **call this first**
```jsonc
// the ID is normalised on the provider side (case, spaces, hyphens), so "yus-1234" is fine
{ "v": 2, "studentCode": "YUS1234" }
// found — a first name + last initial and NOTHING else:
→ { "v": 2, "found": true, "student": { "studentCode": "YUS1234", "firstName": "Yusuf", "lastInitial": "I" } }
// not found (unknown code / withdrawn / locked / payments off — all identical):
→ { "v": 2, "found": false }
```
Echo the name back and ask *“is this the right child?”*. `lastInitial` is `""` for a child recorded
under a single name — render just the given name. This is **not** an optional nicety: it is the
confirmation step that replaced the PIN, and it deliberately reveals no balance, no siblings and no
ids, which is what makes it safe to answer before the parent has confirmed anything. The provider
locks a code after **6 failed probes per hour** (shared bucket across `identify`/`lookup`).

### `lookup` — Student ID → family + per-child balances (step 4)
```jsonc
{ "v": 2, "studentCode": "YUS1234" }   // the ID ALONE — `name`/`pin` are gone and would 400
// found:
→ { "v": 2, "found": true,
    "matchedStudent": { "id": "stu_1", "balanceCents": 20000 },
    "family": { "id": "fam_x1", "label": "Ismail family",
      "students": [{ "studentId": "stu_1", "studentCode": "YUS1234", "firstName": "Yusuf", "lastInitial": "I", "balanceCents": 20000 },
                   { "studentId": "stu_2", "studentCode": "MAR8802", "firstName": "Maryam", "lastInitial": "I", "balanceCents": 15000 }],
      "balanceCents": 35000, "currency": "usd",
      "openInvoices": [{ "id": "inv_9", "studentId": "stu_2", "label": "Tuition — Jul 2026",
                         "dueDate": "2026-07-01", "balanceCents": 15000 }] } }
// not found (identical shape + latency whatever mismatched):
→ { "v": 2, "found": false }
// 400 — a v1-shaped body (name + pin). Our bug, not the parent's: show "temporarily unavailable".
→ { "error": { "code": "invalid", "message": "Bad request." } }
```
Render the household total from `family.balanceCents` (that’s what “pay the full balance” charges) and
the per-child `students[].balanceCents` behind it; render one selectable row per `openInvoices[]`
(that’s the “pay specific months” list), labelled with the child from its `studentId`. **Never display
more than the contract returns** — no full last names, DOB, or contact info. Keep `family.id` +
`matchedStudent.id` server-side for the pay step; we do **not** forward a sibling's `studentCode` to
the browser (we don't offer a sibling switch, so it has no business leaving the server).

### The charge (our job — Stripe Elements)
Create a PaymentIntent on the Stripe account **the school uses for tuition** (see §4) for either the
full `balanceCents` or the sum of the ticked invoices. Put the **§11.3 metadata on the PaymentIntent**:
```
purpose             = students-billing        (REQUIRED — the reconciliation discriminator)
omos_app            = donations
students_family_id  = fam_x1                   (REQUIRED, from lookup)
students_student_id = stu_1                     (optional, matchedStudent.id)
```
Description: `School balance — <family label>`. **Never** put a Student ID or a child's name in
metadata, a description, or the URL (§11.3 — metadata is visible in Stripe dashboards and exports).
Confirm with Elements exactly like a normal donation (confirm-on-return).

### `record-payment` — book it in the Students ledger (idempotent)
Unchanged at v2 and still sent as `"v": 1`. After the PaymentIntent succeeds, call:
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
- **v2's `students[]` per-child split is what actually books the ledger — send it for picked months.**
  Students records a charge as one ledger row **per child**, and it takes those rows from `students[]`
  if you send one, otherwise it **derives** them by walking the *family's* open invoices
  oldest-due-first. That derivation **ignores `allocations` entirely** (the provider parses the field
  and then drops it — verified in `fabric/provider.ts` + `billing/ledger.ts` at 0.40.0). So a parent
  who ticks *Maryam's July* while the family's oldest bill is *Yusuf's July* has the money booked
  against **Yusuf** unless we say otherwise. We therefore send `students[]` derived server-side from
  the same ticked invoices, and **omit it for "pay the full balance"**, where the derived split is
  identical (every open invoice gets covered) and is what reconciliation would reproduce anyway.
  Keep sending `allocations` too — it's harmless, contract-documented, and correct if the provider
  ever honours it.
- The split **must sum to `amountCents` to the penny** and every child must belong to `familyId`, or
  Students answers `422 invalid_allocation`. If any picked invoice arrives without a `studentId`, send
  **no** split and let Students derive one — degrading beats a rejected payment.
- v2 also answers with a `payments[]` array (one ledger row per child); we read the top-level
  `paymentId`, which the contract keeps for that reason.

### `check` — outbox retry
If `record-payment` didn’t get a confirmed response (network blip after the card succeeded), retry with
`check`:
```jsonc
// unchanged at v2; we still send v1 and read `paymentId` (v2 adds `paymentIds[]` beside it)
{ "v": 1, "idempotencyKey": "pi_3PabcDEF" } → { "v": 2, "recorded": true, "paymentId": "pay_71" } | { "v": 2, "recorded": false }
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

- **Rate-limit `identify` + `lookup` per peer** on our side, in **one shared bucket** (40/min — an
  honest flow is two calls), mirroring the provider's single per-code bucket so switching endpoints
  can't launder attempts. Students additionally hard-locks a code after **6 failed probes per hour** and
  returns a uniform `found:false` — but we must not be the open relay that lets an attacker grind
  codes. Key the bucket on the real TCP peer, never a spoofable `X-Forwarded-For`.
- A Student ID is **not a secret** (its letters come from the child's first name and it's printed on
  statements) — it is nonetheless the whole credential, because all it authorises is *seeing a balance
  and paying it*. Treat it as **inert input**: send it in the JSON body only — **never** in a URL, a log
  line, Stripe metadata, a description, or an email. Store nothing about the lookup.
- **Never call `lookup` before the parent confirmed the name from `identify`** — that confirmation is
  the safeguard the PIN used to be.
- Treat every `identify`/`lookup` field as hostile text; render family/student data as text, never HTML.
- On `found:false`, show the same message + timing regardless — no enumeration. Never let a broker
  error or a `400` read as “wrong ID”; both mean “temporarily unavailable”.

---

## 7. Definition of done

- `manifest.yaml` declares `fabric.consumes: [students/billing]`; the broker call returns 200 (not
  `not_granted`) once the OS grants it.
- A `tuition` campaign renders the **Student ID** shell (one field, no PIN, no amount box), confirms the
  child via `identify`, then verifies via `lookup` and shows the balance (with the per-child split when
  there are siblings) + per-month invoices, and offers **pay-all** and **pick-months**.
- `identify`/`lookup` send `"v": 2`; `info`/`record-payment`/`check` still send `"v": 1`.
- A successful card payment calls `record-payment` (allocations for picked months; omitted for full
  balance) and is idempotent; a dropped confirmation is retried via `check`.
- The tuition campaign charges the **school’s tuition Stripe account** (§4).
- Copy says **“payment”**; tuition is excluded from donation totals + year-end letters.
- Everything **fails soft** when Students is unreachable / `enabled:false` / a `fabric_error` arrives.
- `identify` + `lookup` share one per-peer rate limit; the Student ID never appears in
  logs/URLs/metadata.
