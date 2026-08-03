// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

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
import type { Campaign, Donation, StripeAccount, StripeConfig, ThankYou, LargeDonation, EmailReceipt } from './store';
import { COOKIE, cookieOptions, hashPassword, makeToken, verifyPassword, verifyToken, SSO_SESSION_MS } from './auth';
import { notify, probePlatform, fetchFabricStripe, cachedFabricStripe, fetchFabricStripeAccounts, clearFabricStripeCache, fetchFabricSite, cachedFabricSite, fabricConfigSignature, fabricEmail, fabricAlert, emailStatus } from './fabric';
import { renderReceipt, type ReceiptContext } from './email';
import {
  billingConfigured,
  MIN_TUITION_CENTS,
  studentsInfo,
  studentsIdentify,
  studentsLookup,
  recordStudentPayment,
  checkStudentPayment,
  createTuitionSession,
  getTuitionSession,
  computeTuitionAmount,
  type TuitionSelection,
} from './students';
import {
  MAX_FURTHER_PAYMENTS,
  cancelAtAfterCharges,
  cancelPlan,
  endOfDayUnix,
  endsAtUnix,
  fetchPlanInvoices,
  fetchPlanState,
  frequencyLabel,
  friendlyStatus,
  groupPlanSeeds,
  invoiceStatusLabel,
  isAbandonedSeed,
  isoFromUnix,
  mapWithLimit,
  nextPaymentUnix,
  pausePlan,
  planIsOver,
  planSyncOrder,
  resumePlan,
  setPlanEnd,
  type PlanInvoiceRaw,
  type PlanSeed,
  type PlanState,
} from './plans';
import { csvCell } from './csv';
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

  // Baseline fingerprint of the OpenMasjidOS Fabric config (Stripe account + remote-access
  // site). The watcher (started after listen) compares this over time and restarts the app
  // when the admin changes Stripe/remote-access IN OPENMASJIDOS, so the new config applies
  // without a manual container restart. Reset to null after an IN-APP change so that change
  // (already applied via a cache clear) doesn't itself trigger a restart.
  let fabricBaseline: string | null = null;

  const app = Fastify({
    logger: false, // we log ourselves and never log secrets
    // trustProxy stays OFF: the app is port-mapped directly (no reverse proxy in
    // front), so a client-supplied X-Forwarded-For must NOT be trusted — otherwise
    // the login rate-limiter could be bypassed by spoofing it. We key the limiter on
    // the real TCP peer below. (A future reverse-proxy deployment would set this to
    // the specific trusted proxy CIDR, not `true`.)
    bodyLimit: 1_048_576, // 1 MiB JSON cap (uploads get their own limit later)
    // Base-path awareness (manifest `domain: true`): when OpenMasjidOS exposes us behind
    // its Cloudflare tunnel it forwards the FULL admin-chosen path prefix (e.g. /donate)
    // WITHOUT stripping it, so requests arrive as /donate/api/x, /donate/assets/y, etc.
    // We strip that prefix here, before routing, so every route below stays written at the
    // root and works identically on the LAN (no prefix) and behind the tunnel. The prefix
    // comes from the Fabric `basePath` (cached, refreshed below); empty = nothing to strip.
    rewriteUrl(req) {
      const url = req.url ?? '/';
      const base = cachedFabricSite().basePath;
      if (!base) return url;
      if (url === base) return '/';
      if (url.startsWith(base + '/')) return url.slice(base.length);
      if (url.startsWith(base + '?')) return '/' + url.slice(base.length);
      return url;
    },
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
      // Whether donations can be taken (no secrets here): a local account is set up,
      // OR the platform-vaulted Fabric account is (uses the cached copy — no per-load
      // platform call; it's warmed by the admin/campaign requests).
      donationsConfigured:
        store.listStripeAccounts().some((a) => stripeConfigured(a)) ||
        (() => { const f = cachedFabricStripe(); return !!f && stripeConfigured(f); })(),
      // Public address from the OS Fabric remote-access tunnel (manifest `domain: true`),
      // used by the web for share links + QR. Empty when remote access is off → the web
      // falls back to this device's address. Not secret.
      publicUrl: cachedFabricSite().publicUrl,
      basePath: cachedFabricSite().basePath,
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
    // True unless we tried to reach the platform and couldn't — lets the UI tell
    // "open it from the dashboard" apart from "OpenMasjidOS is unreachable" (a
    // migrated/down platform must offer the local-password way in, not a dead loop).
    let reachable = true;
    if (!authed && ssoConfigured()) {
      const probe = await probePlatform(req.headers.cookie);
      reachable = probe.reachable;
      if (probe.username) {
        reply.setCookie(COOKIE, makeToken(store.secret, SSO_SESSION_MS), cookieOptions(SSO_SESSION_MS));
        authed = true;
        username = probe.username;
      }
    }
    return {
      data: {
        // Standalone first run creates a password. Under OpenMasjidOS, signing in is
        // the dashboard's job (SSO) — but a local password is ALWAYS available as a
        // recovery (see /api/setup), so the panel can never get bricked.
        needsSetup: !store.hasAdmin() && !ssoConfigured(),
        authed,
        hasPassword: store.hasAdmin(),
        sso: { enabled: ssoConfigured(), reachable, username },
      },
    };
  });

  // ── First-run setup / local-password recovery ───────────────────────────────
  const SetupBody = z.object({ password: z.string().min(8).max(200), name: z.string().max(80).optional() });
  app.post('/api/setup', async (req, reply) => {
    if (store.hasAdmin()) return reply.code(409).send({ error: 'This app is already set up.' });
    // The local password is a RECOVERY for when OpenMasjidOS can't sign you in. We allow
    // it whenever SSO isn't configured (standalone) OR the platform is currently
    // unreachable (a restore onto a new box, the OS briefly down) — so the panel can
    // never get bricked (see docs/RESTORE_SSO_FIX.md). But when the platform IS reachable
    // we refuse: the admin should sign in through the dashboard, and refusing here closes
    // the pre-setup window where a passer-by on the LAN could otherwise claim the admin
    // password before the real admin. Distinguishing "not configured" from "configured
    // but unreachable" is exactly what the Fabric restore-resilience contract requires.
    if (ssoConfigured() && (await probePlatform(req.headers.cookie)).reachable) {
      return reply.code(403).send({ error: 'Sign in through your OpenMasjidOS dashboard — press Open on the Donations app.' });
    }
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

  // ── Stripe account resolution: Fabric vault first, local keys as fallback ────
  // When embedded under OpenMasjidOS with the `stripe` capability, the admin configures
  // Stripe ONCE in the platform (Settings → Payments) and every app shares that vaulted
  // account — chosen here by the STRIPE_ACCOUNT install setting. It is the source of
  // truth and is shared by every campaign. Standalone (or if the Fabric is unreachable /
  // has no such account), we fall back to the campaign's own locally-entered keys. The
  // fetched secret/webhook keys live in memory only (never our data volume), so they
  // always track the OS vault — including after a restore onto a new machine.
  type ResolvedAccount = StripeConfig & { id: string; label: string };

  /** The platform-vaulted Stripe account for this app, or null when not embedded /
   *  unreachable / not set up in OpenMasjidOS. Uses the account the admin picked on the
   *  in-app Payments screen (store choice; '' = the only/first vault account). */
  const fabricAccount = async (): Promise<ResolvedAccount | null> => {
    if (!ssoConfigured()) return null;
    return await fetchFabricStripe(store.getFabricStripeChoice());
  };

  /** The effective Stripe account a campaign should charge through: the Fabric vault
   *  account when it's actually CONFIGURED (a real pk+sk pair), else the campaign's own
   *  local account. The `stripeConfigured` gate matters — a half-set-up vault account
   *  (secret present but publishable still blank in OpenMasjidOS) must NOT shadow a
   *  working local account, or donations would silently break mid-migration. */
  const effectiveAccountFor = async (c: Campaign): Promise<ResolvedAccount | null> => {
    const fab = await fabricAccount();
    if (fab && stripeConfigured(fab)) return fab;
    return store.getStripeAccount(c.stripeAccountId);
  };

  /** Resolve a Stripe account by id across both sources (used by the webhook route,
   *  whose URL embeds the account id we handed to Stripe). */
  const accountById = async (id: string): Promise<ResolvedAccount | null> => {
    const local = store.getStripeAccount(id);
    if (local) return local;
    const fab = await fabricAccount();
    return fab && fab.id === id ? fab : null;
  };

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

  /** Non-secret view of the platform-vaulted Stripe account (so the admin Payments
   *  screen can show "using your OpenMasjidOS account" instead of asking for keys).
   *  Never includes secrets — only the publishable key + booleans (publicStripeStatus). */
  const fabricStripeStatus = async () => {
    const chosen = store.getFabricStripeChoice();
    const a = await fabricAccount();
    if (!a) return { available: false as const, chosenId: chosen };
    return { available: true as const, id: a.id, label: a.label, chosenId: chosen, ...publicStripeStatus(a) };
  };

  // ── Settings: masjid details + onboarding (Stripe accounts have own routes) ──
  app.get('/api/settings', { preHandler: requireAdmin }, async () => ({
    data: {
      masjid: store.getMasjid(),
      stripeAccounts: store.listStripeAccounts().map(publicAccount),
      fabricStripe: await fabricStripeStatus(),
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
    logo: z.string().max(2000).optional(),
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

  // ── Thank-you screen: the global default shown after a donation ──────────────
  // Per-campaign overrides live on the campaign (CampaignBody.thankYou); empty fields
  // inherit this default. Heading/message support {name} {amount} {campaign} {masjid}.
  const ThankYouBody = z.object({
    heading: z.string().max(200).optional(),
    message: z.string().max(2000).optional(),
    backgroundImage: z.string().max(2000).optional(),
    accent: z.string().max(40).optional(),
  });
  app.get('/api/admin/thankyou', { preHandler: requireAdmin }, async () => ({ data: store.getThankYou() }));
  app.put('/api/admin/thankyou', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = ThankYouBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the details and try again.' });
    const patch = parsed.data.accent !== undefined ? { ...parsed.data, accent: sanitizeAccent(parsed.data.accent) } : parsed.data;
    return { data: store.setThankYou(patch) };
  });

  // ── Large-donation alternative: a global gentle nudge for big gifts ──────────
  // Above `threshold`, the donor sees a suggestion of a cheaper way to give (a message +
  // an optional QR/image) before the card — they can still pay by card. The route speaks
  // MAJOR units; the store keeps minor. `qrImage` is allowlist-validated in setLargeDonation.
  const LargeDonationBody = z.object({
    threshold: z.number().nonnegative().optional(), // major units; 0 = never show
    message: z.string().max(600).optional(),
    qrImage: z.string().max(2000).optional(),
  });
  app.get('/api/admin/large-donation', { preHandler: requireAdmin }, async () => {
    const ld = store.getLargeDonation();
    return { data: { ...ld, threshold: toMajorCur(ld.threshold) } };
  });
  app.put('/api/admin/large-donation', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = LargeDonationBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the details and try again.' });
    const patch: Partial<LargeDonation> = { ...parsed.data };
    if (patch.threshold !== undefined) patch.threshold = toMinorCur(patch.threshold);
    const ld = store.setLargeDonation(patch);
    return { data: { ...ld, threshold: toMajorCur(ld.threshold) } };
  });

  // ── Emailed donation receipt (via the OpenMasjidOS Fabric email provider) ────
  // Resolve the header image to an ABSOLUTE url an email client can load: an http(s) URL is
  // used as-is; an uploaded /uploads/… file only works when the app is publicly reachable, so
  // we prefix the Fabric public URL and drop it otherwise (the email just has no image).
  const resolveEmailImage = (image: string): string => {
    const v = (image ?? '').trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/uploads\//.test(v)) {
      const pub = cachedFabricSite().publicUrl;
      return pub ? `${pub}${v}` : '';
    }
    return '';
  };

  /** Format the receipt "date paid" using the server locale + timezone (best-effort). */
  const fmtReceiptDate = (iso: string): string => {
    const d = new Date(iso);
    try {
      return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' }).format(d);
    } catch {
      return d.toISOString();
    }
  };
  /** "Visa •••• 4242" (or "Card") from the captured card brand + last 4. */
  const paymentMethodLabel = (brand: string, last4: string): string => {
    const b = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : '';
    if (b && last4) return `${b} •••• ${last4}`;
    if (last4) return `Card •••• ${last4}`;
    return 'Card';
  };
  /** Build the Stripe-style receipt context for a donation (from the donation row + masjid). */
  const receiptContext = (don: Donation): ReceiptContext => {
    const m = store.getMasjid();
    return {
      name: don.donorName || '',
      amountText: formatMoney(don.amount, don.currency),
      campaignTitle: store.getCampaign(don.campaignId)?.title ?? '',
      masjidName: m.name || '',
      masjidLogo: resolveEmailImage(m.logo), // the masjid logo (Settings → Your masjid), if publicly reachable
      datePaid: fmtReceiptDate(don.createdAt),
      paymentMethod: paymentMethodLabel(don.cardBrand, don.cardLast4),
      reference: don.id.replace(/^don_/, '').slice(0, 8).toUpperCase(),
      contactEmail: m.email || '',
      contactPhone: m.phone || '',
      contactWebsite: m.website || '',
    };
  };

  /** Render + send a donor's branded receipt for a donation. Returns whether it {sent} and
   *  whether a failure is worth a {retry} (transient/system) vs permanent (no/invalid email, or
   *  the provider rejected the recipient). NEVER throws. Does NOT re-check the enabled toggle —
   *  the CALLER gates on the donation's recorded decision (receipt==='pending'). */
  const sendDonationReceipt = async (don: Donation): Promise<{ sent: boolean; retry: boolean }> => {
    const addr = (don.donorEmail || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return { sent: false, retry: false }; // no/invalid email → never sendable
    try {
      const rendered = renderReceipt(store.getEmailReceipt(), receiptContext(don));
      const res = await fabricEmail({ to: addr, subject: rendered.subject, text: rendered.text, html: rendered.html });
      if (res.sent) return { sent: true, retry: false };
      return { sent: false, retry: res.reason !== 'bad_recipient' }; // bad recipient is permanent; everything else retries
    } catch {
      return { sent: false, retry: true };
    }
  };

  const EmailReceiptBody = z.object({
    enabled: z.boolean().optional(),
    subject: z.string().max(200).optional(),
    heading: z.string().max(200).optional(),
    body: z.string().max(4000).optional(),
    accent: z.string().max(40).optional(),
  });
  // embedded + emailStatus let the UI show whether OS email is set up (no probe on load —
  // emailStatus is the last real send/test outcome; 'ok' once a send succeeded).
  const emailReceiptView = (cfg: EmailReceipt) => ({ ...cfg, embedded: ssoConfigured(), emailStatus: emailStatus() });
  app.get('/api/admin/email-receipt', { preHandler: requireAdmin }, async () => ({ data: emailReceiptView(store.getEmailReceipt()) }));
  app.put('/api/admin/email-receipt', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = EmailReceiptBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the details and try again.' });
    const patch: Partial<EmailReceipt> = { ...parsed.data };
    if (patch.accent !== undefined) patch.accent = sanitizeAccent(patch.accent);
    return { data: emailReceiptView(store.setEmailReceipt(patch)) };
  });
  // In-app "send me a test": fire the declared `test` alert. The platform delivers it to the
  // ADMIN's own email + webhook (per their Settings → Alerts matrix) — the app never learns the
  // admin's address. (Donor receipts still go via /api/fabric/email with the donor's address; the
  // admin's email is never exposed to apps, so this is the only way the app can reach the admin.)
  app.post('/api/admin/test-alert', { preHandler: requireAdmin }, async () => {
    const res = await fabricAlert(
      'test',
      'Test from OpenMasjid Donations',
      'If you received this, OpenMasjidOS is reaching you by email/webhook. Your donation receipts go to donors through the same email provider.',
      'info',
    );
    return { data: res };
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

  // ── In-app picker for the OpenMasjidOS-vault Stripe account (Fabric, embedded) ──
  // Lists the masjid's vault accounts (id + label, NEVER keys) so the admin can choose
  // one on the Payments screen — keeps install one-click (no STRIPE_ACCOUNT setting).
  app.get('/api/admin/stripe/fabric-accounts', { preHandler: requireAdmin }, async () => ({
    data: { accounts: await fetchFabricStripeAccounts(), chosenId: store.getFabricStripeChoice() },
  }));
  app.put('/api/admin/stripe/fabric-account', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ accountId: z.string().max(120) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please choose an account.' });
    store.setFabricStripeChoice(parsed.data.accountId.trim());
    // Apply the new choice immediately: drop the cached keys so the next fetch (this status
    // call, then campaign-create / charges) re-reads the OS vault — no restart needed. Reset
    // the watcher baseline so this in-app change isn't mistaken for an external one + rebooted.
    clearFabricStripeCache();
    fabricBaseline = null;
    return { data: await fabricStripeStatus() };
  });

  // ── Campaigns (admin CRUD) ──────────────────────────────────────────────────
  const CampaignBody = z.object({
    title: z.string().min(1).max(120).optional(),
    type: z.enum(['donation', 'zakat', 'tuition']).optional(),
    slug: z.string().max(60).optional(),
    description: z.string().max(8000).optional(),
    coverImage: z.string().max(2000).optional(),
    backgroundImage: z.string().max(2000).optional(),
    logo: z.string().max(2000).optional(),
    presetAmounts: z.array(z.number().nonnegative()).max(12).optional(), // major units
    allowCustom: z.boolean().optional(),
    minAmount: z.number().nonnegative().optional(), // major
    maxAmount: z.number().nonnegative().optional(), // major, 0 = none
    stripeAccountId: z.string().max(64).optional(),
    coverFees: z.boolean().optional(),
    forceCoverFees: z.boolean().optional(),
    giftAid: z.boolean().optional(),
    allowMonthly: z.boolean().optional(),
    widgetEnabled: z.boolean().optional(),
    goalAmount: z.number().nonnegative().optional(), // major
    active: z.boolean().optional(),
    // Per-campaign thank-you override; any empty field inherits the global default.
    thankYou: z.object({
      heading: z.string().max(200).optional(),
      message: z.string().max(2000).optional(),
      backgroundImage: z.string().max(2000).optional(),
      accent: z.string().max(40).optional(),
    }).optional(),
  });
  /** Keep an accent only if it's a valid hex colour, else '' — so an unvalidated value can
   *  never reach a style/markup consumer (the browser already checks, this is belt-and-braces). */
  const sanitizeAccent = (a?: string): string => (a && /^#[0-9a-fA-F]{3,8}$/.test(a.trim()) ? a.trim() : '');

  /** Normalise a thank-you override from the request into a full (empty-filled) object. */
  const thankYouOverride = (t: z.infer<typeof CampaignBody>['thankYou']): import('./store').ThankYou | undefined =>
    t === undefined ? undefined : { heading: t.heading ?? '', message: t.message ?? '', backgroundImage: t.backgroundImage ?? '', accent: sanitizeAccent(t.accent) };
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
    if (!p.type) return reply.code(400).send({ error: 'Please choose a campaign type (Donation, Zakat or Tuition).' });
    // Pick the account to attach: an explicit choice, else the first local account,
    // else the platform-vaulted Fabric account (when embedded). Charges always resolve
    // the effective account at pay time (Fabric first), so this is just the default.
    const accountId = p.stripeAccountId || store.listStripeAccounts()[0]?.id || (await fabricAccount())?.id;
    if (!accountId) return reply.code(400).send({ error: 'Add a Stripe account before creating a campaign.' });
    const { slug, error } = resolveSlug(p.slug, p.title!);
    if (error) return reply.code(409).send({ error });
    const c = store.createCampaign({
      title: p.title!, // guarded above — title is required for create
      type: p.type, // guarded above — required on create
      slug,
      description: p.description,
      coverImage: p.coverImage,
      backgroundImage: p.backgroundImage,
      logo: p.logo,
      allowCustom: p.allowCustom,
      stripeAccountId: accountId,
      coverFees: p.coverFees,
      forceCoverFees: p.forceCoverFees,
      giftAid: p.giftAid,
      allowMonthly: p.allowMonthly,
      widgetEnabled: p.widgetEnabled,
      active: p.active,
      thankYou: thankYouOverride(p.thankYou),
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
      type: p.type,
      slug,
      description: p.description,
      coverImage: p.coverImage,
      backgroundImage: p.backgroundImage,
      logo: p.logo,
      allowCustom: p.allowCustom,
      stripeAccountId: p.stripeAccountId,
      coverFees: p.coverFees,
      forceCoverFees: p.forceCoverFees,
      giftAid: p.giftAid,
      allowMonthly: p.allowMonthly,
      widgetEnabled: p.widgetEnabled,
      active: p.active,
      thankYou: thankYouOverride(p.thankYou),
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
  /** Donor records must never be cached — not by a browser, not by a shared proxy, and above all
   *  not by the Cloudflare edge when the admin has turned on public access. `.csv` is one of the
   *  extensions Cloudflare caches by default, and a response with no cache directives at a static
   *  extension is a candidate for the edge cache — after which the cached donor list can be served
   *  to a request carrying no session cookie at all. `vary: cookie` is belt-and-braces for any
   *  proxy that does key on it. Applies to the JSON log as well as the export: same data. */
  const noStoreDonorData = (reply: import('fastify').FastifyReply) => {
    reply.header('cache-control', 'no-store, private, max-age=0').header('pragma', 'no-cache').header('vary', 'cookie');
  };

  app.get('/api/admin/donations', { preHandler: requireAdmin }, async (_req, reply) => {
    noStoreDonorData(reply);
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
    noStoreDonorData(reply);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="donations.csv"');
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  });

  // ── Monthly plans (recurring donations) ─────────────────────────────────────
  // The admin's view of every monthly donation plan, and the controls to pause, resume,
  // stop or put an end date on one. Three sources, deliberately (the reasoning lives in
  // plans.ts):
  //   • the INDEX is LOCAL — recurring donation rows — so a subscription WE did not create
  //     can never appear (it has no row here), which matters because a Fabric-vaulted
  //     Stripe account is SHARED with the platform's other apps; and tuition can never
  //     appear, because a tuition payment is written to `student_payments` and never to
  //     `donations` at all (§13 route isolation) — structurally absent, not filtered out;
  //   • plan STATE is read LIVE from Stripe per plan, an outbound call that works on a
  //     LAN-only box where an inbound webhook never would;
  //   • the MONEY is LOCAL, summed over those rows — which is only truthful if renewals
  //     are recorded, hence reconcileRenewals below.
  const PLAN_CACHE_MS = 60_000;
  const PLAN_SYNC_CAP = 200; // most plans we'll ask Stripe about in one request
  const PLAN_INVOICE_LIMIT = 24;
  const PLAN_SYNC_CONCURRENCY = 5; // a Pi must not open 200 sockets at once
  const STRIPE_PLAN_DOWN = 'We couldn’t reach Stripe to change this plan. Please try again.';
  const STRIPE_PLAN_STALE = 'We couldn’t reach Stripe just now, so this shows what’s on file here. Please try again in a moment.';
  // Missing keys are NOT an outage: the account was removed from OpenMasjidOS, or this app
  // lost the `stripe` capability. Stripe is fine and retrying can never help, so we say so
  // and point at the two places the admin can fix it.
  const STRIPE_PLAN_NO_KEYS =
    'This plan’s Stripe account isn’t set up on this device any more — check Payments, or OpenMasjidOS → Settings → Payments.';
  const STRIPE_PLANS_NO_KEYS =
    'Some of these plans were set up with a Stripe account that isn’t on this device any more, so we can’t show their live details — check Payments, or OpenMasjidOS → Settings → Payments.';

  /** Live plan state, cached briefly so opening (or re-opening) the tab doesn't hammer
   *  Stripe. The invoice markers are kept EVEN AFTER the TTL expires: they are how the next
   *  sync knows whether any new money can have landed, and therefore whether listing the
   *  invoices is worth doing. Steady state is one Stripe call per plan. */
  const planCache = new Map<string, { at: number; state: PlanState; latestInvoiceId: string; latestInvoicePaid: boolean }>();

  /** Round a summed major-unit total — floats accumulate noise once you add 200 of them. */
  const round2 = (n: number) => Math.round(n * 100) / 100;

  /** Record any PAID invoice of this plan that we don't already hold as a donation.
   *
   *  This is the same insert the optional `invoice.paid` webhook performs, reached by the
   *  reliable retrieve-on-demand route instead of an inbound hook a LAN-only masjid may
   *  never receive. It is a CATCH-UP, not an event: no receipt email and no notify(), or a
   *  masjid would get a dozen alerts the first time they open this tab. (The webhook path
   *  keeps its notify — there, the money really did just arrive.)
   *
   *  Idempotent, twice over: `payment_intent_id` is UNIQUE, and we check for the row first.
   *  A failed renewal is never recorded as a donation. */
  const reconcileRenewals = (seed: PlanSeed, invoices: PlanInvoiceRaw[]): void => {
    let warnedMissingIntent = false;
    // Oldest first, so a plan's history lands in the order the money actually arrived.
    for (const inv of [...invoices].sort((a, b) => a.momentUnix - b.momentUnix)) {
      const piId = inv.paymentIntentId;
      if (!piId) {
        // No PaymentIntent = no key we can be idempotent on. The donations table's UNIQUE
        // index sits on a column defaulting to '', so inventing a blank key would collide
        // with the next such invoice. Skip it rather than guess.
        if (!warnedMissingIntent) {
          warnedMissingIntent = true;
          log.warn(`monthly plan ${seed.subscriptionId}: skipped an invoice with no payment reference`);
        }
        continue;
      }
      const existing = store.getDonationByPaymentIntent(piId);
      if (existing) {
        // We already know this charge. If Stripe says it's paid but our row never got
        // confirmed (the donor closed the tab, say), put that right — Stripe is the truth.
        // (We still send nothing ourselves. If that row was owed a branded receipt, the
        // existing receipt outbox posts it, exactly as it would after a webhook confirm —
        // that's the donor's own receipt for their own payment, not a catch-up alert.)
        if (inv.paid && inv.amountPaidMinor > 0 && existing.status !== 'succeeded') store.markDonation(piId, 'succeeded');
        continue;
      }
      if (!inv.paid || inv.amountPaidMinor <= 0) continue; // a failed/open renewal is not income
      try {
        store.createDonation({
          // Everything descriptive is copied from the plan's FIRST donation — the row the
          // donor actually filled in. A renewal has no form of its own.
          campaignId: seed.campaignId,
          stripeAccountId: seed.stripeAccountId,
          amount: inv.amountPaidMinor,
          currency: (inv.currency || seed.currency).toUpperCase(),
          status: 'succeeded',
          donorName: seed.donorName,
          donorEmail: seed.donorEmail,
          coverFees: seed.coverFees,
          giftAid: seed.giftAid,
          paymentIntentId: piId,
          recurring: true,
          subscriptionId: seed.subscriptionId,
          cardBrand: seed.cardBrand,
          cardLast4: seed.cardLast4,
          // The date the money ARRIVED, not today — otherwise a year of caught-up renewals
          // would all land in this month's total and wreck the 6-month trend.
          createdAt: isoFromUnix(inv.momentUnix) || new Date().toISOString(),
          // 'stripe' = we owe no branded email for it. A catch-up must not post letters.
          receipt: 'stripe',
        });
      } catch (e) {
        // A concurrent sync of the same plan can lose the UNIQUE race — harmless, the other
        // one wrote the row. Never let it break the tab.
        log.warn(`monthly plan ${seed.subscriptionId}: couldn’t record a renewal: ${e instanceof Error ? e.message : 'error'}`);
      }
    }
  };

  /** Why a sync produced no live state. Three outcomes, not two: "we have no keys for this
   *  plan's Stripe account any more" is a different thing from "Stripe didn't answer", and
   *  telling an admin to try again when only the first is true wastes their afternoon. */
  type PlanSyncOutcome = 'ok' | 'no-keys' | 'unreachable';
  type PlanSync = { state: PlanState | null; invoices: PlanInvoiceRaw[] | null; account: ResolvedAccount | null; outcome: PlanSyncOutcome };

  /** Bring one plan up to date: live state from Stripe (cached 60s unless forced), plus a
   *  renewal reconciliation whenever new money can have landed. `state: null` means we have
   *  no live view — the caller then renders the plan from local data alone, and reads
   *  `outcome` to say WHY. We deliberately do NOT fall back to a stale cached state there:
   *  "Not known" is honest, a month-old status presented as current is not.
   *
   *  `reconcile: false` keeps the read side and skips the WRITE side (see the list route's
   *  same-origin check) — and then leaves the cached invoice markers alone, so the next real
   *  sync still does the catch-up rather than believing it was already done. */
  const syncPlan = async (seed: PlanSeed, force: boolean, reconcile = true): Promise<PlanSync> => {
    const cached = planCache.get(seed.subscriptionId);
    if (!force && cached && Date.now() - cached.at < PLAN_CACHE_MS) {
      return { state: cached.state, invoices: null, account: null, outcome: 'ok' };
    }
    const account = await accountById(seed.stripeAccountId);
    if (!account || !account.secretKey) return { state: null, invoices: null, account: null, outcome: 'no-keys' };
    const state = await fetchPlanState(account.secretKey, seed.subscriptionId);
    if (!state) return { state: null, invoices: null, account, outcome: 'unreachable' };
    let invoices: PlanInvoiceRaw[] | null = null;
    // When could new money have landed? Never synced this plan; a NEW newest invoice; a
    // forced refresh (the admin pressed Refresh — always look, never just skip the TTL); or
    // — the case a bare id comparison misses — a newest invoice that was NOT paid last time
    // we looked. Stripe retries a failed renewal against the SAME invoice, so its id never
    // changes; but once an invoice IS paid it can never gain money again, so "same id, and
    // it was already paid" really does mean there is nothing to reconcile.
    // …and once a plan is over for good, its newest invoice can never be paid either, so that
    // last clause has to stop applying or a dead plan would re-list its invoices for ever.
    const mayHaveNewMoney =
      force ||
      !cached ||
      cached.latestInvoiceId !== state.latestInvoiceId ||
      (!!state.latestInvoiceId && !cached.latestInvoicePaid && !planIsOver(state));
    if (reconcile && mayHaveNewMoney) {
      invoices = await fetchPlanInvoices(account.secretKey, seed.subscriptionId, PLAN_INVOICE_LIMIT);
      if (invoices) reconcileRenewals(seed, invoices);
    }
    if (planCache.size > 2000) {
      const stale = Date.now() - 24 * 3600_000;
      for (const [k, v] of planCache) if (v.at < stale) planCache.delete(k);
    }
    // The markers may only move forward once we have actually caught up — i.e. we saw the
    // invoice list, or there was nothing new to see. If the catch-up was skipped (not our own
    // page's fetch) or the invoice list itself failed, keep the old markers so it happens next
    // time; a marker that runs ahead of the money would hide a renewal until the month after.
    const caughtUp = invoices !== null || !mayHaveNewMoney;
    const markers = caughtUp
      ? { latestInvoiceId: state.latestInvoiceId, latestInvoicePaid: state.latestInvoicePaid }
      : { latestInvoiceId: cached?.latestInvoiceId ?? '', latestInvoicePaid: cached?.latestInvoicePaid ?? false };
    // The TTL may only be extended by a sync that was allowed to WRITE. Otherwise a page an
    // admin merely visits could navigate here every 50 seconds and keep the cache permanently
    // warm, so the admin's own tab always got the cached early-return and reconciliation never
    // ran — the same-origin guard above would have caused the very gap it exists to prevent.
    planCache.set(seed.subscriptionId, { at: reconcile ? Date.now() : (cached?.at ?? 0), state, ...markers });
    return { state, invoices, account, outcome: 'ok' };
  };

  /** One row of the plans list. Amounts cross the API in MAJOR units, in the PLAN's own
   *  currency (which is what the donor is charged in). `live` is true when the row carries
   *  real Stripe state — freshly fetched, or from the 60-second cache, which is still this
   *  request's state and only seconds old; false only when we're showing local data alone. */
  const buildPlan = (seed: PlanSeed, state: PlanState | null, titles: Map<string, string>) => {
    const currency = (state?.currency || seed.currency || cur()).toUpperCase();
    // Stripe's price is the truth about what's charged from now on; the first donation is
    // the fallback (a tiered/custom price reports no unit_amount, and Stripe may be down).
    const amountMinor = state && state.amountMinor != null ? state.amountMinor : seed.amountMinor;
    const st = state ? friendlyStatus(state.status, state.paused) : ({ status: 'unknown', label: 'Not known' } as const);
    const interval = state?.interval ?? '';
    const intervalCount = state?.intervalCount ?? 0;
    return {
      id: seed.subscriptionId,
      ref: donationRef(seed.firstDonationId),
      campaignId: seed.campaignId,
      campaignTitle: titles.get(seed.campaignId) ?? '—',
      donorName: seed.donorName,
      donorEmail: seed.donorEmail,
      amount: toMajor(amountMinor, currency),
      currency,
      interval,
      intervalCount,
      frequency: frequencyLabel(interval, intervalCount),
      status: st.status,
      statusLabel: st.label,
      cardBrand: state?.cardBrand || seed.cardBrand,
      cardLast4: state?.cardLast4 || seed.cardLast4,
      startedAt: seed.startedAt,
      lastPaymentAt: seed.lastPaymentAt,
      nextPaymentAt: state ? isoFromUnix(nextPaymentUnix(state)) : '',
      collected: toMajor(seed.collectedMinor, currency),
      payments: seed.payments,
      endsAt: state ? isoFromUnix(endsAtUnix(state)) : '',
      live: state !== null,
    };
  };

  const campaignTitles = () => new Map(store.listCampaigns().map((c) => [c.id, c.title]));

  /** Read + fold the whole recurring table. Not cheap, so every route reads it ONCE and
   *  passes the array down; the only extra call is the deliberate re-read after a sync has
   *  written renewals, which has to see the new money. */
  const planSeeds = () => groupPlanSeeds(store.listRecurringDonations());

  /** Resolve a plan from the LOCAL index. Every plan route goes through this and 404s when
   *  the subscription id isn't one of ours — the guard that stops an admin, or a stray
   *  request, acting on another app's subscription in a shared Stripe account. */
  const findSeed = (seeds: PlanSeed[], id: string): PlanSeed | null => seeds.find((s) => s.subscriptionId === id) ?? null;

  /** The plan as it now stands, re-read from Stripe after an action. If that re-read fails
   *  we return the local row (live:false) rather than an error: the change WAS applied, and
   *  a 502 here would invite the admin to do it a second time. The seed re-read is required,
   *  not wasteful: the sync above may just have recorded a renewal. */
  const planNow = async (seed: PlanSeed) => {
    const r = await syncPlan(seed, true);
    return buildPlan(findSeed(planSeeds(), seed.subscriptionId) ?? seed, r.state, campaignTitles());
  };

  /** Does this request look like our own admin page's fetch?
   *
   *  The session cookie is SameSite=Lax, so a cross-site TOP-LEVEL navigation to
   *  `/api/admin/plans?refresh=1` carries it: a page an admin merely visits could force
   *  hundreds of outbound Stripe calls and donation INSERTs. It can't read the JSON back, so
   *  this is forced work rather than disclosure — but the WRITE side (reconciliation) is
   *  still gated on this. Our own fetch sends `same-origin`; a browser navigation sends
   *  `cross-site`/`same-site`; curl and older browsers send nothing at all. Live state is
   *  read either way, so the route stays a plain GET for everybody. */
  const ownPageFetch = (req: { headers: Record<string, unknown> }): boolean => {
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin';
  };

  app.get('/api/admin/plans', { preHandler: requireAdmin }, async (req) => {
    const force = (req.query as { refresh?: string }).refresh === '1';
    const ownPage = ownPageFetch(req);
    const seeds = planSeeds(); // newest first
    // Which plans get a live refresh, in which order. Plans that have taken money go FIRST:
    // a recurring donation row is written at /intent, BEFORE the card is entered, so every
    // abandoned monthly checkout leaves a £0 row behind — and a visitor on the masjid's own
    // network can create them without logging in. Filled newest-first, a burst of those would
    // fill the cap entirely and silently stop renewal reconciliation for every real plan.
    const syncing = planSyncOrder(seeds).slice(0, PLAN_SYNC_CAP);
    const capped = seeds.length > syncing.length;
    if (capped) log.warn(`monthly plans: ${seeds.length} plans — refreshing ${PLAN_SYNC_CAP} (paid plans first)`);
    const synced = await mapWithLimit(syncing, PLAN_SYNC_CONCURRENCY, (s) => syncPlan(s, force, ownPage));
    const syncedBySub = new Map(syncing.map((s, i) => [s.subscriptionId, synced[i]]));
    // Re-read the money side AFTER reconciliation, so a renewal we just caught up on counts
    // in this very response (else the first open of the tab would under-report every plan).
    const fresh = new Map(planSeeds().map((s) => [s.subscriptionId, s]));

    // Only NOW may abandoned sign-ups be dropped — after the sync, never before it. A plan
    // whose first payment succeeded but whose /confirm never round-tripped also shows £0
    // locally, and the reconciliation above is what puts it right; filtering earlier would
    // hide precisely the row that needed healing (see isAbandonedSeed).
    // …and only for a plan this request actually SYNCED. A seed the cap left out (or that we
    // deliberately didn't reconcile, below) has not had its chance to heal, so hiding it would
    // be acting on the very £0 we haven't checked — and once hidden the admin can't open it
    // either, which is the one route that would have reconciled it.
    const nowMs = Date.now();
    const shown: PlanSeed[] = [];
    let abandoned = 0;
    for (const s of seeds) {
      const seed = fresh.get(s.subscriptionId) ?? s;
      const checked = ownPage && syncedBySub.has(s.subscriptionId);
      if (checked && isAbandonedSeed(seed, nowMs)) abandoned += 1;
      else shown.push(seed);
    }
    const titles = campaignTitles();
    const plans = shown.map((s) => buildPlan(s, syncedBySub.get(s.subscriptionId)?.state ?? null, titles));

    // "Stripe is down" only when a live read actually FAILED. A plan whose keys have gone is
    // not Stripe's fault and must not make the whole tab claim an outage.
    const anyUnreachable = synced.some((r) => r.outcome === 'unreachable');
    const anyMissingKeys = synced.some((r) => r.outcome === 'no-keys');
    // Both headline totals wear ONE currency symbol, so only plans actually charged in that
    // currency may be folded in. A second Stripe account in another currency would otherwise
    // make the figure a sum of mixed units — worse with a zero-decimal currency, where
    // ¥1,000 and £10.00 are the same number of minor units.
    const currency = cur();
    const inCurrency = (p: { currency: string }) => p.currency === currency;
    const mixedCurrency = plans.some((p) => !inCurrency(p));
    const active = plans.filter((p) => p.status === 'active');

    const notes: string[] = [];
    if (anyUnreachable) notes.push('We couldn’t reach Stripe just now, so these plans show what’s on file here. Please try again in a moment.');
    if (anyMissingKeys) notes.push(STRIPE_PLANS_NO_KEYS);
    // Warn about staleness only when a row we're actually SHOWING missed the refresh — the raw
    // cap can bite entirely on abandoned sign-ups that aren't on screen at all.
    if (shown.some((s) => !syncedBySub.has(s.subscriptionId))) {
      notes.push(`Only ${PLAN_SYNC_CAP} plans can be refreshed at once, so some further down may be out of date.`);
    }
    if (abandoned) {
      notes.push(
        abandoned === 1
          ? '1 monthly sign-up never went through, so it isn’t shown.'
          : `${abandoned} monthly sign-ups never went through, so they aren’t shown.`,
      );
    }
    // The plan COUNT still includes them (they are real plans); only the money totals can't.
    if (mixedCurrency) notes.push('Some plans are charged in another currency, so they aren’t included in the money totals.');
    return {
      data: {
        plans,
        stats: {
          active: active.length,
          plans: plans.length,
          // Only genuinely monthly plans count toward "every month". No annualising: turning
          // a yearly plan into a twelfth (or a weekly one into 4.33) would print a figure the
          // masjid never actually receives in any month.
          monthlyTotal: round2(
            active.filter((p) => inCurrency(p) && p.interval === 'month' && p.intervalCount === 1).reduce((t, p) => t + p.amount, 0),
          ),
          collected: round2(plans.filter(inCurrency).reduce((t, p) => t + p.collected, 0)),
          currency,
        },
        stripeReachable: !anyUnreachable,
        ...(notes.length ? { message: notes.join(' ') } : {}),
      },
    };
  });

  app.get('/api/admin/plans/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const seed = findSeed(planSeeds(), id);
    if (!seed) return reply.code(404).send({ error: 'Unknown plan.' });
    const force = (req.query as { refresh?: string }).refresh === '1';
    const ownPage = ownPageFetch(req);
    const r = await syncPlan(seed, force, ownPage);
    // The sync only lists invoices when new money can have landed; the detail window always
    // wants them, so fetch them here when it didn't (but only if Stripe answered at all).
    let raw = r.invoices;
    if (raw === null && r.state) {
      const acct = r.account ?? (await accountById(seed.stripeAccountId));
      if (acct?.secretKey) raw = await fetchPlanInvoices(acct.secretKey, id, PLAN_INVOICE_LIMIT);
      // And reconcile from exactly the invoices we are about to show. Otherwise this window
      // can list a PAID invoice directly above a "collected so far" figure that leaves it
      // out — the admin reads two numbers that contradict each other.
      if (raw && ownPage) reconcileRenewals(seed, raw);
    }
    // Re-read the money AFTER any reconciliation above, for the same reason.
    const plan = buildPlan(findSeed(planSeeds(), id) ?? seed, r.state, campaignTitles());
    // Stripe lists invoices newest first, which is the order the history reads best in.
    const invoices = (raw ?? []).map((inv) => {
      const st = invoiceStatusLabel(inv.status);
      return {
        id: inv.id,
        number: inv.number,
        date: isoFromUnix(inv.momentUnix),
        amount: toMajor(inv.amountDueMinor, inv.currency),
        paid: toMajor(inv.amountPaidMinor, inv.currency),
        currency: inv.currency,
        status: st.status,
        statusLabel: st.label,
        attempts: inv.attempts,
        failureReason: inv.failureReason,
        hostedUrl: inv.hostedUrl,
      };
    });
    // No live state: say WHICH kind of "no" it is. Missing keys can't be fixed by waiting.
    const stale = r.outcome === 'no-keys' ? STRIPE_PLAN_NO_KEYS : STRIPE_PLAN_STALE;
    return {
      data: {
        plan,
        invoices,
        // "We couldn't read the history" is not "there are no payments". Without this the window
        // would print "No payments on this plan yet" directly above a header saying 4 payments.
        historyUnavailable: raw === null,
        stripeReachable: r.outcome !== 'unreachable',
        ...(r.state ? {} : { message: stale }),
      },
    };
  });

  // An action body carries nothing (pause/resume) — but validate it anyway, so a POST with
  // a junk body is refused politely rather than ignored.
  const NoBody = z.object({}).optional();

  app.post('/api/admin/plans/:id/pause', { preHandler: requireAdmin }, async (req, reply) => {
    if (!NoBody.safeParse(req.body).success) return reply.code(400).send({ error: 'Please check the details and try again.' });
    const seed = findSeed(planSeeds(), (req.params as { id: string }).id);
    if (!seed) return reply.code(404).send({ error: 'Unknown plan.' });
    const acct = await accountById(seed.stripeAccountId);
    if (!acct?.secretKey) return reply.code(502).send({ error: STRIPE_PLAN_NO_KEYS });
    if (!(await pausePlan(acct.secretKey, seed.subscriptionId))) return reply.code(502).send({ error: STRIPE_PLAN_DOWN });
    return { data: { plan: await planNow(seed) } };
  });

  app.post('/api/admin/plans/:id/resume', { preHandler: requireAdmin }, async (req, reply) => {
    if (!NoBody.safeParse(req.body).success) return reply.code(400).send({ error: 'Please check the details and try again.' });
    const seed = findSeed(planSeeds(), (req.params as { id: string }).id);
    if (!seed) return reply.code(404).send({ error: 'Unknown plan.' });
    const acct = await accountById(seed.stripeAccountId);
    if (!acct?.secretKey) return reply.code(502).send({ error: STRIPE_PLAN_NO_KEYS });
    if (!(await resumePlan(acct.secretKey, seed.subscriptionId))) return reply.code(502).send({ error: STRIPE_PLAN_DOWN });
    return { data: { plan: await planNow(seed) } };
  });

  // Stopping a plan stops it, full stop — there is no "when" to choose. `cancel_at_period_end`
  // takes no further payment (Stripe raises no more invoices) and a donation has no service
  // period left to run out, so it was financially identical to stopping now while sounding
  // like one more month of money. A masjid that wants one more payment and then a stop uses
  // "When it ends → stop after 1 further payment", which really does take one.
  app.post('/api/admin/plans/:id/cancel', { preHandler: requireAdmin }, async (req, reply) => {
    if (!NoBody.safeParse(req.body).success) return reply.code(400).send({ error: 'Please check the details and try again.' });
    const seed = findSeed(planSeeds(), (req.params as { id: string }).id);
    if (!seed) return reply.code(404).send({ error: 'Unknown plan.' });
    const acct = await accountById(seed.stripeAccountId);
    if (!acct?.secretKey) return reply.code(502).send({ error: STRIPE_PLAN_NO_KEYS });
    if (!(await cancelPlan(acct.secretKey, seed.subscriptionId))) return reply.code(502).send({ error: STRIPE_PLAN_DOWN });
    return { data: { plan: await planNow(seed) } };
  });

  // Give the plan an end: none (open-ended), a calendar date, or "after N MORE payments"
  // (N is further payments, not the total — the UI says so too).
  const PlanScheduleBody = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('open-ended') }),
    z.object({ mode: z.literal('date'), endDate: z.string().min(1).max(10) }),
    // Range-checked below rather than here, so each refusal gets its own plain sentence.
    z.object({ mode: z.literal('count'), count: z.number() }),
  ]);
  app.post('/api/admin/plans/:id/schedule', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = PlanScheduleBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the details and try again.' });
    const body = parsed.data;
    const seed = findSeed(planSeeds(), (req.params as { id: string }).id);
    if (!seed) return reply.code(404).send({ error: 'Unknown plan.' });
    const acct = await accountById(seed.stripeAccountId);
    if (!acct?.secretKey) return reply.code(502).send({ error: STRIPE_PLAN_NO_KEYS });

    // Every mode needs the plan's live state first: Stripe rejects an end date on a stopped
    // subscription, and answering that with "we couldn't reach Stripe" would be a lie.
    // FORCED, never the 60-second-cached copy: "stop after N more payments" counts forward
    // from `current_period_end`, and if a renewal landed inside that window the cached value
    // is the charge that ALREADY happened — we would set the end one whole interval early and
    // take one fewer donation than the admin agreed to. Forcing also freshens the
    // stopped/paused guards below, which is a bonus. `reconcile: false` because this read only
    // needs the subscription: skipping the invoice list keeps the click to one Stripe round
    // trip, and `planNow` below does the catch-up anyway.
    const r = await syncPlan(seed, true, false);
    const state = r.state;
    if (!state) return reply.code(502).send({ error: r.outcome === 'no-keys' ? STRIPE_PLAN_NO_KEYS : STRIPE_PLAN_DOWN });
    const st = friendlyStatus(state.status, state.paused);
    if (st.status === 'canceled') return reply.code(400).send({ error: 'This plan has already stopped, so there’s nothing left to schedule.' });

    let cancelAt: number | null = null;
    if (body.mode === 'date') {
      cancelAt = endOfDayUnix(body.endDate);
      if (cancelAt === null) return reply.code(400).send({ error: 'Please choose a valid date.' });
      // End of the chosen day, UTC — so "stop on the 30th" includes the 30th.
      if (cancelAt * 1000 <= Date.now()) return reply.code(400).send({ error: 'Please choose a date in the future.' });
    } else if (body.mode === 'count') {
      if (!Number.isInteger(body.count) || body.count < 1) return reply.code(400).send({ error: 'Please choose at least one more payment.' });
      if (body.count > MAX_FURTHER_PAYMENTS) {
        return reply.code(400).send({ error: `Please choose ${MAX_FURTHER_PAYMENTS} or fewer further payments.` });
      }
      // Counting forward needs a real next-payment date to count from.
      if (st.status === 'incomplete') {
        return reply.code(400).send({ error: 'This plan hasn’t taken its first payment yet — please try again once it’s active.' });
      }
      if (st.status === 'paused') {
        return reply.code(400).send({ error: 'This plan is paused. Resume it first, then choose when it should stop.' });
      }
      const next = nextPaymentUnix(state);
      if (!next) return reply.code(400).send({ error: 'We don’t know when the next payment is due, so we can’t count from it yet.' });
      cancelAt = cancelAtAfterCharges(next, state.interval, state.intervalCount, body.count);
      if (cancelAt === null) return reply.code(400).send({ error: 'We couldn’t work out this plan’s schedule — please set an end date instead.' });
    }

    if (!(await setPlanEnd(acct.secretKey, seed.subscriptionId, cancelAt))) return reply.code(502).send({ error: STRIPE_PLAN_DOWN });
    return { data: { plan: await planNow(seed) } };
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

  /** Resolve a campaign's thank-you: each empty override field inherits the global default. */
  const resolveThankYou = (c: Campaign): ThankYou => {
    const g = store.getThankYou();
    const o = c.thankYou;
    return {
      heading: o.heading || g.heading,
      message: o.message || g.message,
      backgroundImage: o.backgroundImage || g.backgroundImage,
      accent: o.accent || g.accent,
    };
  };

  const publicCampaign = async (c: Campaign) => {
    const acct = await effectiveAccountFor(c);
    const ld = store.getLargeDonation();
    // A tuition campaign is a Students-billing shell: ask Students (over the Fabric broker)
    // whether it's set up. Unavailable / disabled → the donor page shows a friendly notice
    // instead of the Student ID form (fail-soft, contract §11.1). Amounts are in the SCHOOL's
    // currency (from Students), not the masjid's donation currency.
    let students: { available: boolean; schoolName: string; tagline: string; allowAdvance: boolean; minAmount: number } | undefined;
    let currency = cur();
    if (c.type === 'tuition') {
      const info = await studentsInfo();
      const available = info.available && info.info.enabled;
      if (available && info.available && info.info.currency) currency = info.info.currency;
      students = {
        available,
        schoolName: available ? info.info.schoolName : '',
        tagline: available ? info.info.tagline : '',
        // §11.0a: does this school take money with nothing due, and what's the smallest card
        // payment it allows? The donor page needs both to render the amount field honestly.
        allowAdvance: available ? info.info.allowAdvance : false,
        minAmount: toMajor(available ? info.info.minAmountCents : MIN_TUITION_CENTS, currency),
      };
    }
    return {
      slug: c.slug,
      title: c.title,
      type: c.type,
      description: c.description,
      coverImage: c.coverImage,
      backgroundImage: c.backgroundImage,
      logo: c.logo, // the campaign's own logo (empty = use masjidLogo)
      presetAmounts: c.presetAmounts.map(toMajorCur),
      allowCustom: c.allowCustom,
      minAmount: toMajorCur(c.minAmount),
      maxAmount: toMajorCur(c.maxAmount),
      coverFees: c.coverFees,
      feesForced: c.forceCoverFees, // fee is mandatory (Zakat) — no donor opt-out; never for tuition
      giftAid: c.giftAid,
      allowMonthly: c.allowMonthly,
      goalAmount: toMajorCur(c.goalAmount),
      raised: toMajorCur(store.raisedForCampaign(c.id)),
      currency,
      masjidName: store.getMasjid().name,
      masjidLogo: store.getMasjid().logo,
      thankYou: resolveThankYou(c), // resolved (campaign override over global default)
      // Global large-donation alternative (major units for the donor page). Advisory only —
      // the donor may still pay by card; the server never blocks above the threshold.
      largeDonation: { threshold: toMajorCur(ld.threshold), message: ld.message, qrImage: ld.qrImage },
      // Tuition (Students) status; undefined for donation/zakat. When present + !available the
      // donor page shows "tuition payments aren't available right now" and no Student ID form.
      students,
      publishableKey: acct?.publishableKey ?? '', // safe; never the secret
      ready: !!acct && stripeConfigured(acct),
    };
  };

  const sendPublicCampaign = async (slug: string, token: string | undefined, reply: import('fastify').FastifyReply) => {
    const c = resolvePublicCampaign(slug, token);
    if (!c || !c.active) return reply.code(404).send({ error: 'This donation page isn’t available.' });
    return { data: await publicCampaign(c) };
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
    // A tuition campaign is NOT a donation — it must never go through the donation flow
    // (that would file a client-chosen amount into the donations ledger, count it in totals/
    // CSV/Gift Aid, and orphan it from the Students ledger). Tuition has its own routes.
    if (!c || !c.active || c.type === 'tuition') return reply.code(404).send({ error: 'This donation page isn’t available.' });
    const acct = await effectiveAccountFor(c);
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
    // Reject non-finite/non-integer/out-of-range amounts (zod already requires > 0).
    if (!Number.isInteger(baseMinor) || baseMinor < 1) return reply.code(400).send({ error: 'Please choose a valid amount.' });
    // Stripe rejects very small charges; enforce a floor (~0.50 in 2-decimal currencies).
    const floor = currencyDecimals(currency) === 0 ? 50 : 50;
    if (baseMinor < floor) return reply.code(400).send({ error: 'That amount is too small.' });
    // …and a sane ceiling (Stripe's per-charge max is 99,999,999 minor units).
    if (baseMinor > 99_999_999) return reply.code(400).send({ error: 'That amount is too large.' });

    // Server-authoritative fee decision: a forced-fee campaign (Zakat, or a Tuition the
    // admin set to require it) always grosses up; otherwise only when the donor opts in AND
    // the campaign offers it. Never trust the client's flag for a forced campaign.
    const coverFees = c.forceCoverFees || (!!p.coverFees && c.coverFees);
    const chargeMinor = coverFees ? withCoveredFees(baseMinor, currency) : baseMinor;
    const giftAid = !!p.giftAid && c.giftAid;
    const monthly = !!p.monthly && c.allowMonthly;
    const donorName = (p.donorName ?? '').slice(0, 120);
    const donorEmail = (p.donorEmail ?? '').slice(0, 200);
    // Monthly donations need a name + email (Stripe attaches the subscription to a customer).
    if (monthly && (!donorName.trim() || !donorEmail.trim())) {
      return reply.code(400).send({ error: 'Please add your name and email — both are required for a monthly donation.' });
    }
    const metadata = {
      app: 'donations', campaignId: c.id, campaign: c.title.slice(0, 120),
      coverFees: String(coverFees), giftAid: String(giftAid), recurring: String(monthly),
    };
    const idempotencyKey = crypto.randomUUID();
    // Receipt strategy — DECIDED ONCE here and RECORDED on the donation (`receipt` below), so
    // the confirm/outbox send stays consistent with whether we suppressed Stripe's own receipt:
    //   • branded → suppress Stripe's built-in receipt + we send our branded one (receipt:'pending').
    //   • else    → let Stripe send its receipt; we send nothing (receipt:'stripe') → no double.
    // We only go branded when the OS email is CONFIRMED working (emailStatus 'ok'), so a donor is
    // never left with zero receipts because email wasn't set up; a transient failure after that is
    // covered by the retry outbox. (Not re-evaluated at confirm — that was the double/zero bug.)
    const branded = store.getEmailReceipt().enabled && ssoConfigured() && emailStatus() === 'ok';
    const stripeReceiptEmail = branded ? undefined : donorEmail.trim() || undefined;
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
        // receipt_email lets Stripe email its built-in receipt on success (see stripeReceiptEmail above).
        const intent = await createPaymentIntent(acct, chargeMinor, currency, metadata, idempotencyKey, stripeReceiptEmail);
        clientSecret = intent.clientSecret;
        paymentIntentId = intent.id;
      }
    } catch (e) {
      log.warn('payment setup failed: ' + (e instanceof Error ? e.message : String(e)));
      // Tell the admin donations are broken (bad/expired keys, Stripe down). Fail soft.
      void fabricAlert('payment-failed', 'A donation payment failed to start', 'Stripe rejected a payment setup — donors can’t give until it’s fixed. Check your Stripe keys/status in OpenMasjidOS → Settings → Payments.', 'error').catch(() => {});
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
      receipt: branded ? 'pending' : 'stripe',
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
    // Tuition confirms go through /students/confirm; never confirm a tuition campaign here
    // (defence in depth — the tuition intent route above is already blocked).
    if (!c || c.type === 'tuition') return reply.code(404).send({ error: 'Unknown campaign.' });
    const don = store.getDonationByPaymentIntent(paymentIntentId);
    // Confirm against the SAME account the PaymentIntent was created on (recorded on the
    // donation) — never re-resolve Fabric-first here, or a payment made on one account
    // could be retrieved against another's keys after a config/reachability change,
    // leaving a genuinely-succeeded donation stuck "pending".
    const acct = don ? await accountById(don.stripeAccountId) : null;
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
      // Branded receipt — ONLY when we recorded 'pending' at intent (i.e. Stripe's receipt was
      // suppressed in favour of ours), so there's never a double. Non-blocking; a transient
      // failure stays 'pending' for the outbox to retry, a permanent one is marked 'skipped'.
      if (don.receipt === 'pending') {
        // `updated` carries the donor name/email + card brand/last4 filled in by markDonation.
        void sendDonationReceipt(updated ?? don)
          .then((r) => {
            if (r.sent) store.setDonationReceipt(paymentIntentId, 'sent');
            else if (!r.retry) store.setDonationReceipt(paymentIntentId, 'skipped');
          })
          .catch(() => {});
      }
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

  // ── Tuition (Students billing) — a `tuition` campaign is a shell around OpenMasjid ──
  // Students. Parent enters the child's Student ID → we confirm whose it is (`identify`) →
  // they confirm the name → we look up the family's balances over the OS Fabric broker →
  // they pay all/some → we record it into the Students ledger. Students owns everything
  // inside; we render the shell + charge the card. Contract: students/billing v2
  // (docs/STUDENTS_INTEGRATION.md). Everything fails soft when Students is unavailable.

  // A stricter per-peer limiter for the tuition lookup so we can't be the open relay that lets
  // an attacker grind Student IDs (Students also hard-locks a code after 6 failed probes per
  // hour — defence in depth). `identify` and `lookup` deliberately SHARE this bucket, exactly
  // as the provider shares one bucket per code, so switching endpoints can't launder attempts.
  // The cap is 40/min rather than 20 only because one honest flow is now two calls (identify →
  // lookup): the effective attempt rate is unchanged. Keyed on the real TCP peer (never a
  // spoofable X-Forwarded-For), like the login limiter.
  const lookupHits = new Map<string, { c: number; reset: number }>();
  const lookupRateOk = (ip: string): boolean => {
    const now = Date.now();
    if (lookupHits.size > 5000) for (const [k, w] of lookupHits) if (w.reset <= now) lookupHits.delete(k);
    const w = lookupHits.get(ip);
    if (!w || w.reset <= now) {
      lookupHits.set(ip, { c: 1, reset: now + 60_000 });
      return true;
    }
    if (w.c >= 40) return false;
    w.c += 1;
    return true;
  };

  /** Push a succeeded tuition payment into the Students ledger (idempotent on the PI id).
   *  Re-verifies the PI succeeded with Stripe before recording (never book a charge that
   *  didn't happen). Leaves record_status 'pending' on a transient outage (the outbox
   *  retries) and 'skipped' on a permanent app error (Students' daily reconciliation is the
   *  final backstop, so money is never lost). The Students app fires its own notification. */
  const tryRecordStudentPayment = async (pi: string): Promise<void> => {
    const sp = store.getStudentPaymentByPI(pi);
    if (!sp || sp.recordStatus !== 'pending') return;
    const acct = await accountById(sp.stripeAccountId);
    if (!acct) return; // account gone/unresolvable right now — try again next tick
    const retrieved = await retrievePaymentIntent(acct, pi);
    if (!retrieved || retrieved.status !== 'succeeded') return; // never record a non-succeeded charge
    if (sp.payStatus !== 'succeeded') store.markStudentPaymentPaid(pi, 'succeeded', sp.occurredAt || new Date().toISOString());
    let allocations: { invoiceId: string; amountCents: number }[] | undefined;
    try {
      const a = JSON.parse(sp.allocations || 'null');
      if (Array.isArray(a) && a.length) allocations = a;
    } catch { /* full-balance (no allocations) */ }
    // The per-child split (v2). Absent for a full-balance charge and for rows written before
    // the column existed — in both cases Students derives the split, which is what those rows
    // always relied on.
    let studentsSplit: { studentId: string; amountCents: number }[] | undefined;
    try {
      const s = JSON.parse(sp.studentsSplit || 'null');
      if (Array.isArray(s) && s.length) studentsSplit = s;
    } catch { /* no split — Students derives it */ }
    // The ticked bill lines (§11.0b). Present only for an itemised selection; when it is, it's
    // the ONLY breakdown that goes on the wire (recordStudentPayment enforces that).
    let lines: { itemId: string; amountCents: number }[] | undefined;
    try {
      const l = JSON.parse(sp.paymentLines || 'null');
      if (Array.isArray(l) && l.length) lines = l;
    } catch { /* not an itemised payment */ }
    const res = await recordStudentPayment({
      idempotencyKey: pi, // = the PaymentIntent id → Students dedups replays
      familyId: sp.familyId,
      studentId: sp.studentId || undefined,
      amountCents: sp.amount,
      currency: sp.currency,
      occurredAt: sp.occurredAt || new Date().toISOString(),
      externalRef: { stripePaymentIntentId: pi, stripeChargeId: retrieved.chargeId || undefined },
      allocations,
      students: studentsSplit,
      lines,
    });
    if (res.status === 'recorded') store.setStudentRecordStatus(pi, 'recorded', res.paymentId);
    else if (res.status === 'rejected') {
      store.setStudentRecordStatus(pi, 'skipped'); // permanent — Students' reconciliation is the backstop
      // The charge succeeded but the ledger rejected it (e.g. the invoice changed). Money is
      // safe (reconciliation picks it up) but the admin should verify. Alert carries no PII.
      void fabricAlert('tuition-record-failed', 'A tuition payment wasn’t recorded in Students', `A card payment succeeded (${pi}) but OpenMasjid Students rejected recording it (${res.code}). The money is safe — Students’ daily reconciliation will pick it up — but please check.`, 'warning').catch(() => {});
    }
    // 'unavailable' → leave pending; the outbox retries.
  };

  // A child's display name — a first name plus a last initial is all the contract ever returns
  // (and a child recorded under one name has no initial). Rendered as plain text, never HTML.
  const childName = (st: { firstName: string; lastInitial: string }): string =>
    st.lastInitial ? `${st.firstName} ${st.lastInitial}.` : st.firstName;

  // Step 1 of the v2 flow: turn a typed Student ID into "is this <child>?" so the parent
  // confirms the right child BEFORE any balance appears. This confirmation is what replaced
  // the PIN (contract §11.0) — it catches the realistic failure, a mistyped ID. The answer is
  // deliberately thin (a first name + initial, nothing else) and uniform on not-found, so it
  // is neither an enumeration oracle nor a disclosure. The code is body-only, never logged.
  const IdentifyBody = z.object({ studentCode: z.string().min(1).max(64) });
  app.post('/api/public/campaign/:slug/students/identify', async (req, reply) => {
    if (!lookupRateOk(req.socket.remoteAddress ?? 'unknown')) {
      return reply.code(429).send({ error: 'Too many attempts. Please wait a moment and try again.' });
    }
    const c = store.getCampaignBySlug((req.params as { slug: string }).slug);
    if (!c || !c.active || c.type !== 'tuition') return reply.code(404).send({ error: 'This page isn’t available.' });
    const parsed = IdentifyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please enter the Student ID.' });
    const r = await studentsIdentify(parsed.data.studentCode);
    if (r.status === 'unavailable') {
      return reply.code(503).send({ error: 'Tuition payments are temporarily unavailable. Please try again shortly.' });
    }
    if (r.status === 'not-found') return { data: { found: false } };
    return { data: { found: true, student: r.student } };
  });

  // Step 2: the parent confirmed the name, so fetch the family's balances. v2 takes the
  // Student ID ALONE — no name, no PIN (they'd 400). The code is read from the body only and
  // NEVER logged/echoed. Not-found is uniform (unknown / withdrawn / locked / payments-off all
  // look the same). On success we stash the family SERVER-SIDE (a session) so the pay step
  // can't be told a different family or a tampered amount — the browser only gets display
  // data + an opaque session id, never the internal family/student ids.
  const LookupBody = z.object({ studentCode: z.string().min(1).max(64) });
  app.post('/api/public/campaign/:slug/students/lookup', async (req, reply) => {
    if (!lookupRateOk(req.socket.remoteAddress ?? 'unknown')) {
      return reply.code(429).send({ error: 'Too many attempts. Please wait a moment and try again.' });
    }
    const c = store.getCampaignBySlug((req.params as { slug: string }).slug);
    if (!c || !c.active || c.type !== 'tuition') return reply.code(404).send({ error: 'This page isn’t available.' });
    const parsed = LookupBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please enter the Student ID.' });
    const r = await studentsLookup(parsed.data.studentCode);
    if (r.status === 'unavailable') {
      return reply.code(503).send({ error: 'Tuition payments are temporarily unavailable. Please try again shortly.' });
    }
    if (r.status === 'not-found') return { data: { found: false } };
    const fam = r.family;
    const ccy = fam.currency || cur();
    const dec = (minor: number) => toMajor(minor, ccy);
    // Advance-payment terms come from `info` (cached), captured into the session so the pay
    // step reads the SERVER's copy of both (§11.0a).
    const inf = await studentsInfo();
    const allowAdvance = inf.available && inf.info.allowAdvance;
    const minAmountCents = inf.available ? inf.info.minAmountCents : MIN_TUITION_CENTS;
    // Itemised (§11.0b) only when EVERY open bill came with usable lines — the provider honours
    // `lines` OR `allocations`, never both, so a selection mixing lines from one bill with a whole
    // other bill can't be expressed in one call. All-or-nothing avoids ever needing to.
    const itemised = fam.openInvoices.length > 0 && fam.openInvoices.every((i) => i.items.length > 0);
    const session = createTuitionSession({
      campaignId: c.id,
      familyId: fam.id,
      studentId: r.matchedStudentId,
      familyLabel: fam.label,
      currency: ccy,
      balanceCents: fam.balanceCents,
      // Keep each invoice's child: it's what lets the pay step tell Students WHOSE bill the
      // parent's picked months are, without ever handing a studentId to the browser. The lines
      // (§11.0b) are held with their amounts so a ticked line's value comes from here.
      invoices: fam.openInvoices.map((i) => ({
        id: i.id,
        studentId: i.studentId,
        balanceCents: i.balanceCents,
        items: i.items.map((it) => ({ id: it.id, balanceCents: it.balanceCents })),
      })),
      // Each child gets an opaque ref the browser uses to say which one an advance is for. The
      // internal studentId stays here, so a crafted request can only name a child of THIS family.
      students: fam.students.map((st, i) => ({ ref: `c${i}`, studentId: st.studentId, balanceCents: st.balanceCents })),
      itemised,
      allowAdvance,
      minAmountCents,
    });
    // v2 bills are per child, so each open invoice names the child it belongs to. Resolve that
    // to a display name + the child's opaque ref HERE — the studentIds stay server-side, in the
    // session. The ref is what lets the donor page group bills under the child they belong to.
    const nameById = new Map(fam.students.filter((st) => st.studentId).map((st) => [st.studentId, childName(st)]));
    const refById = new Map(fam.students.map((st, i) => [st.studentId, `c${i}`]));
    // Return DISPLAY data only — never the internal family/student ids (they live in the session).
    return {
      data: {
        found: true,
        session: session.id,
        currency: ccy,
        family: {
          label: fam.label,
          // Per-child balances are new at v2 (one bill per child); the household total below
          // is still what "pay the full balance" charges. `credit` is what a child has paid
          // ahead (§11.0a) — without it a derived balance of 0 can't be told apart from
          // "square", and once an advance settles its invoice it's the only signal left.
          students: fam.students.map((st, i) => ({
            ref: `c${i}`, // opaque handle for "add money for this child"
            name: childName(st),
            firstName: st.firstName,
            lastInitial: st.lastInitial,
            balance: dec(st.balanceCents),
            credit: dec(st.creditCents),
          })),
          balance: dec(fam.balanceCents),
          credit: dec(fam.creditCents),
          // Whether every bill is itemised, so the donor page and this server agree on which
          // selection the pay step will accept.
          itemised,
          openInvoices: fam.openInvoices.map((i) => ({
            id: i.id,
            label: i.label,
            student: nameById.get(i.studentId) ?? '',
            studentRef: refById.get(i.studentId) ?? '', // groups this bill under its child
            dueDate: i.dueDate,
            amount: dec(i.balanceCents),
            // The lines that make up this bill (§11.0b) — display data plus the item id the pay
            // step needs. `payable` is the only thing that decides whether it can be ticked: a
            // settled line and a credit line (bursary/correction, already deducted above) both
            // report a zero balance and are shown for information, never charged.
            items: i.items.map((it) => ({
              id: it.id,
              label: it.label,
              kind: it.kind,
              amount: dec(it.balanceCents),
              billed: dec(it.amountCents),
              payable: it.balanceCents > 0,
            })),
          })),
        },
      },
    };
  });

  // Start a tuition payment. The client sends the session id + WHAT to pay: "full", a picked
  // set of months, or an advance amount (§11.0a — the one case a parent names the figure, since
  // there's no invoice to derive it from). The family, the child, the currency, the floor and
  // whether advance is allowed at all still come only from the server-side session, and an
  // advance can only ever credit the family this session looked up.
  const StudentsIntentBody = z.object({
    session: z.string().min(1).max(64),
    selection: z.union([
      z.object({ kind: z.literal('full') }),
      z.object({ kind: z.literal('invoices'), invoiceIds: z.array(z.string().min(1).max(128)).min(1).max(60) }),
      z.object({ kind: z.literal('items'), itemIds: z.array(z.string().min(1).max(128)).min(1).max(200) }),
      // major units, and optionally WHICH child it's for (an opaque ref from the lookup)
      z.object({ kind: z.literal('amount'), amount: z.number().positive(), student: z.string().max(16).optional() }),
    ]),
  });
  app.post('/api/public/campaign/:slug/students/intent', async (req, reply) => {
    if (!donateRateOk(req.socket.remoteAddress ?? 'unknown')) {
      return reply.code(429).send({ error: 'Too many attempts. Please wait a moment.' });
    }
    const c = store.getCampaignBySlug((req.params as { slug: string }).slug);
    if (!c || !c.active || c.type !== 'tuition') return reply.code(404).send({ error: 'This page isn’t available.' });
    const acct = await effectiveAccountFor(c);
    if (!acct || !stripeConfigured(acct)) return reply.code(400).send({ error: 'Tuition payments aren’t set up for this page yet.' });
    const parsed = StudentsIntentBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please choose what to pay.' });
    const session = getTuitionSession(parsed.data.session);
    if (!session || session.campaignId !== c.id) {
      return reply.code(400).send({ error: 'Your session expired — please look up your balance again.' });
    }
    const currency = session.currency;
    // A typed amount arrives in major units like the donation flow; convert with the same
    // helper so the currency's minor-unit rules (and zero-decimal currencies) are applied once.
    const sel: TuitionSelection =
      parsed.data.selection.kind === 'amount'
        ? { kind: 'amount', amountCents: toMinor(parsed.data.selection.amount, currency), studentRef: parsed.data.selection.student }
        : parsed.data.selection;
    const amt = computeTuitionAmount(session, sel);
    if ('error' in amt) {
      const minLabel = formatMoney(session.minAmountCents, currency);
      const msg =
        amt.error === 'nothing-due'
          ? 'There’s nothing left to pay on that selection.'
          : amt.error === 'below-min'
            ? `The smallest payment we can take is ${minLabel}.`
            : amt.error === 'too-large'
              ? 'That amount is too large.'
              : amt.error === 'advance-not-allowed'
                ? 'This school isn’t taking payments in advance right now — you can pay up to the balance due.'
                : amt.error === 'bad-amount'
                  ? 'Please enter a valid amount.'
                  : amt.error === 'unknown-item' || amt.error === 'not-itemised' || amt.error === 'unknown-student'
                    ? 'Your balance changed — please look it up again.'
                    : 'Please choose what to pay.';
      return reply.code(400).send({ error: msg });
    }
    const chargeMinor = amt.amountCents;
    // §11.3 metadata — the reconciliation discriminator + the family id (REQUIRED). NEVER the
    // Student ID or a child's name (§11.3 bans both from metadata/descriptions/URLs outright,
    // since metadata shows up in Stripe dashboards and exports). Description = family label.
    const metadata: Record<string, string> = {
      purpose: 'students-billing',
      omos_app: 'donations',
      students_family_id: session.familyId,
      campaignId: c.id,
    };
    // Whose payment this is: the child the parent named for a per-child advance, else the child
    // whose ID was typed. Drives §11.3 metadata AND where Students parks any surplus.
    const forStudentId = amt.targetStudentId || session.studentId;
    if (forStudentId) metadata.students_student_id = forStudentId;
    const idempotencyKey = crypto.randomUUID();
    let clientSecret = '';
    let paymentIntentId = '';
    try {
      const intent = await createPaymentIntent(
        acct,
        chargeMinor,
        currency,
        metadata,
        idempotencyKey,
        undefined, // no receipt email — the tuition flow collects only a Student ID
        `School balance — ${session.familyLabel || 'family'}`,
      );
      clientSecret = intent.clientSecret;
      paymentIntentId = intent.id;
    } catch (e) {
      log.warn('tuition payment setup failed: ' + (e instanceof Error ? e.message : String(e)));
      void fabricAlert('payment-failed', 'A tuition payment failed to start', 'Stripe rejected a payment setup — parents can’t pay tuition until it’s fixed. Check your Stripe keys/status in OpenMasjidOS → Settings → Payments.', 'error').catch(() => {});
      return reply.code(502).send({ error: 'We couldn’t start the payment. Please try again.' });
    }
    store.createStudentPayment({
      campaignId: c.id,
      stripeAccountId: acct.id,
      paymentIntentId,
      familyId: session.familyId,
      studentId: forStudentId,
      familyLabel: session.familyLabel,
      amount: chargeMinor,
      currency,
      allocations: amt.allocations ? JSON.stringify(amt.allocations) : '',
      // Every breakdown is recomputed server-side from the session, then stored so the outbox
      // retry books the payment exactly as this first attempt would have.
      studentsSplit: amt.students ? JSON.stringify(amt.students) : '',
      paymentLines: amt.lines ? JSON.stringify(amt.lines) : '',
    });
    return { data: { clientSecret, publishableKey: acct.publishableKey, amount: toMajor(chargeMinor, currency), currency } };
  });

  // Confirm a tuition payment on return: RETRIEVE the intent from Stripe (never trust the
  // client), record the local outcome, then push it to the Students ledger (best-effort; the
  // outbox + Students' reconciliation are the backstops). The receipt says "payment".
  const StudentsConfirmBody = z.object({ paymentIntentId: z.string().min(1).max(255) });
  app.post('/api/public/campaign/:slug/students/confirm', async (req, reply) => {
    const parsed = StudentsConfirmBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Missing payment reference.' });
    const c = store.getCampaignBySlug((req.params as { slug: string }).slug);
    if (!c || c.type !== 'tuition') return reply.code(404).send({ error: 'Unknown page.' });
    const sp = store.getStudentPaymentByPI(parsed.data.paymentIntentId);
    if (!sp || sp.campaignId !== c.id) return reply.code(404).send({ error: 'Unknown payment.' });
    const acct = await accountById(sp.stripeAccountId);
    if (!acct) return reply.code(404).send({ error: 'Unknown payment.' });
    const pi = await retrievePaymentIntent(acct, sp.paymentIntentId);
    if (!pi) return reply.code(502).send({ error: 'Couldn’t confirm with Stripe. Please try again.' });
    const succeeded = pi.status === 'succeeded';
    const payStatus: 'succeeded' | 'failed' | 'pending' = succeeded ? 'succeeded' : pi.status === 'processing' ? 'pending' : 'failed';
    store.markStudentPaymentPaid(sp.paymentIntentId, payStatus, succeeded ? new Date().toISOString() : undefined);
    if (succeeded) await tryRecordStudentPayment(sp.paymentIntentId); // best-effort; outbox retries on failure
    const info = await studentsInfo();
    return {
      data: {
        status: pi.status,
        succeeded,
        amount: toMajor(pi.amount, pi.currency),
        currency: pi.currency,
        schoolName: info.available ? info.info.schoolName : '',
        familyLabel: sp.familyLabel,
      },
    };
  });

  // ── Stripe webhook (optional, per-account secret) ───────────────────────────
  // Only needed when the app is publicly reachable. It records ongoing monthly
  // charges (invoice.paid on renewal) and resiliently confirms one-time payments.
  // The signature is verified with the account's own webhook secret.
  app.post('/api/stripe/webhook/:accountId', async (req, reply) => {
    const acct = await accountById((req.params as { accountId: string }).accountId);
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
        // A tuition (Students-billing) payment: mark it paid + push to the Students ledger.
        const sp = store.getStudentPaymentByPI(pi.id);
        if (sp) {
          if (sp.payStatus !== 'succeeded') store.markStudentPaymentPaid(pi.id, 'succeeded', new Date().toISOString());
          // Fire-and-forget push to the Students ledger. It's async, so a throw inside becomes
          // a rejected promise the surrounding try/catch can't see — .catch() it so a DB fault
          // never becomes an unhandled rejection that crashes the whole process (fail soft).
          if (sp.recordStatus === 'pending') void tryRecordStudentPayment(pi.id).catch(() => {});
        }
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
  const indexPath = path.join(config.publicDir, 'index.html');
  const havePublic = fs.existsSync(indexPath);
  if (havePublic) {
    // index:false — we serve index.html ourselves (below) so we can inject the base path.
    await app.register(fastifyStatic, { root: config.publicDir, index: false });
  } else {
    log.warn(`no built web app at ${config.publicDir} — run "cd web && npm run build" (dev uses the Vite server)`);
  }

  // The built index.html, read once; the placeholder is replaced per-request with the
  // current base path so a single image works at the root (LAN) and under any tunnel path.
  const rawIndex = havePublic ? fs.readFileSync(indexPath, 'utf8') : '';
  /** Serve index.html with the base path injected: a `<base href>` (so the relative-built
   *  Vite assets resolve under the tunnel prefix) plus `window.__OMOS_BASE__` (read by the
   *  web for API/nav/asset URLs). basePath is sanitised to a safe URL-path charset. When
   *  `widgetSlug` is given, also inject `window.__OMOS_WIDGET__` so the SPA renders that
   *  campaign in the compact, chrome-less widget layout for embedding. */
  const sendIndexHtml = (reply: import('fastify').FastifyReply, widgetSlug?: string) => {
    const base = cachedFabricSite().basePath.replace(/[^\w/-]/g, ''); // defensive: path charset only
    let head = `<base href="${base}/">\n    <script>window.__OMOS_BASE__=${JSON.stringify(base)}</script>`;
    if (widgetSlug) head += `\n    <script>window.__OMOS_WIDGET__=${JSON.stringify({ slug: widgetSlug })}</script>`;
    reply.type('text/html').send(rawIndex.replace('<head>', `<head>\n    ${head}`));
  };
  if (havePublic) app.get('/', async (_req, reply) => sendIndexHtml(reply));

  // ── Public embeddable widget: /w/<slug> (base-path aware behind the tunnel) ──
  // A masjid pastes an <iframe src=".../w/<slug>"> into their own site. We serve the SPA
  // in widget mode and allow framing anywhere (frame-ancestors *). 404 — not 403 — when the
  // campaign is missing, inactive, or its widget is off, so a slug isn't probeable.
  if (havePublic) app.get('/w/:slug', async (req, reply) => {
    const slug = String((req.params as { slug: string }).slug || '');
    const c = store.getCampaignBySlug(slug);
    if (!c || !c.active || !c.widgetEnabled) return reply.code(404).type('text/plain').send('Not found.');
    reply.header('content-security-policy', 'frame-ancestors *'); // meant to be embedded
    reply.header('cache-control', 'no-store');
    return sendIndexHtml(reply, c.slug);
  });

  // SPA fallback: client-side routes (e.g. /admin, /zakat) resolve to index.html; requests
  // that look like a file (have an extension, e.g. a stale /assets/x.js) still 404 rather
  // than silently returning the app shell; unknown API routes return JSON.
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '/';
    const pathname = url.split('?')[0];
    const looksLikeFile = path.extname(pathname) !== '';
    if (req.method === 'GET' && havePublic && !looksLikeFile && !url.startsWith('/api') && !url.startsWith('/healthz')) {
      return sendIndexHtml(reply);
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

  // Learn our base path BEFORE serving so the URL-rewrite hook strips the tunnel prefix
  // from the very first request (not only once something warms the cache). This is
  // awaited but fail-soft: fetchFabricSite has its own ~4s timeout and never throws, so a
  // slow/unreachable platform delays startup by at most that, then we serve at the root.
  if (ssoConfigured()) {
    await fetchFabricSite().catch(() => {});
    void fetchFabricStripe(store.getFabricStripeChoice()); // not routing-critical → don't block
  }

  await app.listen({ port: config.port, host: config.host });
  log.info(`OpenMasjid Donations listening on http://${config.host}:${config.port}`);
  log.info(ssoConfigured() ? 'running embedded under OpenMasjidOS (Fabric available)' : 'running standalone (local password)');

  // The app's own Cloudflare Tunnel is the STANDALONE fallback only. When embedded, remote
  // access is the platform's job (the OS runs Cloudflare and we read our public URL from
  // /api/fabric/site), so we do NOT start a second, redundant tunnel — even if one was
  // configured in-app before this box was adopted by OpenMasjidOS.
  const tcfg = store.getTunnel();
  if (ssoConfigured()) {
    tunnel.stop();
    if (tcfg.enabled) log.info("remote access is managed by OpenMasjidOS (Fabric) — not starting the app's own Cloudflare tunnel");
  } else {
    tunnel.apply(tcfg.token, tcfg.enabled);
  }

  const shutdown = (code = 0) => {
    log.info('shutting down');
    tunnel.stop();
    try { store.close(); } catch { /* already closed */ }
    app.close().finally(() => setTimeout(() => process.exit(code), 200));
    // Hard backstop in case app.close() hangs, so the container actually cycles.
    setTimeout(() => process.exit(code), 2000).unref?.();
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  // Watch the OpenMasjidOS Fabric config (embedded only). When the admin changes the Stripe
  // account or remote-access settings IN OPENMASJIDOS, the fingerprint changes and we restart
  // so the new config is applied cleanly — `restart: unless-stopped` brings us right back.
  // (In-app changes apply instantly via a cache clear and reset the baseline, so they don't
  // trigger this.) We ignore changes seen while the platform is unreachable, so a transient
  // outage never causes a restart loop; the first tick just records the baseline.
  if (ssoConfigured()) {
    const watch = async () => {
      try {
        const { sig, reachable } = await fabricConfigSignature(store.getFabricStripeChoice());
        if (!reachable) return; // can't trust a signature taken during an outage
        if (fabricBaseline === null) { fabricBaseline = sig; return; }
        if (sig !== fabricBaseline) {
          fabricBaseline = sig; // avoid re-triggering if the exit is delayed
          log.info('OpenMasjidOS Stripe/remote-access settings changed — restarting to apply them.');
          shutdown(0);
        }
      } catch { /* fail soft — never let the watcher crash the app */ }
    };
    const iv = setInterval(() => void watch(), 20_000);
    iv.unref?.();
  }

  // Tuition (Students-billing) outbox: retry any succeeded tuition payment whose push to the
  // Students ledger hasn't landed yet (e.g. a network blip right after the card cleared). We
  // `check` first so we never double-record, then re-`record-payment`. Students' daily
  // reconciliation is the FINAL backstop (it scans succeeded students-billing PIs), so this is
  // an optimization — money is never lost even if this never runs. Embedded only.
  if (billingConfigured()) {
    const outbox = async () => {
      try {
        for (const sp of store.listPendingStudentRecords()) {
          const chk = await checkStudentPayment(sp.paymentIntentId);
          if (chk.status === 'recorded') {
            store.setStudentRecordStatus(sp.paymentIntentId, 'recorded', chk.paymentId);
            continue;
          }
          if (chk.status === 'unavailable') break; // platform down — stop this pass, try next tick
          await tryRecordStudentPayment(sp.paymentIntentId); // not-recorded → push it
        }
      } catch { /* fail soft — never let the outbox crash the app */ }
    };
    const iv = setInterval(() => void outbox(), 60_000);
    iv.unref?.();
  }

  // Branded-receipt retry outbox: any succeeded donation still owing a receipt (a transient
  // email failure at confirm) is retried until it lands. Bounded to recent donations so we don't
  // chase ancient ones; stops the pass on a system failure (email down) and resumes next tick.
  if (ssoConfigured()) {
    const RECEIPT_MAX_AGE_MS = 3 * 24 * 3600_000; // 3 days
    const receiptOutbox = async () => {
      try {
        for (const don of store.listPendingReceipts(RECEIPT_MAX_AGE_MS)) {
          const r = await sendDonationReceipt(don);
          if (r.sent) store.setDonationReceipt(don.paymentIntentId, 'sent');
          else if (!r.retry) store.setDonationReceipt(don.paymentIntentId, 'skipped');
          else break; // email provider down / rate-limited — try again next tick
        }
      } catch { /* fail soft — never let the receipt outbox crash the app */ }
    };
    const iv = setInterval(() => void receiptOutbox(), 60_000);
    iv.unref?.();
  }
}

main().catch((err) => {
  // Log the message only (not the whole error object) so a future thrown error
  // can't spill a key or connection string into the logs.
  log.error('fatal startup error', err instanceof Error ? err.message : err);
  process.exit(1);
});
