// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the gate that decides whether a donor gets OUR branded receipt or Stripe's plain one
// (v0.42.0, D-2026-0813-1).
//
// Going branded SUPPRESSES Stripe's own receipt, so it needs a reason to believe we can deliver
// ours. That reason used to be "a previous send succeeded" — and since the only sends that ever
// happened were ones the gate had already permitted, it was a closed loop that no fresh container
// could break. The branded receipt shipped in v0.29.0 and could never once be sent.
//
// So the property under test is deliberately the OPPOSITE of the obvious one: we attempt unless we
// hold POSITIVE evidence that email cannot work. "Never tried", a timeout, a 500 and a rate limit
// are all "we don't know", and the honest answer to not knowing is to try. Only `not_configured`
// (the platform saying so) and `no-fabric` (there is no platform) are evidence.
//
// The second half is that the evidence has to SURVIVE A RESTART, or the one donation that pays for
// discovering it pays for it again on every boot — and this app restarts itself whenever remote
// access changes in OpenMasjidOS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailLikelyAvailable, emailStatus, primeEmailStatus } from './fabric';
import { Store } from './store';

test('receipt gate: a fresh container ATTEMPTS — this is the closed loop that broke v0.29.0', () => {
  // 'unknown' is where every container starts. Demanding a prior success here is what made the
  // branded receipt unsendable for three weeks: nothing could send, so nothing could ever prove
  // sending worked.
  primeEmailStatus('unknown'); // not a decisive value — ignored, leaving whatever we had
  assert.equal(emailLikelyAvailable(), true, 'a fresh container must be willing to try');
});

test('receipt gate: only the platform SAYING SO counts as evidence against', () => {
  for (const decisive of ['not_configured', 'no-fabric']) {
    primeEmailStatus(decisive);
    assert.equal(emailStatus(), decisive);
    assert.equal(emailLikelyAvailable(), false, `${decisive} is real evidence — fall back to Stripe's receipt`);
  }
});

test('receipt gate: “we don’t know” is not evidence — a blip must not switch receipts off', () => {
  // A timeout, an HTTP 500 or a rate limit says nothing about whether email is set up. Treating
  // any of them as "unavailable" would silently downgrade every donation after one bad minute.
  for (const inconclusive of ['error', 'rate_limited', 'ok']) {
    primeEmailStatus(inconclusive);
    assert.equal(emailLikelyAvailable(), true, `${inconclusive} must not stop us trying`);
  }
});

test('receipt gate: junk from the data volume is ignored rather than trusted', () => {
  primeEmailStatus('ok');
  for (const junk of ['', 'unknown', 'yes', 'OK', 'not-configured', '{"a":1}']) {
    primeEmailStatus(junk);
    assert.equal(emailStatus(), 'ok', `"${junk}" must not become the status`);
  }
});

test('receipt gate: the status round-trips through the store, so a restart remembers', () => {
  // Without persistence the negative is relearned on every boot, and relearning it costs a donor
  // their receipt each time (we suppress Stripe's, ours fails, THEN we find out).
  const s = new Store(':memory:');
  assert.equal(s.getEmailStatus(), '', 'nothing known before the first send');

  s.setEmailStatus('not_configured');
  assert.equal(s.getEmailStatus(), 'not_configured');

  // A new process reading that value must reach the same decision the old one did.
  primeEmailStatus(s.getEmailStatus());
  assert.equal(emailLikelyAvailable(), false, 'the negative must survive the restart');

  // …and be forgotten the moment email starts working.
  s.setEmailStatus('ok');
  primeEmailStatus(s.getEmailStatus());
  assert.equal(emailLikelyAvailable(), true);
});
