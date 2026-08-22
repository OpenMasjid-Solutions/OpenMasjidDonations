// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the country-code handling added in v0.44.0, and the bug it exists to fix.
//
// THE BUG: `toWhatsAppDigits` refuses a leading zero, because no E.164 country code starts with one —
// which catches "07700900123" typed by a British admin. It cannot catch the American equivalent. A
// bare ten-digit "3135550142" has no leading zero, so it passed, and read as E.164 that is +31 (the
// Netherlands) number 35550142. A masjid in Michigan would have been sending its donation figures to
// a stranger in Amsterdam, and nothing anywhere would have looked wrong.
//
// THE FIX is not a smarter parser — it is that the panel now asks for the country separately, so the
// dial code is something the admin CHOSE rather than something we inferred. These tests pin that the
// composition is exact, that a duplicated country code is never doubled, and that a number we cannot
// place is refused rather than repaired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIALS, DEFAULT_DIAL, toE164, fromE164, formatNational, formatE164, dialById, digitsOnly } from './phone';
import { toWhatsAppDigits } from './whatsapp';

const ok = (r: { digits: string } | { error: string }): string => {
  assert.ok('digits' in r, `expected digits, got error: ${'error' in r ? r.error : '?'}`);
  return r.digits;
};
const err = (r: { digits: string } | { error: string }): string => {
  assert.ok('error' in r, `expected an error, got ${'digits' in r ? r.digits : '?'}`);
  return r.error;
};

// ── The bug this file exists for ─────────────────────────────────────────────

test('THE BUG: a bare US ten-digit number used to pass as a Dutch number', () => {
  // Kept as a regression witness. `toWhatsAppDigits` still accepts it — it is pinned by §13 and is
  // the final gate, not the country resolver — which is precisely why nothing may reach it without a
  // country having been chosen first.
  assert.equal(toWhatsAppDigits('3135550142'), '3135550142', 'the old gate still cannot tell');
  assert.equal(fromE164('3135550142').dialId, 'other', 'and we no longer pretend to know whose it is');
  // Through the new path, the same keystrokes produce the right number.
  assert.equal(ok(toE164('us', '3135550142')), '13135550142');
});

test('the US dial code is prepended exactly once, however the admin typed it', () => {
  assert.equal(ok(toE164('us', '3135550142')), '13135550142', 'plain national');
  assert.equal(ok(toE164('us', '13135550142')), '13135550142', 'already carrying the country code');
  assert.equal(ok(toE164('us', '+1 (313) 555-0142')), '13135550142', 'pasted, formatted');
  assert.equal(ok(toE164('us', '(313) 555-0142')), '13135550142', 'formatted, no code');
  assert.equal(ok(toE164('us', '1-313-555-0142')), '13135550142', 'hyphenated with the code');
});

test('a doubled country code would be a real-looking number belonging to nobody', () => {
  // The failure mode: "1" + "13135550142" = 113135550142, twelve digits, no leading zero, accepted by
  // every length check there is — and addressed to nobody at all.
  assert.notEqual(ok(toE164('us', '13135550142')), '113135550142');
});

// ── Composition per country ──────────────────────────────────────────────────

test('every country in the list composes to a plausible E.164 number', () => {
  for (const d of DIALS) {
    const national = d.lengths.length > 0 ? '5'.repeat(d.lengths[0]) : '5'.repeat(9);
    const digits = ok(toE164(d.id, national));
    assert.ok(digits.startsWith(d.dial), `${d.id}: ${digits} should start with ${d.dial}`);
    assert.ok(digits.length >= 8 && digits.length <= 15, `${d.id}: ${digits} is not an E.164 length`);
    assert.ok(toWhatsAppDigits(digits), `${d.id}: ${digits} must survive the real gate`);
  }
});

test('the default country is one that exists, and it is +1', () => {
  const d = dialById(DEFAULT_DIAL);
  assert.ok(d, 'the default must be in the list');
  assert.equal(d.dial, '1', 'this app’s admins are overwhelmingly North American');
});

test('countries sharing a dial code are ONE entry, and no dial code repeats', () => {
  // A dropdown offering a choice with no consequence is a choice somebody can get wrong.
  const dials = DIALS.map((d) => d.dial);
  assert.equal(new Set(dials).size, dials.length, `a dial code appears twice: ${dials.join(', ')}`);
  const ids = DIALS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate country id');
  assert.ok(DIALS.some((d) => d.label.includes('/')), 'US / CA should be one combined entry');
});

// ── Refusals: refuse, never repair ───────────────────────────────────────────

test('a national trunk zero is stripped, because the country is already known', () => {
  // Safe here and NOT safe in a single text box: it is the explicit country choice that makes this a
  // correction rather than a guess.
  assert.equal(ok(toE164('gb', '07700900123')), '447700900123');
  assert.equal(ok(toE164('gb', '7700900123')), '447700900123');
});

test('a wrong-length number for a fixed-length country is refused with the reason', () => {
  const m = err(toE164('us', '31355501'));
  assert.match(m, /10 digits/, 'the sentence must say what was expected');
  assert.match(m, /8/, 'and what it got');
});

test('an empty number is refused rather than becoming the bare country code', () => {
  err(toE164('us', ''));
  err(toE164('us', '   '));
  err(toE164('gb', '0'));
});

test('an unknown country id is refused rather than defaulted', () => {
  // Defaulting would attach a wrong country to a right number, which is the whole bug again.
  assert.match(err(toE164('atlantis', '3135550142')), /country/i);
});

test('"other" takes a full international number and adds nothing', () => {
  assert.equal(ok(toE164('other', '+971 50 123 4567')), '971501234567');
  assert.match(err(toE164('other', '07700900123')), /country code/, 'a local number has no country to infer');
  err(toE164('other', '12345'));
  err(toE164('other', '1234567890123456'));
});

// ── Round-tripping, for editing an existing row ──────────────────────────────

test('a stored number splits back into the country the admin picked', () => {
  for (const [dialId, national] of [['us', '3135550142'], ['gb', '7700900123'], ['pk', '3001234567']] as const) {
    const digits = ok(toE164(dialId, national));
    assert.deepEqual(fromE164(digits), { dialId, national }, `${dialId} must round-trip`);
  }
});

test('the longest dial code wins, so +1 cannot claim a +971 number', () => {
  const uae = ok(toE164('ae', '501234567'));
  assert.equal(fromE164(uae).dialId, 'ae');
});

test('a number we cannot place comes back as "other" with its digits intact', () => {
  // The honest answer. Inventing a country would show a wrong flag beside a right number.
  const r = fromE164('99912345678');
  assert.equal(r.dialId, 'other');
  assert.equal(r.national, '99912345678');
});

// ── Display only ─────────────────────────────────────────────────────────────

test('US numbers format as they are typed, and never lose a digit', () => {
  assert.equal(formatNational('us', '3'), '3');
  assert.equal(formatNational('us', '313'), '313');
  assert.equal(formatNational('us', '3135'), '(313) 5');
  assert.equal(formatNational('us', '313555'), '(313) 555');
  assert.equal(formatNational('us', '3135550142'), '(313) 555-0142');
  // The invariant that matters: formatting is reversible, so nothing is ever silently dropped.
  for (const n of ['3', '31', '313', '3135', '31355', '313555', '3135550', '3135550142']) {
    assert.equal(digitsOnly(formatNational('us', n)), n, `formatting lost a digit at ${n.length}`);
  }
});

test('a country without a fixed shape is grouped loosely rather than wrongly', () => {
  assert.equal(digitsOnly(formatNational('gb', '7700900123')), '7700900123');
  assert.ok(formatNational('gb', '7700900123').includes(' '), 'still readable');
  assert.ok(!formatNational('gb', '7700900123').includes('('), 'but not pretending to be NANP');
});

test('a stored destination renders with its country for the panel', () => {
  assert.equal(formatE164('13135550142'), '+1 (313) 555-0142');
  assert.equal(formatE164('447700900123'), '+44 770 090 0123');
});
