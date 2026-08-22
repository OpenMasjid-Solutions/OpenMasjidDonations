// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Phone-number PRESENTATION for the admin panel. No validation lives here, on purpose.
 *
 * The country list and every refusal come from the server (`server/src/phone.ts`, sent in the
 * notifications view and applied on save), and the panel sends the country choice and the national
 * number as two separate fields. So there is exactly ONE implementation of "is this a real number and
 * whose country is it" and it is the one that guards the send — rather than two that must agree, which
 * is the arrangement where the copy drifts and the tests keep passing anyway.
 *
 * What is here is what the browser genuinely has to do locally: group digits as they are typed, so the
 * field reads like a phone number instead of a serial number.
 */

/** One entry in the country dropdown, as the server sends it. */
export interface Dial {
  id: string;
  label: string;
  dial: string;
  lengths: number[];
}

export function digitsOnly(v: string): string {
  return String(v ?? '').replace(/[^0-9]/g, '');
}

/**
 * Group a national number for display as it is typed.
 *
 * Only the North American Numbering Plan gets real grouping — `(313) 555-0142` — because it is the one
 * shape this app's admins will recognize on sight, and a confident wrong guess elsewhere reads worse
 * than no grouping. Everything else is spaced in threes: readable, and not claiming to be canonical.
 *
 * Display only. The value sent to the server is always plain digits.
 */
export function formatNational(dialId: string, national: string): string {
  const n = digitsOnly(national);
  if (dialId === 'us') {
    if (n.length <= 3) return n;
    if (n.length <= 6) return `(${n.slice(0, 3)}) ${n.slice(3)}`;
    return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6, 10)}`;
  }
  // Groups of three, except that a trailing SINGLE digit is merged into the group before it —
  // "770 090 012 3" reads like something went wrong, where "770 090 0123" reads like a phone number.
  const parts = n.match(/\d{1,3}/g) ?? [];
  if (parts.length > 1 && parts[parts.length - 1].length === 1) parts[parts.length - 2] += parts.pop();
  return parts.join(' ');
}

/** How many digits the field should stop accepting at, so a typo cannot run past the end. */
export function maxNational(d: Dial | undefined): number {
  if (!d) return 15;
  return d.lengths.length > 0 ? Math.max(...d.lengths) : 14;
}

/**
 * Split a stored E.164 number back into a country and a national part, for editing.
 *
 * Longest dial code first, so `+1` cannot claim a `+971` number. Anything unrecognized comes back as
 * `other` with the digits intact — the honest answer, where inventing a country would show a wrong
 * flag beside a right number.
 */
export function fromE164(digits: string, dials: Dial[]): { dialId: string; national: string } {
  const all = digitsOnly(digits);
  for (const d of [...dials].sort((a, b) => b.dial.length - a.dial.length)) {
    if (!all.startsWith(d.dial)) continue;
    const national = all.slice(d.dial.length);
    if (d.lengths.length > 0 && !d.lengths.includes(national.length)) continue;
    if (national.length >= 6) return { dialId: d.id, national };
  }
  return { dialId: 'other', national: all };
}

/** A stored destination rendered for a table cell: `+1 (313) 555-0142`. */
export function formatE164(digits: string, dials: Dial[]): string {
  const { dialId, national } = fromE164(digits, dials);
  const d = dials.find((x) => x.id === dialId);
  if (!d) return `+${digitsOnly(digits)}`;
  return `+${d.dial} ${formatNational(dialId, national)}`.trim();
}
