// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the campaign type→fee derivation and the large-donation validation, so the
// enforcement rules (Zakat always covers the fee; the qrImage allowlist) can't regress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store';

function fresh(): Store {
  return new Store(':memory:');
}
const mk = (s: Store, over: Record<string, unknown> = {}) =>
  s.createCampaign({ title: 'Test', stripeAccountId: 'acct_test', ...over });

test('campaign type defaults to donation, fee not forced', () => {
  const c = mk(fresh());
  assert.equal(c.type, 'donation');
  assert.equal(c.forceCoverFees, false);
});

test('zakat forces cover-fees (and implies coverFees), ignoring the body flags', () => {
  const s = fresh();
  const c = mk(s, { type: 'zakat', coverFees: false, forceCoverFees: false });
  assert.equal(c.type, 'zakat');
  assert.equal(c.forceCoverFees, true, 'zakat must force the fee');
  assert.equal(c.coverFees, true, 'forcing implies offering');
  const got = s.getCampaign(c.id)!; // survives a DB round-trip
  assert.equal(got.forceCoverFees, true);
  assert.equal(got.coverFees, true);
});

test('donation never forces the fee, even if the body sets forceCoverFees', () => {
  const c = mk(fresh(), { type: 'donation', forceCoverFees: true });
  assert.equal(c.forceCoverFees, false);
});

test('tuition respects the admin forceCoverFees choice', () => {
  const s = fresh();
  const on = mk(s, { type: 'tuition', forceCoverFees: true });
  assert.equal(on.forceCoverFees, true);
  assert.equal(on.coverFees, true); // forcing implies offering
  const off = mk(s, { title: 'Test 2', type: 'tuition', forceCoverFees: false, coverFees: false });
  assert.equal(off.forceCoverFees, false);
  assert.equal(off.coverFees, false, 'a not-required tuition offers no cover-fees checkbox');
});

test('tuition with a stale coverFees=true is normalised away when not required', () => {
  const s = fresh();
  // A crafted body: not required, but coverFees left true (the leak the review caught).
  const c = mk(s, { type: 'tuition', forceCoverFees: false, coverFees: true });
  assert.equal(c.forceCoverFees, false);
  assert.equal(c.coverFees, false, 'tuition never carries a standalone optional offer');
});

test('updateCampaign re-derives fees when the type changes', () => {
  const s = fresh();
  const c = mk(s, { type: 'donation' });
  assert.equal(s.updateCampaign(c.id, { type: 'zakat' })!.forceCoverFees, true);
  assert.equal(s.updateCampaign(c.id, { type: 'donation' })!.forceCoverFees, false);
});

test('a legacy row with an empty/invalid type reads back as donation', () => {
  const s = fresh();
  const c = mk(s);
  (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db
    .prepare("UPDATE campaigns SET type='' WHERE id=?")
    .run(c.id);
  assert.equal(s.getCampaign(c.id)!.type, 'donation');
});

test('large-donation clamps the threshold, caps the message, and allowlists qrImage', () => {
  const s = fresh();
  const ld = s.setLargeDonation({ threshold: -50, message: 'x'.repeat(700), qrImage: 'javascript:alert(1)' });
  assert.equal(ld.threshold, 0, 'negative threshold clamps to 0');
  assert.equal(ld.message.length, 600, 'message capped at 600');
  assert.equal(ld.qrImage, '', 'javascript: rejected');
  assert.equal(s.setLargeDonation({ qrImage: 'data:image/png;base64,AAAA' }).qrImage, '', 'data: rejected');
  assert.equal(s.setLargeDonation({ qrImage: '/uploads/qr_1.png' }).qrImage, '/uploads/qr_1.png', 'uploads accepted');
  assert.equal(s.setLargeDonation({ threshold: 25000, qrImage: 'https://ex.org/qr.png' }).qrImage, 'https://ex.org/qr.png', 'https accepted');
  assert.equal(s.getLargeDonation().threshold, 25000);
});
