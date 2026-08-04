// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the login brute-force limiter — the only thing standing behind a short admin password on a
// masjid LAN. Two properties matter and both were broken or untested before the 2026-08-03 audit:
//
//  1. The backoff itself: five free attempts, then a growing lockout, cleared by a success.
//  2. The sweep actually sweeps (DONATIONS-017). Its old condition could never be true, so the map
//     grew one entry per attacking IP for the life of the process — and the naive fix (evict
//     anything old) would have handed an attacker a fresh allowance every ten minutes, so the test
//     pins BOTH halves: idle entries go, locked-out entries stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginLimiter } from './rateLimit';

const HOUR = 3_600_000;

test('LoginLimiter: five free attempts, then a lockout that grows', () => {
  const lim = new LoginLimiter();
  for (let i = 0; i < 5; i++) {
    assert.equal(lim.retryAfterMs('1.2.3.4'), 0, `attempt ${i + 1} of the five free ones`);
    lim.fail('1.2.3.4');
  }
  assert.equal(lim.retryAfterMs('1.2.3.4'), 0, 'the fifth failure has not locked us out yet');
  lim.fail('1.2.3.4');
  const first = lim.retryAfterMs('1.2.3.4');
  assert.ok(first > 0 && first <= 2000, `sixth failure starts the backoff (got ${first}ms)`);
  lim.fail('1.2.3.4');
  assert.ok(lim.retryAfterMs('1.2.3.4') > first, 'and the next one is longer');
});

test('LoginLimiter: a peer is only ever limited on its own attempts', () => {
  const lim = new LoginLimiter();
  for (let i = 0; i < 10; i++) lim.fail('10.0.0.1');
  assert.ok(lim.retryAfterMs('10.0.0.1') > 0, 'the attacker is locked out');
  assert.equal(lim.retryAfterMs('10.0.0.2'), 0, 'a different peer is untouched');
});

test('LoginLimiter: a successful sign-in forgets the failures', () => {
  const lim = new LoginLimiter();
  for (let i = 0; i < 8; i++) lim.fail('10.0.0.3');
  assert.ok(lim.retryAfterMs('10.0.0.3') > 0);
  lim.succeed('10.0.0.3');
  assert.equal(lim.retryAfterMs('10.0.0.3'), 0, 'the admin got in, so the slate is clean');
  assert.equal(lim.size(), 0, 'and nothing is left behind');
});

// ── DONATIONS-017 ────────────────────────────────────────────────────────────
// This is the regression test proper. Against the pre-fix code the first assertion fails: the old
// sweep condition (`lockedUntil < now - 1h && fails === 0`) was unsatisfiable, because an entry
// only exists after fail() has already pushed `fails` to >= 1.
test('LoginLimiter: the sweep drops idle peers (the map is not unbounded)', () => {
  const lim = new LoginLimiter();
  for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) lim.fail(ip);
  assert.equal(lim.size(), 3, 'three peers remembered');

  lim.sweepNow(Date.now() + 10_000); // ten seconds later: far too soon to forget anyone
  assert.equal(lim.size(), 3, 'a recent failure is still remembered');

  lim.sweepNow(Date.now() + HOUR + 60_000); // an hour and a minute later
  assert.equal(lim.size(), 0, 'idle peers are forgotten, so the map cannot grow for ever');
});

test('LoginLimiter: a sweep during an active lockout does not release the attacker', () => {
  const lim = new LoginLimiter();
  // 12 failures → a lockout, capped at 5 minutes.
  for (let i = 0; i < 12; i++) lim.fail('9.9.9.9');
  assert.ok(lim.retryAfterMs('9.9.9.9') > 0, 'attacker is locked out');

  // A sweep landing mid-lockout must leave it alone. Losing the entry here would hand the attacker
  // five fresh attempts every ten minutes — a rate-limit bypass introduced BY the fix, which is the
  // failure mode worth pinning.
  lim.sweepNow(Date.now() + 60_000);
  assert.equal(lim.size(), 1, 'the locked-out peer survives the sweep');
  assert.ok(lim.retryAfterMs('9.9.9.9') > 0, 'and is still locked out');

  // Honest note on the guard's reach: because the idle window (1h) is far longer than the longest
  // single lockout (5 min), `lockedUntil <= now` can never be the deciding clause in practice — by
  // the time a peer is idle enough to sweep, its lockout has long expired. It is kept as
  // belt-and-braces in case either constant is ever changed, and this test documents that a peer
  // released by the sweep is only ever one whose lockout had ALREADY run out:
  lim.sweepNow(Date.now() + HOUR + 60_000);
  assert.equal(lim.size(), 0, 'an hour idle and no longer locked → forgotten');
});
