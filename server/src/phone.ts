// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Turning what an admin typed into an E.164 number, without ever guessing a country.
 *
 * WHY THIS FILE EXISTS, and it is a real bug rather than tidiness. `toWhatsAppDigits` refuses a
 * leading zero because no E.164 country code starts with one — which catches "07700900123" typed by a
 * British admin. It cannot catch the American equivalent: a bare ten-digit "3135550142" has no leading
 * zero, so it passed, and as E.164 that is +31 (the Netherlands) number 35550142. A masjid in Michigan
 * would have been sending its donation figures to a stranger in Amsterdam, and nothing anywhere would
 * have looked wrong.
 *
 * The fix is not a smarter parser — it is to stop asking a text box to carry a fact it cannot express.
 * The panel now asks for the country SEPARATELY (a dropdown) and the national number on its own, and
 * `toE164` composes the two. The country code is then something the admin chose from a list, never
 * something we inferred from digits.
 *
 * `toWhatsAppDigits` in whatsapp.ts stays exactly as it is and stays the final gate — it is pinned by
 * CLAUDE.md §13 and by tests, and this file feeds it rather than replacing it.
 */

/** A country an admin can pick, with its E.164 dial code (no `+`). */
export interface Dial {
  /** ISO-ish key, unique in this list — also what the panel stores in its dropdown state. */
  id: string;
  /** What the dropdown shows. Countries sharing a dial code are ONE entry ("US / CA"), because a
   *  dropdown that offers the user a choice with no consequence is a choice they can get wrong. */
  label: string;
  /** Digits, no plus. */
  dial: string;
  /** National significant number length(s), where they are fixed and worth checking. Empty = don't
   *  check: a wrong length refused is worse than a wrong length accepted, and most of the world has
   *  more than one. */
  lengths: readonly number[];
}

/**
 * The list the dropdown offers. Deliberately short and headed by +1.
 *
 * This app's admins are overwhelmingly North American, and a long alphabetical list with the United
 * States somewhere in the middle is how a Canadian masjid ends up filing a number under Cameroon. The
 * rest are the countries the OpenMasjid family is actually installed in or asked about; anything else
 * is served by "Other", which takes a full international number and applies no formatting at all.
 */
export const DIALS: readonly Dial[] = [
  { id: 'us', label: 'US / CA', dial: '1', lengths: [10] },
  { id: 'gb', label: 'UK', dial: '44', lengths: [] },
  { id: 'au', label: 'Australia', dial: '61', lengths: [] },
  { id: 'za', label: 'South Africa', dial: '27', lengths: [9] },
  { id: 'ae', label: 'UAE', dial: '971', lengths: [] },
  { id: 'sa', label: 'Saudi Arabia', dial: '966', lengths: [9] },
  { id: 'pk', label: 'Pakistan', dial: '92', lengths: [10] },
  { id: 'in', label: 'India', dial: '91', lengths: [10] },
  { id: 'bd', label: 'Bangladesh', dial: '880', lengths: [] },
  { id: 'my', label: 'Malaysia', dial: '60', lengths: [] },
  { id: 'ng', label: 'Nigeria', dial: '234', lengths: [10] },
  { id: 'tr', label: 'Türkiye', dial: '90', lengths: [10] },
  { id: 'eg', label: 'Egypt', dial: '20', lengths: [10] },
  { id: 'id', label: 'Indonesia', dial: '62', lengths: [] },
] as const;

/** The default the panel opens on. US/CA — see DIALS. */
export const DEFAULT_DIAL = 'us';

export function dialById(id: string): Dial | undefined {
  return DIALS.find((d) => d.id === id);
}

/** Strip everything that is not a digit. */
export function digitsOnly(v: string): string {
  return String(v ?? '').replace(/[^0-9]/g, '');
}

/**
 * Compose a country choice and a typed national number into E.164 digits, or explain the refusal.
 *
 * Refuses rather than repairs, in both directions — the same rule as `toWhatsAppDigits`, for the same
 * reason: a repaired number is a guess about whose phone it is.
 *
 * The one convenience here is deliberate and safe: if the admin typed or pasted a number that ALREADY
 * carries this country's dial code (`+1 313…`, or `1 313…` where the rest is the right length), the
 * duplicate prefix is dropped rather than doubled. Doubling it would produce a real-looking 14-digit
 * number belonging to nobody, which is the failure this whole file exists to prevent.
 */
export function toE164(dialId: string, typed: string): { digits: string } | { error: string } {
  const raw = String(typed ?? '').trim();
  if (!raw) return { error: 'Enter a phone number.' };

  // "Other" means the admin is typing a full international number themselves; we add nothing.
  if (dialId === 'other') {
    const all = digitsOnly(raw);
    if (all.startsWith('0')) {
      return { error: 'That looks like a local number. Start with the country code — for example 1 for the US and Canada.' };
    }
    if (all.length < 8 || all.length > 15) return { error: 'That doesn’t look like a full international number.' };
    return { digits: all };
  }

  const d = dialById(dialId);
  if (!d) return { error: 'Choose a country for this number.' };

  let national = digitsOnly(raw);
  // A pasted number that already includes this dial code — accept it once, never twice.
  if (national.length > d.dial.length && national.startsWith(d.dial)) {
    const without = national.slice(d.dial.length);
    // Only treat the prefix as a country code when what follows is a plausible national number.
    // Otherwise "1..." in a US box is far more likely to be the start of the number itself.
    if (d.lengths.length === 0 ? without.length >= 6 : d.lengths.includes(without.length)) national = without;
  }
  // A national trunk prefix ("0" in most of the world) is not part of the number. Dropped rather than
  // refused here, because the admin has already told us the country — which is exactly the fact that
  // makes stripping it safe, and the fact a single text box never had.
  if (national.startsWith('0')) national = national.replace(/^0+/, '');

  if (!national) return { error: 'Enter a phone number.' };
  if (d.lengths.length > 0 && !d.lengths.includes(national.length)) {
    const want = d.lengths.join(' or ');
    return { error: `A ${d.label} number should be ${want} digits after the country code — that one has ${national.length}.` };
  }
  const digits = d.dial + national;
  if (digits.length < 8 || digits.length > 15) return { error: 'That doesn’t look like a full phone number.' };
  return { digits };
}

/**
 * Split stored E.164 digits back into a country choice and a national number, for editing.
 *
 * Longest dial code first, so +1 does not claim a +971 number. An unrecognized country comes back as
 * `other` with the whole thing in the field, which is the honest answer — inventing a country here
 * would put a wrong flag beside a right number.
 */
export function fromE164(digits: string): { dialId: string; national: string } {
  const all = digitsOnly(digits);
  const byLongest = [...DIALS].sort((a, b) => b.dial.length - a.dial.length);
  for (const d of byLongest) {
    if (!all.startsWith(d.dial)) continue;
    const national = all.slice(d.dial.length);
    if (d.lengths.length > 0 && !d.lengths.includes(national.length)) continue;
    if (national.length >= 6) return { dialId: d.id, national };
  }
  return { dialId: 'other', national: all };
}

/**
 * Format a national number for display as it is typed.
 *
 * Only the North American Numbering Plan gets real grouping — `(313) 555-0142` — because it is the one
 * shape this app's admins will recognize on sight, and a wrong guess elsewhere is worse than none.
 * Everything else is grouped loosely in threes, which is readable without claiming to be canonical.
 * Display only: the stored value is always plain digits.
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

/** A stored destination rendered for the panel: `+1 (313) 555-0142`. Never used for sending. */
export function formatE164(digits: string): string {
  const { dialId, national } = fromE164(digits);
  const d = dialById(dialId);
  if (!d) return `+${digitsOnly(digits)}`;
  return `+${d.dial} ${formatNational(dialId, national)}`.trim();
}
