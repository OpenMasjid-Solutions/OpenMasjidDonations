// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Has this admin read the release notes for the version they're running?
 *
 *  OpenMasjidOS updates an app in the background, so nothing otherwise tells a masjid that the
 *  panel changed under them — "What's new" is a menu item nobody has a reason to press. This tracks
 *  the newest version whose notes have been opened, per browser, and is used ONLY to put a quiet dot
 *  on the account button. It never gates anything, so storage being unavailable is harmless.
 *
 *  Mirrors OpenMasjid Kiosk's. Deliberately free of any import of `changelog.ts`: this runs on the
 *  donation page too, and the notes themselves must stay a lazy chunk (see changelog.ts). */
import { useEffect, useState } from 'react';

const SEEN_KEY = 'omdon.whatsnew.seen';
const SEEN_EVENT = 'omdon:whatsnew-seen';

function readSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return ''; // private mode / storage disabled — the dot simply never settles
  }
}

function writeSeen(v: string): void {
  try {
    localStorage.setItem(SEEN_KEY, v);
  } catch {
    /* best-effort */
  }
}

/** Is version `a` newer than version `b`? Compared NUMERICALLY, segment by segment: "0.9.9" is older
 *  than "0.9.34", and a string compare gets that exactly backwards — which is how a "there's
 *  something new" dot ends up lying to a masjid. */
export function versionNewer(a: string, b: string): boolean {
  const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** Record that the notes for `version` have been read, and tell every listener in this tab. */
export function markReleaseSeen(version: string): void {
  if (!version) return;
  writeSeen(version);
  window.dispatchEvent(new Event(SEEN_EVENT));
}

/** True when the running build is newer than the notes last opened in this browser. */
export function useUnreadRelease(version: string | undefined): boolean {
  const [seen, setSeen] = useState(readSeen);

  useEffect(() => {
    // The dialog itself marks the notes read; another tab may have got there first.
    const onSeen = () => setSeen(readSeen());
    window.addEventListener(SEEN_EVENT, onSeen);
    window.addEventListener('storage', onSeen);
    return () => {
      window.removeEventListener(SEEN_EVENT, onSeen);
      window.removeEventListener('storage', onSeen);
    };
  }, []);

  if (!version) return false;
  // A fresh install has nothing to catch up on, so day one is not "new": record it and stay quiet.
  // (Writing during render is safe here — same value every time, and no state is set.)
  if (!seen) {
    writeSeen(version);
    return false;
  }
  return versionNewer(version, seen);
}
