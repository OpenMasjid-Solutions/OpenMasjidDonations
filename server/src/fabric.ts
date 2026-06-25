// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * OpenMasjidOS Fabric — single sign-on + notifications (optional, server→server).
 *
 * When this app runs under OpenMasjidOS, the platform injects OPENMASJID_BASE_URL and
 * a per-app OPENMASJID_APP_SECRET, and the browser also sends the platform's
 * `omos_session` cookie to us (same host, different port = same-site). We NEVER trust
 * that cookie ourselves — we ask the platform to validate it, presenting our per-app
 * secret so the platform can confirm it's really us asking (identity-bound; the
 * platform fails closed without it). A positive result is cached briefly per token.
 *
 * Everything degrades gracefully: no base URL, no secret, no cookie, or an
 * unreachable platform all simply mean "no SSO", and the app falls back to its own
 * admin password. The wire identifiers (env vars, header, cookie, endpoints) are the
 * shared Fabric contract — do not rename them. See docs/ARCHITECTURE.md.
 */
import { config, ssoConfigured } from './config';
import { makeLog } from './logger';

const log = makeLog('fabric');

export { ssoConfigured };

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

/**
 * Returns the platform username if the request carries a session the platform
 * confirms, or null otherwise. Only ever validates the cookie actually present on
 * THIS request (never a client-supplied username). Reads the cookie ONLY from the
 * incoming Cookie header — never a query, header or body.
 */
export async function platformUser(cookieHeader: string | undefined): Promise<string | null> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return null;
  const token = omosCookie(cookieHeader);
  if (!token) return null;

  const cached = positiveCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.username;

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
    if (!res.ok) return null;
    const j = (await res.json()) as { authenticated?: boolean; username?: unknown };
    if (j.authenticated === true) {
      // Untrusted display string — cap + trim, never use it for any decision.
      const username = (typeof j.username === 'string' ? j.username : '').trim().slice(0, 64) || 'OpenMasjidOS';
      positiveCache.set(token, { username, expires: Date.now() + CACHE_MS });
      if (positiveCache.size > 256) {
        for (const [k, v] of positiveCache) if (v.expires <= Date.now()) positiveCache.delete(k);
      }
      return username;
    }
    return null;
  } catch (err) {
    log.debug(`platform session check failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
