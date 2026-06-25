/** Entry point: a Fastify server that serves the built web app (donor site +
 *  admin) and the JSON API. Slice 1 established the themed shell + health check;
 *  slice 2 adds the OpenMasjidOS Fabric — single sign-on (server→server) with a
 *  local admin-password fallback, plus the notifications relay. Stripe, appeals and
 *  the donations log arrive in later slices. */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { z } from 'zod';
import { config, ssoConfigured } from './config';
import { makeLog } from './logger';
import { Store, slugify, rid, RESERVED_SLUGS } from './store';
import type { Campaign, StripeAccount } from './store';
import { COOKIE, cookieOptions, hashPassword, makeToken, verifyPassword, verifyToken, SSO_SESSION_MS } from './auth';
import { notify, platformUser } from './fabric';
import { LoginLimiter } from './rateLimit';
import { TunnelManager } from './tunnel';
import {
  constructWebhookEvent,
  createPaymentIntent,
  createProduct,
  createSubscription,
  currencyDecimals,
  looksLikePublishable,
  looksLikeSecret,
  looksLikeWebhookSecret,
  publicStripeStatus,
  retrievePaymentIntent,
  stripeConfigured,
  stripeMode,
  toMajor,
  toMinor,
  verifySecretKey,
  withCoveredFees,
} from './stripe';

const log = makeLog('main');

const LOOPBACK_RE = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[?::1)/i;

/** Quote a CSV cell (escape quotes; wrap if it contains comma/quote/newline). */
function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Friendly money string for a minor-unit amount, e.g. "£50.00". */
function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(toMajor(minor, currency));
  } catch {
    return `${toMajor(minor, currency)} ${currency}`;
  }
}

async function main(): Promise<void> {
  const store = new Store();
  const loginLimiter = new LoginLimiter();
  const tunnel = new TunnelManager();

  const app = Fastify({
    logger: false, // we log ourselves and never log secrets
    // trustProxy stays OFF: the app is port-mapped directly (no reverse proxy in
    // front), so a client-supplied X-Forwarded-For must NOT be trusted — otherwise
    // the login rate-limiter could be bypassed by spoofing it. We key the limiter on
    // the real TCP peer below. (A future reverse-proxy deployment would set this to
    // the specific trusted proxy CIDR, not `true`.)
    bodyLimit: 1_048_576, // 1 MiB JSON cap (uploads get their own limit later)
  });
  await app.register(fastifyCookie); // parses req.cookies + decorates reply.setCookie
  // Multipart, only for image uploads (≤5 MiB, one file). Other routes keep JSON.
  await app.register(fastifyMultipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4 } });
  // Keep the raw JSON body around so we can verify Stripe webhook signatures (Stripe
  // signs the exact bytes). All other JSON routes still get the parsed object.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = body as string;
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  // Uploaded images live on the data volume and are served read-only at /uploads/*.
  const uploadsDir = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  await app.register(fastifyStatic, { root: uploadsDir, prefix: '/uploads/', decorateReply: false, index: false });

  // A request is authenticated if it carries a valid local session cookie. That
  // cookie is minted by first-run setup, by password login, or by a confirmed
  // OpenMasjidOS SSO check (see GET /api/session) — so every protected route stays a
  // simple, synchronous check.
  const isAuthed = (cookie: string | undefined): boolean => verifyToken(store.secret, cookie, 'admin');

  const requireAdmin = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!isAuthed(req.cookies[COOKIE])) {
      return reply.code(401).send({ error: 'Please sign in.' });
    }
  };

  // ── Health check ────────────────────────────────────────────────────────────
  app.get('/healthz', async () => ({ ok: true }));

  // ── Public bootstrap the web app reads on load (no secrets) ─────────────────
  app.get('/api/app', async () => ({
    data: {
      name: 'OpenMasjid Donations',
      version: config.version,
      embedded: ssoConfigured(),
      omosBase: config.omosBaseUrl, // '' when standalone
      // Whether any Stripe account is fully configured (no secrets here).
      donationsConfigured: store.listStripeAccounts().some((a) => stripeConfigured(a)),
      // Before the admin finishes first-run setup, the landing page sends them
      // straight to /admin (where they log in / set a password, then the wizard).
      onboarded: store.isOnboarded(),
    },
  }));

  // ── Same-origin appearance relay ────────────────────────────────────────────
  // Our page is served over HTTPS (the platform's per-app TLS proxy, because our
  // manifest sets `https: true` for Stripe). The platform's appearance endpoint is
  // plain HTTP, so a direct browser fetch would be blocked as mixed content. The web
  // polls us (same origin) and we fetch the platform server-to-server. Returns the
  // platform's { v, theme, wallpaper, wallpaperImage, accent, lang } or {} (no secrets).
  app.get('/api/public/appearance', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const base = config.omosBaseUrl;
    if (!base) return {};
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${base}/api/public/appearance`, { signal: ctrl.signal, redirect: 'error' });
      clearTimeout(t);
      if (!res.ok) return {};
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return {}; // platform offline / unreachable — the #omos fragment still themed us
    }
  });

  // ── Session: who am I? Also performs the SSO upgrade. ───────────────────────
  // If not already signed in here but the visitor carries a valid OpenMasjidOS
  // session, we confirm it with the platform (server→server) and mint a short-lived
  // local cookie, so the rest of the API stays a simple synchronous check. Falls
  // back silently to local login when SSO is absent or the platform is down.
  app.get('/api/session', async (req, reply) => {
    let authed = isAuthed(req.cookies[COOKIE]);
    let username: string | undefined;
    if (!authed && ssoConfigured()) {
      const user = await platformUser(req.headers.cookie);
      if (user) {
        reply.setCookie(COOKIE, makeToken(store.secret, SSO_SESSION_MS), cookieOptions(SSO_SESSION_MS));
        authed = true;
        username = user;
      }
    }
    return {
      data: {
        // Standalone: first run creates a password. Under OpenMasjidOS, signing in
        // is the dashboard's job (SSO), so we never block on local setup.
        needsSetup: !store.hasAdmin() && !ssoConfigured(),
        authed,
        hasPassword: store.hasAdmin(),
        sso: { enabled: ssoConfigured(), username },
      },
    };
  });

  // ── First-run setup (standalone only) ───────────────────────────────────────
  const SetupBody = z.object({ password: z.string().min(8).max(200), name: z.string().max(80).optional() });
  app.post('/api/setup', async (req, reply) => {
    // Under OpenMasjidOS, sign-in is the dashboard's job (SSO) — there is no local
    // admin password to claim, so refuse setup to close the pre-setup window.
    if (ssoConfigured()) return reply.code(403).send({ error: 'This panel signs in through OpenMasjidOS.' });
    if (store.hasAdmin()) return reply.code(409).send({ error: 'This app is already set up.' });
    const parsed = SetupBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please choose a password of at least 8 characters.' });
    store.setAdmin(hashPassword(parsed.data.password), parsed.data.name?.trim());
    reply.setCookie(COOKIE, makeToken(store.secret), cookieOptions());
    return { data: { ok: true } };
  });

  // ── Password login (rate-limited) ───────────────────────────────────────────
  const LoginBody = z.object({ password: z.string().min(1).max(200) });
  app.post('/api/login', async (req, reply) => {
    // Key the brute-force limiter on the real, unspoofable TCP peer — never req.ip
    // (which would honour a forged X-Forwarded-For). This is the defence behind the
    // short admin password, so it must not be bypassable by a request header.
    const peer = req.socket.remoteAddress ?? 'unknown';
    const wait = loginLimiter.retryAfterMs(peer);
    if (wait > 0) return reply.code(429).send({ error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });
    const admin = store.getAdmin();
    if (!admin) return reply.code(400).send({ error: 'This app has not been set up yet.' });
    const parsed = LoginBody.safeParse(req.body);
    if (parsed.success && verifyPassword(parsed.data.password, admin)) {
      loginLimiter.succeed(peer);
      reply.setCookie(COOKIE, makeToken(store.secret), cookieOptions());
      return { data: { ok: true } };
    }
    loginLimiter.fail(peer);
    return reply.code(401).send({ error: 'Incorrect password.' });
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { data: { ok: true } };
  });

  // ── Fabric notifications: diagnose + send a test alert ──────────────────────
  // Reports what the platform injected (non-secret) so the admin can see exactly why
  // alerts are/aren't arriving, and fires a real test through the Fabric. Donation
  // events in later slices relay through the same notify() helper.
  app.post('/api/admin/notify-test', { preHandler: requireAdmin }, async () => {
    const base = config.omosBaseUrl;
    const hasSecret = !!config.omosAppSecret;
    let result: { delivered: boolean; reason?: string } = { delivered: false, reason: 'no-fabric' };
    if (base && hasSecret) {
      result = await notify({
        title: 'OpenMasjid Donations — test',
        text: '✅ Test alert from OpenMasjid Donations. If you see this, donation alerts will reach you here.',
        level: 'info',
      });
    }
    return {
      data: { baseUrlSet: !!base, hasSecret, baseUrlLoopback: LOOPBACK_RE.test(base), appId: config.omosAppId, ...result },
    };
  });

  // ── Currency + view helpers (amounts cross the API in MAJOR units) ──────────
  const cur = () => store.getMasjid().currency;
  const toMinorCur = (major: number) => toMinor(major, cur());
  const toMajorCur = (minor: number) => toMajor(minor, cur());

  /** Non-secret view of a Stripe account (publishable key + booleans only). */
  const publicAccount = (a: StripeAccount) => ({ id: a.id, label: a.label, ...publicStripeStatus(a) });

  const checkKeys = (p: { publishableKey?: string; secretKey?: string; webhookSecret?: string }): string | null => {
    if (p.publishableKey && !looksLikePublishable(p.publishableKey)) return 'The publishable key should start with pk_.';
    if (p.secretKey && !looksLikeSecret(p.secretKey)) return 'The secret key should start with sk_.';
    if (p.webhookSecret && !looksLikeWebhookSecret(p.webhookSecret)) return 'The webhook secret should start with whsec_.';
    return null;
  };

  /** Admin view of a campaign (amounts in major units + raised + public link). */
  const adminCampaign = (c: Campaign) => ({
    ...c,
    presetAmounts: c.presetAmounts.map(toMajorCur),
    minAmount: toMajorCur(c.minAmount),
    maxAmount: toMajorCur(c.maxAmount),
    goalAmount: toMajorCur(c.goalAmount),
    raised: toMajorCur(store.raisedForCampaign(c.id)),
    currency: cur(),
    url: `/${c.slug}`,
  });

  /** Validate + resolve a campaign link slug. Returns the final slug, or an error
   *  message if the admin chose one that's reserved or already taken. When no slug is
   *  given, derives a unique one from the title. */
  const resolveSlug = (raw: string | undefined, title: string, exceptId?: string): { slug?: string; error?: string } => {
    if (raw == null || raw.trim() === '') return { slug: store.uniqueSlug(title || 'appeal', exceptId) };
    const slug = slugify(raw);
    if (RESERVED_SLUGS.has(slug)) return { error: `“${slug}” is reserved — please choose a different link.` };
    if (!store.isSlugAvailable(slug, exceptId)) return { error: `The link “/${slug}” is already used by another campaign.` };
    return { slug };
  };

  // ── Settings: masjid details + onboarding (Stripe accounts have own routes) ──
  app.get('/api/settings', { preHandler: requireAdmin }, async () => ({
    data: {
      masjid: store.getMasjid(),
      stripeAccounts: store.listStripeAccounts().map(publicAccount),
      onboarded: store.isOnboarded(),
    },
  }));

  const MasjidBody = z.object({
    name: z.string().max(120).optional(),
    address: z.string().max(400).optional(),
    email: z.string().max(200).optional(),
    phone: z.string().max(60).optional(),
    website: z.string().max(200).optional(),
    currency: z.string().max(8).optional(),
  });
  app.put('/api/settings/masjid', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = MasjidBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the details and try again.' });
    return { data: store.setMasjid(parsed.data) };
  });

  app.post('/api/settings/complete-onboarding', { preHandler: requireAdmin }, async () => {
    store.setOnboarded();
    return { data: { ok: true } };
  });

  // ── Image upload (campaign cover/background) — saved to the data volume ──────
  // Raster images only (no SVG — it can carry scripts and we serve from same origin).
  const IMG_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  app.post('/api/admin/upload', { preHandler: requireAdmin }, async (req, reply) => {
    const file = await req.file().catch(() => null);
    if (!file) return reply.code(400).send({ error: 'No image was received.' });
    const ext = IMG_EXT[file.mimetype];
    if (!ext) {
      file.file.resume(); // drain the stream we're rejecting
      return reply.code(415).send({ error: 'Please choose a PNG, JPG, WEBP or GIF image.' });
    }
    const name = `${rid('img')}.${ext}`;
    const dest = path.join(uploadsDir, name);
    try {
      await pipeline(file.file, fs.createWriteStream(dest));
    } catch {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      return reply.code(500).send({ error: 'Couldn’t save that image. Please try again.' });
    }
    if (file.file.truncated) {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      return reply.code(413).send({ error: 'That image is too large (max 5 MB).' });
    }
    try { fs.chmodSync(dest, 0o644); } catch { /* best-effort */ }
    return { data: { url: `/uploads/${name}` } };
  });

  // ── Cloudflare Tunnel (optional public access; token is a server-side secret) ─
  // Reduce a pasted value to a bare hostname (strip scheme, port, path); '' if invalid.
  const cleanHostname = (s: string): string => {
    const h = s.trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').toLowerCase();
    return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(h) && h.includes('.') ? h : '';
  };
  const TunnelBody = z.object({
    token: z.string().max(4000).optional(),
    enabled: z.boolean().optional(),
    publicHostname: z.string().max(255).optional(),
  });
  const tunnelView = () => {
    const t = store.getTunnel();
    return { hasToken: !!t.token, publicHostname: t.publicHostname, ...tunnel.status() };
  };
  app.get('/api/admin/tunnel', { preHandler: requireAdmin }, async () => ({ data: tunnelView() }));
  app.put('/api/admin/tunnel', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = TunnelBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the details.' });
    const t = store.setTunnel({
      token: parsed.data.token?.trim(),
      enabled: parsed.data.enabled,
      publicHostname: parsed.data.publicHostname != null ? cleanHostname(parsed.data.publicHostname) : undefined,
    });
    tunnel.apply(t.token, t.enabled); // never echoes the token back
    return { data: tunnelView() };
  });

  // ── Stripe accounts (multiple — e.g. Zakat vs general) ──────────────────────
  // Secrets are stored server-side and NEVER echoed back; a set secret is verified
  // with Stripe so the admin gets immediate confirmation.
  const AccountBody = z.object({
    label: z.string().max(80).optional(),
    publishableKey: z.string().max(255).optional(),
    secretKey: z.string().max(255).optional(),
    webhookSecret: z.string().max(255).optional(),
  });
  app.get('/api/admin/stripe-accounts', { preHandler: requireAdmin }, async () => ({
    data: store.listStripeAccounts().map(publicAccount),
  }));
  app.post('/api/admin/stripe-accounts', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = AccountBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the details.' });
    const err = checkKeys(parsed.data);
    if (err) return reply.code(400).send({ error: err });
    const acct = store.createStripeAccount({ label: parsed.data.label || 'Stripe account', ...parsed.data });
    const verify = acct.secretKey ? await verifySecretKey(acct.secretKey) : undefined;
    return { data: { ...publicAccount(acct), verify } };
  });
  app.put('/api/admin/stripe-accounts/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = AccountBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the details.' });
    const err = checkKeys(parsed.data);
    if (err) return reply.code(400).send({ error: err });
    const acct = store.updateStripeAccount((req.params as { id: string }).id, parsed.data);
    if (!acct) return reply.code(404).send({ error: 'Account not found.' });
    const verify = acct.secretKey ? await verifySecretKey(acct.secretKey) : undefined;
    return { data: { ...publicAccount(acct), verify } };
  });
  app.delete('/api/admin/stripe-accounts/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const res = store.deleteStripeAccount((req.params as { id: string }).id);
    if (!res.ok) return reply.code(409).send({ error: 'A campaign uses this account. Reassign or delete those campaigns first.' });
    return { data: { ok: true } };
  });
  app.post('/api/admin/stripe-accounts/:id/test', { preHandler: requireAdmin }, async (req) => {
    const acct = store.getStripeAccount((req.params as { id: string }).id);
    if (!acct || !acct.secretKey) return { data: { ok: false, message: 'Add a secret key first.' } };
    return { data: await verifySecretKey(acct.secretKey) };
  });

  // ── Campaigns (admin CRUD) ──────────────────────────────────────────────────
  const CampaignBody = z.object({
    title: z.string().min(1).max(120).optional(),
    slug: z.string().max(60).optional(),
    description: z.string().max(8000).optional(),
    coverImage: z.string().max(2000).optional(),
    backgroundImage: z.string().max(2000).optional(),
    presetAmounts: z.array(z.number().nonnegative()).max(12).optional(), // major units
    allowCustom: z.boolean().optional(),
    minAmount: z.number().nonnegative().optional(), // major
    maxAmount: z.number().nonnegative().optional(), // major, 0 = none
    stripeAccountId: z.string().max(64).optional(),
    coverFees: z.boolean().optional(),
    giftAid: z.boolean().optional(),
    allowMonthly: z.boolean().optional(),
    goalAmount: z.number().nonnegative().optional(), // major
    active: z.boolean().optional(),
  });
  /** Convert the major-unit amount fields on a campaign body to minor units. */
  const campaignAmountsToMinor = (p: z.infer<typeof CampaignBody>) => ({
    presetAmounts: p.presetAmounts?.map(toMinorCur),
    minAmount: p.minAmount != null ? toMinorCur(p.minAmount) : undefined,
    maxAmount: p.maxAmount != null ? toMinorCur(p.maxAmount) : undefined,
    goalAmount: p.goalAmount != null ? toMinorCur(p.goalAmount) : undefined,
  });

  app.get('/api/admin/campaigns', { preHandler: requireAdmin }, async () => ({
    data: store.listCampaigns().map(adminCampaign),
  }));
  app.post('/api/admin/campaigns', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = CampaignBody.safeParse(req.body);
    if (!parsed.success || !parsed.data.title) return reply.code(400).send({ error: 'A campaign needs a title.' });
    const p = parsed.data;
    const accountId = p.stripeAccountId || store.listStripeAccounts()[0]?.id;
    if (!accountId) return reply.code(400).send({ error: 'Add a Stripe account before creating a campaign.' });
    const { slug, error } = resolveSlug(p.slug, p.title!);
    if (error) return reply.code(409).send({ error });
    const c = store.createCampaign({
      title: p.title!, // guarded above — title is required for create
      slug,
      description: p.description,
      coverImage: p.coverImage,
      backgroundImage: p.backgroundImage,
      allowCustom: p.allowCustom,
      stripeAccountId: accountId,
      coverFees: p.coverFees,
      giftAid: p.giftAid,
      allowMonthly: p.allowMonthly,
      active: p.active,
      ...campaignAmountsToMinor(p),
    });
    return { data: adminCampaign(c) };
  });
  app.put('/api/admin/campaigns/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = CampaignBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the campaign details.' });
    const p = parsed.data;
    const id = (req.params as { id: string }).id;
    // Only touch the slug when the admin actually sent one; an empty/omitted slug
    // leaves the existing link untouched.
    let slug: string | undefined;
    if (p.slug != null && p.slug.trim() !== '') {
      const r = resolveSlug(p.slug, p.title ?? '', id);
      if (r.error) return reply.code(409).send({ error: r.error });
      slug = r.slug;
    }
    const c = store.updateCampaign(id, {
      title: p.title,
      slug,
      description: p.description,
      coverImage: p.coverImage,
      backgroundImage: p.backgroundImage,
      allowCustom: p.allowCustom,
      stripeAccountId: p.stripeAccountId,
      coverFees: p.coverFees,
      giftAid: p.giftAid,
      allowMonthly: p.allowMonthly,
      active: p.active,
      ...campaignAmountsToMinor(p),
    });
    if (!c) return reply.code(404).send({ error: 'Campaign not found.' });
    return { data: adminCampaign(c) };
  });
  app.delete('/api/admin/campaigns/:id', { preHandler: requireAdmin }, async (req) => {
    store.deleteCampaign((req.params as { id: string }).id);
    return { data: { ok: true } };
  });
  // Live feedback for the link editor: is this slug usable? Returns the cleaned slug.
  app.get('/api/admin/campaigns/slug-check', { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { slug?: string; exceptId?: string };
    const slug = slugify(q.slug ?? '');
    const reserved = RESERVED_SLUGS.has(slug);
    return { data: { slug, available: !reserved && store.isSlugAvailable(slug, q.exceptId), reserved } };
  });

  // ── Donations log + CSV ─────────────────────────────────────────────────────
  // A short, human-friendly transaction reference derived from the donation id
  // (stable + unique enough for display; the full id stays the real key).
  const donationRef = (id: string) => id.replace(/^don_/, '').slice(0, 8).toUpperCase();
  app.get('/api/admin/donations', { preHandler: requireAdmin }, async () => {
    const titles = new Map(store.listCampaigns().map((c) => [c.id, c.title]));
    const list = store.listDonations();
    const succeeded = list.filter((d) => d.status === 'succeeded');
    return {
      data: {
        donations: list.map((d) => ({ ...d, ref: donationRef(d.id), amount: toMajorCur(d.amount), campaignTitle: titles.get(d.campaignId) ?? '—' })),
        stats: { totalRaised: toMajorCur(succeeded.reduce((s, d) => s + d.amount, 0)), count: succeeded.length, currency: cur() },
      },
    };
  });
  app.get('/api/admin/donations.csv', { preHandler: requireAdmin }, async (_req, reply) => {
    const titles = new Map(store.listCampaigns().map((c) => [c.id, c.title]));
    const rows = [['Ref', 'Date', 'Campaign', 'Amount', 'Currency', 'Status', 'Donor', 'Email', 'Card', 'Covered fees', 'PaymentIntent']];
    for (const d of store.listDonations()) {
      const card = d.cardBrand ? `${d.cardBrand} ${d.cardLast4}`.trim() : '';
      rows.push([
        donationRef(d.id), d.createdAt, titles.get(d.campaignId) ?? '', String(toMajorCur(d.amount)), d.currency, d.status,
        d.donorName, d.donorEmail, card, d.coverFees ? 'yes' : 'no', d.paymentIntentId,
      ]);
    }
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="donations.csv"');
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  });

  // ── Metrics dashboard ───────────────────────────────────────────────────────
  // Headline totals + a per-campaign breakdown (which appeal raised what) + a 6-month
  // trend, all derived from succeeded donations. Amounts are returned in major units.
  app.get('/api/admin/metrics', { preHandler: requireAdmin }, async () => {
    const currency = cur();
    const m = store.metrics();
    const campaigns = store.listCampaigns();
    const titles = new Map(campaigns.map((c) => [c.id, c.title]));
    const raisedBy = new Map(m.byCampaign.map((r) => [r.campaignId, r]));

    // One row per current campaign (sorted by money raised), so the admin sees every
    // appeal — even those at £0 — and which is pulling its weight.
    const byCampaign = campaigns
      .map((c) => {
        const r = raisedBy.get(c.id);
        return {
          id: c.id,
          title: c.title,
          slug: c.slug,
          active: c.active,
          goal: toMajorCur(c.goalAmount),
          raised: toMajorCur(r?.raised ?? 0),
          count: r?.count ?? 0,
        };
      })
      .sort((a, b) => b.raised - a.raised);
    // Include any orphaned totals from deleted campaigns so the numbers reconcile.
    for (const r of m.byCampaign) {
      if (!titles.has(r.campaignId)) {
        byCampaign.push({ id: r.campaignId, title: 'Deleted campaign', slug: '', active: false, goal: 0, raised: toMajorCur(r.raised), count: r.count });
      }
    }

    // Build a contiguous trailing 6-month window (fill empty months with zero) so the
    // chart never has gaps. Months are YYYY-MM in the server's local zone.
    const monthMap = new Map(m.monthly.map((r) => [r.month, r]));
    const now = new Date();
    const monthly: { month: string; label: string; raised: number; count: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const row = monthMap.get(key);
      monthly.push({
        month: key,
        label: d.toLocaleString('en', { month: 'short' }),
        raised: toMajorCur(row?.raised ?? 0),
        count: row?.count ?? 0,
      });
    }
    const thisMonth = monthly[monthly.length - 1];

    return {
      data: {
        currency,
        totalRaised: toMajorCur(m.totalRaised),
        count: m.count,
        average: m.count > 0 ? toMajorCur(Math.round(m.totalRaised / m.count)) : 0,
        thisMonthRaised: thisMonth.raised,
        thisMonthCount: thisMonth.count,
        activeCampaigns: campaigns.filter((c) => c.active).length,
        byCampaign,
        monthly,
      },
    };
  });

  // ── Public donation flow (no auth) ──────────────────────────────────────────
  // Simple per-IP fixed-window limiter for intent creation.
  const donateHits = new Map<string, { c: number; reset: number }>();
  const donateRateOk = (ip: string): boolean => {
    const now = Date.now();
    if (donateHits.size > 5000) for (const [k, w] of donateHits) if (w.reset <= now) donateHits.delete(k);
    const w = donateHits.get(ip);
    if (!w || w.reset <= now) {
      donateHits.set(ip, { c: 1, reset: now + 60_000 });
      return true;
    }
    if (w.c >= 30) return false;
    w.c += 1;
    return true;
  };

  // Resolve a public campaign by its clean slug. A legacy /c/<slug>-<token> link may
  // still carry a token — prefer the exact slug+token match for those, then fall back
  // to the (now unique) slug, so old shared links keep working.
  const resolvePublicCampaign = (slug: string, token?: string): Campaign | null => {
    if (token) {
      const exact = store.getCampaignBySlugToken(slug, token);
      if (exact) return exact;
    }
    return store.getCampaignBySlug(slug);
  };

  const publicCampaign = (c: Campaign) => {
    const acct = store.getStripeAccount(c.stripeAccountId);
    return {
      slug: c.slug,
      title: c.title,
      description: c.description,
      coverImage: c.coverImage,
      backgroundImage: c.backgroundImage,
      presetAmounts: c.presetAmounts.map(toMajorCur),
      allowCustom: c.allowCustom,
      minAmount: toMajorCur(c.minAmount),
      maxAmount: toMajorCur(c.maxAmount),
      coverFees: c.coverFees,
      giftAid: c.giftAid,
      allowMonthly: c.allowMonthly,
      goalAmount: toMajorCur(c.goalAmount),
      raised: toMajorCur(store.raisedForCampaign(c.id)),
      currency: cur(),
      masjidName: store.getMasjid().name,
      publishableKey: acct?.publishableKey ?? '', // safe; never the secret
      ready: !!acct && stripeConfigured(acct),
    };
  };

  const sendPublicCampaign = (slug: string, token: string | undefined, reply: import('fastify').FastifyReply) => {
    const c = resolvePublicCampaign(slug, token);
    if (!c || !c.active) return reply.code(404).send({ error: 'This donation page isn’t available.' });
    return { data: publicCampaign(c) };
  };
  // Primary clean route + back-compat route that still accepts the old token segment.
  app.get('/api/public/campaign/:slug', async (req, reply) =>
    sendPublicCampaign((req.params as { slug: string }).slug, undefined, reply),
  );
  app.get('/api/public/campaign/:slug/:token', async (req, reply) => {
    const { slug, token } = req.params as { slug: string; token: string };
    return sendPublicCampaign(slug, token, reply);
  });

  const IntentBody = z.object({
    amount: z.number().positive(), // major units
    coverFees: z.boolean().optional(),
    giftAid: z.boolean().optional(),
    monthly: z.boolean().optional(),
    donorName: z.string().max(120).optional(),
    donorEmail: z.string().max(200).optional(),
  });
  const intentHandler = async (
    req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) => {
    if (!donateRateOk(req.socket.remoteAddress ?? 'unknown')) {
      return reply.code(429).send({ error: 'Too many attempts. Please wait a moment.' });
    }
    const { slug, token } = req.params as { slug: string; token?: string };
    const c = resolvePublicCampaign(slug, token);
    if (!c || !c.active) return reply.code(404).send({ error: 'This donation page isn’t available.' });
    const acct = store.getStripeAccount(c.stripeAccountId);
    if (!acct || !stripeConfigured(acct)) return reply.code(400).send({ error: 'Donations aren’t set up for this page yet.' });
    const parsed = IntentBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please choose a valid amount.' });
    const p = parsed.data;
    const currency = cur();
    const baseMinor = toMinor(p.amount, currency);
    // Validate against the campaign's rules — never trust the client amount.
    if (!c.allowCustom) {
      if (!c.presetAmounts.includes(baseMinor)) return reply.code(400).send({ error: 'Please choose one of the suggested amounts.' });
    } else {
      if (baseMinor < Math.max(c.minAmount, 1)) return reply.code(400).send({ error: 'That amount is below the minimum.' });
      if (c.maxAmount > 0 && baseMinor > c.maxAmount) return reply.code(400).send({ error: 'That amount is above the maximum.' });
    }
    // Stripe rejects very small charges; enforce a floor (~0.50 in 2-decimal currencies).
    const floor = currencyDecimals(currency) === 0 ? 50 : 50;
    if (baseMinor < floor) return reply.code(400).send({ error: 'That amount is too small.' });

    const coverFees = !!p.coverFees && c.coverFees;
    const chargeMinor = coverFees ? withCoveredFees(baseMinor, currency) : baseMinor;
    const giftAid = !!p.giftAid && c.giftAid;
    const monthly = !!p.monthly && c.allowMonthly;
    const donorName = (p.donorName ?? '').slice(0, 120);
    const donorEmail = (p.donorEmail ?? '').slice(0, 200);
    // Monthly donations need an email — Stripe attaches the subscription to a customer.
    if (monthly && !donorEmail.trim()) {
      return reply.code(400).send({ error: 'Please add your email — it’s required for a monthly donation.' });
    }
    const metadata = {
      app: 'donations', campaignId: c.id, campaign: c.title.slice(0, 120),
      coverFees: String(coverFees), giftAid: String(giftAid), recurring: String(monthly),
    };
    const idempotencyKey = crypto.randomUUID();
    let clientSecret = '';
    let paymentIntentId = '';
    let subscriptionId = '';
    try {
      if (monthly) {
        // Resolve (and cache) a reusable Stripe Product for this account + key mode.
        const mode = stripeMode(acct);
        let productId = store.getStripeProduct(acct.id, mode);
        if (!productId) {
          productId = await createProduct(acct, `Donations — ${store.getMasjid().name || 'Masjid'}`);
          store.setStripeProduct(acct.id, mode, productId);
        }
        const sub = await createSubscription(acct, chargeMinor, currency, donorEmail, donorName, productId, metadata, idempotencyKey);
        clientSecret = sub.clientSecret;
        paymentIntentId = sub.paymentIntentId;
        subscriptionId = sub.subscriptionId;
        if (!clientSecret || !paymentIntentId) throw new Error('subscription has no payment intent');
      } else {
        const intent = await createPaymentIntent(acct, chargeMinor, currency, metadata, idempotencyKey);
        clientSecret = intent.clientSecret;
        paymentIntentId = intent.id;
      }
    } catch (e) {
      log.warn('payment setup failed: ' + (e instanceof Error ? e.message : String(e)));
      return reply.code(502).send({ error: 'We couldn’t start the payment. Please try again.' });
    }
    store.createDonation({
      campaignId: c.id,
      stripeAccountId: acct.id,
      amount: chargeMinor,
      currency,
      status: 'pending',
      donorName,
      donorEmail,
      coverFees,
      giftAid,
      paymentIntentId,
      recurring: monthly,
      subscriptionId,
    });
    return {
      data: { clientSecret, publishableKey: acct.publishableKey, amount: toMajor(chargeMinor, currency), currency, recurring: monthly },
    };
  };
  app.post('/api/public/campaign/:slug/intent', intentHandler);
  app.post('/api/public/campaign/:slug/:token/intent', intentHandler); // back-compat

  // Confirm a return from the Payment Element by RETRIEVING the intent from Stripe
  // (never trust the client). Records the outcome + alerts the masjid on first success.
  const ConfirmBody = z.object({ paymentIntentId: z.string().max(255), slug: z.string().max(80), token: z.string().max(40).optional() });
  app.post('/api/public/confirm', async (req, reply) => {
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Missing payment reference.' });
    const { paymentIntentId, slug, token } = parsed.data;
    const c = resolvePublicCampaign(slug, token);
    if (!c) return reply.code(404).send({ error: 'Unknown campaign.' });
    const acct = store.getStripeAccount(c.stripeAccountId);
    const don = store.getDonationByPaymentIntent(paymentIntentId);
    if (!acct || !don || don.campaignId !== c.id) return reply.code(404).send({ error: 'Unknown donation.' });
    const pi = await retrievePaymentIntent(acct, paymentIntentId);
    if (!pi) return reply.code(502).send({ error: 'Couldn’t confirm with Stripe. Please try again.' });
    const succeeded = pi.status === 'succeeded';
    const wasPending = don.status === 'pending';
    const status: 'succeeded' | 'failed' | 'pending' = succeeded ? 'succeeded' : pi.status === 'processing' ? 'pending' : 'failed';
    const updated = store.markDonation(paymentIntentId, status, {
      donorName: pi.billingName || don.donorName,
      donorEmail: pi.receiptEmail || don.donorEmail,
      cardBrand: pi.cardBrand,
      cardLast4: pi.cardLast4,
    });
    if (succeeded && wasPending) {
      void notify({ title: 'New donation', text: `A donation of ${formatMoney(pi.amount, pi.currency)} to “${c.title}” was received.`, level: 'success' });
    }
    return {
      data: {
        status: pi.status,
        succeeded,
        amount: toMajor(pi.amount, pi.currency),
        currency: pi.currency,
        campaignTitle: c.title,
        donorName: updated?.donorName ?? '',
        recurring: don.recurring,
      },
    };
  });

  // ── Stripe webhook (optional, per-account secret) ───────────────────────────
  // Only needed when the app is publicly reachable. It records ongoing monthly
  // charges (invoice.paid on renewal) and resiliently confirms one-time payments.
  // The signature is verified with the account's own webhook secret.
  app.post('/api/stripe/webhook/:accountId', async (req, reply) => {
    const acct = store.getStripeAccount((req.params as { accountId: string }).accountId);
    if (!acct || !acct.webhookSecret) return reply.code(400).send({ error: 'Webhook not configured.' });
    const sig = req.headers['stripe-signature'];
    const raw = (req as unknown as { rawBody?: string }).rawBody;
    if (typeof sig !== 'string' || !raw) return reply.code(400).send({ error: 'Bad webhook request.' });
    const event = constructWebhookEvent(acct.secretKey, raw, sig, acct.webhookSecret);
    if (!event) return reply.code(400).send({ error: 'Signature verification failed.' });
    try {
      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object as { id: string };
        const don = store.getDonationByPaymentIntent(pi.id);
        if (don && don.status !== 'succeeded') store.markDonation(pi.id, 'succeeded');
      } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
        const inv = event.data.object as { billing_reason?: string; subscription?: string; payment_intent?: string; amount_paid?: number; currency?: string };
        // Only renewals here — the FIRST invoice is recorded via the donor's confirm flow.
        if (inv.billing_reason === 'subscription_cycle' && inv.subscription) {
          const original = store.getDonationBySubscription(inv.subscription);
          const piId = typeof inv.payment_intent === 'string' ? inv.payment_intent : '';
          if (original && piId && !store.getDonationByPaymentIntent(piId)) {
            const ccy = (inv.currency ?? original.currency).toUpperCase();
            const amt = inv.amount_paid ?? original.amount;
            store.createDonation({
              campaignId: original.campaignId,
              stripeAccountId: original.stripeAccountId,
              amount: amt,
              currency: ccy,
              status: 'succeeded',
              donorName: original.donorName,
              donorEmail: original.donorEmail,
              coverFees: original.coverFees,
              giftAid: original.giftAid,
              paymentIntentId: piId,
              recurring: true,
              subscriptionId: inv.subscription,
            });
            const camp = store.getCampaign(original.campaignId);
            void notify({ title: 'Recurring donation', text: `A monthly donation of ${formatMoney(amt, ccy)} to “${camp?.title ?? 'your masjid'}” was received.`, level: 'success' });
          }
        }
      }
    } catch (e) {
      log.warn('webhook handling error: ' + (e instanceof Error ? e.message : String(e)));
    }
    return { received: true };
  });

  // ── Static web app (built by Vite into ./public) ────────────────────────────
  const havePublic = fs.existsSync(path.join(config.publicDir, 'index.html'));
  if (havePublic) {
    await app.register(fastifyStatic, { root: config.publicDir, index: ['index.html'] });
  } else {
    log.warn(`no built web app at ${config.publicDir} — run "cd web && npm run build" (dev uses the Vite server)`);
  }

  // SPA fallback: client-side routes (e.g. /admin) resolve to index.html; requests
  // that look like a file (have an extension, e.g. a stale /assets/x.js) still 404
  // rather than silently returning the app shell; unknown API routes return JSON.
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '/';
    const pathname = url.split('?')[0];
    const looksLikeFile = path.extname(pathname) !== '';
    if (req.method === 'GET' && havePublic && !looksLikeFile && !url.startsWith('/api') && !url.startsWith('/healthz')) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found.' });
  });

  // Consistent JSON error envelope; never leak a stack trace OR framework-internal
  // text to the browser. Only a message the app itself authored (expose: true) is
  // surfaced; everything else becomes a friendly line.
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { message?: string; statusCode?: number; expose?: boolean };
    log.error('request error', e.message ?? 'unknown');
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    const friendly =
      status === 413 ? 'That request was too large.' : status < 500 ? "We couldn't process that request." : 'Something went wrong. Please try again.';
    reply.code(status).send({ error: e.expose && e.message ? e.message : friendly });
  });

  await app.listen({ port: config.port, host: config.host });
  log.info(`OpenMasjid Donations listening on http://${config.host}:${config.port}`);
  log.info(ssoConfigured() ? 'running embedded under OpenMasjidOS (Fabric available)' : 'running standalone (local password)');

  // Bring up the Cloudflare Tunnel if the admin has enabled it (no-op otherwise).
  const tcfg = store.getTunnel();
  tunnel.apply(tcfg.token, tcfg.enabled);

  const shutdown = () => {
    log.info('shutting down');
    tunnel.stop();
    store.close();
    app.close().finally(() => setTimeout(() => process.exit(0), 200));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  // Log the message only (not the whole error object) so a future thrown error
  // can't spill a key or connection string into the logs.
  log.error('fatal startup error', err instanceof Error ? err.message : err);
  process.exit(1);
});
