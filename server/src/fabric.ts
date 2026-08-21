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

// The `/api/fabric/notify` relay used to live here. It was retired in v0.43.0: it reached the
// masjid's WEBHOOK ONLY, with no per-event control, and the alert channel (`fabricAlert` below)
// strictly dominates it — same webhook, plus the admin's email, per declared event, with an on/off
// the admin owns. Keeping both would have posted twice to one webhook for a single event.
//
// `notifications: true` stays in the manifest deliberately: it is what the platform reads to know
// this app has something to say, and the alert delivery uses the masjid's notification channel
// configuration. Nothing in this app calls the raw relay any more.

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
 *  in OpenMasjidOS WITHOUT us sending a probe on every settings load.
 *
 *  Kept in memory AND mirrored to the data volume by the owner of the store (see `primeEmailStatus`
 *  / `onEmailStatusChange`), because in-memory alone made this a fact the app could only ever
 *  discover by accident and then forget on the next restart. */
export type EmailStatus = 'unknown' | 'ok' | 'not_configured' | 'rate_limited' | 'error' | 'no-fabric';
let lastEmailStatus: EmailStatus = 'unknown';
let emailStatusSink: ((s: EmailStatus) => void) | null = null;

export function emailStatus(): EmailStatus {
  return lastEmailStatus;
}

/** Restore the last known status at boot (from the data volume). Ignores junk and 'unknown'. */
export function primeEmailStatus(s: string): void {
  const known: EmailStatus[] = ['ok', 'not_configured', 'rate_limited', 'error', 'no-fabric'];
  if ((known as string[]).includes(s)) lastEmailStatus = s as EmailStatus;
}

/** Register a persistence sink, called whenever the status changes. */
export function onEmailStatusChange(fn: (s: EmailStatus) => void): void {
  emailStatusSink = fn;
}

function setEmailStatus(s: EmailStatus): void {
  if (s === lastEmailStatus) return;
  lastEmailStatus = s;
  try {
    emailStatusSink?.(s);
  } catch {
    /* persistence is best-effort; never let it break a send */
  }
}

/**
 * Is it worth ATTEMPTING to send through the Fabric right now?
 *
 * True unless we hold positive evidence that email cannot work — the platform said `not_configured`,
 * or there is no Fabric at all. Everything else (never tried, a timeout, a 500, a rate limit) is
 * "we don't know", and the honest answer to "we don't know" is to try.
 *
 * This is the gate on suppressing Stripe's own receipt in favor of our branded one, and it used to
 * demand a previous SUCCESS ('ok'). That was a closed loop: the only thing that ever set 'ok' was a
 * successful send, and the only sends that happened were ones the gate had already allowed — so on a
 * fresh container the branded receipt could never be sent at all, and a restart re-closed it.
 *
 * The failure mode this direction is bounded and self-healing: if email really is unconfigured, the
 * FIRST donation after the admin turns receipts on loses its receipt (we suppressed Stripe's, ours
 * failed), the platform tells us `not_configured`, that is persisted, and every donation after it
 * falls back to Stripe's own receipt. One donation, once — against every donation, for ever.
 */
export function emailLikelyAvailable(): boolean {
  return lastEmailStatus !== 'not_configured' && lastEmailStatus !== 'no-fabric';
}

/** Send one email through the Fabric. Returns {sent} / {sent:false, reason}. NEVER throws;
 *  NEVER logs the recipient or the body (only a status code on failure). */
export async function fabricEmail(msg: FabricEmailMessage): Promise<{ sent: boolean; reason?: string }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) {
    setEmailStatus('no-fabric');
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
      setEmailStatus('error');
      return { sent: false, reason: `http_${res.status}` };
    }
    const j = (await res.json().catch(() => ({}))) as { sent?: boolean; reason?: string };
    if (j.sent === true) {
      setEmailStatus('ok');
      return { sent: true };
    }
    const reason = j.reason ?? 'unknown';
    setEmailStatus(reason === 'not_configured' ? 'not_configured' : reason === 'rate_limited' ? 'rate_limited' : 'error');
    return { sent: false, reason };
  } catch (err) {
    // Reached-but-failed / unreachable — NOT proof it's unconfigured, so don't say so.
    log.debug(`Fabric email failed: ${err instanceof Error ? err.message : String(err)}`);
    setEmailStatus('error');
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
): Promise<{ delivered: boolean; reason?: string; email?: boolean; webhook?: boolean }> {
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
    const j = (await res.json().catch(() => ({}))) as { delivered?: boolean; reason?: string; email?: boolean; webhook?: boolean };
    return { delivered: j.delivered === true, reason: j.reason, email: j.email, webhook: j.webhook };
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
async function platformReachable(): Promise<boolean> {
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

// Both caches are keyed PER ACCOUNT NAME ('' = the platform's own default/first account).
//
// They used to be single slots holding one account each, with the account name stored alongside so
// a lookup for a different account counted as a miss. That was correct but thrashing: once
// campaigns may each name their own vaulted account (v0.42.0), alternating donations on two
// campaigns would evict each other's keys every time and make a platform round trip per donation —
// and, worse, would keep evicting the LAST-GOOD copy that exists precisely so a platform blip
// cannot stop donations. Per-account entries fix both; nothing else about the semantics changes.
const stripeCache = new Map<string, { at: number; value: FabricStripeAccount | null }>();
// The last account we successfully fetched, kept so a transient platform blip doesn't
// break live donations (we'd rather serve slightly-stale vault keys than fail). `at` is
// when THIS good copy was fetched, so the freshness window below is measured against the
// last success — not against the last attempt (which may have been a 404 or a miss).
const stripeLastGood = new Map<string, { at: number; value: FabricStripeAccount }>();
const STRIPE_CACHE_MS = 60_000;
const STRIPE_LASTGOOD_MS = 10 * 60_000;
/** A ceiling on both maps. The keys are admin-chosen account names, so this is a belt-and-braces
 *  bound rather than a defense — but an unbounded map fed from stored config is a leak waiting for
 *  a future caller, and a masjid will never have more accounts than this. */
const STRIPE_CACHE_MAX = 32;

/** Drop the oldest entries when a cache outgrows its ceiling. */
function trimStripeCaches(): void {
  for (const m of [stripeCache, stripeLastGood] as Map<string, { at: number }>[]) {
    if (m.size <= STRIPE_CACHE_MAX) continue;
    for (const [k] of [...m.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, m.size - STRIPE_CACHE_MAX)) {
      m.delete(k);
    }
  }
}

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
/** The outcome of a vault lookup. `authoritative` false means the platform told us NOTHING
 *  (throttled, broken, unreachable) — as distinct from telling us there is no such account. Callers
 *  that would ACT on "no account" must check it: the reboot watcher must not restart a box on a
 *  fingerprint taken during an outage. */
export interface FabricStripeResult {
  value: FabricStripeAccount | null;
  authoritative: boolean;
}

export async function fetchFabricStripe(accountName: string, force = false): Promise<FabricStripeAccount | null> {
  return (await fetchFabricStripeDetailed(accountName, force)).value;
}

export async function fetchFabricStripeDetailed(accountName: string, force = false): Promise<FabricStripeResult> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { value: null, authoritative: true };
  const now = Date.now();
  const cached = stripeCache.get(accountName);
  if (!force && cached && now - cached.at < STRIPE_CACHE_MS) return { value: cached.value, authoritative: true };
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
      // NOT all failures mean the same thing, and conflating them was safe only while a missing
      // Fabric account silently fell back to a local one. Now that a campaign can PIN an account and
      // an unresolvable pin REFUSES the donation, the difference is the difference between a correct
      // refusal and a self-inflicted outage:
      //
      //  • 404 / 403 — the platform has answered authoritatively: no such account, or we may not have
      //    it. Cache that. (404 is also how a vaulted account the admin has since deleted comes back
      //    as "nothing" rather than as somebody else's keys — the platform does not substitute its
      //    default for an unknown id.)
      //  • 429 / 5xx — the platform is throttling or broken and has told us NOTHING about the
      //    account. Caching a null here would turn one rate-limited request into a 60-second
      //    donation outage for that appeal, and the Fabric budget is shared with every other app on
      //    the box. So don't write the cache, and serve the last good copy if we have a fresh one —
      //    exactly as for a transport failure.
      const authoritative = res.status === 404 || res.status === 403;
      if (authoritative) {
        stripeCache.set(accountName, { at: now, value: null });
        trimStripeCaches();
        return { value: null, authoritative: true };
      }
      log.warn(`Fabric stripe fetch got HTTP ${res.status} — treating as "no information" and keeping any cached keys.`);
      const held = stripeLastGood.get(accountName);
      return { value: held && now - held.at < STRIPE_LASTGOOD_MS ? held.value : null, authoritative: false };
    }
    const value = parseFabricStripe(await res.json().catch(() => null));
    stripeCache.set(accountName, { at: now, value });
    if (value) stripeLastGood.set(accountName, { at: now, value });
    trimStripeCaches();
    return { value, authoritative: true };
  } catch (err) {
    log.debug(`Fabric stripe fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    // Transient unreachable: keep donations working with the last good copy OF THIS ACCOUNT (never
    // another one's) if it was fetched within the freshness window.
    const good = stripeLastGood.get(accountName);
    return { value: good && now - good.at < STRIPE_LASTGOOD_MS ? good.value : null, authoritative: false };
  }
}

/** A cached Fabric Stripe account WITHOUT triggering a network call — for cheap, frequently-hit
 *  sync paths (e.g. the public landing hint). May be stale or null.
 *
 *  With `accountName`, that account specifically. Without, ANY account we happen to hold, which is
 *  what the landing hint wants: it only asks "can this masjid take a card at all?", and one usable
 *  vaulted account is a truthful yes however many campaigns point elsewhere. */
export function cachedFabricStripe(accountName?: string): FabricStripeAccount | null {
  if (accountName !== undefined) {
    return stripeCache.get(accountName)?.value ?? stripeLastGood.get(accountName)?.value ?? null;
  }
  for (const m of [stripeCache, stripeLastGood]) {
    for (const e of m.values()) if (e.value) return e.value;
  }
  return null;
}

/** Drop the in-memory Stripe-keys cache so the next fetch re-reads the OS vault. Called
 *  when the admin changes the chosen account in-app, so a freshly-connected/rotated
 *  account takes effect immediately — no container restart needed.
 *
 *  Clears EVERY account, not just the one that changed: the admin may have re-pointed a campaign,
 *  and a stale copy of any account is exactly what this exists to prevent. */
export function clearFabricStripeCache(): void {
  stripeCache.clear();
  stripeLastGood.clear();
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

/** The platform's answer for this app's public address. `basePath` is normalized to a
 *  leading slash with no trailing slash (e.g. "/donate"), or "" when remote access is off. */
export interface FabricSite {
  enabled: boolean;
  domain: string;
  publicUrl: string;
  basePath: string;
}

const SITE_OFF: FabricSite = { enabled: false, domain: '', publicUrl: '', basePath: '' };

/** Normalize a path to "" or "/seg[/seg…]" (leading slash, no trailing slash). */
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
 * — callers then derive URLs from the incoming request host (today's behavior). Cached
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
  const [detailed, site, up] = await Promise.all([
    fetchFabricStripeDetailed(accountName, true),
    fetchFabricSite(true),
    platformReachable(),
  ]);
  const stripe = detailed.value;
  // "Reachable" has to mean "we got real answers", not merely "something responded". The
  // reachability probe hits /api/public/appearance, which is NOT behind the Fabric rate limiter — so
  // while the Fabric routes are throttling, the probe says "up" while the Stripe lookup says
  // "nothing". Believing that pair would blank s_pk/s_hasSecret, differ from the baseline, and
  // restart a box in the middle of taking live donations — over and over, for as long as the
  // throttling lasted. A non-authoritative lookup is no information, so the watcher must skip.
  const reachable = up && detailed.authoritative;
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
