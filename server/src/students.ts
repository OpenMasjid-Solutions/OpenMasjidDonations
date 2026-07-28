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

/** Canonicalise a typed Student ID the way the provider does — case, spaces and hyphens
 *  (§11.2: "yus-1234" is fine) — so the `identify` we confirm and the `lookup` that follows
 *  ask about the same code. Deliberately NOT a format check: the provider owns the format,
 *  and a client that validated it would reject codes the school later starts issuing. */
export function normaliseStudentCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase().slice(0, 64);
}

// ── info ────────────────────────────────────────────────────────────────────
export interface StudentsInfo {
  enabled: boolean;
  schoolName: string;
  currency: string;
  tagline: string;
}
export type InfoResult = { available: true; info: StudentsInfo } | { available: false };

function parseInfo(d: Record<string, unknown>): StudentsInfo {
  return {
    enabled: d.enabled === true,
    schoolName: str(d.schoolName, 120),
    currency: str(d.currency, 10).toUpperCase(),
    tagline: str(d.tagline, 200),
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

/** Last cached info without a network call — for cheap sync paths. */
export function cachedStudentsInfo(): InfoResult {
  return infoCache?.value ?? { available: false };
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
export interface StudentInvoice {
  id: string;
  /** Which child this bill belongs to (new at v2 — bills are per student). */
  studentId: string;
  label: string;
  dueDate: string;
  balanceCents: number;
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
}
export interface StudentFamily {
  id: string;
  label: string;
  students: StudentFamilyMember[];
  balanceCents: number;
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
    }));
  const invRaw = Array.isArray(f.openInvoices) ? f.openInvoices : [];
  const openInvoices = invRaw
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .slice(0, 60)
    .map((i) => ({
      id: str(i.id, 128),
      studentId: str(i.studentId, 128),
      label: str(i.label, 120),
      dueDate: str(i.dueDate, 40),
      balanceCents: intNonNeg(i.balanceCents),
    }))
    .filter((i) => i.id); // an invoice with no id can't be paid specifically
  return {
    id,
    label: str(f.label, 120),
    students,
    balanceCents: intNonNeg(f.balanceCents),
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
  if (input.allocations && input.allocations.length) body.allocations = input.allocations;
  // Unchanged by v2 and still sent as v1 (§11.0) — the money path doesn't move with the lookup
  // screen. We also don't send v2's optional per-child `students[]` breakdown: with either
  // `allocations` (picked months, each already tagged with its child) or none at all (pay the
  // full balance), the provider derives the exact same split itself, and a breakdown that
  // failed to sum to amountCents to the penny would be rejected 422 for no gain.
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

// ── Server-side tuition session (so the client never dictates the family or amount) ──
// On a successful lookup we stash the family + its open invoices here, keyed by a random
// 128-bit id handed to the browser. At pay time the browser sends only that id + which
// invoices it wants (or "full") — we recompute the amount + the familyId SERVER-SIDE from
// this stash, so a crafted request can't attribute a charge to an arbitrary family or pay a
// tampered amount. Short-lived + in-memory only (nothing about a lookup is persisted).
export interface TuitionSession {
  id: string;
  campaignId: string;
  familyId: string;
  studentId: string;
  familyLabel: string;
  currency: string;
  balanceCents: number;
  invoices: { id: string; balanceCents: number }[];
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
export type TuitionSelection = { kind: 'full' } | { kind: 'invoices'; invoiceIds: string[] };
export type AmountResult =
  | { amountCents: number; allocations: { invoiceId: string; amountCents: number }[] | null }
  | { error: string };

/** Compute the charge amount + allocations from the SERVER-side session, never the client's
 *  numbers. "full" pays the whole balance (allocations omitted → Students auto-allocates
 *  oldest-due-first); otherwise pay exactly the chosen open invoices, at their stored amounts. */
export function computeTuitionAmount(session: TuitionSession, selection: TuitionSelection): AmountResult {
  if (selection.kind === 'full') {
    if (session.balanceCents <= 0) return { error: 'nothing-due' };
    return { amountCents: session.balanceCents, allocations: null };
  }
  const ids = [...new Set(selection.invoiceIds)];
  if (!ids.length) return { error: 'no-selection' };
  const allocations: { invoiceId: string; amountCents: number }[] = [];
  let sum = 0;
  for (const id of ids) {
    const inv = session.invoices.find((i) => i.id === id);
    if (!inv || inv.balanceCents <= 0) return { error: 'unknown-invoice' };
    allocations.push({ invoiceId: id, amountCents: inv.balanceCents });
    sum += inv.balanceCents;
  }
  if (sum <= 0) return { error: 'nothing-due' };
  return { amountCents: sum, allocations };
}
