// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * OpenMasjid Students billing — the `tuition` campaign type talks to the OpenMasjid
 * Students app through the OpenMasjidOS Fabric app-to-app broker (never to Students
 * directly). Contract: `students/billing` v2 — authoritative source
 * `OpenMasjidStudentManager/docs/FABRIC_BILLING_CONTRACT.md` §11 (also docs/STUDENTS_INTEGRATION.md).
 *
 * v1 → v2 (provider 0.39.0, contract §11.0): PINs are gone. `lookup` no longer takes a name
 * and a PIN — it takes the **Student ID alone** — and a v1-shaped body now 400s, so the flow
 * cannot half-work. The confirmation step that replaced the PIN is `identify`: we echo the
 * matched child's first name back and the parent confirms it BEFORE any balance appears,
 * which catches the realistic failure (a mistyped ID) that a PIN never did. Bills are also
 * per child at v2, so `lookup` reports a balance per student as well as the household total.
 * `info`, `record-payment` and `check` are unchanged and still accept `v: 1`, so the money
 * path is untouched by this migration — only the lookup screen moved.
 *
 * Transport: our backend POSTs
 *   ${OPENMASJID_BASE_URL}/api/fabric/app/students/billing/<method>
 * with OUR OWN per-app secret in `X-OpenMasjid-App-Secret`. The OS core verifies our
 * secret + that our manifest declares `fabric.consumes: [students/billing]`, then proxies
 * to the Students app (injecting the target's own secret + `X-OpenMasjid-Caller-App`). We
 * never hold the Students secret and never reach the app directly. LAN-only (the broker
 * refuses tunnel-origin calls) — but our call is server→server on the LAN regardless of
 * whether the *parent* is on the LAN or the public tunnel, so tuition works either way.
 *
 * FAIL-SOFT DOCTRINE (required of consumers): every broker error (`fabric_error`:
 * target_not_installed / target_unreachable / timeout / not_granted / rate_limited, or any
 * network fault) means "tuition unavailable, the rest of the donation site is fine" — never
 * a crash. A tuition campaign hides itself / shows a friendly notice when unavailable.
 *
 * SECURITY: the typed Student ID is INERT input — sent in the JSON body only, NEVER put in a
 * URL, a log line, Stripe metadata, a description, or an email, and never stored. (§11.3 bans
 * a Student ID or a child's name from Stripe metadata/descriptions/URLs outright.) A Student
 * ID is not a secret — it is printed on statements — but it is the whole credential, so we
 * still rate-limit it per peer and never become the relay that grinds codes. We log method
 * names only, never request/response bodies. Secrets are read from env every start
 * (config.ts), never persisted.
 */
import crypto from 'node:crypto';
import { config } from './config';
import { makeLog } from './logger';

const log = makeLog('students');

const BILLING_PATH = 'students/billing'; // <target-app-id>/<capability> — the broker route + our grant

/** True when the Fabric is available (embedded under OpenMasjidOS with our per-app secret). */
export function billingConfigured(): boolean {
  return !!config.omosBaseUrl && !!config.omosAppSecret;
}

// ── Low-level broker call ───────────────────────────────────────────────────
type BrokerOk = { ok: true; data: Record<string, unknown> };
/** The broker/platform/target couldn't be reached, or refused us → fail soft (hide tuition). */
type BrokerUnavailable = { ok: false; unavailable: true; code: string };
/** The Students app itself answered with an app-level error (e.g. family_not_found) — a real,
 *  usually-permanent outcome we can act on (surface / stop retrying), not a transient outage. */
type BrokerAppError = { ok: false; unavailable: false; code: string; message: string };
type BrokerResult = BrokerOk | BrokerUnavailable | BrokerAppError;

/** The wire version to send, per method. `identify`/`lookup` MUST be v2 (the PIN-free flow —
 *  §11.0); `info`, `record-payment` and `check` are unchanged and keep sending v1, which the
 *  provider still accepts, so the money path can't be broken by the lookup migration. */
async function brokerCall(method: string, body: Record<string, unknown>, v: 1 | 2 = 1): Promise<BrokerResult> {
  if (!billingConfigured()) return { ok: false, unavailable: true, code: 'no-fabric' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000); // contract: respond < 10 s
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/app/${BILLING_PATH}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmasjid-app-secret': config.omosAppSecret },
      body: JSON.stringify({ v, ...body }), // every request/response carries a "v"
      signal: ctrl.signal,
      redirect: 'error', // never follow a redirect to some other host
    });
    clearTimeout(t);
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // Broker-generated failure envelope (target_not_installed, timeout, not_granted, …) → fail soft.
    if (j && typeof j === 'object' && j.fabric_error && typeof j.fabric_error === 'object') {
      const code = (j.fabric_error as { code?: unknown }).code;
      return { ok: false, unavailable: true, code: typeof code === 'string' ? code : 'fabric_error' };
    }
    if (!res.ok) {
      // App-level error the target authored: { error: { code, message } }.
      const e = j && typeof j.error === 'object' && j.error ? (j.error as { code?: unknown; message?: unknown }) : null;
      if (e) {
        return { ok: false, unavailable: false, code: typeof e.code === 'string' ? e.code : 'error', message: typeof e.message === 'string' ? e.message : '' };
      }
      return { ok: false, unavailable: true, code: `http_${res.status}` }; // unrecognised non-2xx → fail soft
    }
    if (!j || typeof j !== 'object') return { ok: false, unavailable: true, code: 'bad_response' };
    return { ok: true, data: j };
  } catch (err) {
    // Message only (never the body) — the body carries the Student ID + family data.
    log.debug(`students/billing ${method} unreachable: ${err instanceof Error ? err.message : 'error'}`);
    return { ok: false, unavailable: true, code: 'unreachable' };
  }
}

// ── Small coercion helpers (never trust the provider's response blindly) ────
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v : '').slice(0, max);
const intNonNeg = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
/** A SIGNED money field, bounded. Only a bill line's `amountCents` needs this: a credit line (a
 *  bursary, a correction) is negative, and clamping it to zero would render "Bursary $0.00" on a
 *  bill instead of the deduction it is. Balances stay non-negative — the contract says so, and the
 *  items-sum-to-the-bill guarantee is over balances. */
const intSigned = (v: unknown): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_TUITION_CENTS, Math.min(MAX_TUITION_CENTS, n));
};

/** Canonicalise a typed Student ID the way the provider does — case, spaces and hyphens
 *  (§11.2: "yus-1234" is fine) — so the `identify` we confirm and the `lookup` that follows
 *  ask about the same code. Deliberately NOT a format check: the provider owns the format,
 *  and a client that validated it would reject codes the school later starts issuing. */
export function normaliseStudentCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase().slice(0, 64);
}

// ── info ────────────────────────────────────────────────────────────────────
/** Our own floor on any tuition charge, whatever the school advertises. Matches the provider's
 *  MIN_PAYMENT_CENTS, which sits deliberately above Stripe's per-currency minimum so a parent
 *  is stopped by a friendly message rather than a decline — and a charge under a pound/dollar
 *  costs more in card fees than it collects. Minor units. Taken as a MINIMUM, never overridden
 *  downwards by what a provider advertises. */
export const MIN_TUITION_CENTS = 100;

/** One processing rate from §11.2 `info.fee` (Students 0.51.0, additive at v2).
 *
 *  `percentBps` is basis points **of the GROSS**, not of the tuition — that is how Stripe takes
 *  its own cut, and it is the whole reason `grossUpTuition` divides rather than multiplies.
 *  `capCents` (present on the bank rate) is a ceiling on the fee itself; 0 = uncapped. */
export interface StudentsFeeRate {
  percentBps: number;
  fixedCents: number;
  capCents: number;
}

/** Does the PAYER cover the processing fee, or the school? `enabled: false` — the default, and
 *  what almost every install returns — means **change nothing**: charge the tuition, report the
 *  tuition, and the masjid absorbs Stripe's cut exactly as it always has. */
export interface StudentsFee {
  enabled: boolean;
  /** null when the feature is off. */
  card: StudentsFeeRate | null;
  /** null whenever the office is absorbing the (smaller, capped) bank fee — and a null means
   *  DO NOT ADD ONE. Parsed for completeness; this app never applies it, see `cardFeeRate`. */
  bank: StudentsFeeRate | null;
}

export interface StudentsInfo {
  enabled: boolean;
  schoolName: string;
  currency: string;
  tagline: string;
  /** §11.0a (Students 0.41.0): a parent may pay ANY amount at ANY time, including with nothing
   *  due — money beyond the open invoices becomes that child's credit. Advertised rather than
   *  assumed, so it stays false against a Students that hasn't shipped it. */
  allowAdvance: boolean;
  /** The floor to enforce on the amount field (minor units), never below MIN_TUITION_CENTS. */
  minAmountCents: number;
  /** §11.2 `info.fee` (Students 0.51.0). Read every time rather than hard-coded: an office can
   *  change the rate, and two apps disagreeing about what a parent owes is worse than either
   *  being wrong on its own. */
  fee: StudentsFee;
}
export type InfoResult = { available: true; info: StudentsInfo } | { available: false };

/** One rate, or null when there is nothing usable to apply.
 *
 *  Refused rather than repaired, in both directions that matter: `percentBps >= 10000` is 100% or
 *  more and would divide by zero or invert (a "fee" larger than any charge), and a rate of nothing
 *  at all is not a fee. Either way the answer is "add nothing", which is the safe direction — the
 *  school absorbs the cut, exactly as it does with the feature off. */
function parseFeeRate(v: unknown): StudentsFeeRate | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  const percentBps = intNonNeg(d.percentBps);
  const fixedCents = intNonNeg(d.fixedCents);
  if (percentBps >= 10_000) return null;
  if (percentBps === 0 && fixedCents === 0) return null;
  return { percentBps, fixedCents, capCents: intNonNeg(d.capCents) };
}

/** `fee` from `info`. Absent (a pre-0.51.0 school) parses to disabled, which is the shape every
 *  consumer written before this already behaves correctly for. Both rates are forced to null when
 *  `enabled` is false, so a stale or malformed payload cannot add a charge the office switched off. */
function parseFee(v: unknown): StudentsFee {
  const d = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const enabled = d.enabled === true;
  return {
    enabled,
    card: enabled ? parseFeeRate(d.card) : null,
    bank: enabled ? parseFeeRate(d.bank) : null,
  };
}

/**
 * The rate to quote on THIS page, or null for "add nothing".
 *
 * Always the CARD rate, and never the bank one — a deliberate, documented choice. The fee has to
 * be fixed when the PaymentIntent is created, which is before the payer has chosen anything: this
 * page uses Stripe's Payment Element with `automatic_payment_methods`, so whether the money
 * eventually arrives by card or by bank debit is not knowable at the moment we must decide the
 * amount. Quoting the card rate and calling it a card fee is honest about the common case; quoting
 * the bank rate would under-collect the moment somebody used a card, which leaves the school short
 * — the exact failure the gross-up formula exists to prevent. A flow that KNOWS it is a bank debit
 * (the school's own portal, a kiosk with an ACH button) is where `fee.bank` belongs.
 */
export function cardFeeRate(info: StudentsInfo | null | undefined): StudentsFeeRate | null {
  if (!info || !info.fee.enabled) return null;
  return info.fee.card;
}

/**
 * Gross up a tuition amount so the PAYER covers the processing fee.
 *
 *   gross = ceil((tuition + fixedCents) / (1 - percentBps / 10000))
 *   fee   = gross - tuition
 *
 * **Divide, don't multiply.** The percentage is a share of the gross, because that is what Stripe
 * takes its cut of. The naive markup — a percentage of the tuition — gives $103.20 on a $100 bill
 * instead of $103.30 and leaves the school a dime short every single time; a $100 invoice that
 * settles at $99.91 then stays open for ever and shows a family as unpaid over ten cents.
 *
 * **Round the gross UP**, for the same reason, and do the arithmetic in integers: `10030 / 0.971`
 * in binary floating point can land a hair either side of the true value, and `Math.ceil` of a hair
 * too much is a whole extra cent charged for nothing. The loops below correct a division that came
 * out high or low, so the result is the exact mathematical ceiling.
 *
 * A `capCents` (the bank rate carries one) is applied last: if the implied fee exceeds it the answer
 * is simply `tuition + cap`, because a $2,000 payment must not have $16 added to cover a $5 charge.
 */
export interface TuitionCharge {
  /** What the family owes — what goes in `record-payment.amountCents`, always. */
  tuitionCents: number;
  /** What was added on top. 0 = nothing was added, and no metadata key is written. */
  feeCents: number;
  /** What the card is actually charged. */
  grossCents: number;
}

export function grossUpTuition(tuitionCents: number, rate: StudentsFeeRate | null): TuitionCharge {
  const tuition = Math.max(0, Math.trunc(tuitionCents));
  const none: TuitionCharge = { tuitionCents: tuition, feeCents: 0, grossCents: tuition };
  if (!rate || tuition <= 0) return none;
  const den = 10_000 - rate.percentBps;
  if (den <= 0) return none; // parseFeeRate already refuses this; belt and braces
  const num = (tuition + rate.fixedCents) * 10_000;
  // Exact integer ceiling of num/den. Both products stay far below 2^53 (num ~1e12 at the
  // MAX_TUITION_CENTS ceiling), so every comparison here is exact.
  let f = Math.floor(num / den);
  while (f * den > num) f -= 1;
  while ((f + 1) * den <= num) f += 1;
  let gross = f * den === num ? f : f + 1;
  let fee = gross - tuition;
  if (rate.capCents > 0 && fee > rate.capCents) {
    fee = rate.capCents;
    gross = tuition + fee;
  }
  if (fee <= 0) return none;
  return { tuitionCents: tuition, feeCents: fee, grossCents: gross };
}

function parseInfo(d: Record<string, unknown>): StudentsInfo {
  return {
    enabled: d.enabled === true,
    schoolName: str(d.schoolName, 120),
    currency: str(d.currency, 10).toUpperCase(),
    tagline: str(d.tagline, 200),
    allowAdvance: d.allowAdvance === true,
    // Take the STRICTER of the school's floor and ours: a provider that advertises nothing still
    // gets a floor, and one that advertises 50c can't drag us under a pound/dollar.
    minAmountCents: Math.max(MIN_TUITION_CENTS, intNonNeg(d.minAmountCents)),
    fee: parseFee(d.fee),
  };
}

// Cache info so rendering the shell doesn't hit the broker every load. A good copy lasts
// ~5 min (brief §3); an "unavailable" answer is cached only briefly so we recover fast.
let infoCache: { at: number; value: InfoResult } | null = null;
const INFO_OK_MS = 5 * 60_000;
const INFO_BAD_MS = 30_000;

export async function studentsInfo(force = false): Promise<InfoResult> {
  const now = Date.now();
  if (!force && infoCache) {
    const ttl = infoCache.value.available ? INFO_OK_MS : INFO_BAD_MS;
    if (now - infoCache.at < ttl) return infoCache.value;
  }
  const r = await brokerCall('info', {}); // unchanged at v2; keeps sending v1 (§11.0)
  const value: InfoResult = r.ok ? { available: true, info: parseInfo(r.data) } : { available: false };
  infoCache = { at: now, value };
  return value;
}

// ── identify (Student ID → whose it is) ─────────────────────────────────────
// Step 1 of the v2 flow and NOT optional: it is the confirmation that replaced the PIN
// (§11.0). Deliberately thin — a first name + last initial and nothing else: no balance, no
// invoices, no sibling list, not even the family id — which is what makes it safe to answer
// before the parent has confirmed anything.
export interface IdentifiedStudent {
  /** The code as the provider echoes it back (normalised) — what we then `lookup` with. */
  studentCode: string;
  firstName: string;
  /** '' for a child recorded under a single name (plenty don't split into two halves). */
  lastInitial: string;
}
export type IdentifyResult =
  | { status: 'found'; student: IdentifiedStudent }
  | { status: 'not-found' }
  | { status: 'unavailable' };

/** Ask who a typed Student ID belongs to. `not-found` is uniform — an unknown code, a
 *  withdrawn student, a locked code and "external payments switched off" all look identical,
 *  so we are not an enumeration oracle. Any broker/app error → `unavailable` (fail soft). */
export async function studentsIdentify(studentCode: string): Promise<IdentifyResult> {
  const code = normaliseStudentCode(studentCode);
  if (!code) return { status: 'not-found' };
  const r = await brokerCall('identify', { studentCode: code }, 2);
  if (!r.ok) return { status: 'unavailable' };
  if (r.data.found !== true) return { status: 'not-found' };
  const s = r.data.student && typeof r.data.student === 'object' ? (r.data.student as Record<string, unknown>) : null;
  const firstName = str(s?.firstName, 60);
  // A "found" we can't put a name to can't be confirmed by a parent — don't guess at it.
  if (!firstName) return { status: 'unavailable' };
  return {
    status: 'found',
    student: { studentCode: str(s?.studentCode, 64) || code, firstName, lastInitial: str(s?.lastInitial, 4) },
  };
}

// ── lookup (Student ID → family + per-child balances) ───────────────────────
/** One line of a bill (§11.0b, Students 0.43.0). A February bill is commonly $200 of tuition
 *  plus a $50 book fee, and parents routinely want to pay just the book fee.
 *  `sum(items[].balanceCents) === invoice.balanceCents`, always. */
export interface StudentInvoiceItem {
  id: string;
  label: string;
  /** `tuition` | `charge` | `credit` — an OPEN set: keep whatever arrives and render an
   *  unrecognised kind as a plain line rather than dropping money off the screen. */
  kind: string;
  /** What the line was billed at. SIGNED — a credit line (bursary, correction) is negative. */
  amountCents: number;
  /** What's left on it. 0 = already settled, or a credit line (a bursary/correction, whose
   *  value is already deducted from the lines above it) — never payable either way. */
  balanceCents: number;
}
export interface StudentInvoice {
  id: string;
  /** Which child this bill belongs to (new at v2 — bills are per student). */
  studentId: string;
  label: string;
  dueDate: string;
  balanceCents: number;
  /** The lines this bill is made of (§11.0b). Empty = not itemised (an older Students, or a
   *  payload we couldn't trust) → pay it as one thing, exactly as before. */
  items: StudentInvoiceItem[];
}
/** A child on the family's bill. We keep the contract's `studentId` (needed to tag invoices
 *  with the child they belong to) but deliberately NOT its `studentCode`: we never offer a
 *  "pay for a sibling" switch, and a sibling's code must not reach the browser. */
export interface StudentFamilyMember {
  studentId: string;
  firstName: string;
  lastInitial: string;
  /** What THIS child owes (new at v2) — the household total is `family.balanceCents`. */
  balanceCents: number;
  /** What THIS child has paid ahead (§11.0a). Pairs with balanceCents: both non-negative, at
   *  most one non-zero. A derived balance of 0 is ambiguous on its own — square, or ahead. */
  creditCents: number;
}
export interface StudentFamily {
  id: string;
  label: string;
  students: StudentFamilyMember[];
  balanceCents: number;
  /** The household's credit (§11.0a) — see StudentFamilyMember.creditCents. */
  creditCents: number;
  currency: string;
  openInvoices: StudentInvoice[];
}
export type LookupResult =
  // `matchedStudentId` is the child whose ID was typed (v2 also reports that child's own
  // `balanceCents`, which we don't read: the per-child figures we display come from
  // `family.students[]`, and the charge always comes from the family total or ticked invoices).
  | { status: 'found'; matchedStudentId: string; family: StudentFamily }
  | { status: 'not-found' }
  | { status: 'unavailable' };

function parseFamily(d: Record<string, unknown>): StudentFamily | null {
  const f = d.family && typeof d.family === 'object' ? (d.family as Record<string, unknown>) : null;
  if (!f) return null;
  const id = str(f.id, 128);
  if (!id) return null; // no family id = unusable for the pay step
  const studentsRaw = Array.isArray(f.students) ? f.students : [];
  const students = studentsRaw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .slice(0, 40)
    .map((s) => ({
      studentId: str(s.studentId, 128),
      firstName: str(s.firstName, 60),
      lastInitial: str(s.lastInitial, 4),
      balanceCents: intNonNeg(s.balanceCents),
      creditCents: intNonNeg(s.creditCents),
    }));
  const invRaw = Array.isArray(f.openInvoices) ? f.openInvoices : [];
  const openInvoices = invRaw
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .slice(0, 60)
    .map((i) => {
      const balanceCents = intNonNeg(i.balanceCents);
      const rawItems = Array.isArray(i.items) ? i.items : [];
      const items = rawItems
        .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
        .slice(0, 40)
        .map((it) => ({
          id: str(it.id, 128),
          label: str(it.label, 120),
          kind: str(it.kind, 40), // open set — kept verbatim, never matched against a closed list
          amountCents: intSigned(it.amountCents), // a credit line is NEGATIVE — never clamp it
          balanceCents: intNonNeg(it.balanceCents),
        }));
      // Only trust itemisation we can actually pay with: every line needs an id (a `lines[]`
      // entry is an itemId), and the lines must add up to the bill as the contract guarantees.
      // If either fails, drop to a single un-itemised bill rather than showing a parent a
      // breakdown that doesn't reconcile or offering a line we can't name.
      const usable = items.length > 0 && items.every((it) => it.id) && items.reduce((s, it) => s + it.balanceCents, 0) === balanceCents;
      return {
        id: str(i.id, 128),
        studentId: str(i.studentId, 128),
        label: str(i.label, 120),
        dueDate: str(i.dueDate, 40),
        balanceCents,
        items: usable ? items : [],
      };
    })
    .filter((i) => i.id); // an invoice with no id can't be paid specifically
  return {
    id,
    label: str(f.label, 120),
    students,
    balanceCents: intNonNeg(f.balanceCents),
    creditCents: intNonNeg(f.creditCents),
    currency: str(f.currency, 10).toUpperCase(),
    openInvoices,
  };
}

/** Resolve a Student ID to a family + its per-child balances. Call this only AFTER the parent
 *  confirmed the name from `identify` — that confirmation is the safeguard the PIN used to be
 *  (§11.0). The code is sent in the body only and is NEVER logged. `not-found` is uniform
 *  (unknown / withdrawn / locked / payments-off all look identical — no enumeration oracle). */
export async function studentsLookup(studentCode: string): Promise<LookupResult> {
  const code = normaliseStudentCode(studentCode);
  if (!code) return { status: 'not-found' };
  const r = await brokerCall('lookup', { studentCode: code }, 2);
  if (r.ok) {
    if (r.data.found === true) {
      const family = parseFamily(r.data);
      if (!family) return { status: 'unavailable' }; // malformed "found" payload → don't guess
      const m = r.data.matchedStudent && typeof r.data.matchedStudent === 'object' ? (r.data.matchedStudent as Record<string, unknown>) : null;
      return { status: 'found', matchedStudentId: str(m?.id, 128), family };
    }
    return { status: 'not-found' };
  }
  // Any broker/app error on a lookup is treated as unavailable (fail soft) — a transient
  // outage must never read as "wrong ID", and a 400 means WE are behind on the contract
  // (a v1-shaped body): tell the parent to try later, never that their code is bad.
  return { status: 'unavailable' };
}

// ── record-payment (book it in the Students ledger; idempotent) ─────────────
export interface RecordPaymentInput {
  idempotencyKey: string; // = the Stripe PaymentIntent id
  familyId: string;
  studentId?: string;
  amountCents: number;
  currency: string;
  occurredAt: string;
  externalRef: { stripePaymentIntentId: string; stripeChargeId?: string; stripeAccountId?: string };
  /** One entry per paid invoice; omit for "pay full balance" (Students auto-allocates). */
  allocations?: { invoiceId: string; amountCents: number }[];
  /** The per-child split of this one charge. Must sum EXACTLY to amountCents and every child
   *  must belong to familyId, or Students returns 422. Omit for "pay full balance". THIS is
   *  what decides whose ledger the money lands on — see the note in recordStudentPayment. */
  students?: { studentId: string; amountCents: number }[];
  /** The exact bill LINES the parent ticked (§11.0b). Supersedes `students` and `allocations`,
   *  so it is sent ALONE. Must sum exactly to amountCents and every itemId must belong to an
   *  open bill of familyId, or Students returns 422 — strict on purpose, since we built these
   *  ids from the lookup in this same session. */
  lines?: { itemId: string; amountCents: number }[];
  /** Stripe's cut, when the payer covered it (§11.2 `info.fee`). INFORMATIONAL — Students' ledger
   *  holds tuition only. `amountCents` above is the tuition either way, and that is the invariant
   *  that matters: a gross there credits Stripe's cut to the family as an overpayment, leaving a
   *  credit that silently eats their next bill for as long as the setting is on. */
  feeCents?: number;
}
export type RecordResult =
  | { status: 'recorded'; paymentId: string; duplicate: boolean }
  | { status: 'unavailable' } // transient → retry via the outbox
  | { status: 'rejected'; code: string }; // permanent app error → stop; Students' reconciliation is the backstop

export async function recordStudentPayment(input: RecordPaymentInput): Promise<RecordResult> {
  const body: Record<string, unknown> = {
    idempotencyKey: input.idempotencyKey,
    familyId: input.familyId,
    amountCents: input.amountCents,
    currency: input.currency.toLowerCase(),
    channel: 'donations-web',
    occurredAt: input.occurredAt,
    externalRef: input.externalRef,
  };
  if (input.studentId) body.studentId = input.studentId;
  // Informational, and only when there is one. `amountCents` above is always the tuition.
  if (input.feeCents && input.feeCents > 0) body.feeCents = Math.trunc(input.feeCents);
  // Students resolves exactly ONE breakdown, in the order lines → allocations → students →
  // derive-it-itself. So send exactly one and never a mixture: extra fields would be dead weight
  // at best, and a contradiction to debug at worst.
  if (input.lines && input.lines.length) {
    // Ticked LINES (§11.0b). Best of the three: each line resolves to its own child (so it
    // supersedes `students`), and the choice is stored and re-applied — the book fee a parent
    // deliberately paid still reads settled on next month's statement.
    body.lines = input.lines;
  } else if (input.allocations && input.allocations.length) {
    // Whole invoices. Honoured from Students 0.43.0 (before that it was parsed and silently
    // ignored, which is why `students` below exists), and lenient by design: if the office took
    // cash against a bill between our lookup and this call, the remainder is recorded as ordinary
    // money on that child rather than rejected — the card is already captured by then.
    body.allocations = input.allocations;
    // Belt and braces for a pre-0.43.0 school, where `allocations` was dropped on the floor and
    // the split would otherwise be derived from the FAMILY's oldest bills — landing a parent's
    // chosen month on a sibling. Ignored by 0.43.0+ (allocations wins the chain), harmless there.
    if (input.students && input.students.length) body.students = input.students;
  } else if (input.students && input.students.length) {
    body.students = input.students;
  }
  // Still sent as v1: `record-payment` is byte-identical between v1 and v2 (§11.0), and every
  // breakdown above is an additive optional field the provider accepts on either version.
  const r = await brokerCall('record-payment', body);
  if (r.ok) {
    if (r.data.recorded === true) {
      return { status: 'recorded', paymentId: str(r.data.paymentId, 128), duplicate: r.data.duplicate === true };
    }
    return { status: 'unavailable' }; // 200 but not recorded — treat as transient, retry
  }
  if (!r.unavailable) return { status: 'rejected', code: r.code }; // family_not_found / invalid_allocation → permanent
  return { status: 'unavailable' };
}

// ── check (outbox retry helper) ─────────────────────────────────────────────
export type CheckResult = { status: 'recorded'; paymentId: string } | { status: 'not-recorded' } | { status: 'unavailable' };

export async function checkStudentPayment(idempotencyKey: string): Promise<CheckResult> {
  // Unchanged at v2, still v1: we ask with the plain key we sent and read `paymentId`, which
  // the contract keeps alongside v2's new `paymentIds[]` for exactly this reason.
  const r = await brokerCall('check', { idempotencyKey });
  if (r.ok) {
    if (r.data.recorded === true) return { status: 'recorded', paymentId: str(r.data.paymentId, 128) };
    return { status: 'not-recorded' };
  }
  return { status: 'unavailable' };
}

// ── Server-side tuition session (so the client never dictates the family) ────
// On a successful lookup we stash the family + its open invoices here, keyed by a random
// 128-bit id handed to the browser. At pay time the browser sends only that id + which
// invoices it wants ("full", a picked set, or an advance amount) — we recompute the charge +
// the familyId SERVER-SIDE from this stash, so a crafted request can't attribute a charge to
// an arbitrary family or pay a tampered invoice. Short-lived + in-memory only (nothing about
// a lookup is persisted).
//
// An ADVANCE payment (§11.0a) is the one case where the parent names the amount — there is no
// invoice to derive it from. That is safe in a way a donation amount isn't: the money can only
// ever land on the family THIS session looked up, and anything beyond their open invoices
// becomes that family's own credit. What still comes only from here: the familyId, the child,
// the currency, whether advance is allowed at all, and the floor.
export interface TuitionSession {
  id: string;
  campaignId: string;
  familyId: string;
  studentId: string;
  familyLabel: string;
  currency: string;
  balanceCents: number;
  /** Each open invoice with the child it belongs to (v2 bills are per student). `studentId`
   *  is what lets us tell Students WHICH child the parent's picked months belong to, and
   *  `items` (§11.0b) what lets a parent pay ONE line of a bill — the ids and amounts are held
   *  here so a ticked line's value comes from the server's copy, never the browser's. */
  invoices: { id: string; studentId: string; balanceCents: number; items: { id: string; balanceCents: number }[] }[];
  /** True when EVERY open bill arrived itemised. Decided per family, not per bill: the provider
   *  chain is `lines` OR `allocations`, never both, so a selection mixing lines from one bill
   *  with a whole other bill couldn't be expressed in one call. All-or-nothing removes that. */
  itemised: boolean;
  /** The family's children, each with an opaque `ref` the browser uses to say WHICH child an
   *  advance is for. The internal studentId stays here — a browser never sees one, so a crafted
   *  request can only ever name a child of the family this session looked up. */
  students: { ref: string; studentId: string; balanceCents: number }[];
  /** From `info` at lookup time (§11.0a), held server-side so a client can't relax either. */
  allowAdvance: boolean;
  minAmountCents: number;
  /** The processing rate (§11.2 `info.fee`) as it stood when this family looked up their balance,
   *  or null for "add nothing".
   *
   *  Captured here rather than re-read at intent, on purpose: **the payer must be charged what they
   *  were shown.** `info` is cached for five minutes and a session lives fifteen, so re-reading it
   *  could quote one total on the balance screen and charge another after the office changed the
   *  rate mid-visit — and being surprised by a total is what generates a phone call to the office.
   *  This is still "read it from `info`, never hard-code it"; it is read once per visit. */
  fee: StudentsFeeRate | null;
  expires: number;
}

const sessions = new Map<string, TuitionSession>();
const SESSION_TTL_MS = 15 * 60_000;
const SESSION_MAX = 2000;

export function createTuitionSession(input: Omit<TuitionSession, 'id' | 'expires'>): TuitionSession {
  const now = Date.now();
  if (sessions.size > SESSION_MAX) {
    for (const [k, v] of sessions) if (v.expires <= now) sessions.delete(k);
  }
  const s: TuitionSession = { ...input, id: crypto.randomBytes(16).toString('hex'), expires: now + SESSION_TTL_MS };
  sessions.set(s.id, s);
  return s;
}

export function getTuitionSession(id: string): TuitionSession | null {
  const s = sessions.get(id);
  if (!s) return null;
  if (s.expires <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return s;
}

// ── Amount computation (PURE — the security-critical bit; unit-tested) ──────
/** The absolute ceiling on one tuition charge (minor units) — a guard against a typo turning
 *  into a five-figure card charge, well above any real term's fees. */
export const MAX_TUITION_CENTS = 99_999_999;

export type TuitionSelection =
  | { kind: 'full' }
  | { kind: 'invoices'; invoiceIds: string[] }
  /** The exact LINES the parent ticked (§11.0b) — ids from the session's own items. */
  | { kind: 'items'; itemIds: string[] }
  /** An advance/part payment the parent typed (§11.0a): minor units, floored at the school's
   *  `minAmountCents`. Allowed with nothing due — that's the whole point. `studentRef` names the
   *  child it's for: with one ledger per child, "add $50" has to say for whom, and a family where
   *  one child is clear while another owes is the ordinary case. */
  | { kind: 'amount'; amountCents: number; studentRef?: string };
export type AmountResult =
  | {
      amountCents: number;
      allocations: { invoiceId: string; amountCents: number }[] | null;
      /** The per-CHILD split of this charge — what actually books the Students ledger (see
       *  `recordStudentPayment`). `null` = let Students derive it (correct for a full balance). */
      students: { studentId: string; amountCents: number }[] | null;
      /** The exact LINES the parent ticked (§11.0b). When present this is the ONLY breakdown we
       *  send: it supersedes `students` (a line already says whose bill it is) and it's honoured
       *  stickily — the line stays settled when Students recomputes its allocations. */
      lines: { itemId: string; amountCents: number }[] | null;
      /** Which child this charge is FOR, when the parent said so (a per-child advance). Goes on
       *  the PaymentIntent metadata and the stored row; `null` = the child whose ID was typed. */
      targetStudentId: string | null;
    }
  | { error: string };

/** Compute the charge amount, the per-invoice allocations AND the per-child split from the
 *  SERVER-side session, never the client's numbers. "full" pays the whole balance (both splits
 *  omitted → Students derives them oldest-due-first, which for a full balance is the same
 *  answer); otherwise pay exactly the chosen open invoices, at their stored amounts, and tell
 *  Students which child each of those months belongs to. */
export function computeTuitionAmount(session: TuitionSession, selection: TuitionSelection): AmountResult {
  // The floor applies to every tuition charge, not just a typed one: it is "the smallest card
  // payment a parent may start, wherever they start it", so the school's portal, the kiosk and
  // this page all stop at the same number rather than one surface declining what another took.
  const floor = Math.max(MIN_TUITION_CENTS, session.minAmountCents);
  const checked = (r: Exclude<AmountResult, { error: string }>): AmountResult => {
    if (r.amountCents < floor) return { error: 'below-min' };
    if (r.amountCents > MAX_TUITION_CENTS) return { error: 'too-large' };
    return r;
  };
  if (selection.kind === 'amount') {
    // A typed amount: a part payment, or money paid AHEAD of any bill.
    if (!Number.isInteger(selection.amountCents) || selection.amountCents <= 0) return { error: 'bad-amount' };
    // Paying AHEAD needs the school to have advertised it; paying part of a real balance never
    // does — that's just settling what's already owed, so only the excess needs permission.
    if (selection.amountCents > session.balanceCents && !session.allowAdvance) return { error: 'advance-not-allowed' };
    // Which child is it for? A ref names one explicitly; a family with a single child has only
    // one answer. Either way we then send the whole amount as that child's split, so "money for
    // Yusuf" lands on Yusuf's ledger even when a sibling owns the family's oldest unpaid bill —
    // left to Students to derive, it would go there instead.
    const target = selection.studentRef
      ? session.students.find((s) => s.ref === selection.studentRef)
      : session.students.length === 1
        ? session.students[0]
        : undefined;
    if (selection.studentRef && !target) return { error: 'unknown-student' };
    const targetId = target?.studentId || '';
    return checked({
      amountCents: selection.amountCents,
      allocations: null,
      // With no child to name, Students derives it: the open invoices oldest-due-first, and any
      // remainder as the credit of the child whose ID was typed (our top-level studentId).
      students: targetId ? [{ studentId: targetId, amountCents: selection.amountCents }] : null,
      lines: null,
      targetStudentId: targetId || null,
    });
  }
  if (selection.kind === 'full') {
    if (session.balanceCents <= 0) return { error: 'nothing-due' };
    return checked({ amountCents: session.balanceCents, allocations: null, students: null, lines: null, targetStudentId: null });
  }
  if (selection.kind === 'items') {
    // Particular LINES of a bill (§11.0b) — e.g. the book fee but not the month's tuition. The
    // amount is the sum of those lines' balances FROM THE SESSION, so a browser can name which
    // lines but never what they cost. `lines` alone goes on the wire: it supersedes `students`
    // (each line already resolves to a child) and is strict, since the ids came from us.
    if (!session.itemised) return { error: 'not-itemised' };
    const itemIds = [...new Set(selection.itemIds)];
    if (!itemIds.length) return { error: 'no-selection' };
    const lines: { itemId: string; amountCents: number }[] = [];
    let total = 0;
    for (const itemId of itemIds) {
      // A settled line (balance 0) and a credit line are both unpayable — the browser is never
      // offered them, and a crafted request naming one is refused rather than quietly dropped.
      const line = session.invoices.flatMap((i) => i.items).find((it) => it.id === itemId);
      if (!line || line.balanceCents <= 0) return { error: 'unknown-item' };
      lines.push({ itemId, amountCents: line.balanceCents });
      total += line.balanceCents;
    }
    if (total <= 0) return { error: 'nothing-due' };
    return checked({ amountCents: total, allocations: null, students: null, lines, targetStudentId: null });
  }
  const ids = [...new Set(selection.invoiceIds)];
  if (!ids.length) return { error: 'no-selection' };
  const allocations: { invoiceId: string; amountCents: number }[] = [];
  const byStudent = new Map<string, number>();
  let sum = 0;
  let everyInvoiceHasAChild = true;
  for (const id of ids) {
    const inv = session.invoices.find((i) => i.id === id);
    if (!inv || inv.balanceCents <= 0) return { error: 'unknown-invoice' };
    allocations.push({ invoiceId: id, amountCents: inv.balanceCents });
    if (inv.studentId) byStudent.set(inv.studentId, (byStudent.get(inv.studentId) ?? 0) + inv.balanceCents);
    else everyInvoiceHasAChild = false;
    sum += inv.balanceCents;
  }
  if (sum <= 0) return { error: 'nothing-due' };
  // A split must cover the WHOLE charge to the penny or Students rejects it (422). If any
  // picked invoice arrived without a child (a provider we don't recognise), send no split at
  // all and let Students derive one — degrading beats a rejected payment.
  const students = everyInvoiceHasAChild && byStudent.size ? [...byStudent].map(([studentId, amountCents]) => ({ studentId, amountCents })) : null;
  return checked({ amountCents: sum, allocations, students, lines: null, targetStudentId: null });
}
