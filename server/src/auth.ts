// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Single-admin local auth (the fallback for standalone use, and what an
 *  OpenMasjidOS SSO sign-in is minted into). The admin account is created in-app on
 *  first run (no install-time password). The password is stored as a scrypt hash in
 *  the data volume (see store.ts); the session is a signed, HTTP-only cookie whose
 *  payload carries an expiry + an audience claim. No external crypto dependency. */
import crypto from 'node:crypto';

export const COOKIE = 'omdon_session';
/** A password login lasts 30 days; an SSO-minted session is capped short (1h) so a
 *  stale platform session can't linger here after a dashboard logout. */
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
export const SSO_SESSION_MS = 60 * 60 * 1000;

export interface Cred {
  hash: string;
  salt: string;
  /** scrypt cost (N) used for this hash. Absent on pre-v0.11 hashes → Node default
   *  (16384); stored so we can raise the cost without locking out existing admins. */
  n?: number;
}

// Hardened cost for new hashes: N=2^16 (4× Node's default). r=8,p=1; maxmem sized for
// it (~67 MiB transient). We avoid 2^17 to stay friendly to small Raspberry Pi hosts
// (the manifest hints 128 MiB). Verification uses whatever N a hash was created with.
const SCRYPT_N = 2 ** 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const scryptOpts = (n: number) => ({ N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });

export function hashPassword(password: string): Cred {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, 32, scryptOpts(SCRYPT_N));
  return { hash: dk.toString('hex'), salt: salt.toString('hex'), n: SCRYPT_N };
}

export function verifyPassword(password: string, cred: Cred): boolean {
  try {
    const dk = crypto.scryptSync(password, Buffer.from(cred.salt, 'hex'), 32, scryptOpts(cred.n ?? 16384));
    const stored = Buffer.from(cred.hash, 'hex');
    return stored.length === dk.length && crypto.timingSafeEqual(stored, dk);
  } catch {
    return false;
  }
}

function hmac(secret: Buffer, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

type Audience = 'admin';

/** `usr` is carried so the audit log can name WHO did something (DONATIONS-011) without another
 *  platform round-trip on every request. It is inside the HMAC, so it cannot be forged; it is the
 *  admin's own OpenMasjidOS username, which they already see in the panel. Purely additive — a token
 *  minted before this existed simply has no `usr` and still verifies. */
export function makeToken(secret: Buffer, maxAgeMs = MAX_AGE_MS, aud: Audience = 'admin', usr?: string): string {
  const claims: { exp: number; aud: Audience; usr?: string } = { exp: Date.now() + maxAgeMs, aud };
  if (usr) claims.usr = usr.slice(0, 120);
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${hmac(secret, payload)}`;
}

/** The username inside a VALID token, or '' (unsigned/expired/absent). Verifies before reading, so
 *  a caller can never be handed an attacker-chosen name. */
export function tokenUser(secret: Buffer, token: string | undefined, aud: Audience = 'admin'): string {
  if (!verifyToken(secret, token, aud) || !token) return '';
  try {
    const obj = JSON.parse(Buffer.from(token.slice(0, token.lastIndexOf('.')), 'base64url').toString()) as { usr?: unknown };
    return typeof obj.usr === 'string' ? obj.usr.slice(0, 120) : '';
  } catch {
    return '';
  }
}

/** Verify signature, expiry AND audience (constant-time on the signature). */
export function verifyToken(secret: Buffer, token: string | undefined, aud: Audience = 'admin'): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const a = Buffer.from(sig);
  const b = Buffer.from(hmac(secret, payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number; aud?: string };
    return typeof obj.exp === 'number' && obj.exp > Date.now() && obj.aud === aud;
  } catch {
    return false;
  }
}

// Force `Secure` on every session cookie regardless of the request scheme. Rarely needed now that
// the flag follows the actual scheme (see `secureForRequest`), but kept as an override for an
// operator who knows their deployment is HTTPS-only and wants no scheme sniffing at all.
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' || (process.env.COOKIE_SECURE ?? '').toLowerCase() === 'true';

/** Did this request arrive over TLS?
 *
 *  Nothing in the shipped configuration ever set COOKIE_SECURE, so before this the admin session
 *  cookie was issued WITHOUT `Secure` even in the normal deployment — where `manifest.yaml` declares
 *  `https: true` (the platform fronts the app with TLS, required for Stripe) and `domain: true` (it
 *  can be published on a public hostname). A 30-day admin token with no transport restriction is
 *  then attached to any plaintext request to the same host (DONATIONS-012).
 *
 *  Always setting `Secure` was not an option: a masjid LAN is usually plain HTTP, and the flag would
 *  silently lock every standalone admin out of their own panel. So it follows the scheme the request
 *  actually arrived on.
 *
 *  On trusting `x-forwarded-proto` while `trustProxy` is off: reading it here is safe in a way that
 *  reading it for a rate-limit key would not be. The header can only ever ADD `Secure` to the
 *  cookie in the response to THAT SAME request — i.e. it can only restrict where the sender's own
 *  cookie will be sent. There is no cross-user effect and no privilege gained, and a cross-site
 *  attacker cannot set headers on the admin's own request in the first place. */
export function secureForRequest(req: { protocol?: string; headers: Record<string, unknown> }): boolean {
  if (COOKIE_SECURE) return true;
  if (req.protocol === 'https') return true;
  const xfp = req.headers['x-forwarded-proto'];
  // May be a comma-separated list from a proxy chain; the client-facing hop is the first entry.
  const first = (Array.isArray(xfp) ? xfp[0] : typeof xfp === 'string' ? xfp : '').split(',')[0].trim().toLowerCase();
  return first === 'https';
}

/** Cookie options for @fastify/cookie's setCookie. HTTP-only + SameSite=Lax + Path=/, and `Secure`
 *  when the request came over TLS. Pass the request; omitting it falls back to the env override
 *  only, which is the pre-existing behaviour. */
export function cookieOptions(maxAgeMs = MAX_AGE_MS, secure = COOKIE_SECURE) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure,
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}
