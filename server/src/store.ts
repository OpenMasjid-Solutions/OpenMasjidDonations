// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Durable store for all app state, kept in the data volume as a single SQLite file
 *  (better-sqlite3, WAL). Everything goes through this thin repository so a different
 *  backend (e.g. Postgres) could be slotted in later without touching the routes.
 *
 *  Slice 2 persists only the admin credential + the session-signing secret. Later
 *  slices add proper tables (Stripe config, appeals, donations) alongside these. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config';
import { makeLog } from './logger';
import type { Cred } from './auth';

const log = makeLog('store');

/** Drop undefined values so a partial update never overwrites a field with nothing. */
function clean<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface Admin extends Cred {
  name?: string;
  createdAt: string;
}

/** Masjid branding/details — seeded from MASJID_* / install settings, then owned by
 *  the admin once edited in-app. Used for receipts, branding and the default
 *  donation currency. */
export interface MasjidProfile {
  name: string;
  address: string;
  email: string;
  phone: string;
  website: string;
  currency: string;
  /** Logo image URL (upload path or link) shown on the donation pages. */
  logo: string;
}

/** Stripe credentials. The SECRET key + webhook secret are server-side only and
 *  must never be returned to the browser or logged. */
export interface StripeConfig {
  publishableKey: string;
  secretKey: string;
  webhookSecret: string;
}

/** A Stripe account the masjid owns. Multiple are supported so e.g. Zakat and
 *  general funds can settle to different accounts. Secrets are server-side only. */
export interface StripeAccount extends StripeConfig {
  id: string;
  label: string;
  createdAt: string;
}

/** A donation page/appeal. The public URL is a clean, admin-chosen path: /<slug>
 *  (e.g. /zakat). The slug is unique across campaigns. The `token` is retained only
 *  so older /c/<slug>-<token> links keep working; new links never expose it. */
/** Every campaign has a type.
 *  - `donation` — the admin may OFFER donors the option to cover the card fee.
 *  - `zakat` — the fee is always enforced (so the full Zakat reaches the masjid).
 *  - `tuition` — NOT a donation flow at all: a thin shell around the OpenMasjid Students
 *    app (Student ID → confirm the child → family balance → pay → recorded in Students over
 *    the Fabric broker).
 *    It has NO card-fee concept — the parent pays the exact school balance (grossing up
 *    would overpay an invoice and break Students' allocation). See docs/STUDENTS_INTEGRATION.md. */
export type CampaignType = 'donation' | 'zakat' | 'tuition';

export interface Campaign {
  id: string;
  slug: string;
  token: string;
  title: string;
  /** Required campaign type — drives the fee rule (see coverFees/forceCoverFees). */
  type: CampaignType;
  description: string;
  coverImage: string;
  /** Full-page background image URL for this campaign's public page. When empty the
   *  page shows the default theme scene (it does NOT inherit the dashboard wallpaper). */
  backgroundImage: string;
  /** This campaign's own logo/icon. When empty it falls back to the masjid logo. */
  logo: string;
  /** Suggested amounts, in MINOR currency units (e.g. pence). */
  presetAmounts: number[];
  allowCustom: boolean;
  /** Min/max custom amount in minor units. maxAmount 0 = no max. */
  minAmount: number;
  maxAmount: number;
  /** LEGACY. The account chosen when the campaign was made, and still the fallback for a campaign
   *  that has never picked one explicitly. Read ONLY by the site-default branch of the resolver —
   *  new logic goes through `paymentAccount`. */
  stripeAccountId: string;
  /** Which Stripe account this appeal's money goes into: '' = the site default, or a namespaced
   *  reference ('fabric:<vault-id>' / 'local:<account-id>'). See parsePaymentAccount. '' is the
   *  value every pre-v0.42.0 campaign has, and it means "behave exactly as before". */
  paymentAccount: string;
  /** Offer the donor the option to cover the card fee. */
  coverFees: boolean;
  /** Require the donor to cover the card fee (no opt-out). Always true for Zakat; set by
   *  deriveFees from the type. When true, coverFees is implied true too. */
  forceCoverFees: boolean;
  giftAid: boolean;
  /** Offer donors a monthly (recurring) option in addition to one-time. */
  allowMonthly: boolean;
  /** Opt this campaign in to the public embeddable widget (served at /w/<slug>). Off by
   *  default so a campaign's widget id isn't reachable until the admin turns it on. */
  widgetEnabled: boolean;
  /** Goal in minor units, 0 = no goal/progress bar. */
  goalAmount: number;
  active: boolean;
  sortOrder: number;
  /** Per-campaign thank-you override. Any empty field inherits the global default
   *  (see ThankYou + getThankYou). Shown on the post-donation thank-you screen. */
  thankYou: ThankYou;
  createdAt: string;
}

/** The post-donation thank-you screen content. The heading/message support the
 *  variables {name}, {amount}, {campaign}, {masjid}, substituted when shown. As a
 *  per-campaign override, an empty field means "inherit the global default". */
export interface ThankYou {
  heading: string;
  message: string;
  /** Background image URL (or /uploads/…) for the thank-you screen; empty = the page's. */
  backgroundImage: string;
  /** Accent color (hex) for the thank-you screen highlight; empty = the theme accent. */
  accent: string;
}

export const THANKYOU_DEFAULT: ThankYou = {
  heading: 'JazākAllāhu khayran, {name}!',
  message: 'Your donation of {amount} to {campaign} was received. May Allah accept it from you and reward you abundantly.',
  backgroundImage: '',
  accent: '',
};

/** An empty override (every field inherits the global default). */
const THANKYOU_EMPTY: ThankYou = { heading: '', message: '', backgroundImage: '', accent: '' };

/** Global "large-donation alternative": above `threshold` (MINOR units; 0 = off) the donor
 *  is shown a gentle suggestion of a cheaper way to give (a message + an optional QR/image)
 *  before the card — they can still choose to pay by card. Mirrors the Kiosk's giving config. */
export interface LargeDonation {
  threshold: number; // minor units in the store; 0 = never show
  message: string;
  qrImage: string;
}
export const LARGE_DONATION_DEFAULT: LargeDonation = { threshold: 0, message: '', qrImage: '' };

/** The emailed donation receipt (sent via the OpenMasjidOS Fabric email provider when the
 *  admin enables it). subject/heading/body are the admin-editable text (the {name} {amount}
 *  {campaign} {masjid} variables work); the receipt DETAILS (amount, date, payment method, fund),
 *  the masjid logo + contact info are filled in automatically (see email.ts renderReceipt), so
 *  the paragraph stays a clean thank-you. `accent` is a hex tint. Off by default — nothing is
 *  emailed until the admin turns it on AND the OS has an email provider set up. */
export interface EmailReceipt {
  enabled: boolean;
  subject: string;
  heading: string;
  body: string;
  accent: string;
}
export const EMAIL_RECEIPT_DEFAULT: EmailReceipt = {
  enabled: false,
  subject: 'Your donation receipt — {masjid}',
  heading: 'JazākAllāhu khayran, {name}!',
  body: 'Thank you for your generous donation to {masjid}. May Allah accept it from you and reward you abundantly. Your receipt is below — please keep it for your records.',
  accent: '',
};

// ── Who gets told what ────────────────────────────────────────────────────────
/**
 * Every notification this app can raise. One id per real EVENT, not per channel — the channels are
 * chosen per event below, so adding a channel later never means renaming these.
 *
 * Each maps to a declared alert id in `manifest.yaml` (kebab-case there, camelCase here); the
 * platform 400s an alert id it was not told about, so the two lists must stay in step.
 */
export const NOTIFY_EVENTS = ['donation', 'donationRecovered', 'refund', 'planStopped', 'paymentFailed', 'tuitionFailed'] as const;
export type NotifyEventId = (typeof NOTIFY_EVENTS)[number];

/**
 * The declared `alerts:` id in `manifest.yaml` for each event.
 *
 * Kept here, beside the event list, because the platform **400s an alert id it was not told about**
 * — so these two lists and the manifest are one contract in three places, and a rename that misses
 * one turns a notification into a silent failure. `store.test.ts` asserts every event has an id.
 *
 * Note `donation` and `donationRecovered` were added to the manifest in v0.43.0. Before that, "a
 * donation arrived" went out through `notify()`, which reaches the masjid's **webhook only** — so
 * there was no way for the most-wanted notification of all to reach an inbox. Giving it an alert id
 * is what makes "email is on by default" true rather than aspirational.
 */
export const NOTIFY_ALERT_ID: Record<NotifyEventId, string> = {
  donation: 'donation-received',
  donationRecovered: 'donation-recovered',
  refund: 'donation-refunded',
  planStopped: 'plan-stopped',
  paymentFailed: 'payment-failed',
  tuitionFailed: 'tuition-record-failed',
};

/**
 * The three ways one event can reach a person, chosen independently.
 *
 * Independent, not a priority list: a masjid may well want the treasurer messaged on WhatsApp AND
 * the record kept in the admin inbox. A channel that is off or unavailable never suppresses another.
 */
export interface NotifyChannels {
  /**
   * Raise the OpenMasjidOS **alert** for this event, which reaches the admin's own email and webhook.
   *
   * ON by default for every event — this is the channel a masjid already has, and the one that needs
   * no setup. Note it is an **AND** with the admin's own matrix in OpenMasjidOS → Settings → Alerts:
   * we ask the platform to deliver, the platform still honors the admin's per-alert channel
   * choices, and `disabled_by_admin` is a normal answer. Turning this on here therefore means "we
   * will raise it", never "it will definitely arrive" — and the panel says so, because an admin who
   * reads it as a guarantee would stop looking for the real switch.
   */
  os: boolean;
  /**
   * A specific email address, sent through the platform's email provider. '' = off, and off by
   * default: the OS alert already reaches the admin, so this is for somebody who is NOT them — the
   * treasurer, the school office — and we cannot guess who that is.
   */
  email: string;
  /**
   * A specific WhatsApp destination: digits with a country code, or an approved group id.
   *
   * `whatsappOn` is a SEPARATE switch rather than "non-empty means on", so an admin can turn the
   * channel off for a month without losing the number they typed — and so the tick box in the panel
   * means what a tick box normally means. Both must be true to send.
   *
   * Off by default for every event, deliberately: WhatsApp is an unofficial client whose number can
   * be banned, and the platform paces every message under a daily cap shared with every other app —
   * so it is something a masjid opts into per event, never something an update switches on for them.
   */
  whatsapp: string;
  whatsappOn: boolean;
}

/** The last thing that happened to a WhatsApp message for one event.
 *
 *  `refused` is ours (the platform said no, with a reason); `failed`/`expired` come from the
 *  platform's status endpoint; `queued` means accepted and not yet resolved. `sent` is deliberately
 *  NOT "delivered" — WhatsApp gives no receipt, and the platform only knows it handed it over. */
export interface WhatsAppEventOutcome {
  state: 'queued' | 'sent' | 'failed' | 'expired' | 'refused';
  /** The platform's own sentence, when there is one. Never a recipient, never the message. */
  reason: string;
  /** ISO timestamp of when WE recorded this. */
  at: string;
}

export interface NotifySettings {
  /** Prefill for the form only. NEVER consulted when sending: an event with an empty `email` is off,
   *  full stop. A default that silently became the recipient would be how a masjid discovers they
   *  have been emailing the wrong person for a month. */
  defaultEmail: string;
  defaultWhatsapp: string;
  /** Don't raise `donation` below this, in MINOR units. 0 = every donation.
   *
   *  Matters most for WhatsApp, where the platform spaces messages 6–20s apart under hourly and
   *  daily caps shared with every other app on the box: a busy Friday of $2 gifts would spend the
   *  whole allowance on good news and push the refunds and failures behind it. Applied to all three
   *  channels so the three never disagree about what happened. */
  minAmount: number;
  events: Record<NotifyEventId, NotifyChannels>;
}

/** A partial update — `events` and each channel set within it are themselves partial, so a form can
 *  send one toggle without restating everything (and a new event can be added without an older
 *  client wiping it). */
export type NotifyPatch = Partial<Omit<NotifySettings, 'events'>> & {
  events?: Partial<Record<NotifyEventId, Partial<NotifyChannels>>>;
};

/** OS alert on, the other two off — "the channel you already have, and nothing switched on for you". */
const CHANNELS_DEFAULT: NotifyChannels = { os: true, email: '', whatsapp: '', whatsappOn: false };

/**
 * The OS channel is ON for every event, `donation` included — Hasan's call, made after the risk
 * below was put to him.
 *
 * The risk, recorded so nobody has to rediscover it: `donation` fires on every transaction, and the
 * platform defaults a newly-declared alert id to email+webhook ON while persisting only non-defaults
 * — so a masjid updating into this gets an email per donation without having asked, and during a
 * Ramadan appeal that is hundreds. Alert mail is also rate-limited on a bucket shared with the
 * platform's own alerts and with this app's, so a flood of good news can push `payment-failed` — the
 * one that means nobody can give at all — behind it.
 *
 * `minAmount` is what keeps that in hand, and it is why the donation row carries the "only tell me
 * about donations of at least…" field right beside its switches rather than somewhere in a
 * sub-menu. If a masjid ever reports being buried, that field (or turning this one row off) is the
 * answer — not a change of default, which was considered and decided against.
 */
export const NOTIFY_DEFAULT: NotifySettings = {
  defaultEmail: '',
  defaultWhatsapp: '',
  minAmount: 0,
  events: Object.fromEntries(NOTIFY_EVENTS.map((e) => [e, { ...CHANNELS_DEFAULT }])) as Record<NotifyEventId, NotifyChannels>,
};

export interface Donation {
  id: string;
  campaignId: string;
  stripeAccountId: string;
  /** Amount actually charged, in minor units (includes the fee top-up if covered). */
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
  donorName: string;
  donorEmail: string;
  coverFees: boolean;
  giftAid: boolean;
  paymentIntentId: string;
  /** Card brand + last 4, captured from Stripe on confirm (when paid by card). */
  cardBrand: string;
  cardLast4: string;
  /** True for monthly (subscription) donations; subscriptionId is the Stripe sub. */
  recurring: boolean;
  subscriptionId: string;
  /** How much of this donation has been given back to the donor, in MINOR units. 0 = none,
   *  `amount` = fully refunded, anything between = a part refund.
   *
   *  A refund is recorded as an AMOUNT, not as a status, deliberately. `status` stays the
   *  PAYMENT's outcome — the money really did arrive, and rewriting that to 'refunded' would
   *  lose the fact and cannot express a part refund at all. Every money figure the masjid sees
   *  (totals, the campaign goal bar, a monthly plan's "collected so far") is therefore
   *  `amount - refundedAmount`, so a refund lowers what was raised without erasing the record.
   *  Stripe is the source of truth for the running total; see refunds.ts. */
  refundedAmount: number;
  /** ISO timestamp of the MOST RECENT refund, '' when none. Not a history: a masjid needs
   *  "when was money last sent back", and Stripe's dashboard holds the per-refund detail. */
  refundedAt: string;
  /** Branded-receipt-email lifecycle, DECIDED ONCE at intent (so confirm/outbox stay
   *  consistent with whether Stripe's own receipt was suppressed):
   *  - 'stripe'  — Stripe sends its built-in receipt; we send nothing (no double).
   *  - 'pending' — Stripe's receipt was suppressed; WE owe a branded receipt (retried).
   *  - 'sent'    — the branded receipt was delivered.
   *  - 'skipped' — permanently un-sendable (no/invalid donor email, or provider rejected it). */
  receipt: 'stripe' | 'pending' | 'sent' | 'skipped';
  createdAt: string;
}

/** A tuition (Students-billing) payment. NOT a donation — it credits a family's balance in
 *  the OpenMasjid Students ledger. We hold only what the record/retry flow needs; NEVER the
 *  typed Student ID or a child's name. `allocations` is the per-INVOICE JSON the parent chose
 *  and `studentsSplit` the per-CHILD JSON derived from it (both '' = pay the full balance,
 *  which Students allocates oldest-due-first). Both are stored so an outbox retry books the
 *  payment exactly as the first attempt would have. `recordStatus` tracks the durable push to
 *  Students: 'pending' (outbox will retry), 'recorded' (done), 'skipped' (a permanent app
 *  error — Students' own daily reconciliation is the backstop, so money is never lost). */
export interface StudentPayment {
  id: string;
  campaignId: string;
  stripeAccountId: string;
  paymentIntentId: string;
  familyId: string;
  studentId: string;
  familyLabel: string;
  /** **The TUITION** — what the family owed, in MINOR units of the school's currency.
   *
   *  NOT what the card was charged, when a processing fee was passed on (§11.2 `info.fee`): the
   *  charge is `amount + feeCents`. This column keeps its original meaning on purpose, because it
   *  is what `record-payment` sends as `amountCents`, and the contract's failure directions are
   *  lopsided — a gross in `amountCents` credits Stripe's cut to the family as an overpayment and
   *  the ledger is wrong until somebody notices by hand. Leaving the net here means the money path
   *  needs no arithmetic at all, so no bug in the fee code can reach the ledger. */
  amount: number;
  /** Stripe's cut, when the PAYER covered it (§11.2 `info.fee`); 0 when the school absorbed it,
   *  which is every row written before Students 0.51.0 and almost every one after.
   *
   *  Stored rather than recomputed so an outbox retry — hours later, possibly after the office
   *  switched the setting off or changed the rate — reports exactly what was charged. */
  feeCents: number;
  currency: string;
  allocations: string;
  /** JSON `[{studentId, amountCents}]` — the per-child split; '' = let Students derive it. */
  studentsSplit: string;
  /** JSON `[{itemId, amountCents}]` — the exact bill LINES the parent ticked (§11.0b); '' = none.
   *  Stored so an outbox retry books the same lines the first attempt would have. */
  paymentLines: string;
  payStatus: 'pending' | 'succeeded' | 'failed';
  recordStatus: 'pending' | 'recorded' | 'skipped';
  studentsPaymentId: string;
  createdAt: string;
  occurredAt: string;
}

/** One line of the append-only admin audit log. See the `audit_log` DDL for what may go in it —
 *  in particular, never a key, a token, a Student ID or a donor's details. */
export interface AuditEntry {
  id: string;
  /** ISO timestamp. */
  at: string;
  /** Who did it, as the panel knows them: an OpenMasjidOS username, or 'local admin'. */
  actor: string;
  /** A stable machine-ish verb, e.g. 'donations.export' or 'plan.cancel'. */
  action: string;
  /** The id of the thing acted on ('' when not applicable). */
  subject: string;
  /** A short human phrase for the panel to show. */
  detail: string;
}

/** Cloudflare Tunnel config. The token is a CREDENTIAL — server-side only, never
 *  returned to the browser or logged. `publicHostname` is the public address the admin
 *  set up in Cloudflare (e.g. give.masjid.org); it's not secret and is used to build
 *  shareable campaign links + QR codes when public access is on. */
export interface TunnelConfig {
  token: string;
  enabled: boolean;
  publicHostname: string;
}

/** Short, URL-safe id with a kind prefix, e.g. "cmp_a1b2c3d4". */
export function rid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/** An unguessable, lowercase, URL-safe token for a campaign's public link. */
export function campaignToken(): string {
  return crypto.randomBytes(5).toString('hex'); // 10 hex chars
}

/** The token in a monthly donor's "stop these payments" link — 128 bits, as 32 lowercase hex
 *  characters.
 *
 *  Hex, not base64url, and deliberately: this string is retyped, forwarded and line-wrapped by mail
 *  clients, and `-`/`_`/mixed case are exactly what those mangle. It is the ONLY thing standing
 *  between a stranger and stopping somebody's donation, so the entropy is the defense (a rate limit
 *  cannot be, because behind the platform's ingress every remote visitor shares one bucket —
 *  DONATIONS-009). 2^128 makes guessing hopeless. */
export function planLinkToken(): string {
  return crypto.randomBytes(16).toString('hex');
}
/** Shape check before any lookup, so a junk path can be refused without touching the database. */
export function looksLikePlanToken(v: string): boolean {
  return /^[0-9a-f]{32}$/.test(v);
}

/** Make a URL-safe slug from a title (kebab-case, alnum + dashes). */
export function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return out || 'appeal';
}

// ── Which Stripe account an appeal's money goes into ──────────────────────────
/**
 * A campaign's `paymentAccount` is a namespaced reference, so that "which bank account receives
 * this donation" can never be ambiguous:
 *
 *   ''              — no choice: follow the site default (exactly the pre-v0.42.0 behavior).
 *   'fabric:<id>'   — a named account in the OpenMasjidOS vault, by its ID (a slugified label:
 *                     lowercase, [a-z0-9-], never an underscore). IDs, never labels — the platform
 *                     matches either, but a label changes when the admin renames the account while
 *                     the id is minted once and never moves.
 *   'local:<id>'    — an account whose keys live on this device (`stripe_accounts.id`, "acct_<hex>").
 *
 * The two namespaces are provably disjoint on the underscore, which is what makes it safe for
 * `accountById` to try the local table first when re-resolving a bare recorded id.
 *
 * Anything that does not match EXACTLY is `invalid`, and an invalid reference must make the appeal
 * refuse rather than fall back to some other account. That is not pedantry: `fabric:` with an empty
 * id would reach the platform as `?account=` omitted, which it answers with its FIRST account — so a
 * Zakat appeal would quietly settle into the general account and the ledger would record the general
 * account's id, leaving nothing to notice.
 */
export type ParsedAccount =
  | { kind: 'default' }
  | { kind: 'openmasjidos'; id: string }
  | { kind: 'device'; id: string }
  | { kind: 'invalid' };

const FABRIC_REF_RE = /^fabric:([a-z0-9][a-z0-9-]{0,62})$/;
const LOCAL_REF_RE = /^local:([A-Za-z0-9_-]{1,64})$/;

export function parsePaymentAccount(raw: string | null | undefined): ParsedAccount {
  const v = (raw ?? '').trim();
  if (!v) return { kind: 'default' };
  const fab = FABRIC_REF_RE.exec(v);
  if (fab) return { kind: 'openmasjidos', id: fab[1] };
  const loc = LOCAL_REF_RE.exec(v);
  if (loc) return { kind: 'device', id: loc[1] };
  return { kind: 'invalid' };
}

/** Build a reference for storage. Returns '' for the site default. */
export function formatPaymentAccount(kind: 'default' | 'openmasjidos' | 'device', id = ''): string {
  if (kind === 'default') return '';
  return `${kind === 'openmasjidos' ? 'fabric' : 'local'}:${id}`;
}

/** Slugs the admin must not claim — they collide with the app's own top-level paths
 *  (the admin panel, the API, health check, the built assets, and the legacy /c/ link
 *  prefix). The donation page lives at /<slug>, so these are off-limits. */
export const RESERVED_SLUGS = new Set(['admin', 'api', 'healthz', 'assets', 'c', 'static', 'public']);

export class Store {
  private readonly db: Database.Database;
  private cachedSecret: Buffer | null = null;

  constructor(dbPath = path.join(config.dataDir, 'donations.db')) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // A small key/value table for singletons (admin credential, signing secret,
    // masjid profile, onboarding flag). Structured data gets its own tables.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS stripe_accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        publishable_key TEXT NOT NULL DEFAULT '',
        secret_key TEXT NOT NULL DEFAULT '',
        webhook_secret TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        token TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        cover_image TEXT NOT NULL DEFAULT '',
        background_image TEXT NOT NULL DEFAULT '',
        logo TEXT NOT NULL DEFAULT '',
        preset_amounts TEXT NOT NULL DEFAULT '[]',
        allow_custom INTEGER NOT NULL DEFAULT 1,
        min_amount INTEGER NOT NULL DEFAULT 100,
        max_amount INTEGER NOT NULL DEFAULT 0,
        stripe_account_id TEXT NOT NULL,
        cover_fees INTEGER NOT NULL DEFAULT 0,
        gift_aid INTEGER NOT NULL DEFAULT 0,
        allow_monthly INTEGER NOT NULL DEFAULT 0,
        goal_amount INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_slug_token ON campaigns(slug, token);

      CREATE TABLE IF NOT EXISTS donations (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        stripe_account_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        donor_name TEXT NOT NULL DEFAULT '',
        donor_email TEXT NOT NULL DEFAULT '',
        cover_fees INTEGER NOT NULL DEFAULT 0,
        gift_aid INTEGER NOT NULL DEFAULT 0,
        payment_intent_id TEXT NOT NULL DEFAULT '',
        card_brand TEXT NOT NULL DEFAULT '',
        card_last4 TEXT NOT NULL DEFAULT '',
        recurring INTEGER NOT NULL DEFAULT 0,
        subscription_id TEXT NOT NULL DEFAULT '',
        refunded_amount INTEGER NOT NULL DEFAULT 0,
        refunded_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_donations_campaign ON donations(campaign_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_pi ON donations(payment_intent_id);

      -- Tuition (Students-billing) payments live in their OWN table, deliberately separate
      -- from donations: they are school payments, NOT gifts, so they must never appear in
      -- donation totals, metrics, the CSV, Gift Aid or year-end tax letters (contract §5).
      -- We keep only what the record-payment outbox + retry need (never the typed Student ID
      -- or a child's name). record_status drives the durable push to the Students ledger.
      CREATE TABLE IF NOT EXISTS student_payments (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        stripe_account_id TEXT NOT NULL,
        payment_intent_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        student_id TEXT NOT NULL DEFAULT '',
        family_label TEXT NOT NULL DEFAULT '',
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        allocations TEXT NOT NULL DEFAULT '',
        students_split TEXT NOT NULL DEFAULT '',
        payment_lines TEXT NOT NULL DEFAULT '',
        pay_status TEXT NOT NULL DEFAULT 'pending',
        record_status TEXT NOT NULL DEFAULT 'pending',
        students_payment_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        occurred_at TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_student_payments_pi ON student_payments(payment_intent_id);
      CREATE INDEX IF NOT EXISTS idx_student_payments_outbox ON student_payments(pay_status, record_status);

      -- Append-only record of every admin action that touches money or donor data (DONATIONS-011).
      -- This app handles donations, so "who exported the donor list, who canceled that plan, who
      -- rotated the Stripe key, and when" must be answerable — CLAUDE.md §8 promises the masjid a
      -- financial record, and a second volunteer with panel access is in the threat model.
      -- Deliberately NOT a general request log: no donor rows, no amounts, no PII beyond the actor
      -- label the admin already sees, and never a key, token or Student ID. "detail" is a short
      -- human phrase; "subject" is the id of the thing acted on so a row can be traced.
      -- Nothing in the app ever UPDATEs or DELETEs from this table.
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at DESC);

      -- The "stop these payments" link a monthly donor is emailed. One token per Stripe
      -- subscription; the token IS the credential, so it is the primary key and the lookup is a
      -- single indexed probe.
      --
      -- Stored in PLAINTEXT, on purpose. Hashing it would mean the letter could never be rendered
      -- twice — and it is rendered up to three times for one donation (the donor's own confirm, the
      -- receipt outbox for up to three days, and the lost-donation sweep) — so a hash would either
      -- mail no link or re-mint one and silently kill the link already sitting in the donor's inbox.
      -- Nor would hashing buy much: the session_secret lives in this same file and mints admin
      -- session cookies, so anyone who can read this table can already reach the panel's own Stop
      -- button. (No backticks in here: this DDL is a JS template literal.)
      --
      -- CHECK(...) because a blank subscription_id would collapse every one-off donation onto one
      -- token; UNIQUE so re-rendering the letter always produces the SAME link. Rows are KEPT after
      -- a plan ends, so a donor clicking an old link reads "these payments have already stopped"
      -- rather than a frightening "this link doesn't work".
      CREATE TABLE IF NOT EXISTS plan_links (
        token TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL UNIQUE CHECK(length(subscription_id) > 0),
        created_at TEXT NOT NULL
      );
    `);
    // Tighten file perms where the OS supports it (secrets + admin hash live here).
    //
    // The DIRECTORY is locked down too, and that is the part that matters: SQLite creates
    // `donations.db-wal` and `-shm` sidecars itself, lazily, at default permissions — and in WAL
    // mode the most recent committed data (including a freshly saved Stripe secret key) lives in
    // the -wal file, not the 0600 database. chmod'ing the sidecars here would be a race, since they
    // are recreated on demand; 0700 on the directory covers every current and future file in it
    // (DONATIONS-028). Best-effort: a no-op on Windows dev boxes and on a volume the container does
    // not own, hence the swallowed error and the info-level note rather than a hard failure.
    for (const [target, mode] of [
      [path.dirname(dbPath), 0o700],
      [dbPath, 0o600],
    ] as const) {
      try {
        fs.chmodSync(target, mode);
      } catch {
        /* best-effort (e.g. Windows dev, or a volume we don't own) */
      }
    }
    // Add columns introduced after first release (CREATE TABLE IF NOT EXISTS won't).
    this.ensureColumn('campaigns', 'background_image', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('campaigns', 'logo', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('campaigns', 'allow_monthly', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('campaigns', 'thank_you', "TEXT NOT NULL DEFAULT ''");
    // Required campaign type + forced-fee flag. Legacy rows default to 'donation' (a valid
    // required type) with fees not forced — the back-compat answer for existing campaigns.
    this.ensureColumn('campaigns', 'type', "TEXT NOT NULL DEFAULT 'donation'");
    this.ensureColumn('campaigns', 'force_cover_fees', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('campaigns', 'widget_enabled', 'INTEGER NOT NULL DEFAULT 0');
    // Which Stripe account an appeal pays into. Legacy rows default to '' = "the site default",
    // which is precisely the behavior they had before this column existed — there is deliberately
    // NO backfill from stripe_account_id, because inferring a choice nobody made is how an existing
    // appeal would start charging a different bank account after an unattended overnight update.
    this.ensureColumn('campaigns', 'payment_account', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('donations', 'card_brand', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('donations', 'card_last4', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('donations', 'recurring', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('donations', 'subscription_id', "TEXT NOT NULL DEFAULT ''");
    // Legacy rows default to 'stripe' (their receipts were Stripe's built-in ones).
    this.ensureColumn('donations', 'receipt', "TEXT NOT NULL DEFAULT 'stripe'");
    // Refunds. Legacy rows default to 0 / '' = "nothing was given back", which is true of every
    // donation taken before refunds existed — and, because every money figure now subtracts this
    // column, a default of 0 also keeps existing totals exactly as they were.
    this.ensureColumn('donations', 'refunded_amount', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('donations', 'refunded_at', "TEXT NOT NULL DEFAULT ''");
    // The per-child split of a tuition charge (students/billing v2). Legacy rows default to ''
    // = "no split", which is exactly how they were pushed to Students before this existed.
    this.ensureColumn('student_payments', 'students_split', "TEXT NOT NULL DEFAULT ''");
    // The ticked bill lines of a tuition charge (students/billing §11.0b). Legacy rows default to
    // '' = "no lines", exactly how they were pushed to Students before itemized bills existed.
    this.ensureColumn('student_payments', 'payment_lines', "TEXT NOT NULL DEFAULT ''");
    // The processing fee the PAYER covered (students/billing §11.2 `info.fee`, Students 0.51.0).
    // Legacy rows default to 0 = "the school absorbed it", which is true of every tuition payment
    // taken before the feature existed — and 0 also means no `students_fee_cents` and no `feeCents`
    // on a retry, which is exactly how those rows were pushed the first time.
    this.ensureColumn('student_payments', 'fee_cents', 'INTEGER NOT NULL DEFAULT 0');
    this.migrateLegacyStripe();
    // Slugs are now the public link (/<slug>) and must be unique. Older data could
    // have duplicate or reserved slugs, so reconcile BEFORE enforcing the unique index.
    this.migrateCampaignSlugs();
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_slug ON campaigns(slug)');
    log.info(`data store ready at ${dbPath}`);
  }

  /** Add a column to an existing table if it isn't already there (forward migration). */
  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      log.info(`added column ${table}.${column}`);
    }
  }

  private getRaw(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  private setRaw(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** The HMAC secret that signs session cookies. Generated once and persisted, so
   *  sessions survive restarts but are invalidated if the data volume is wiped. */
  get secret(): Buffer {
    if (this.cachedSecret) return this.cachedSecret;
    let hex = this.getRaw('session_secret');
    if (!hex) {
      hex = crypto.randomBytes(32).toString('hex');
      this.setRaw('session_secret', hex);
    }
    this.cachedSecret = Buffer.from(hex, 'hex');
    return this.cachedSecret;
  }

  getAdmin(): Admin | null {
    const raw = this.getRaw('admin');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Admin;
    } catch {
      return null;
    }
  }

  hasAdmin(): boolean {
    return this.getRaw('admin') !== null;
  }

  setAdmin(cred: Cred, name?: string): void {
    const admin: Admin = { ...cred, name: name || undefined, createdAt: new Date().toISOString() };
    this.setRaw('admin', JSON.stringify(admin));
  }

  private getJson<T>(key: string): Partial<T> {
    const raw = this.getRaw(key);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Partial<T>;
    } catch {
      return {};
    }
  }

  /** Masjid profile: stored values take precedence over the env seeds. */
  getMasjid(): MasjidProfile {
    const s = this.getJson<MasjidProfile>('masjid');
    const seed = config.seed;
    return {
      name: s.name ?? seed.masjid.name,
      address: s.address ?? seed.masjid.address,
      email: s.email ?? seed.masjid.email,
      phone: s.phone ?? seed.masjid.phone,
      website: s.website ?? seed.masjid.website,
      currency: (s.currency ?? seed.currency ?? 'USD').toUpperCase() || 'USD',
      logo: s.logo ?? seed.masjid.logo,
    };
  }

  setMasjid(patch: Partial<MasjidProfile>): MasjidProfile {
    const merged = { ...this.getMasjid(), ...clean(patch) };
    if (merged.currency) merged.currency = merged.currency.toUpperCase();
    this.setRaw('masjid', JSON.stringify(merged));
    return merged;
  }

  /** Stripe config: stored values take precedence over the env seeds. Never return
   *  the result of this to the browser — it contains the secret key. */
  getStripe(): StripeConfig {
    const s = this.getJson<StripeConfig>('stripe');
    const seed = config.seed.stripe;
    return {
      publishableKey: s.publishableKey ?? seed.publishableKey,
      secretKey: s.secretKey ?? seed.secretKey,
      webhookSecret: s.webhookSecret ?? seed.webhookSecret,
    };
  }

  /** Apply a partial update. A provided '' clears that key; an omitted key is left
   *  untouched (so the admin can update one field without resending secrets). */
  setStripe(patch: Partial<StripeConfig>): StripeConfig {
    const current = this.getStripe();
    const merged: StripeConfig = {
      publishableKey: patch.publishableKey ?? current.publishableKey,
      secretKey: patch.secretKey ?? current.secretKey,
      webhookSecret: patch.webhookSecret ?? current.webhookSecret,
    };
    this.setRaw('stripe', JSON.stringify(merged));
    return merged;
  }

  /** The admin-chosen OpenMasjidOS-vault Stripe account id (picked on the in-app Payments
   *  screen from GET /api/fabric/stripe/accounts). '' = use the only/first vault account.
   *  Storing the id is fine (it is NOT a secret); the keys are always fetched fresh from
   *  the Fabric. Seeded from the STRIPE_ACCOUNT env for advanced/older installs. */
  getFabricStripeChoice(): string {
    return this.getRaw('fabric_stripe_account') ?? config.stripeAccount ?? '';
  }
  setFabricStripeChoice(id: string): void {
    this.setRaw('fabric_stripe_account', id);
  }

  /** The last decisive outcome of a Fabric email send ('ok' / 'not_configured' / …).
   *
   *  Persisted only so the app does not forget, on every restart, whether the masjid's OpenMasjidOS
   *  email provider works — which is what decides whether a donor's receipt may be a branded one of
   *  ours (Stripe's own suppressed) or must be left to Stripe. Not a secret, not a setting: a cached
   *  observation, and the live value in memory always wins. See fabric.ts `emailLikelyAvailable`. */
  /** What became of the last WhatsApp message we sent for one event.
   *
   *  Persisted rather than kept in memory because the whole point is to answer a question the admin
   *  asks LATER — "did the treasurer get told about that refund?" — and a dev-channel box restarts
   *  often. Deliberately holds no message text and no recipient: the state, the platform's own
   *  sentence, and when. One row per event, newest only; this is a health indicator on a settings
   *  screen, not an audit trail. */
  getWhatsAppOutcomes(): Record<string, WhatsAppEventOutcome> {
    const raw = this.getJson<Record<string, unknown>>('whatsapp_outcomes');
    const out: Record<string, WhatsAppEventOutcome> = {};
    for (const [event, v] of Object.entries(raw ?? {})) {
      if (!v || typeof v !== 'object') continue;
      const o = v as Record<string, unknown>;
      const state = String(o.state ?? '');
      if (!state) continue;
      out[event] = {
        state: state as WhatsAppEventOutcome['state'],
        reason: String(o.reason ?? '').slice(0, 200),
        at: String(o.at ?? ''),
      };
    }
    return out;
  }

  setWhatsAppOutcome(event: string, outcome: WhatsAppEventOutcome): void {
    const all = this.getWhatsAppOutcomes();
    all[event] = { state: outcome.state, reason: (outcome.reason || '').slice(0, 200), at: outcome.at };
    // Bounded by the number of declared events, so no pruning is needed.
    this.setRaw('whatsapp_outcomes', JSON.stringify(all));
  }

  getEmailStatus(): string {
    return this.getRaw('email_status') ?? '';
  }
  setEmailStatus(status: string): void {
    this.setRaw('email_status', status);
  }

  /**
   * Who gets told what. Never holds a donor's address or number — every recipient here is somebody
   * the admin typed in themselves (see NotifySettings).
   *
   * Reads from `notify`, and MIGRATES the old `whatsapp` key on first read if `notify` is absent.
   * That migration matters even though the old shape only ever shipped on 0.43.0-dev.2/3: a masjid
   * on the development channel configured real recipients, and losing them silently would mean the
   * refund notification they set up simply stops arriving with nothing to see.
   */
  getNotify(): NotifySettings {
    // `getJson` answers {} for a value that will not parse, so "present" is not enough: a truncated
    // write would otherwise drop a dev.3 masjid onto all-defaults AND skip the migration, losing the
    // recipients they configured with nothing to show why.
    const stored = this.getRaw('notify') ? this.getJson<NotifySettings>('notify') : {};
    const s: NotifyPatch = Object.keys(stored).length > 0 ? stored : this.migrateWhatsAppSettings();
    const events = {} as Record<NotifyEventId, NotifyChannels>;
    const given = (s.events ?? {}) as Partial<Record<NotifyEventId, Partial<NotifyChannels>>>;
    for (const id of NOTIFY_EVENTS) {
      const c = given[id] ?? {};
      events[id] = {
        // An event the stored settings say nothing about — a fresh install, or one added by an
        // update — takes the same default as a new install would, so there is exactly one answer to
        // "is this on?" and `donation` cannot become a flood by the back door.
        os: typeof c.os === 'boolean' ? c.os : NOTIFY_DEFAULT.events[id].os,
        email: typeof c.email === 'string' ? c.email.trim().slice(0, 200) : '',
        whatsapp: typeof c.whatsapp === 'string' ? c.whatsapp.trim().slice(0, 64) : '',
        // Absent on a row written before the switch existed: a stored number meant "on" then, and
        // must keep meaning it now, or an upgrade silently stops a masjid's WhatsApp messages.
        whatsappOn: typeof c.whatsappOn === 'boolean' ? c.whatsappOn : !!(typeof c.whatsapp === 'string' && c.whatsapp.trim()),
      };
    }
    return {
      defaultEmail: typeof s.defaultEmail === 'string' ? s.defaultEmail.trim().slice(0, 200) : '',
      defaultWhatsapp: typeof s.defaultWhatsapp === 'string' ? s.defaultWhatsapp.trim().slice(0, 64) : '',
      minAmount: Math.max(0, Math.round(s.minAmount ?? 0)),
      events,
    };
  }

  /**
   * Carry a 0.43.0-dev WhatsApp configuration into the per-event model. Read-only — the result is
   * persisted by the next `setNotify`, so a masjid that never opens the screen keeps being migrated
   * consistently on every boot rather than depending on a write having happened.
   *
   * The old shape had ONE list of numbers plus an optional group, and per-event booleans. A single
   * destination per event is the new shape, so we take the first number if there was one and fall
   * back to the group — and only for events that were actually switched on, and only if the whole
   * feature was enabled. `os` comes out true throughout, which is the new default and matches what
   * those masjids were already getting from the alerts matrix.
   */
  private migrateWhatsAppSettings(): NotifyPatch {
    const old = this.getJson<{
      enabled?: boolean;
      numbers?: unknown;
      groupId?: string;
      events?: Partial<Record<string, boolean>>;
      minAmount?: number;
    }>('whatsapp');
    if (!old || Object.keys(old).length === 0) return {};
    const numbers = (Array.isArray(old.numbers) ? old.numbers : []).filter((n): n is string => typeof n === 'string' && !!n.trim());
    const target = old.enabled ? (numbers[0] ?? (old.groupId || '')) : '';
    const events: Partial<Record<NotifyEventId, Partial<NotifyChannels>>> = {};
    for (const id of NOTIFY_EVENTS) {
      // `donationRecovered` is new and had no old toggle; it follows the `donation` choice, which is
      // the same kind of news about the same money.
      const wasOn = !!old.events?.[id === 'donationRecovered' ? 'donation' : id];
      // `os` takes the SAME default a fresh install would, rather than being hardcoded, so there is
      // exactly one answer anywhere to "is this channel on by default?".
      events[id] = { os: NOTIFY_DEFAULT.events[id].os, email: '', whatsapp: wasOn ? target : '', whatsappOn: wasOn && !!target };
    }
    // Deliberately silent. `raise()` reads these settings on EVERY notification, and this runs until
    // something writes `notify` — so a line here would print once per donation, for ever, on a box
    // whose admin never opens the screen.
    return { minAmount: Math.max(0, Math.round(old.minAmount ?? 0)), defaultWhatsapp: target, events };
  }

  setNotify(patch: NotifyPatch): NotifySettings {
    const cur = this.getNotify();
    const events = { ...cur.events };
    for (const [id, c] of Object.entries(patch.events ?? {})) {
      if (!(NOTIFY_EVENTS as readonly string[]).includes(id)) continue; // ignore an unknown event id
      events[id as NotifyEventId] = { ...events[id as NotifyEventId], ...clean(c ?? {}) };
    }
    const merged: NotifySettings = { ...cur, ...clean({ ...patch, events: undefined }), events };
    merged.minAmount = Math.max(0, Math.round(merged.minAmount));
    this.setRaw('notify', JSON.stringify(merged));
    return merged;
  }

  /** Cached Stripe Product id per account + mode (test/live), for recurring prices. */
  getStripeProduct(accountId: string, mode: string): string | null {
    return this.getRaw(`stripe_product:${accountId}:${mode}`);
  }
  setStripeProduct(accountId: string, mode: string, id: string): void {
    this.setRaw(`stripe_product:${accountId}:${mode}`, id);
  }

  isOnboarded(): boolean {
    return this.getRaw('onboarded') === '1';
  }

  setOnboarded(): void {
    this.setRaw('onboarded', '1');
  }

  // ── Cloudflare Tunnel (optional public access) ──────────────────────────────
  getTunnel(): TunnelConfig {
    const s = this.getJson<TunnelConfig>('tunnel');
    return { token: s.token ?? '', enabled: s.enabled ?? false, publicHostname: s.publicHostname ?? '' };
  }

  setTunnel(patch: Partial<TunnelConfig>): TunnelConfig {
    const cur = this.getTunnel();
    const next: TunnelConfig = {
      token: patch.token ?? cur.token,
      enabled: patch.enabled ?? cur.enabled,
      publicHostname: patch.publicHostname ?? cur.publicHostname,
    };
    this.setRaw('tunnel', JSON.stringify(next));
    return next;
  }

  // ── Legacy migration: fold the old single Stripe config into an account ─────
  private migrateLegacyStripe(): void {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM stripe_accounts').get() as { n: number }).n;
    if (n > 0) return;
    const legacy = this.getStripe();
    if (legacy.publishableKey || legacy.secretKey) {
      this.createStripeAccount({ label: 'Main account', ...legacy });
      log.info('migrated the existing Stripe config into a default account');
    }
  }

  // ── Slugs: the public link is /<slug>, so slugs must be unique + not reserved ──
  /** Is this slug free to use? (Not reserved, and not held by another campaign.) */
  isSlugAvailable(slug: string, exceptId?: string): boolean {
    if (!slug || RESERVED_SLUGS.has(slug)) return false;
    const row = this.db.prepare('SELECT id FROM campaigns WHERE slug = ?').get(slug) as { id: string } | undefined;
    return !row || row.id === exceptId;
  }

  /** A guaranteed-free slug derived from `base`, appending -2, -3, … on collision. */
  uniqueSlug(base: string, exceptId?: string): string {
    const root = slugify(base);
    if (this.isSlugAvailable(root, exceptId)) return root;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${root.slice(0, 37)}-${n}`;
      if (this.isSlugAvailable(candidate, exceptId)) return candidate;
    }
    return `${root.slice(0, 30)}-${rid('x').slice(2)}`;
  }

  /** One-off reconcile: rename any reserved or duplicate slugs so the unique index
   *  can be created. Order by creation so the oldest campaign keeps its original slug. */
  private migrateCampaignSlugs(): void {
    const rows = this.db.prepare('SELECT id, slug FROM campaigns ORDER BY created_at, id').all() as { id: string; slug: string }[];
    const seen = new Set<string>();
    for (const r of rows) {
      let slug = slugify(r.slug || '');
      if (RESERVED_SLUGS.has(slug) || seen.has(slug)) {
        // Derive a fresh unique slug, avoiding the ones we've already locked in.
        let candidate = this.uniqueSlug(slug, r.id);
        while (seen.has(candidate)) candidate = this.uniqueSlug(`${slug}-x`, r.id);
        slug = candidate;
        this.db.prepare('UPDATE campaigns SET slug = ? WHERE id = ?').run(slug, r.id);
        log.info(`migrated campaign ${r.id} to slug "${slug}"`);
      }
      seen.add(slug);
    }
  }

  // ── Stripe accounts ─────────────────────────────────────────────────────────
  private rowToAccount(r: Record<string, unknown>): StripeAccount {
    return {
      id: String(r.id),
      label: String(r.label),
      publishableKey: String(r.publishable_key),
      secretKey: String(r.secret_key),
      webhookSecret: String(r.webhook_secret),
      createdAt: String(r.created_at),
    };
  }

  listStripeAccounts(): StripeAccount[] {
    return (this.db.prepare('SELECT * FROM stripe_accounts ORDER BY created_at').all() as Record<string, unknown>[]).map((r) =>
      this.rowToAccount(r),
    );
  }

  getStripeAccount(id: string): StripeAccount | null {
    const r = this.db.prepare('SELECT * FROM stripe_accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToAccount(r) : null;
  }

  createStripeAccount(input: { label: string } & Partial<StripeConfig>): StripeAccount {
    const acct: StripeAccount = {
      id: rid('acct'),
      label: input.label || 'Stripe account',
      publishableKey: input.publishableKey ?? '',
      secretKey: input.secretKey ?? '',
      webhookSecret: input.webhookSecret ?? '',
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO stripe_accounts (id, label, publishable_key, secret_key, webhook_secret, created_at)
         VALUES (@id, @label, @publishableKey, @secretKey, @webhookSecret, @createdAt)`,
      )
      .run(acct);
    return acct;
  }

  /** Partial update; '' clears a key, omitted leaves it (so secrets aren't resent). */
  updateStripeAccount(id: string, patch: Partial<Omit<StripeAccount, 'id' | 'createdAt'>>): StripeAccount | null {
    const cur = this.getStripeAccount(id);
    if (!cur) return null;
    const next: StripeAccount = { ...cur, ...clean(patch) };
    this.db
      .prepare(
        `UPDATE stripe_accounts SET label=@label, publishable_key=@publishableKey, secret_key=@secretKey,
         webhook_secret=@webhookSecret WHERE id=@id`,
      )
      .run(next);
    return next;
  }

  /** How many campaigns depend on this local account — through EITHER the legacy column or an
   *  explicit 'local:<id>' choice. Missing the second one would let an admin delete an account a
   *  live appeal is pinned to, and that appeal would then refuse every donation. */
  campaignsForAccount(id: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM campaigns WHERE stripe_account_id = ? OR payment_account = ?')
        .get(id, formatPaymentAccount('device', id)) as { n: number }
    ).n;
  }

  /** How many donations / tuition payments were TAKEN on this account. Money already taken is the
   *  stronger claim: confirming, refunding, and canceling a monthly plan all re-resolve the account
   *  from the row, so deleting it would strand those records for ever — including leaving a card
   *  mandate that neither the admin nor the donor could stop. */
  paymentsForAccount(id: string): number {
    const d = (this.db.prepare('SELECT COUNT(*) AS n FROM donations WHERE stripe_account_id = ?').get(id) as { n: number }).n;
    const s = (this.db.prepare('SELECT COUNT(*) AS n FROM student_payments WHERE stripe_account_id = ?').get(id) as { n: number }).n;
    return d + s;
  }

  deleteStripeAccount(id: string): { ok: boolean; reason?: string } {
    if (this.campaignsForAccount(id) > 0) return { ok: false, reason: 'in-use' };
    if (this.paymentsForAccount(id) > 0) return { ok: false, reason: 'has-payments' };
    this.db.prepare('DELETE FROM stripe_accounts WHERE id = ?').run(id);
    return { ok: true };
  }

  /** Every account id this installation could legitimately be asked about: the ones campaigns point
   *  at, the ones money was actually taken on, and the site default. Bare ids, as recorded on rows.
   *
   *  This is a GUARD, not a convenience. accountById is reached from the UNAUTHENTICATED Stripe
   *  webhook (/api/stripe/webhook/:accountId), so without a known-id bound a stranger could make the
   *  app fetch arbitrary account names from the platform vault — an amplifier against the platform,
   *  and a way to flush the in-memory key cache that keeps donations alive through a blip. */
  knownAccountIds(): Set<string> {
    const out = new Set<string>();
    const add = (v: unknown) => {
      const t = String(v ?? '').trim();
      if (t) out.add(t);
    };
    for (const r of this.db.prepare('SELECT id FROM stripe_accounts').all() as { id: string }[]) add(r.id);
    for (const r of this.db.prepare('SELECT DISTINCT stripe_account_id AS a FROM donations').all() as { a: string }[]) add(r.a);
    for (const r of this.db.prepare('SELECT DISTINCT stripe_account_id AS a FROM student_payments').all() as { a: string }[]) add(r.a);
    for (const r of this.db.prepare('SELECT DISTINCT stripe_account_id AS a FROM campaigns').all() as { a: string }[]) add(r.a);
    // Explicit per-campaign choices, unwrapped to the bare id the vault/local table knows.
    for (const r of this.db.prepare("SELECT DISTINCT payment_account AS a FROM campaigns WHERE payment_account <> ''").all() as { a: string }[]) {
      const parsed = parsePaymentAccount(r.a);
      if (parsed.kind === 'openmasjidos' || parsed.kind === 'device') add(parsed.id);
    }
    add(this.getFabricStripeChoice());
    return out;
  }

  // ── Campaigns ─────────────────────────────────────────────────────────────
  private rowToCampaign(r: Record<string, unknown>): Campaign {
    let presets: number[] = [];
    try {
      presets = JSON.parse(String(r.preset_amounts)) as number[];
    } catch {
      /* keep [] */
    }
    return {
      id: String(r.id),
      slug: String(r.slug),
      token: String(r.token),
      title: String(r.title),
      type: ((['donation', 'zakat', 'tuition'] as const).includes(String(r.type) as CampaignType) ? String(r.type) : 'donation') as CampaignType,
      description: String(r.description),
      coverImage: String(r.cover_image),
      backgroundImage: String(r.background_image ?? ''),
      logo: String(r.logo ?? ''),
      presetAmounts: Array.isArray(presets) ? presets : [],
      allowCustom: !!r.allow_custom,
      minAmount: Number(r.min_amount),
      maxAmount: Number(r.max_amount),
      stripeAccountId: String(r.stripe_account_id),
      paymentAccount: String(r.payment_account ?? ''),
      coverFees: !!r.cover_fees,
      forceCoverFees: !!r.force_cover_fees,
      giftAid: !!r.gift_aid,
      allowMonthly: !!r.allow_monthly,
      widgetEnabled: !!r.widget_enabled,
      goalAmount: Number(r.goal_amount),
      active: !!r.active,
      sortOrder: Number(r.sort_order),
      thankYou: this.parseThankYou(r.thank_you),
      createdAt: String(r.created_at),
    };
  }

  /** Parse a stored per-campaign thank-you override; missing/invalid → empty (inherit). */
  private parseThankYou(raw: unknown): ThankYou {
    if (typeof raw !== 'string' || !raw) return { ...THANKYOU_EMPTY };
    try {
      const o = JSON.parse(raw) as Partial<ThankYou>;
      return {
        heading: typeof o.heading === 'string' ? o.heading : '',
        message: typeof o.message === 'string' ? o.message : '',
        backgroundImage: typeof o.backgroundImage === 'string' ? o.backgroundImage : '',
        accent: typeof o.accent === 'string' ? o.accent : '',
      };
    } catch {
      return { ...THANKYOU_EMPTY };
    }
  }

  /** The global default thank-you (admin-editable), merged over the built-in default. */
  getThankYou(): ThankYou {
    const s = this.getJson<ThankYou>('thankyou');
    return {
      heading: s.heading ?? THANKYOU_DEFAULT.heading,
      message: s.message ?? THANKYOU_DEFAULT.message,
      backgroundImage: s.backgroundImage ?? THANKYOU_DEFAULT.backgroundImage,
      accent: s.accent ?? THANKYOU_DEFAULT.accent,
    };
  }

  setThankYou(patch: Partial<ThankYou>): ThankYou {
    const merged = { ...this.getThankYou(), ...clean(patch) };
    this.setRaw('thankyou', JSON.stringify(merged));
    return merged;
  }

  /** Global large-donation alternative (admin-editable). threshold is MINOR units. */
  getLargeDonation(): LargeDonation {
    const s = this.getJson<LargeDonation>('large_donation');
    return {
      threshold: Math.max(0, Math.round(Number(s.threshold) || 0)),
      message: s.message ?? LARGE_DONATION_DEFAULT.message,
      qrImage: s.qrImage ?? LARGE_DONATION_DEFAULT.qrImage,
    };
  }

  setLargeDonation(patch: Partial<LargeDonation>): LargeDonation {
    const merged = { ...this.getLargeDonation(), ...clean(patch) };
    merged.threshold = Math.max(0, Math.round(Number(merged.threshold) || 0));
    merged.message = String(merged.message ?? '').slice(0, 600);
    // Only accept a same-origin uploaded image or an http(s) URL — reject javascript:/data:
    // and anything with quotes/backslashes/whitespace that could break an <img>/url().
    const u = String(merged.qrImage ?? '').trim().slice(0, 500);
    merged.qrImage = /^\/uploads\/[A-Za-z0-9._-]+$/.test(u) || /^https?:\/\/[^"'\\\s]+$/i.test(u) ? u : '';
    this.setRaw('large_donation', JSON.stringify(merged));
    return merged;
  }

  /** The emailed donation-receipt template (admin-editable). Off by default. */
  getEmailReceipt(): EmailReceipt {
    const s = this.getJson<EmailReceipt>('email_receipt');
    return {
      enabled: s.enabled ?? EMAIL_RECEIPT_DEFAULT.enabled,
      subject: s.subject ?? EMAIL_RECEIPT_DEFAULT.subject,
      heading: s.heading ?? EMAIL_RECEIPT_DEFAULT.heading,
      body: s.body ?? EMAIL_RECEIPT_DEFAULT.body,
      accent: s.accent ?? EMAIL_RECEIPT_DEFAULT.accent,
    };
  }

  setEmailReceipt(patch: Partial<EmailReceipt>): EmailReceipt {
    const merged = { ...this.getEmailReceipt(), ...clean(patch) };
    merged.enabled = !!merged.enabled;
    merged.subject = String(merged.subject ?? '').slice(0, 200);
    merged.heading = String(merged.heading ?? '').slice(0, 200);
    merged.body = String(merged.body ?? '').slice(0, 4000);
    const a = String(merged.accent ?? '').trim();
    merged.accent = /^#[0-9a-fA-F]{3,8}$/.test(a) ? a : '';
    this.setRaw('email_receipt', JSON.stringify(merged));
    return merged;
  }

  private writeCampaign(c: Campaign): void {
    this.db
      .prepare(
        `INSERT INTO campaigns
          (id, slug, token, title, type, description, cover_image, background_image, logo, preset_amounts, allow_custom, min_amount,
           max_amount, stripe_account_id, payment_account, cover_fees, force_cover_fees, gift_aid, allow_monthly, widget_enabled, goal_amount, active, sort_order, thank_you, created_at)
         VALUES
          (@id, @slug, @token, @title, @type, @description, @coverImage, @backgroundImage, @logo, @presetAmounts, @allowCustom, @minAmount,
           @maxAmount, @stripeAccountId, @paymentAccount, @coverFees, @forceCoverFees, @giftAid, @allowMonthly, @widgetEnabled, @goalAmount, @active, @sortOrder, @thankYou, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           slug=excluded.slug, title=excluded.title, type=excluded.type, description=excluded.description, cover_image=excluded.cover_image,
           background_image=excluded.background_image, logo=excluded.logo, preset_amounts=excluded.preset_amounts,
           allow_custom=excluded.allow_custom, min_amount=excluded.min_amount, max_amount=excluded.max_amount,
           stripe_account_id=excluded.stripe_account_id, payment_account=excluded.payment_account,
           cover_fees=excluded.cover_fees, force_cover_fees=excluded.force_cover_fees,
           gift_aid=excluded.gift_aid, allow_monthly=excluded.allow_monthly, widget_enabled=excluded.widget_enabled,
           goal_amount=excluded.goal_amount, active=excluded.active, sort_order=excluded.sort_order, thank_you=excluded.thank_you`,
      )
      .run({
        ...c,
        presetAmounts: JSON.stringify(c.presetAmounts),
        allowCustom: c.allowCustom ? 1 : 0,
        coverFees: c.coverFees ? 1 : 0,
        forceCoverFees: c.forceCoverFees ? 1 : 0,
        giftAid: c.giftAid ? 1 : 0,
        allowMonthly: c.allowMonthly ? 1 : 0,
        widgetEnabled: c.widgetEnabled ? 1 : 0,
        active: c.active ? 1 : 0,
        thankYou: JSON.stringify(c.thankYou ?? THANKYOU_EMPTY),
      });
  }

  listCampaigns(): Campaign[] {
    return (this.db.prepare('SELECT * FROM campaigns ORDER BY sort_order, created_at').all() as Record<string, unknown>[]).map((r) =>
      this.rowToCampaign(r),
    );
  }

  getCampaign(id: string): Campaign | null {
    const r = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToCampaign(r) : null;
  }

  /** Resolve a campaign by its (now unique) slug — the primary public lookup. */
  getCampaignBySlug(slug: string): Campaign | null {
    const r = this.db.prepare('SELECT * FROM campaigns WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;
    return r ? this.rowToCampaign(r) : null;
  }

  /** Back-compat lookup for older /c/<slug>-<token> links. */
  getCampaignBySlugToken(slug: string, token: string): Campaign | null {
    const r = this.db.prepare('SELECT * FROM campaigns WHERE slug = ? AND token = ?').get(slug, token) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToCampaign(r) : null;
  }

  /** Enforce the type→fee rule (the single source of truth, so a hand-crafted API body
   *  can't create a non-enforcing Zakat campaign): Zakat always forces the fee onto the
   *  donor; Donation never forces it (coverFees stays the admin's optional offer); Tuition
   *  has NO card-fee at all — it's a Students-billing shell where the parent pays the exact
   *  school balance (a fee gross-up would overpay an invoice and break Students' allocation),
   *  so both flags are forced off regardless of the body. */
  private deriveFees(c: Campaign): Campaign {
    if (c.type === 'zakat') {
      c.forceCoverFees = true; // Zakat: always enforced…
      c.coverFees = true; // …and offering is implied.
    } else if (c.type === 'tuition') {
      // Tuition (Students billing): the amount is the school balance, exact — never grossed up.
      c.coverFees = false;
      c.forceCoverFees = false;
    } else {
      // Donation: never forced; coverFees stays the admin's optional offer.
      c.forceCoverFees = false;
    }
    return c;
  }

  createCampaign(input: Partial<Campaign> & { title: string; stripeAccountId: string }): Campaign {
    const maxSort = (this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM campaigns').get() as { m: number }).m;
    const c: Campaign = {
      id: rid('cmp'),
      slug: input.slug || slugify(input.title),
      token: campaignToken(),
      title: input.title,
      type: input.type ?? 'donation',
      description: input.description ?? '',
      coverImage: input.coverImage ?? '',
      backgroundImage: input.backgroundImage ?? '',
      logo: input.logo ?? '',
      presetAmounts: input.presetAmounts ?? [],
      allowCustom: input.allowCustom ?? true,
      minAmount: input.minAmount ?? 100,
      maxAmount: input.maxAmount ?? 0,
      stripeAccountId: input.stripeAccountId,
      paymentAccount: input.paymentAccount ?? '',
      coverFees: input.coverFees ?? false,
      forceCoverFees: input.forceCoverFees ?? false,
      giftAid: input.giftAid ?? false,
      allowMonthly: input.allowMonthly ?? false,
      widgetEnabled: input.widgetEnabled ?? false,
      goalAmount: input.goalAmount ?? 0,
      active: input.active ?? true,
      sortOrder: maxSort + 1,
      thankYou: input.thankYou ?? { ...THANKYOU_EMPTY },
      createdAt: new Date().toISOString(),
    };
    this.writeCampaign(this.deriveFees(c));
    return c;
  }

  updateCampaign(id: string, patch: Partial<Campaign>): Campaign | null {
    const cur = this.getCampaign(id);
    if (!cur) return null;
    // id/token/createdAt are immutable.
    const next: Campaign = { ...cur, ...clean(patch), id: cur.id, token: cur.token, createdAt: cur.createdAt };
    this.writeCampaign(this.deriveFees(next));
    return next;
  }

  deleteCampaign(id: string): void {
    this.db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  }

  // ── Donations ───────────────────────────────────────────────────────────────
  private rowToDonation(r: Record<string, unknown>): Donation {
    return {
      id: String(r.id),
      campaignId: String(r.campaign_id),
      stripeAccountId: String(r.stripe_account_id),
      amount: Number(r.amount),
      currency: String(r.currency),
      status: String(r.status) as Donation['status'],
      donorName: String(r.donor_name),
      donorEmail: String(r.donor_email),
      coverFees: !!r.cover_fees,
      giftAid: !!r.gift_aid,
      paymentIntentId: String(r.payment_intent_id),
      cardBrand: String(r.card_brand ?? ''),
      cardLast4: String(r.card_last4 ?? ''),
      recurring: !!r.recurring,
      subscriptionId: String(r.subscription_id ?? ''),
      refundedAmount: Number(r.refunded_amount ?? 0),
      refundedAt: String(r.refunded_at ?? ''),
      receipt: (['stripe', 'pending', 'sent', 'skipped'] as const).includes(String(r.receipt) as Donation['receipt'])
        ? (String(r.receipt) as Donation['receipt'])
        : 'stripe',
      createdAt: String(r.created_at),
    };
  }

  createDonation(
    input: Omit<
      Donation,
      'id' | 'createdAt' | 'status' | 'cardBrand' | 'cardLast4' | 'recurring' | 'subscriptionId' | 'receipt' | 'refundedAmount' | 'refundedAt'
    > & {
      status?: Donation['status'];
      recurring?: boolean;
      subscriptionId?: string;
      receipt?: Donation['receipt'];
      /** Normally omitted (the row is created as the payment starts, so "now" is right).
       *  The Monthly-plans reconciliation passes it because it is catching up on a renewal
       *  Stripe charged weeks ago: stamping it with today's date would put the money in the
       *  wrong month in the donations log and in the 6-month trend chart. */
      createdAt?: string;
      /** Also normally omitted — card details are unknown until the payment confirms and are
       *  filled in by markDonation. A reconciled renewal already knows them (copied from the
       *  plan's first donation), so it can supply them up front. */
      cardBrand?: string;
      cardLast4?: string;
    },
  ): Donation {
    // Defaults come AFTER the spread and read from `input`, so an explicitly-passed
    // `undefined` still falls back instead of writing undefined into the row.
    const d: Donation = {
      ...input,
      id: rid('don'),
      status: input.status ?? 'pending',
      cardBrand: input.cardBrand ?? '',
      cardLast4: input.cardLast4 ?? '',
      recurring: input.recurring ?? false,
      subscriptionId: input.subscriptionId ?? '',
      // A brand-new donation has never been refunded — there is no path that creates one that
      // has, so this is not an input the caller may set (only setDonationRefund moves it).
      refundedAmount: 0,
      refundedAt: '',
      receipt: input.receipt ?? 'stripe',
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO donations
          (id, campaign_id, stripe_account_id, amount, currency, status, donor_name, donor_email, cover_fees, gift_aid,
           payment_intent_id, card_brand, card_last4, recurring, subscription_id, receipt, created_at)
         VALUES
          (@id, @campaignId, @stripeAccountId, @amount, @currency, @status, @donorName, @donorEmail, @coverFees, @giftAid,
           @paymentIntentId, @cardBrand, @cardLast4, @recurring, @subscriptionId, @receipt, @createdAt)`,
      )
      .run({ ...d, coverFees: d.coverFees ? 1 : 0, giftAid: d.giftAid ? 1 : 0, recurring: d.recurring ? 1 : 0 });
    return d;
  }

  /** One donation by its own id — the key the admin panel holds for a row it is showing.
   *  (Everything on the donor side keys off the PaymentIntent instead; this is for the panel.) */
  getDonation(id: string): Donation | null {
    const r = this.db.prepare('SELECT * FROM donations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToDonation(r) : null;
  }

  getDonationByPaymentIntent(pi: string): Donation | null {
    const r = this.db.prepare('SELECT * FROM donations WHERE payment_intent_id = ?').get(pi) as Record<string, unknown> | undefined;
    return r ? this.rowToDonation(r) : null;
  }

  /** The original donation for a subscription (used to attribute renewal charges). */
  getDonationBySubscription(subscriptionId: string): Donation | null {
    const r = this.db.prepare('SELECT * FROM donations WHERE subscription_id = ? ORDER BY created_at LIMIT 1').get(subscriptionId) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToDonation(r) : null;
  }

  /** Mark a donation's outcome (idempotent — safe to call repeatedly on confirm).
   *  Also records the donor name/email and card brand/last4 from Stripe when given. */
  markDonation(
    pi: string,
    status: Donation['status'],
    opts: { donorName?: string; donorEmail?: string; cardBrand?: string; cardLast4?: string } = {},
  ): Donation | null {
    const cur = this.getDonationByPaymentIntent(pi);
    if (!cur) return null;
    this.db
      .prepare(
        `UPDATE donations SET status=@status, donor_name=@donorName, donor_email=@donorEmail,
         card_brand=@cardBrand, card_last4=@cardLast4 WHERE payment_intent_id=@pi`,
      )
      .run({
        pi,
        status,
        donorName: opts.donorName ?? cur.donorName,
        donorEmail: opts.donorEmail ?? cur.donorEmail,
        cardBrand: opts.cardBrand || cur.cardBrand,
        cardLast4: opts.cardLast4 || cur.cardLast4,
      });
    return this.getDonationByPaymentIntent(pi);
  }

  /** Record how much of a donation has been refunded, as a RUNNING TOTAL in minor units — the
   *  figure Stripe reports for the charge (`amount_refunded`), not the size of one refund.
   *
   *  Three guards, and each of them is load-bearing:
   *   • MONOTONIC. The value may only ever rise. Two things write here — an admin's refund in the
   *     panel and a `charge.refunded` webhook — and Stripe delivers webhooks with no ordering
   *     guarantee, so a retry of the FIRST refund's event can arrive after a second refund. Taking
   *     it at face value would quietly put money back into the masjid's totals.
   *   • CLAMPED to the amount charged, so a currency/rounding surprise can never make a donation
   *     read as more-than-refunded (which would show as negative money raised).
   *   • The TIMESTAMP only moves when the amount does, so a duplicate event can't restamp a
   *     week-old refund as today's.
   *
   *  Returns the row as it now stands, or null if there is no donation for that PaymentIntent. */
  setDonationRefund(pi: string, refundedMinor: number, atIso: string): Donation | null {
    const cur = this.getDonationByPaymentIntent(pi);
    if (!cur) return null;
    const next = Math.min(Math.max(0, Math.round(refundedMinor)), cur.amount);
    if (next <= cur.refundedAmount) return cur; // nothing new — an out-of-order or replayed event
    this.db
      .prepare('UPDATE donations SET refunded_amount = ?, refunded_at = ? WHERE payment_intent_id = ?')
      .run(next, atIso || new Date().toISOString(), pi);
    return this.getDonationByPaymentIntent(pi);
  }

  /** Every donation row that belongs to a monthly (subscription) plan, OLDEST FIRST so the
   *  first row of each subscription is the plan's origin. This is the whole index behind the
   *  admin "Monthly plans" tab — and the reason a subscription we did not create can never
   *  appear there (it has no row here), and the reason tuition can never appear (a tuition
   *  payment is written to `student_payments`, never to `donations`). */
  listRecurringDonations(): Donation[] {
    return (
      this.db.prepare(`SELECT * FROM donations WHERE recurring = 1 AND subscription_id <> '' ORDER BY created_at ASC`).all() as Record<
        string,
        unknown
      >[]
    ).map((r) => this.rowToDonation(r));
  }

  // ── The monthly donor's "stop these payments" link ──────────────────────────
  /** The token for this subscription's stop link, minting one on first need.
   *
   *  GET-OR-CREATE, and that is the whole point: the letter carrying this link is rendered up to
   *  three times for one donation (the donor's own confirm, the receipt outbox retrying for up to
   *  three days, and the lost-donation sweep), and every render must produce the SAME URL. Minting a
   *  fresh token per render would leave whichever letter actually arrived pointing at a dead link.
   *
   *  Returns '' for a blank subscription id (a one-off donation has no plan to stop). */
  ensurePlanLink(subscriptionId: string): string {
    if (!subscriptionId) return '';
    const read = (): string => {
      const r = this.db.prepare('SELECT token FROM plan_links WHERE subscription_id = ?').get(subscriptionId) as { token: string } | undefined;
      return r?.token ?? '';
    };
    const existing = read();
    if (existing) return existing;
    const token = planLinkToken();
    try {
      this.db.prepare('INSERT INTO plan_links (token, subscription_id, created_at) VALUES (?, ?, ?)').run(token, subscriptionId, new Date().toISOString());
      return token;
    } catch {
      // Lost the UNIQUE race with a concurrent render — the other one wrote a token, so use theirs
      // rather than failing the letter.
      return read();
    }
  }

  /** The subscription a stop-link token belongs to, or '' when the token is unknown.
   *
   *  Shape-checked first so a junk path never reaches SQLite. Note this deliberately says nothing
   *  about whether the plan is one of OURS or still running — the caller must resolve it through the
   *  local recurring-donations index (see plans.ts groupPlanSeeds) before acting on it. */
  planLinkSubscription(token: string): string {
    if (!looksLikePlanToken(token)) return '';
    const r = this.db.prepare('SELECT subscription_id FROM plan_links WHERE token = ?').get(token) as { subscription_id: string } | undefined;
    return r?.subscription_id ?? '';
  }

  // ── Audit log (append-only) ─────────────────────────────────────────────────
  /** Record one admin action. Never throws: an audit write must not be able to fail the action it
   *  is describing (a masjid losing the ability to cancel a plan because a log insert failed would
   *  be a worse outcome than a missing log line — the failure is logged instead). */
  recordAudit(action: string, opts: { actor?: string; subject?: string; detail?: string } = {}): void {
    try {
      this.db
        .prepare('INSERT INTO audit_log (id, at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rid('aud'), new Date().toISOString(), (opts.actor ?? '').slice(0, 120), action.slice(0, 60), (opts.subject ?? '').slice(0, 120), (opts.detail ?? '').slice(0, 300));
    } catch (e) {
      log.warn(`couldn’t write the audit log: ${e instanceof Error ? e.message : 'error'}`);
    }
  }

  /** Most recent audit entries, newest first.
   *
   *  Ordered by `rowid`, i.e. INSERTION order, not by the `at` timestamp. Two actions in the same
   *  millisecond share an `at`, and the id tie-break is random hex — so ordering on `at` returned
   *  them in an arbitrary order (caught by store.test.ts). Insertion order is also immune to the
   *  clock stepping backwards, which an unattended Pi syncing NTP after a long outage really does. */
  listAudit(limit = 200): AuditEntry[] {
    return (this.db.prepare('SELECT * FROM audit_log ORDER BY rowid DESC LIMIT ?').all(Math.max(1, Math.min(1000, limit))) as Record<string, unknown>[]).map(
      (r) => ({
        id: String(r.id),
        at: String(r.at),
        actor: String(r.actor ?? ''),
        action: String(r.action),
        subject: String(r.subject ?? ''),
        detail: String(r.detail ?? ''),
      }),
    );
  }

  listDonations(): Donation[] {
    return (this.db.prepare('SELECT * FROM donations ORDER BY created_at DESC').all() as Record<string, unknown>[]).map((r) =>
      this.rowToDonation(r),
    );
  }

  /** Set the branded-receipt lifecycle state for a donation (idempotent). */
  setDonationReceipt(pi: string, receipt: Donation['receipt']): void {
    this.db.prepare('UPDATE donations SET receipt = ? WHERE payment_intent_id = ?').run(receipt, pi);
  }

  /** Succeeded donations that still owe a branded receipt (receipt='pending') and are recent
   *  enough to bother retrying — the outbox drains these when the email provider recovers. */
  listPendingReceipts(maxAgeMs: number, limit = 50): Donation[] {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return (
      this.db
        .prepare(`SELECT * FROM donations WHERE status = 'succeeded' AND receipt = 'pending' AND created_at >= ? ORDER BY created_at LIMIT ?`)
        .all(cutoff, limit) as Record<string, unknown>[]
    ).map((r) => this.rowToDonation(r));
  }

  /** One-time donations still sitting at 'pending', old enough that the donor's browser is never
   *  coming back, and young enough to be worth asking Stripe about (DONATIONS-002).
   *
   *  A one-time payment is only marked succeeded by the donor's own `/confirm` callback, so a closed
   *  tab, a lost signal or a momentarily unreachable box leaves money taken at Stripe and NOTHING
   *  recorded here — missing from the ledger, the CSV, the totals and the goal bar, with no receipt,
   *  for ever. This feeds the sweep that asks Stripe about each one.
   *
   *  `recurring = 0` because monthly plans have their own reconciliation (reconcileRenewals), which
   *  is both cheaper and more complete for them. Oldest first, so a backlog drains in the order the
   *  money arrived. The window has a floor as well as a ceiling: a row younger than `minAgeMs` may
   *  still be mid-confirmation, and racing the donor's own callback would double-send the receipt. */
  listUnconfirmedDonations(minAgeMs: number, maxAgeMs: number, limit = 25): Donation[] {
    const now = Date.now();
    return (
      this.db
        .prepare(
          `SELECT * FROM donations
            WHERE status = 'pending' AND recurring = 0 AND payment_intent_id <> ''
              AND created_at <= ? AND created_at >= ?
            ORDER BY created_at LIMIT ?`,
        )
        .all(new Date(now - minAgeMs).toISOString(), new Date(now - maxAgeMs).toISOString(), limit) as Record<string, unknown>[]
    ).map((r) => this.rowToDonation(r));
  }

  /** Total raised (succeeded) for a campaign, in minor units, NET of anything refunded.
   *
   *  This is the number behind a campaign's goal/progress bar, which is shown to DONORS. A
   *  refund that left it alone would keep asking the public to fund money the masjid no longer
   *  has — so refunds come off here, as they do everywhere else money is counted. */
  raisedForCampaign(campaignId: string): number {
    return (
      this.db
        .prepare(`SELECT COALESCE(SUM(amount - refunded_amount), 0) AS s FROM donations WHERE campaign_id = ? AND status = 'succeeded'`)
        .get(campaignId) as {
        s: number;
      }
    ).s;
  }

  /** Aggregated donation metrics (all amounts in MINOR units; only succeeded
   *  donations count toward money raised). The route converts to major units, joins
   *  campaign titles and fills the month window for display.
   *
   *  Every `raised` figure is NET of refunds (`amount - refunded_amount`), so returning money
   *  to a donor lowers what the masjid is told it raised. The COUNTS are deliberately gross:
   *  a refunded donation was still a donation that arrived, and quietly deducting it from the
   *  count would make the ledger (which still lists the row) disagree with the headline.
   *  `totalRefunded` is reported separately so the difference is never a mystery. */
  /** Money and count for one day or month, net of refunds, from the LOCAL ledger.
   *
   *  `prefix` is matched against `created_at` — 'YYYY-MM-DD' for a day, 'YYYY-MM' for a month.
   *  Timestamps are stored as the server's own ISO strings, so this is the same day boundary the
   *  panel's "this month" figure uses; a masjid and its box are in the same place.
   *
   *  Exists for the WhatsApp commands, which have a ten-second budget and someone holding a phone:
   *  two indexed prefix scans, no Stripe, no full table read. */
  raisedInPeriod(prefix: string): { raised: number; count: number } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount - refunded_amount), 0) AS s, COUNT(*) AS n
         FROM donations WHERE status = 'succeeded' AND created_at LIKE ?`,
      )
      .get(`${prefix}%`) as { s: number; n: number };
    return { raised: Number(r.s), count: Number(r.n) };
  }

  /** Monthly giving, from LOCAL rows only — no Stripe call, so it is safe on a command's clock.
   *
   *  "Donors" counts distinct subscriptions that have actually TAKEN money: a recurring row is
   *  written at /intent, before the card is entered, so counting every one would report every
   *  abandoned checkout as a monthly donor. `perMonth` sums the most recent payment on each of
   *  those, which is what they are currently giving; `thisMonth` is what has arrived this month.
   *
   *  `activeSince` is what keeps the answer TRUE as the years pass, and it is the reason this is
   *  not a one-line SUM. Nothing local records that a plan ENDED — a cancellation happens at
   *  Stripe, and a masjid on a LAN may never see the webhook — so a plan stopped two years ago
   *  still has its succeeded rows sitting in this table. Counting those, a masjid three years in
   *  would be told it had fifty monthly donors giving about $2,000 a month when the truth was ten
   *  and $400: confidently wrong, about money, in the flattering direction.
   *
   *  A live monthly plan is charged every month, so "nothing since `activeSince`" is the one local
   *  signal that a plan is no longer running. Those are returned separately as `dormant` rather
   *  than dropped, so a caller can explain the smaller figure instead of just presenting it. Pass
   *  nothing to count every plan ever, which is the old behavior. */
  monthlyGiving(monthPrefix: string, activeSince = ''): { donors: number; perMonth: number; thisMonth: number; dormant: number } {
    const rows = this.db
      .prepare(
        `SELECT subscription_id AS sub, amount - refunded_amount AS net, created_at AS at
         FROM donations
         WHERE status = 'succeeded' AND recurring = 1 AND subscription_id <> ''
         ORDER BY created_at ASC`,
      )
      .all() as { sub: string; net: number; at: string }[];
    // Ascending, so the last write for a subscription wins = its most recent payment.
    const latest = new Map<string, { net: number; at: string }>();
    let thisMonth = 0;
    for (const r of rows) {
      latest.set(String(r.sub), { net: Number(r.net), at: String(r.at) });
      if (String(r.at).startsWith(monthPrefix)) thisMonth += Number(r.net);
    }
    let donors = 0;
    let perMonth = 0;
    let dormant = 0;
    for (const v of latest.values()) {
      // ISO-8601 throughout, so a lexical compare IS a chronological one.
      if (activeSince && v.at < activeSince) {
        dormant += 1;
        continue;
      }
      donors += 1;
      perMonth += v.net;
    }
    return { donors, perMonth, thisMonth, dormant };
  }

  metrics(): {
    totalRaised: number;
    count: number;
    totalRefunded: number;
    refundedCount: number;
    byCampaign: { campaignId: string; raised: number; count: number }[];
    monthly: { month: string; raised: number; count: number }[];
  } {
    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount - refunded_amount), 0) AS s, COUNT(*) AS n,
                COALESCE(SUM(refunded_amount), 0) AS r, COALESCE(SUM(refunded_amount > 0), 0) AS rn
         FROM donations WHERE status = 'succeeded'`,
      )
      .get() as { s: number; n: number; r: number; rn: number };
    const byCampaign = (
      this.db
        .prepare(
          `SELECT campaign_id AS campaignId, COALESCE(SUM(amount - refunded_amount), 0) AS raised, COUNT(*) AS count
           FROM donations WHERE status = 'succeeded' GROUP BY campaign_id`,
        )
        .all() as { campaignId: string; raised: number; count: number }[]
    ).map((r) => ({ campaignId: String(r.campaignId), raised: Number(r.raised), count: Number(r.count) }));
    const monthly = (
      this.db
        .prepare(
          `SELECT strftime('%Y-%m', created_at) AS month, COALESCE(SUM(amount - refunded_amount), 0) AS raised, COUNT(*) AS count
           FROM donations WHERE status = 'succeeded' GROUP BY month`,
        )
        .all() as { month: string; raised: number; count: number }[]
    ).map((r) => ({ month: String(r.month), raised: Number(r.raised), count: Number(r.count) }));
    return {
      totalRaised: Number(totals.s),
      count: Number(totals.n),
      totalRefunded: Number(totals.r),
      refundedCount: Number(totals.rn),
      byCampaign,
      monthly,
    };
  }

  // ── Tuition (Students-billing) payments ─────────────────────────────────────
  // A separate ledger from donations (never counted as a gift). See student_payments DDL.
  private rowToStudentPayment(r: Record<string, unknown>): StudentPayment {
    return {
      id: String(r.id),
      campaignId: String(r.campaign_id),
      stripeAccountId: String(r.stripe_account_id),
      paymentIntentId: String(r.payment_intent_id),
      familyId: String(r.family_id),
      studentId: String(r.student_id ?? ''),
      familyLabel: String(r.family_label ?? ''),
      amount: Number(r.amount),
      feeCents: Number(r.fee_cents ?? 0),
      currency: String(r.currency),
      allocations: String(r.allocations ?? ''),
      studentsSplit: String(r.students_split ?? ''),
      paymentLines: String(r.payment_lines ?? ''),
      payStatus: String(r.pay_status) as StudentPayment['payStatus'],
      recordStatus: String(r.record_status) as StudentPayment['recordStatus'],
      studentsPaymentId: String(r.students_payment_id ?? ''),
      createdAt: String(r.created_at),
      occurredAt: String(r.occurred_at ?? ''),
    };
  }

  createStudentPayment(
    input: Omit<StudentPayment, 'id' | 'createdAt' | 'payStatus' | 'recordStatus' | 'studentsPaymentId' | 'occurredAt' | 'feeCents'> & {
      /** Omitted = 0 = "the school absorbed Stripe's cut", which is the answer for every school
       *  that has not switched the payer-pays setting on (§11.2 `info.fee`). Optional rather than
       *  required so a caller that knows nothing about fees cannot accidentally write a NULL. */
      feeCents?: number;
    },
  ): StudentPayment {
    const p: StudentPayment = {
      id: rid('spy'),
      payStatus: 'pending',
      recordStatus: 'pending',
      studentsPaymentId: '',
      occurredAt: '',
      createdAt: new Date().toISOString(),
      ...input,
      feeCents: Math.max(0, Math.trunc(input.feeCents ?? 0)),
    };
    this.db
      .prepare(
        `INSERT INTO student_payments
          (id, campaign_id, stripe_account_id, payment_intent_id, family_id, student_id, family_label,
           amount, fee_cents, currency, allocations, students_split, payment_lines, pay_status, record_status, students_payment_id, created_at, occurred_at)
         VALUES
          (@id, @campaignId, @stripeAccountId, @paymentIntentId, @familyId, @studentId, @familyLabel,
           @amount, @feeCents, @currency, @allocations, @studentsSplit, @paymentLines, @payStatus, @recordStatus, @studentsPaymentId, @createdAt, @occurredAt)`,
      )
      .run(p);
    return p;
  }

  getStudentPaymentByPI(pi: string): StudentPayment | null {
    const r = this.db.prepare('SELECT * FROM student_payments WHERE payment_intent_id = ?').get(pi) as Record<string, unknown> | undefined;
    return r ? this.rowToStudentPayment(r) : null;
  }

  /** Record the Stripe outcome of a tuition payment (idempotent). */
  markStudentPaymentPaid(pi: string, payStatus: StudentPayment['payStatus'], occurredAt?: string): StudentPayment | null {
    const cur = this.getStudentPaymentByPI(pi);
    if (!cur) return null;
    this.db
      .prepare('UPDATE student_payments SET pay_status=@payStatus, occurred_at=@occurredAt WHERE payment_intent_id=@pi')
      .run({ pi, payStatus, occurredAt: occurredAt || cur.occurredAt });
    return this.getStudentPaymentByPI(pi);
  }

  /** Record the Students-ledger push outcome (idempotent). */
  setStudentRecordStatus(pi: string, recordStatus: StudentPayment['recordStatus'], studentsPaymentId?: string): StudentPayment | null {
    const cur = this.getStudentPaymentByPI(pi);
    if (!cur) return null;
    this.db
      .prepare('UPDATE student_payments SET record_status=@recordStatus, students_payment_id=@studentsPaymentId WHERE payment_intent_id=@pi')
      .run({ pi, recordStatus, studentsPaymentId: studentsPaymentId || cur.studentsPaymentId });
    return this.getStudentPaymentByPI(pi);
  }

  /** Succeeded charges whose Students-ledger push hasn't landed yet — the outbox to retry. */
  listPendingStudentRecords(limit = 50): StudentPayment[] {
    return (
      this.db
        .prepare(`SELECT * FROM student_payments WHERE pay_status = 'succeeded' AND record_status = 'pending' ORDER BY created_at LIMIT ?`)
        .all(limit) as Record<string, unknown>[]
    ).map((r) => this.rowToStudentPayment(r));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
