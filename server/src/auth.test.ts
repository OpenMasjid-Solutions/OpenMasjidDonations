// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the admin session primitives. Before the 2026-08-03 audit this file did not exist, which is
// why DONATIONS-012 (a session cookie that could never be `Secure`) survived so long.
//
// The `Secure` tests cut BOTH ways on purpose. The bug was a missing flag on HTTPS; the dangerous
// over-fix is setting it on a plain-HTTP LAN box, which would lock a masjid volunteer out of their
// own panel with no way back in. Both directions are asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieOptions, hashPassword, makeToken, secureForRequest, verifyPassword, verifyToken, MAX_AGE_MS } from './auth';

const req = (protocol: string | undefined, headers: Record<string, unknown> = {}) => ({ protocol, headers });

// ── DONATIONS-012 ────────────────────────────────────────────────────────────

test('cookie Secure: set when the request arrived over TLS directly', () => {
  assert.equal(secureForRequest(req('https')), true);
});

test('cookie Secure: set when the platform ingress reports https', () => {
  assert.equal(secureForRequest(req('http', { 'x-forwarded-proto': 'https' })), true);
  // A proxy chain sends a list; the client-facing hop is the first entry.
  assert.equal(secureForRequest(req('http', { 'x-forwarded-proto': 'https, http' })), true);
  assert.equal(secureForRequest(req('http', { 'x-forwarded-proto': ['https', 'http'] })), true);
  assert.equal(secureForRequest(req('http', { 'x-forwarded-proto': 'HTTPS' })), true, 'case-insensitive');
});

test('cookie Secure: NOT set on a plain-HTTP LAN request — a masjid must not be locked out', () => {
  assert.equal(secureForRequest(req('http')), false);
  assert.equal(secureForRequest(req(undefined)), false);
  assert.equal(secureForRequest(req('http', { 'x-forwarded-proto': 'http' })), false);
  assert.equal(secureForRequest(req('http', { 'x-forwarded-proto': '' })), false);
  assert.equal(secureForRequest(req('http', { 'x-forwarded-proto': 'httpsish' })), false, 'no prefix matching');
  assert.equal(secureForRequest(req('http', { 'x-forwarded-proto': 42 })), false, 'a non-string header is not TLS');
});

test('cookieOptions: always httpOnly + SameSite=Lax + Path=/, and carries the Secure decision', () => {
  const insecure = cookieOptions(MAX_AGE_MS, false);
  assert.equal(insecure.httpOnly, true);
  assert.equal(insecure.sameSite, 'lax');
  assert.equal(insecure.path, '/');
  assert.equal(insecure.secure, false);
  assert.equal(insecure.maxAge, Math.floor(MAX_AGE_MS / 1000));
  assert.equal(cookieOptions(MAX_AGE_MS, true).secure, true);
});

// ── Session token ────────────────────────────────────────────────────────────

test('session token: round-trips, and a tampered payload or signature is rejected', () => {
  const secret = Buffer.from('a'.repeat(32));
  const token = makeToken(secret, 60_000);
  assert.equal(verifyToken(secret, token), true);

  const [payload, sig] = token.split('.');
  assert.equal(verifyToken(secret, `${payload}x.${sig}`), false, 'payload tampered');
  assert.equal(verifyToken(secret, `${payload}.${sig.slice(0, -1)}z`), false, 'signature tampered');
  assert.equal(verifyToken(Buffer.from('b'.repeat(32)), token), false, 'wrong signing secret');
  assert.equal(verifyToken(secret, undefined), false);
  assert.equal(verifyToken(secret, 'nonsense'), false);
});

test('session token: an expired token is rejected', () => {
  const secret = Buffer.from('c'.repeat(32));
  assert.equal(verifyToken(secret, makeToken(secret, -1_000)), false, 'already expired');
});

test('session token: the audience claim is checked, so a token minted for another use is refused', () => {
  const secret = Buffer.from('d'.repeat(32));
  // Forge a correctly-SIGNED token with a different audience: signature valid, aud wrong.
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60_000, aud: 'something-else' })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  assert.equal(verifyToken(secret, `${payload}.${sig}`), false);
});

// ── Password hashing ─────────────────────────────────────────────────────────

test('password: verifies, rejects a wrong one, and salts so two hashes differ', () => {
  const a = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', a), true);
  assert.equal(verifyPassword('Correct horse battery staple', a), false);
  assert.equal(verifyPassword('', a), false);

  const b = hashPassword('correct horse battery staple');
  assert.notEqual(a.hash, b.hash, 'same password, different salt → different hash');
  assert.notEqual(a.salt, b.salt);
});

test('password: a pre-v0.11 hash with no stored cost still verifies (no admin lockout on upgrade)', () => {
  // Cost is recorded per hash so it can be raised without invalidating existing credentials; a hash
  // written before that field existed must fall back to Node's default N=16384.
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const salt = crypto.randomBytes(16);
  const legacy = {
    hash: crypto.scryptSync('old-password', salt, 32, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString('hex'),
    salt: salt.toString('hex'),
  };
  assert.equal(verifyPassword('old-password', legacy), true);
  assert.equal(verifyPassword('wrong', legacy), false);
});

test('password: a corrupt credential record fails closed rather than throwing', () => {
  assert.equal(verifyPassword('x', { hash: 'not-hex', salt: 'zz', n: 16384 }), false);
  assert.equal(verifyPassword('x', { hash: '', salt: '', n: 1 }), false);
});
