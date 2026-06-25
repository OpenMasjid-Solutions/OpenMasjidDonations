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
export interface Campaign {
  id: string;
  slug: string;
  token: string;
  title: string;
  description: string;
  coverImage: string;
  /** Full-page background image URL for this campaign's public page. When empty the
   *  page shows the default theme scene (it does NOT inherit the dashboard wallpaper). */
  backgroundImage: string;
  /** Suggested amounts, in MINOR currency units (e.g. pence). */
  presetAmounts: number[];
  allowCustom: boolean;
  /** Min/max custom amount in minor units. maxAmount 0 = no max. */
  minAmount: number;
  maxAmount: number;
  stripeAccountId: string;
  coverFees: boolean;
  giftAid: boolean;
  /** Offer donors a monthly (recurring) option in addition to one-time. */
  allowMonthly: boolean;
  /** Goal in minor units, 0 = no goal/progress bar. */
  goalAmount: number;
  active: boolean;
  sortOrder: number;
  createdAt: string;
}

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
  createdAt: string;
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
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_donations_campaign ON donations(campaign_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_pi ON donations(payment_intent_id);
    `);
    // Tighten file perms where the OS supports it (secrets + admin hash live here).
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      /* best-effort (e.g. Windows dev) */
    }
    // Add columns introduced after first release (CREATE TABLE IF NOT EXISTS won't).
    this.ensureColumn('campaigns', 'background_image', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('campaigns', 'allow_monthly', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('donations', 'card_brand', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('donations', 'card_last4', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('donations', 'recurring', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('donations', 'subscription_id', "TEXT NOT NULL DEFAULT ''");
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
      description: String(r.description),
      coverImage: String(r.cover_image),
      backgroundImage: String(r.background_image ?? ''),
      presetAmounts: Array.isArray(presets) ? presets : [],
      allowCustom: !!r.allow_custom,
      minAmount: Number(r.min_amount),
      maxAmount: Number(r.max_amount),
      stripeAccountId: String(r.stripe_account_id),
      coverFees: !!r.cover_fees,
      giftAid: !!r.gift_aid,
      allowMonthly: !!r.allow_monthly,
      goalAmount: Number(r.goal_amount),
      active: !!r.active,
      sortOrder: Number(r.sort_order),
      createdAt: String(r.created_at),
    };
  }

  private writeCampaign(c: Campaign): void {
    this.db
      .prepare(
        `INSERT INTO campaigns
          (id, slug, token, title, description, cover_image, background_image, preset_amounts, allow_custom, min_amount,
           max_amount, stripe_account_id, cover_fees, gift_aid, allow_monthly, goal_amount, active, sort_order, created_at)
         VALUES
          (@id, @slug, @token, @title, @description, @coverImage, @backgroundImage, @presetAmounts, @allowCustom, @minAmount,
           @maxAmount, @stripeAccountId, @coverFees, @giftAid, @allowMonthly, @goalAmount, @active, @sortOrder, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           slug=excluded.slug, title=excluded.title, description=excluded.description, cover_image=excluded.cover_image,
           background_image=excluded.background_image, preset_amounts=excluded.preset_amounts, allow_custom=excluded.allow_custom,
           min_amount=excluded.min_amount, max_amount=excluded.max_amount, stripe_account_id=excluded.stripe_account_id,
           cover_fees=excluded.cover_fees, gift_aid=excluded.gift_aid, allow_monthly=excluded.allow_monthly,
           goal_amount=excluded.goal_amount, active=excluded.active, sort_order=excluded.sort_order`,
      )
      .run({
        ...c,
        presetAmounts: JSON.stringify(c.presetAmounts),
        allowCustom: c.allowCustom ? 1 : 0,
        coverFees: c.coverFees ? 1 : 0,
        giftAid: c.giftAid ? 1 : 0,
        allowMonthly: c.allowMonthly ? 1 : 0,
        active: c.active ? 1 : 0,
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

  createCampaign(input: Partial<Campaign> & { title: string; stripeAccountId: string }): Campaign {
    const maxSort = (this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM campaigns').get() as { m: number }).m;
    const c: Campaign = {
      id: rid('cmp'),
      slug: input.slug || slugify(input.title),
      token: campaignToken(),
      title: input.title,
      description: input.description ?? '',
      coverImage: input.coverImage ?? '',
      backgroundImage: input.backgroundImage ?? '',
      presetAmounts: input.presetAmounts ?? [],
      allowCustom: input.allowCustom ?? true,
      minAmount: input.minAmount ?? 100,
      maxAmount: input.maxAmount ?? 0,
      stripeAccountId: input.stripeAccountId,
      coverFees: input.coverFees ?? false,
      giftAid: input.giftAid ?? false,
      allowMonthly: input.allowMonthly ?? false,
      goalAmount: input.goalAmount ?? 0,
      active: input.active ?? true,
      sortOrder: maxSort + 1,
      createdAt: new Date().toISOString(),
    };
    this.writeCampaign(c);
    return c;
  }

  updateCampaign(id: string, patch: Partial<Campaign>): Campaign | null {
    const cur = this.getCampaign(id);
    if (!cur) return null;
    // id/token/createdAt are immutable.
    const next: Campaign = { ...cur, ...clean(patch), id: cur.id, token: cur.token, createdAt: cur.createdAt };
    this.writeCampaign(next);
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
      createdAt: String(r.created_at),
    };
  }

  createDonation(
    input: Omit<Donation, 'id' | 'createdAt' | 'status' | 'cardBrand' | 'cardLast4' | 'recurring' | 'subscriptionId'> & {
      status?: Donation['status'];
      recurring?: boolean;
      subscriptionId?: string;
    },
  ): Donation {
    // Card details are unknown until the payment confirms — start blank, filled in by markDonation.
    const d: Donation = {
      id: rid('don'),
      status: input.status ?? 'pending',
      cardBrand: '',
      cardLast4: '',
      recurring: input.recurring ?? false,
      subscriptionId: input.subscriptionId ?? '',
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.db
      .prepare(
        `INSERT INTO donations
          (id, campaign_id, stripe_account_id, amount, currency, status, donor_name, donor_email, cover_fees, gift_aid,
           payment_intent_id, recurring, subscription_id, created_at)
         VALUES
          (@id, @campaignId, @stripeAccountId, @amount, @currency, @status, @donorName, @donorEmail, @coverFees, @giftAid,
           @paymentIntentId, @recurring, @subscriptionId, @createdAt)`,
      )
      .run({ ...d, coverFees: d.coverFees ? 1 : 0, giftAid: d.giftAid ? 1 : 0, recurring: d.recurring ? 1 : 0 });
    return d;
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

  listDonations(): Donation[] {
    return (this.db.prepare('SELECT * FROM donations ORDER BY created_at DESC').all() as Record<string, unknown>[]).map((r) =>
      this.rowToDonation(r),
    );
  }

  /** Total raised (succeeded) for a campaign, in minor units. */
  raisedForCampaign(campaignId: string): number {
    return (
      this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM donations WHERE campaign_id = ? AND status = 'succeeded'`).get(campaignId) as {
        s: number;
      }
    ).s;
  }

  /** Aggregated donation metrics (all amounts in MINOR units; only succeeded
   *  donations count toward money raised). The route converts to major units, joins
   *  campaign titles and fills the month window for display. */
  metrics(): {
    totalRaised: number;
    count: number;
    byCampaign: { campaignId: string; raised: number; count: number }[];
    monthly: { month: string; raised: number; count: number }[];
  } {
    const totals = this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n FROM donations WHERE status = 'succeeded'`)
      .get() as { s: number; n: number };
    const byCampaign = (
      this.db
        .prepare(
          `SELECT campaign_id AS campaignId, COALESCE(SUM(amount), 0) AS raised, COUNT(*) AS count
           FROM donations WHERE status = 'succeeded' GROUP BY campaign_id`,
        )
        .all() as { campaignId: string; raised: number; count: number }[]
    ).map((r) => ({ campaignId: String(r.campaignId), raised: Number(r.raised), count: Number(r.count) }));
    const monthly = (
      this.db
        .prepare(
          `SELECT strftime('%Y-%m', created_at) AS month, COALESCE(SUM(amount), 0) AS raised, COUNT(*) AS count
           FROM donations WHERE status = 'succeeded' GROUP BY month`,
        )
        .all() as { month: string; raised: number; count: number }[]
    ).map((r) => ({ month: String(r.month), raised: Number(r.raised), count: Number(r.count) }));
    return { totalRaised: Number(totals.s), count: Number(totals.n), byCampaign, monthly };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
