// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks per-campaign Stripe accounts (v0.42.0) — which BANK ACCOUNT receives a donation. Four
// properties, and each of them is the difference between money arriving where the masjid intended
// and money arriving somewhere else with nothing looking wrong:
//
//  1. THE MIGRATION RULE. An appeal that existed before this feature must charge exactly the account
//     it charged before. `payment_account` defaults to '' and there is NO backfill, so the resolver's
//     default branch is the old code path, reached by every existing row.
//  2. REFUSE, NEVER SUBSTITUTE. An explicit choice that cannot be honoured must stop the donation,
//     not quietly settle it elsewhere. The dangerous case is subtle: 'fabric:' with an empty id would
//     reach the platform as `?account=` omitted, which it answers with its FIRST account — so a Zakat
//     appeal would land in the general account and the ledger would record the general account's id.
//  3. THE NAMESPACES ARE DISJOINT. A local id always contains '_', a vault slug never can, which is
//     what makes it safe for accountById to try the local table first when re-resolving a recorded id.
//  4. THE DELETE GUARD SEES BOTH COLUMNS, and money already taken. Deleting an account a live appeal
//     is pinned to would silence that appeal; deleting one with payments against it would strand
//     every refund and leave a monthly plan nobody — admin or donor — could stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, formatPaymentAccount, parsePaymentAccount } from './store';

function fresh(): Store {
  return new Store(':memory:');
}

// ── 1 + 2. Parsing: the boundary that decides "honour", "refuse" or "site default" ──

test('accounts: an empty setting is the SITE DEFAULT — the pre-v0.42.0 behaviour every old row has', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.deepEqual(parsePaymentAccount(v), { kind: 'default' }, `${JSON.stringify(v)} must mean "site default"`);
  }
});

test('accounts: a well-formed reference parses to its source and bare id', () => {
  assert.deepEqual(parsePaymentAccount('fabric:zakat'), { kind: 'openmasjidos', id: 'zakat' });
  assert.deepEqual(parsePaymentAccount('fabric:general-fund-2'), { kind: 'openmasjidos', id: 'general-fund-2' });
  assert.deepEqual(parsePaymentAccount('local:acct_a1b2c3d4e5f6'), { kind: 'device', id: 'acct_a1b2c3d4e5f6' });
});

test('accounts: "fabric:" with no id is INVALID, never the site default', () => {
  // THE trap. An empty id would be sent to the platform as `?account=` omitted, and the platform
  // answers that with its first account — so treating this as "default" would silently re-route a
  // pinned appeal's money and record the substitute account's id in the ledger.
  for (const v of ['fabric:', 'fabric: ', 'local:', 'fabric', 'local', ':zakat', 'fabric::zakat']) {
    assert.deepEqual(parsePaymentAccount(v), { kind: 'invalid' }, `"${v}" must be invalid, not default`);
  }
});

test('accounts: a vault id must be a real slug — no uppercase, no underscore, no spaces, no labels', () => {
  // The platform matches a LABEL as well as an id, so a label would appear to work until the admin
  // renamed the account. Only ids (slugify output: lowercase, [a-z0-9-]) are accepted.
  for (const v of ['fabric:Zakat', 'fabric:my account', 'fabric:acct_x', 'fabric:-leading', 'fabric:' + 'a'.repeat(70)]) {
    assert.deepEqual(parsePaymentAccount(v), { kind: 'invalid' }, `"${v}" must be refused`);
  }
});

test('accounts: anything unrecognised is INVALID — the resolver must refuse, not fall back', () => {
  for (const v of ['garbage', 'acct_a1b2c3', 'zakat', 'https://evil.example', 'fabric:a b']) {
    assert.deepEqual(parsePaymentAccount(v), { kind: 'invalid' }, `"${v}" must be invalid`);
  }
});

test('accounts: format and parse round-trip, and the two namespaces cannot collide', () => {
  assert.equal(formatPaymentAccount('default'), '');
  assert.equal(formatPaymentAccount('openmasjidos', 'zakat'), 'fabric:zakat');
  assert.equal(formatPaymentAccount('device', 'acct_ff00'), 'local:acct_ff00');
  assert.deepEqual(parsePaymentAccount(formatPaymentAccount('openmasjidos', 'zakat')), { kind: 'openmasjidos', id: 'zakat' });
  assert.deepEqual(parsePaymentAccount(formatPaymentAccount('device', 'acct_ff00')), { kind: 'device', id: 'acct_ff00' });
  // A local id always carries an underscore; a vault slug can never contain one. That is what makes
  // accountById's local-first ordering safe.
  const local = new Store(':memory:').createStripeAccount({ label: 'Main' });
  assert.ok(local.id.includes('_'), `local ids must contain "_" (got ${local.id})`);
  assert.deepEqual(parsePaymentAccount(`fabric:${local.id}`), { kind: 'invalid' }, 'a local id can never be read as a vault slug');
});

// ── 1. The migration rule, at the storage layer ──

test('accounts: an existing campaign has NO explicit choice, so it follows the site default', () => {
  const s = fresh();
  const c = s.createCampaign({ title: 'General Fund', stripeAccountId: 'acct_legacy' });
  assert.equal(c.paymentAccount, '', 'a campaign made without a choice must have none');
  assert.equal(s.getCampaign(c.id)!.paymentAccount, '');
  assert.equal(s.getCampaign(c.id)!.stripeAccountId, 'acct_legacy', 'and its legacy binding is untouched');
});

test('accounts: a choice persists across create AND edit (the ON CONFLICT clause)', () => {
  const s = fresh();
  const c = s.createCampaign({ title: 'Zakat', stripeAccountId: 'acct_legacy', paymentAccount: 'fabric:zakat' });
  assert.equal(s.getCampaign(c.id)!.paymentAccount, 'fabric:zakat');
  // An edit that says nothing about the account must not lose it…
  s.updateCampaign(c.id, { title: 'Zakat Fund' });
  assert.equal(s.getCampaign(c.id)!.paymentAccount, 'fabric:zakat', 'an unrelated edit must not clear the choice');
  // …and one that changes it must stick (this is the ON CONFLICT DO UPDATE line).
  s.updateCampaign(c.id, { paymentAccount: 'local:acct_other' });
  assert.equal(s.getCampaign(c.id)!.paymentAccount, 'local:acct_other');
  // Back to the site default.
  s.updateCampaign(c.id, { paymentAccount: '' });
  assert.equal(s.getCampaign(c.id)!.paymentAccount, '');
});

test('accounts: changing where an appeal pays in never touches its legacy binding', () => {
  const s = fresh();
  const c = s.createCampaign({ title: 'Zakat', stripeAccountId: 'acct_legacy' });
  s.updateCampaign(c.id, { paymentAccount: 'fabric:zakat' });
  assert.equal(s.getCampaign(c.id)!.stripeAccountId, 'acct_legacy', 'the fallback the default branch reads must survive');
});

// ── 4. The delete guard ──

test('accounts: an account a campaign is PINNED to cannot be deleted', () => {
  const s = fresh();
  const a = s.createStripeAccount({ label: 'Zakat', publishableKey: 'pk_test_x', secretKey: 'sk_test_x' });
  // Pinned only through the NEW column, with the legacy one pointing elsewhere — the case the old
  // single-column guard missed entirely.
  s.createCampaign({ title: 'Zakat', stripeAccountId: 'acct_other', paymentAccount: formatPaymentAccount('device', a.id) });
  assert.equal(s.campaignsForAccount(a.id), 1);
  assert.deepEqual(s.deleteStripeAccount(a.id), { ok: false, reason: 'in-use' });
  assert.ok(s.getStripeAccount(a.id), 'and it must still be there');
});

test('accounts: the legacy column still counts as in-use', () => {
  const s = fresh();
  const a = s.createStripeAccount({ label: 'Main' });
  s.createCampaign({ title: 'General', stripeAccountId: a.id });
  assert.equal(s.campaignsForAccount(a.id), 1);
  assert.deepEqual(s.deleteStripeAccount(a.id), { ok: false, reason: 'in-use' });
});

test('accounts: an account that has TAKEN money cannot be deleted, even with no campaign left', () => {
  // Confirming, refunding and cancelling a plan all re-resolve the account from the row. Delete it
  // and those records are stranded — including a monthly plan neither side could ever stop.
  const s = fresh();
  const a = s.createStripeAccount({ label: 'Old' });
  s.createDonation({
    campaignId: 'cmp_gone', stripeAccountId: a.id, amount: 5000, currency: 'GBP', status: 'succeeded',
    donorName: '', donorEmail: '', coverFees: false, giftAid: false, paymentIntentId: 'pi_1',
  } as Parameters<Store['createDonation']>[0]);
  assert.equal(s.campaignsForAccount(a.id), 0, 'no campaign points at it any more');
  assert.equal(s.paymentsForAccount(a.id), 1);
  assert.deepEqual(s.deleteStripeAccount(a.id), { ok: false, reason: 'has-payments' });
});

test('accounts: an unused account still deletes', () => {
  const s = fresh();
  const a = s.createStripeAccount({ label: 'Spare' });
  assert.deepEqual(s.deleteStripeAccount(a.id), { ok: true });
  assert.equal(s.getStripeAccount(a.id), null);
});

// ── The known-id bound on accountById ──

test('accounts: knownAccountIds covers every id we could legitimately be asked about', () => {
  const s = fresh();
  const local = s.createStripeAccount({ label: 'Main' });
  s.createCampaign({ title: 'A', stripeAccountId: local.id });
  s.createCampaign({ title: 'B', stripeAccountId: local.id, paymentAccount: 'fabric:zakat' });
  s.createDonation({
    campaignId: 'cmp_x', stripeAccountId: 'acct_historic', amount: 100, currency: 'GBP', status: 'succeeded',
    donorName: '', donorEmail: '', coverFees: false, giftAid: false, paymentIntentId: 'pi_known',
  } as Parameters<Store['createDonation']>[0]);
  s.setFabricStripeChoice('general-fund');

  const known = s.knownAccountIds();
  assert.ok(known.has(local.id), 'a local account');
  assert.ok(known.has('zakat'), 'a vault account a campaign is pinned to — stored prefixed, known BARE');
  assert.ok(known.has('acct_historic'), 'an account money was taken on, even with no campaign left');
  assert.ok(known.has('general-fund'), 'the site default');
  // The bound is what stops the unauthenticated webhook route being used to make us fetch arbitrary
  // account names from the platform vault, and to flush the keys that keep donations alive.
  assert.ok(!known.has('anything-else'), 'and nothing else');
  assert.ok(!known.has('fabric:zakat'), 'never the prefixed form — rows record bare ids');
  assert.ok(!known.has(''), 'never the empty string');
});
