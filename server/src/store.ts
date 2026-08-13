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
  stripeAccountId: string;
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
  /** Accent colour (hex) for the thank-you screen highlight; empty = the theme accent. */
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
  /** Amount charged, in MINOR units of the SCHOOL's currency (from the Students lookup). */
  amount: number;
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
 *  between a stranger and stopping somebody's donation, so the entropy is the defence (a rate limit
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
      -- This app handles donations, so "who exported the donor list, who cancelled that plan, who
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
    // '' = "no lines", exactly how they were pushed to Students before itemised bills existed.
    this.ensureColumn('student_payments', 'payment_lines', "TEXT NOT NULL DEFAULT ''");
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

  campaignsForAccount(id: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM campaigns WHERE stripe_account_id = ?').get(id) as { n: number }).n;
  }

  deleteStripeAccount(id: string): { ok: boolean; reason?: string } {
    if (this.campaignsForAccount(id) > 0) return { ok: false, reason: 'in-use' };
    this.db.prepare('DELETE FROM stripe_accounts WHERE id = ?').run(id);
    return { ok: true };
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
           max_amount, stripe_account_id, cover_fees, force_cover_fees, gift_aid, allow_monthly, widget_enabled, goal_amount, active, sort_order, thank_you, created_at)
         VALUES
          (@id, @slug, @token, @title, @type, @description, @coverImage, @backgroundImage, @logo, @presetAmounts, @allowCustom, @minAmount,
           @maxAmount, @stripeAccountId, @coverFees, @forceCoverFees, @giftAid, @allowMonthly, @widgetEnabled, @goalAmount, @active, @sortOrder, @thankYou, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           slug=excluded.slug, title=excluded.title, type=excluded.type, description=excluded.description, cover_image=excluded.cover_image,
           background_image=excluded.background_image, logo=excluded.logo, preset_amounts=excluded.preset_amounts,
           allow_custom=excluded.allow_custom, min_amount=excluded.min_amount, max_amount=excluded.max_amount,
           stripe_account_id=excluded.stripe_account_id, cover_fees=excluded.cover_fees, force_cover_fees=excluded.force_cover_fees,
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
    input: Omit<StudentPayment, 'id' | 'createdAt' | 'payStatus' | 'recordStatus' | 'studentsPaymentId' | 'occurredAt'>,
  ): StudentPayment {
    const p: StudentPayment = {
      id: rid('spy'),
      payStatus: 'pending',
      recordStatus: 'pending',
      studentsPaymentId: '',
      occurredAt: '',
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.db
      .prepare(
        `INSERT INTO student_payments
          (id, campaign_id, stripe_account_id, payment_intent_id, family_id, student_id, family_label,
           amount, currency, allocations, students_split, payment_lines, pay_status, record_status, students_payment_id, created_at, occurred_at)
         VALUES
          (@id, @campaignId, @stripeAccountId, @paymentIntentId, @familyId, @studentId, @familyLabel,
           @amount, @currency, @allocations, @studentsSplit, @paymentLines, @payStatus, @recordStatus, @studentsPaymentId, @createdAt, @occurredAt)`,
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
