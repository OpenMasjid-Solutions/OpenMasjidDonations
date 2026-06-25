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
}

const MAX_FREE = 5; // attempts before backoff kicks in
const BASE_MS = 2000; // first lockout step
const MAX_MS = 5 * 60 * 1000; // cap a single lockout at 5 minutes

export class LoginLimiter {
  private readonly map = new Map<string, Entry>();

  constructor() {
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [k, e] of this.map) if (e.lockedUntil < now - 3_600_000 && e.fails === 0) this.map.delete(k);
    }, 10 * 60 * 1000);
    sweep.unref?.();
  }

  /** ms the caller must wait before another attempt (0 = allowed now). */
  retryAfterMs(ip: string): number {
    const e = this.map.get(ip);
    if (!e) return 0;
    const left = e.lockedUntil - Date.now();
    return left > 0 ? left : 0;
  }

  fail(ip: string): void {
    const e = this.map.get(ip) ?? { fails: 0, lockedUntil: 0 };
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
