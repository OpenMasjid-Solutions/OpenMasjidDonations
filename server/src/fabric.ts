// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * OpenMasjidOS Fabric — single sign-on + notifications + Stripe (optional, server→server).
 *
 * When this app runs under OpenMasjidOS, the platform injects OPENMASJID_BASE_URL and
 * a per-app OPENMASJID_APP_SECRET, and the browser also sends the platform's
 * `omos_session` cookie to us (same host, different port = same-site). We NEVER trust
 * that cookie ourselves — we ask the platform to validate it, presenting our per-app
 * secret so the platform can confirm it's really us asking (identity-bound; the
 * platform fails closed without it). A positive result is cached briefly per token.
 *
 * Everything degrades gracefully: no base URL, no secret, no cookie, or an
 * unreachable platform all simply mean "no Fabric", and the app falls back to its own
 * admin password / its own locally-entered Stripe keys. The wire identifiers (env
 * vars, header, cookie, endpoints) are the shared Fabric contract — do not rename
 * them. See docs/ARCHITECTURE.md and OpenMasjidAPPS docs/BUILDING_AN_APP.md §7.
 *
 * RESTORE/MIGRATION RESILIENCE (required of every Fabric app): OPENMASJID_BASE_URL and
 * OPENMASJID_APP_SECRET are read from the environment on EVERY process start (config.ts)
 * and NEVER persisted — the platform rewrites the base URL when a backup is restored on
 * a new machine and may rotate the secret, so a cached copy would point at the old box
 * and break sign-in. Every call here fails soft (short timeout, redirect:'error') so an
 * unreachable platform is "no Fabric this request", never a crash or a lock-out.
 */
import { config, ssoConfigured } from './config';
import { makeLog } from './logger';

const log = makeLog('fabric');

export { ssoConfigured };

/**
 * Is `host` a loopback / private / LAN address where sending our app secret over plain
 * HTTP is acceptable? Covers loopback (127/::1/localhost), RFC1918 private ranges,
 * link-local, and the mDNS/intranet hostnames used by default (*.local, *.lan).
 * Anything else is treated as PUBLIC (we err toward "this is public" if unsure).
 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.lan')) return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 link-local + unique-local
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  }
  return false;
}

// Warn at most once per process — a cleartext secret on a public host is a config
// concern, not a per-request event, so we don't spam the log.
let cleartextSecretWarned = false;

/** One-time warning when our per-app Fabric secret is about to be sent in cleartext to
 *  a PUBLIC host (non-https base URL whose host isn't loopback/private/LAN). The default
 *  LAN flow (http://openmasjidos.local, a 192.168.x.x box, …) is fine and stays silent.
 *  We never stop sending — this only nudges cross-host deployments toward https. */
function warnIfCleartextSecret(): void {
  if (cleartextSecretWarned || !config.omosBaseUrl) return;
  let url: URL;
  try {
    url = new URL(config.omosBaseUrl);
  } catch {
    return; // malformed base URL — the fetch will fail and be handled there
  }
  if (url.protocol === 'https:') return; // encrypted — nothing to warn about
  if (isPrivateHost(url.hostname)) return; // trusted LAN — http is fine
  cleartextSecretWarned = true;
  log.warn(
    `OPENMASJID_BASE_URL is a public address over plain http (${url.host}); this app's Fabric secret ` +
      `is being sent across the network unencrypted. For a cross-host deployment, set an https ` +
      `OPENMASJID_BASE_URL so the secret isn't exposed. (Over a trusted LAN, plain http is fine.)`,
  );
}

export interface NotifyPayload {
  text: string;
  title?: string;
  level?: 'info' | 'success' | 'warning' | 'error';
}

/**
 * Relay a message to the masjid's configured webhook via the Fabric (server→server,
 * authenticated with our per-app secret). The platform owns the destination — we
 * never see the webhook URL — and it requires the notifications capability (manifest
 * `notifications: true`). FAILS SOFT: no platform, no secret, the admin hasn't
 * enabled notifications, or any error → returns delivered:false and the app carries
 * on. Never throws. Used to alert the masjid (e.g. "A new donation of £50 arrived").
 */
export async function notify(payload: NotifyPayload): Promise<{ delivered: boolean; reason?: string }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { delivered: false, reason: 'no-fabric' };
  if (!payload.text?.trim()) return { delivered: false, reason: 'empty' };
  warnIfCleartextSecret(); // about to send the per-app secret — flag it if cleartext to a public host
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openmasjid-app-secret': config.omosAppSecret,
      },
      body: JSON.stringify({ text: payload.text, title: payload.title, level: payload.level ?? 'info' }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      log.warn(`Fabric notify not delivered: platform returned HTTP ${res.status}`);
      return { delivered: false, reason: `http_${res.status}` };
    }
    const j = (await res.json().catch(() => ({}))) as { delivered?: boolean; reason?: string };
    if (j.delivered !== true) {
      log.warn(`Fabric notify not delivered (reason: ${j.reason ?? 'unknown'}) — e.g. notifications not enabled in OpenMasjidOS.`);
    }
    return { delivered: j.delivered === true, reason: j.reason };
  } catch (err) {
    log.warn(`Fabric notify could not reach the platform: ${err instanceof Error ? err.message : String(err)}`);
    return { delivered: false, reason: 'unreachable' };
  }
}

// ── Fabric email (manifest `email: true`) — send a donor a receipt via the OS ──────
// The admin sets up ONE provider (SMTP/Resend) in OpenMasjidOS → Settings → Email; we send
// through the platform with our per-app secret and NEVER see the mail credentials or the From
// address. Server→server, LAN-only, not CORS-enabled. Fails soft: `not_configured` = the admin
// hasn't set up email yet → we just don't send (the donation is still recorded + shown).
export interface FabricEmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Last outcome of a Fabric email attempt, so the admin UI can tell whether email is set up
 *  in OpenMasjidOS WITHOUT us sending a probe on every settings load. In-memory only. */
export type EmailStatus = 'unknown' | 'ok' | 'not_configured' | 'rate_limited' | 'error' | 'no-fabric';
let lastEmailStatus: EmailStatus = 'unknown';
export function emailStatus(): EmailStatus {
  return lastEmailStatus;
}

/** Send one email through the Fabric. Returns {sent} / {sent:false, reason}. NEVER throws;
 *  NEVER logs the recipient or the body (only a status code on failure). */
export async function fabricEmail(msg: FabricEmailMessage): Promise<{ sent: boolean; reason?: string }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) {
    lastEmailStatus = 'no-fabric';
    return { sent: false, reason: 'no-fabric' };
  }
  if (!msg.to.trim() || !msg.subject.trim() || !msg.text.trim()) return { sent: false, reason: 'empty' };
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmasjid-app-secret': config.omosAppSecret },
      body: JSON.stringify({ to: msg.to, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      lastEmailStatus = 'error';
      return { sent: false, reason: `http_${res.status}` };
    }
    const j = (await res.json().catch(() => ({}))) as { sent?: boolean; reason?: string };
    if (j.sent === true) {
      lastEmailStatus = 'ok';
      return { sent: true };
    }
    const reason = j.reason ?? 'unknown';
    lastEmailStatus = reason === 'not_configured' ? 'not_configured' : reason === 'rate_limited' ? 'rate_limited' : 'error';
    return { sent: false, reason };
  } catch (err) {
    // Reached-but-failed / unreachable — NOT proof it's unconfigured, so don't say so.
    log.debug(`Fabric email failed: ${err instanceof Error ? err.message : String(err)}`);
    lastEmailStatus = 'error';
    return { sent: false, reason: 'unreachable' };
  }
}

// ── Fabric alerts (manifest `alerts:`) — tell the ADMIN something's wrong ──────────
// The admin chooses the channel (email/webhook/both/off) per alert in OpenMasjidOS →
// Settings → Alerts; we never pick it. `alert` MUST be an id we declared in the manifest.
// Fails soft: `disabled_by_admin` (muted, or both channels off) is normal — never crash.
export async function fabricAlert(
  alert: string,
  title: string,
  text: string,
  level: 'info' | 'success' | 'warning' | 'error' = 'warning',
): Promise<{ delivered: boolean; reason?: string }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { delivered: false, reason: 'no-fabric' };
  if (!alert || !text.trim()) return { delivered: false, reason: 'empty' };
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/alert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmasjid-app-secret': config.omosAppSecret },
      body: JSON.stringify({ alert, title, text, level }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) return { delivered: false, reason: `http_${res.status}` };
    const j = (await res.json().catch(() => ({}))) as { delivered?: boolean; reason?: string };
    return { delivered: j.delivered === true, reason: j.reason };
  } catch (err) {
    log.debug(`Fabric alert failed: ${err instanceof Error ? err.message : String(err)}`);
    return { delivered: false, reason: 'unreachable' };
  }
}

/** Pull the platform's session token out of the raw Cookie header. */
function omosCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const m = /(?:^|;\s*)omos_session=([^;]+)/.exec(cookieHeader);
  if (!m) return null;
  const token = m[1].trim();
  // Only forward a token that looks like a cookie value, so nothing odd can be
  // injected into the outbound Cookie header we send to the platform.
  return /^[A-Za-z0-9._~%+/=-]{1,4096}$/.test(token) ? token : null;
}

interface CacheEntry {
  username: string;
  expires: number;
}
const positiveCache = new Map<string, CacheEntry>();
const CACHE_MS = 45_000;

export interface PlatformProbe {
  /** the platform-confirmed username, or null if the visitor isn't signed in there */
  username: string | null;
  /** did we actually REACH the platform? false = not configured, network error, or
   *  timeout. Distinguishes "not signed in" from "OpenMasjidOS is down / wrong address"
   *  so the panel can offer the local-password recovery instead of looping — a
   *  momentarily-unreachable or freshly-migrated platform must never lock you out. */
  reachable: boolean;
}

/**
 * Probe the platform: validate the omos_session cookie present on THIS request (if any)
 * AND report whether the platform was reachable at all. Only ever validates the cookie
 * actually on the request (never a client-supplied username). Reads the cookie ONLY
 * from the incoming Cookie header — never a query, header or body.
 */
export async function probePlatform(cookieHeader: string | undefined): Promise<PlatformProbe> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { username: null, reachable: false };
  const token = omosCookie(cookieHeader);
  if (!token) {
    // No session cookie to validate — still check reachability so the UI can tell
    // "open it from the dashboard" apart from "the platform is unreachable".
    return { username: null, reachable: await platformReachable() };
  }

  const cached = positiveCache.get(token);
  if (cached && cached.expires > Date.now()) return { username: cached.username, reachable: true };

  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/auth/session`, {
      headers: {
        cookie: `omos_session=${token}`,
        // Identity-bound SSO: prove which app is asking. Without this the platform
        // fails closed. A credential — never logged.
        'x-openmasjid-app-secret': config.omosAppSecret,
      },
      signal: ctrl.signal,
      redirect: 'error', // don't follow a redirect to some other (internal) host
    });
    clearTimeout(t);
    // Any HTTP response (even non-200 / "not signed in") means the platform is reachable.
    if (res.ok) {
      const j = (await res.json()) as { authenticated?: boolean; username?: unknown };
      if (j.authenticated === true) {
        // Untrusted display string — cap + trim, never use it for any decision.
        const username = (typeof j.username === 'string' ? j.username : '').trim().slice(0, 64) || 'OpenMasjidOS';
        positiveCache.set(token, { username, expires: Date.now() + CACHE_MS });
        if (positiveCache.size > 256) {
          for (const [k, v] of positiveCache) if (v.expires <= Date.now()) positiveCache.delete(k);
        }
        return { username, reachable: true };
      }
    }
    return { username: null, reachable: true };
  } catch (err) {
    log.debug(`platform session check failed: ${err instanceof Error ? err.message : String(err)}`);
    return { username: null, reachable: false };
  }
}

/** Cheap, unauthenticated "is the platform up?" check, used only when there's no session
 *  cookie to validate. The appearance endpoint is public + CORS-enabled; any response
 *  (even an error status) proves we reached it. */
export async function platformReachable(): Promise<boolean> {
  if (!config.omosBaseUrl) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    await fetch(`${config.omosBaseUrl}/api/public/appearance`, { signal: ctrl.signal, redirect: 'error' });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

/** Returns the platform username if the request carries a session the platform confirms,
 *  or null otherwise. Thin wrapper over probePlatform for callers that only need identity. */
export async function platformUser(cookieHeader: string | undefined): Promise<string | null> {
  return (await probePlatform(cookieHeader)).username;
}

// ── Stripe via the Fabric (platform-vaulted keys) ───────────────────────────────
// When the admin configures Stripe ONCE in OpenMasjidOS (Settings → Payments), every
// app shares it and the keys are backed up / migrated with the platform — never pasted
// per app. We fetch the chosen named account's keys server→server with our per-app
// secret and keep them IN MEMORY ONLY (never written to our data volume), so they always
// track the OS vault even across a restore-to-new-machine. See BUILDING_AN_APP.md §7.

/** The shape the platform returns for a vaulted Stripe account. The secret + webhook
 *  secret are server-side only and must never be returned to the browser or logged. */
export interface FabricStripeAccount {
  id: string;
  label: string;
  publishableKey: string;
  secretKey: string;
  webhookSecret: string;
}

interface StripeCache {
  at: number;
  account: string;
  value: FabricStripeAccount | null;
}
let stripeCache: StripeCache | null = null;
// The last account we successfully fetched, kept so a transient platform blip doesn't
// break live donations (we'd rather serve slightly-stale vault keys than fail). `at` is
// when THIS good copy was fetched, so the freshness window below is measured against the
// last success — not against the last attempt (which may have been a 404 or a miss).
let stripeLastGood: { at: number; account: string; value: FabricStripeAccount } | null = null;
const STRIPE_CACHE_MS = 60_000;
const STRIPE_LASTGOOD_MS = 10 * 60_000;

function parseFabricStripe(j: unknown): FabricStripeAccount | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const secretKey = typeof o.secretKey === 'string' ? o.secretKey : '';
  if (!secretKey) return null; // no secret = nothing usable
  return {
    id: typeof o.id === 'string' && o.id ? o.id : 'fabric',
    label: typeof o.label === 'string' && o.label ? o.label.slice(0, 80) : 'OpenMasjidOS account',
    publishableKey: typeof o.publishableKey === 'string' ? o.publishableKey : '',
    secretKey,
    webhookSecret: typeof o.webhookSecret === 'string' ? o.webhookSecret : '',
  };
}

/**
 * Fetch a vaulted Stripe account from the platform (server→server). `accountName` is the
 * admin-chosen account label (our STRIPE_ACCOUNT install setting); empty = the only/first
 * account. Returns null when the Fabric isn't configured, the platform is unreachable
 * (with no recent good copy), or the platform has no such account — callers then fall back
 * to local keys. Caches the result in memory (~60s); on a transient error serves the last
 * good copy (~10min) so a blip doesn't stop donations. NEVER throws; NEVER persists.
 */
export async function fetchFabricStripe(accountName: string, force = false): Promise<FabricStripeAccount | null> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return null;
  const now = Date.now();
  if (!force && stripeCache && stripeCache.account === accountName && now - stripeCache.at < STRIPE_CACHE_MS) {
    return stripeCache.value;
  }
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const qs = accountName ? `?account=${encodeURIComponent(accountName)}` : '';
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/stripe${qs}`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      // Reached the platform and it has nothing for us (e.g. 404 unknown account, or this
      // app lacks the stripe capability) — respect that: no Fabric account, use local.
      stripeCache = { at: now, account: accountName, value: null };
      return null;
    }
    const value = parseFabricStripe(await res.json().catch(() => null));
    stripeCache = { at: now, account: accountName, value };
    if (value) stripeLastGood = { at: now, account: accountName, value };
    return value;
  } catch (err) {
    log.debug(`Fabric stripe fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    // Transient unreachable: keep donations working with the last good copy if it's for
    // this same account and was fetched within the freshness window.
    if (stripeLastGood && stripeLastGood.account === accountName && now - stripeLastGood.at < STRIPE_LASTGOOD_MS) {
      return stripeLastGood.value;
    }
    return null;
  }
}

/** The last fetched Fabric Stripe account WITHOUT triggering a network call — for cheap,
 *  frequently-hit sync paths (e.g. the public landing hint). May be stale or null. */
export function cachedFabricStripe(): FabricStripeAccount | null {
  return stripeCache?.value ?? stripeLastGood?.value ?? null;
}

/** Drop the in-memory Stripe-keys cache so the next fetch re-reads the OS vault. Called
 *  when the admin changes the chosen account in-app, so a freshly-connected/rotated
 *  account takes effect immediately — no container restart needed. */
export function clearFabricStripeCache(): void {
  stripeCache = null;
  stripeLastGood = null;
}

/** A non-secret reference to a vaulted Stripe account, for the in-app account picker. */
export interface FabricStripeAccountRef {
  id: string;
  label: string;
}

/**
 * List the masjid's Stripe accounts from the OS vault (id + label only, NEVER keys) so the
 * admin can pick one on the app's own Payments screen — the recommended pattern that keeps
 * install one-click (no STRIPE_ACCOUNT setting). Server→server, fail-soft → [] when the
 * Fabric isn't configured, the platform is unreachable, or it's an older platform without
 * the endpoint (v0.33.0+). Never throws.
 */
export async function fetchFabricStripeAccounts(): Promise<FabricStripeAccountRef[]> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return [];
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/stripe/accounts`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const j = (await res.json().catch(() => null)) as { accounts?: unknown } | null;
    const list = Array.isArray(j?.accounts) ? j!.accounts : [];
    return list
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string')
      .map((a) => ({
        id: String(a.id),
        label: typeof a.label === 'string' && a.label ? a.label.slice(0, 80) : String(a.id),
      }));
  } catch (err) {
    log.debug(`Fabric stripe accounts list failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ── Remote access / public URL via the Fabric (manifest `domain: true`) ─────────
// The admin runs a Cloudflare Tunnel once in OpenMasjidOS (Settings → Remote access);
// every app is reached on one hostname under an admin-chosen path (default the app id),
// e.g. https://omos.example.org/donate/…. We ask the platform for OUR public base + path
// instead of guessing, and use it for share links, QR codes and the Stripe webhook URL.
// Cloudflare forwards the FULL path (it does not strip the prefix), so the server must be
// base-path aware (see index.ts rewriteUrl + HTML injection). Never persisted; fails soft.

/** The platform's answer for this app's public address. `basePath` is normalised to a
 *  leading slash with no trailing slash (e.g. "/donate"), or "" when remote access is off. */
export interface FabricSite {
  enabled: boolean;
  domain: string;
  publicUrl: string;
  basePath: string;
}

const SITE_OFF: FabricSite = { enabled: false, domain: '', publicUrl: '', basePath: '' };

/** Normalise a path to "" or "/seg[/seg…]" (leading slash, no trailing slash). */
function normBasePath(raw: unknown): string {
  let p = (typeof raw === 'string' ? raw : '').trim();
  if (!p || p === '/') return '';
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '');
}

let siteCache: { at: number; value: FabricSite } | null = null;
const SITE_CACHE_MS = 60_000;

function parseSite(j: unknown): FabricSite {
  if (!j || typeof j !== 'object') return SITE_OFF;
  const o = j as Record<string, unknown>;
  const enabled = o.enabled === true;
  if (!enabled) return SITE_OFF;
  return {
    enabled: true,
    domain: typeof o.domain === 'string' ? o.domain : '',
    publicUrl: typeof o.publicUrl === 'string' ? o.publicUrl.replace(/\/+$/, '') : '',
    basePath: normBasePath(o.basePath),
  };
}

/**
 * Fetch this app's public address from the platform (server→server). Returns SITE_OFF
 * when the Fabric isn't configured, the platform is unreachable, or remote access is off
 * — callers then derive URLs from the incoming request host (today's behaviour). Cached
 * ~60s; on a transient error serves the last cached value so base-path routing stays
 * stable through a blip. NEVER throws; NEVER persists the domain/publicUrl.
 */
export async function fetchFabricSite(force = false): Promise<FabricSite> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return SITE_OFF;
  const now = Date.now();
  if (!force && siteCache && now - siteCache.at < SITE_CACHE_MS) return siteCache.value;
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/site`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    const value = res.ok ? parseSite(await res.json().catch(() => null)) : SITE_OFF;
    siteCache = { at: now, value };
    return value;
  } catch (err) {
    log.debug(`Fabric site fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    // Keep the last known base path stable through a transient outage so routing behind
    // the tunnel doesn't flap; only forget it after the cache window lapses.
    if (siteCache && now - siteCache.at < SITE_CACHE_MS * 5) return siteCache.value;
    return SITE_OFF;
  }
}

/** The last fetched site WITHOUT a network call — for the synchronous URL-rewrite hook
 *  that must decide, per request, whether to strip a base-path prefix. */
export function cachedFabricSite(): FabricSite {
  return siteCache?.value ?? SITE_OFF;
}

/**
 * A fingerprint of the Fabric config that affects this app — the vaulted Stripe account
 * (which one, and whether its keys are present) and the remote-access site (base path +
 * public URL). The reboot watcher compares this over time: when the admin changes Stripe
 * or remote access IN OPENMASJIDOS, the fingerprint changes and the app restarts so the
 * new config is applied cleanly. `reachable` lets the watcher ignore transient outages
 * (a fingerprint that only changed because the platform was briefly down). Force-refreshes
 * both, so it sees changes promptly rather than through the normal cache.
 */
export async function fabricConfigSignature(accountName: string): Promise<{ sig: string; reachable: boolean }> {
  const [stripe, site, reachable] = await Promise.all([
    fetchFabricStripe(accountName, true),
    fetchFabricSite(true),
    platformReachable(),
  ]);
  const sig = JSON.stringify({
    s_id: stripe?.id ?? '',
    s_pk: stripe?.publishableKey ?? '',
    s_hasSecret: !!stripe?.secretKey,
    s_hasWebhook: !!stripe?.webhookSecret,
    site_enabled: site.enabled,
    site_base: site.basePath,
    site_url: site.publicUrl,
  });
  return { sig, reachable };
}
