// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * A tiny in-memory failed-attempt limiter for the login endpoint. Keyed by client
 * IP, with exponential backoff after a few failures. This is the real defence behind
 * the short admin password — without it, it is trivially brute-forced over the LAN.
 */
interface Entry {
  fails: number;
  lockedUntil: number;
  /** When we last saw a failure from this peer — what the sweep ages entries out on. */
  seen: number;
}

const MAX_FREE = 5; // attempts before backoff kicks in
const BASE_MS = 2000; // first lockout step
const MAX_MS = 5 * 60 * 1000; // cap a single lockout at 5 minutes
/** Forget a peer that has not failed for this long. Longer than the longest single lockout
 *  (5 min) by a wide margin, so ageing an entry out can never shorten a live lockout. */
const IDLE_MS = 60 * 60 * 1000;

export class LoginLimiter {
  private readonly map = new Map<string, Entry>();

  constructor() {
    const sweep = setInterval(() => this.sweep(), 10 * 60 * 1000);
    sweep.unref?.();
  }

  /** Drop peers that are not currently locked out and have not failed for an hour.
   *
   *  The previous condition (`lockedUntil < now - 1h && fails === 0`) could never be true: an
   *  entry only exists after `fail()`, which always increments `fails` to at least 1, and
   *  `succeed()` deletes the entry outright — so nothing was ever swept and the map grew for the
   *  life of the process, one entry per attacking IP. Exposed publicly when the box is tunnelled.
   *
   *  Both conditions matter. `lockedUntil <= now` means we never evict a peer mid-lockout (that
   *  would hand an attacker a fresh allowance every sweep — a rate-limit bypass introduced by the
   *  fix). `seen` ageing means an honest admin who mistyped their password twice last month is not
   *  remembered for ever, which is the same forgiveness the exponential backoff already implies. */
  private sweep(now = Date.now()): void {
    for (const [k, e] of this.map) {
      if (e.lockedUntil <= now && now - e.seen > IDLE_MS) this.map.delete(k);
    }
  }

  /** Entries currently held. Exposed for the regression test that pins the sweep. */
  size(): number {
    return this.map.size;
  }

  /** Run the sweep now, with an injectable clock (tests; the interval uses the real one). */
  sweepNow(now = Date.now()): void {
    this.sweep(now);
  }

  /** ms the caller must wait before another attempt (0 = allowed now). */
  retryAfterMs(ip: string): number {
    const e = this.map.get(ip);
    if (!e) return 0;
    const left = e.lockedUntil - Date.now();
    return left > 0 ? left : 0;
  }

  fail(ip: string): void {
    const e = this.map.get(ip) ?? { fails: 0, lockedUntil: 0, seen: 0 };
    e.seen = Date.now();
    e.fails += 1;
    if (e.fails > MAX_FREE) {
      const step = Math.min(MAX_MS, BASE_MS * 2 ** (e.fails - MAX_FREE - 1));
      e.lockedUntil = Date.now() + step;
    }
    this.map.set(ip, e);
  }

  succeed(ip: string): void {
    this.map.delete(ip);
  }
}
