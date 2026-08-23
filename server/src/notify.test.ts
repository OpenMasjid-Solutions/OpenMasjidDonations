// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the per-event notification settings (v0.43.0) and the one contract that spans three files.
//
// THE CONTRACT: every event in NOTIFY_EVENTS needs an alert id in NOTIFY_ALERT_ID, and every one of
// those ids must be declared in `manifest.yaml`. The platform **400s an alert id it was not told
// about**, so a rename that misses one file turns a notification into a silent failure — the app
// looks fine, the admin's switch says on, and nothing ever arrives. Reading the manifest here is the
// only way that fails loudly instead.
//
// THE OTHER THREE PROPERTIES:
//  1. The OS channel is on by default for every event; a new EMAIL address starts on the alerts that
//     cost money or hide a problem; a new WHATSAPP row starts on nothing at all. The first is Hasan's
//     call and the third is not negotiable — an update must never start sending from a masjid's own
//     number on their behalf. The known cost of the first is volume on `donation`, which fires per
//     transaction; the mitigation used to be a `minAmount` floor and is now simply that `donation` is
//     one tick per person, which a new address does not get by default.
//  2. A configuration from either older shape must survive the upgrade — the v0.43.0 per-event blob
//     (one address and one number per event) and the 0.43.0-dev `whatsapp` key before it. Those
//     masjids typed in real recipients; losing them would mean the refund notification they set up
//     simply stops arriving, with nothing on screen to say so.
//  3. A recipient's event list is filtered against NOTIFY_EVENTS on read, so a row left behind by a
//     downgrade can never widen what it receives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, NOTIFY_EVENTS, NOTIFY_ALERT_ID, NOTIFY_DEFAULT, NEW_EMAIL_EVENTS, NOTIFY_EVENT_LABEL, type NotifyEventId } from './store';

const MANIFEST = path.join(__dirname, '..', '..', 'manifest.yaml');

/** The `alerts:` ids the manifest declares. Parsed rather than duplicated, so the test cannot drift
 *  from the file the platform actually reads. */
function declaredAlertIds(): string[] {
  const src = fs.readFileSync(MANIFEST, 'utf8');
  const start = src.indexOf('\nalerts:');
  assert.ok(start > 0, 'manifest.yaml must declare an alerts: block');
  // Up to the next top-level key (a line starting with a letter), so a later block can't leak in.
  const rest = src.slice(start + 1);
  const endMatch = /\n(?=[A-Za-z])/.exec(rest.slice('alerts:'.length));
  const block = endMatch ? rest.slice(0, 'alerts:'.length + endMatch.index) : rest;
  return [...block.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

// ── The three-file contract ──────────────────────────────────────────────────

test('every notification event has an alert id, and the manifest declares it', () => {
  const declared = declaredAlertIds();
  for (const event of NOTIFY_EVENTS) {
    const id = NOTIFY_ALERT_ID[event];
    assert.ok(id, `event "${event}" has no alert id`);
    assert.ok(
      declared.includes(id),
      `manifest.yaml does not declare "${id}" (for event "${event}") — the platform will 400 it and the notification will silently never arrive. Declared: ${declared.join(', ')}`,
    );
  }
});

test('the alert ids are distinct — two events sharing one would be indistinguishable to the admin', () => {
  const ids = NOTIFY_EVENTS.map((e) => NOTIFY_ALERT_ID[e]);
  assert.equal(new Set(ids).size, ids.length, `duplicate alert id in NOTIFY_ALERT_ID: ${ids.join(', ')}`);
});

test('the manifest ids are kebab-case, as the platform requires', () => {
  for (const id of declaredAlertIds()) {
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `"${id}" is not kebab-case`);
  }
});

// ── Defaults ─────────────────────────────────────────────────────────────────

test('the OS channel is on by default for EVERY event', () => {
  // Hasan's call, made after the volume risk was put to him: `donation` fires per transaction, and
  // the platform defaults a newly-declared alert to email+webhook ON — so a masjid updating into
  // this gets an email per donation. The `minAmount` floor that used to mitigate that was removed in
  // v0.44.0, also on his instruction; what carries it now is that `donation` is a per-recipient tick
  // and a new address does not start on it. If this default ever needs revisiting, change it here and
  // say so in the release note; do not let it drift.
  for (const event of NOTIFY_EVENTS) {
    assert.equal(NOTIFY_DEFAULT.events[event].os, true, `${event} should default to the channel the masjid already has`);
  }
});
test('a new WhatsApp row starts on NOTHING, and there are no recipients at all by default', () => {
  // Not a matter of taste (CLAUDE.md §13). WhatsApp sends from the MASJID's own number, shared with
  // every other app on the box and unrecoverable if it is banned — so an update must never begin
  // sending on their behalf. The email list is empty for a duller reason: we cannot guess who.
  assert.deepEqual(NOTIFY_DEFAULT.emails, [], 'no address may be configured for a masjid');
  assert.deepEqual(NOTIFY_DEFAULT.whatsapps, [], 'no number may be configured for a masjid');
});

test('a brand-new email address does NOT start on the per-donation event', () => {
  // `donation` fires on every transaction. An address that started on it would bury a treasurer who
  // only wanted to hear about refunds, and would spend the shared email budget — the one the refund
  // notice has no outbox to survive — on good news.
  assert.ok(!NEW_EMAIL_EVENTS.includes('donation'), 'the per-transaction event must be opt-IN');
  for (const e of NEW_EMAIL_EVENTS) assert.ok((NOTIFY_EVENTS as readonly string[]).includes(e), `${e} is not a real event`);
  assert.ok(NEW_EMAIL_EVENTS.includes('refund'), 'money going back out is worth hearing about unprompted');
  assert.ok(NEW_EMAIL_EVENTS.includes('paymentFailed'), 'so is nobody being able to give at all');
});

test('a fresh store reads back the defaults', () => {
  const s = new Store(':memory:');
  const cfg = s.getNotify();
  assert.equal(cfg.events.donation.os, true);
  assert.equal(cfg.events.refund.os, true);
  assert.deepEqual(cfg.emails, []);
  assert.deepEqual(cfg.whatsapps, []);
});

// ── Partial writes ───────────────────────────────────────────────────────────

test('one platform switch can be changed without restating the others', () => {
  const s = new Store(':memory:');
  s.setNotify({ events: { refund: { os: false } } });
  const cfg = s.getNotify();
  assert.equal(cfg.events.refund.os, false);
  assert.equal(cfg.events.donation.os, true, 'no other event may be affected');
});

test('an unknown event id in a patch is ignored rather than stored', () => {
  const s = new Store(':memory:');
  s.setNotify({ events: { nonsense: { os: false } } as never });
  const cfg = s.getNotify();
  assert.ok(!Object.keys(cfg.events).includes('nonsense'));
  for (const e of NOTIFY_EVENTS) assert.ok(typeof cfg.events[e].os === 'boolean');
});

// ── Recipients ───────────────────────────────────────────────────────────────

test('a recipient is added with the events it was given, and gets a stable id', () => {
  const s = new Store(':memory:');
  const cfg = s.upsertNotifyRecipient('emails', { address: 'treasurer@masjid.org', label: 'Treasurer', events: ['refund'] });
  assert.equal(cfg.emails.length, 1);
  assert.equal(cfg.emails[0].address, 'treasurer@masjid.org');
  assert.equal(cfg.emails[0].label, 'Treasurer');
  assert.deepEqual(cfg.emails[0].events, ['refund']);
  assert.ok(cfg.emails[0].id, 'a row without an id could never be edited or deleted');
});

test('adding the SAME address twice edits that row instead of doubling every message', () => {
  const s = new Store(':memory:');
  s.upsertNotifyRecipient('emails', { address: 'office@masjid.org', events: ['refund'] });
  const cfg = s.upsertNotifyRecipient('emails', { address: 'office@masjid.org', events: ['refund', 'planStopped'] });
  assert.equal(cfg.emails.length, 1, 'two rows with one address would be sent everything twice');
  assert.deepEqual(cfg.emails[0].events, ['refund', 'planStopped']);
});

test('an existing row is edited by ID, so re-typing the label cannot move the ticks', () => {
  const s = new Store(':memory:');
  const id = s.upsertNotifyRecipient('emails', { address: 'a@masjid.org', events: ['refund'] }).emails[0].id;
  const cfg = s.upsertNotifyRecipient('emails', { id, address: 'a@masjid.org', label: 'Accounts', events: ['refund'] });
  assert.equal(cfg.emails.length, 1);
  assert.equal(cfg.emails[0].id, id, 'the id must survive an edit');
  assert.equal(cfg.emails[0].label, 'Accounts');
});

test('an unknown event id on a recipient is filtered on READ, so a downgraded row cannot widen', () => {
  // A row written by a NEWER build (or hand-edited) must never end up subscribed to something this
  // build does not understand — the platform would 400 it, and the admin would see a tick that means
  // nothing. Order is normalized to NOTIFY_EVENTS too, so the panel and the row always agree.
  const s = new Store(':memory:');
  seedNotify(s, { emails: [{ id: 'em_1', address: 'a@masjid.org', label: '', events: ['refund', 'somethingNew', 'donation'] }] });
  assert.deepEqual(s.getNotify().emails[0].events, ['donation', 'refund']);
});

test('a stored row with no id or no address is dropped rather than repaired', () => {
  const s = new Store(':memory:');
  seedNotify(s, {
    emails: [
      { id: '', address: 'a@masjid.org', events: [] },
      { id: 'em_2', address: '', events: [] },
      { id: 'em_3', address: 'good@masjid.org', events: [] },
    ],
  });
  const rows = s.getNotify().emails;
  assert.equal(rows.length, 1, 'something we cannot address is not a recipient');
  assert.equal(rows[0].address, 'good@masjid.org');
});

test('the recipient list is bounded — a list is a blast radius, not a storage question', () => {
  const s = new Store(':memory:');
  let cfg = s.getNotify();
  for (let i = 0; i < 40; i += 1) cfg = s.upsertNotifyRecipient('whatsapps', { address: `1313555${String(1000 + i)}`, events: [] });
  assert.ok(cfg.whatsapps.length <= 25, `expected a cap, got ${cfg.whatsapps.length}`);
});

test('removing a recipient takes its WhatsApp health lines with it', () => {
  // Otherwise a number the admin deleted leaves its last refusal on the screen attached to nothing.
  const s = new Store(':memory:');
  const id = s.upsertNotifyRecipient('whatsapps', { address: '13135550142', events: ['refund'] }).whatsapps[0].id;
  s.setWhatsAppOutcome(`${id}|refund`, { state: 'refused', reason: 'that group is not approved', at: '2026-08-21T12:00:00Z' });
  assert.ok(s.getWhatsAppOutcomes()[`${id}|refund`], 'precondition: the outcome was recorded');
  s.removeNotifyRecipient('whatsapps', id);
  assert.equal(s.getWhatsAppOutcomes()[`${id}|refund`], undefined);
});

test('outcomes are keyed per RECIPIENT, so one number’s refusal is not shown against another', () => {
  // This is why the key stopped being the event alone in v0.44.0: with two destinations on one event,
  // the second refusal used to overwrite the first and the panel blamed both.
  const s = new Store(':memory:');
  let cfg = s.upsertNotifyRecipient('whatsapps', { address: '13135550142', events: ['refund'] });
  const a = cfg.whatsapps[0].id;
  cfg = s.upsertNotifyRecipient('whatsapps', { address: '13135550143', events: ['refund'] });
  const b = cfg.whatsapps.find((r) => r.id !== a)!.id;
  s.setWhatsAppOutcome(`${a}|refund`, { state: 'queued', reason: '', at: '2026-08-21T12:00:00Z' });
  s.setWhatsAppOutcome(`${b}|refund`, { state: 'refused', reason: 'needs a country code', at: '2026-08-21T12:01:00Z' });
  const all = s.getWhatsAppOutcomes();
  assert.equal(all[`${a}|refund`].state, 'queued', 'the first number was fine and must still look fine');
  assert.equal(all[`${b}|refund`].state, 'refused');
});

// ── The v0.43.0 → v0.44.0 migration (per-event → lists) ──────────────────────

test('migration: one address typed against three events becomes ONE row on three events', () => {
  // Three identical rows would each be sent the same message, tripling what a masjid gets from an
  // upgrade they never asked for.
  const s = new Store(':memory:');
  seedNotify(s, {
    events: {
      donation: { os: true, email: 'treasurer@masjid.org', whatsapp: '', whatsappOn: false },
      refund: { os: true, email: 'treasurer@masjid.org', whatsapp: '', whatsappOn: false },
      planStopped: { os: true, email: 'treasurer@masjid.org', whatsapp: '', whatsappOn: false },
    },
  });
  const cfg = s.getNotify();
  assert.equal(cfg.emails.length, 1, 'the same address must not become three subscribers');
  assert.equal(cfg.emails[0].address, 'treasurer@masjid.org');
  assert.deepEqual(cfg.emails[0].events, ['donation', 'refund', 'planStopped']);
});

test('migration: a number stored with the switch OFF is dropped, not carried over unticked', () => {
  // It would otherwise reappear as a configured destination the admin does not remember, attached to
  // the masjid's own phone number.
  const s = new Store(':memory:');
  seedNotify(s, {
    events: {
      refund: { os: true, email: '', whatsapp: '447700900123', whatsappOn: false },
      donation: { os: true, email: '', whatsapp: '13135550142', whatsappOn: true },
    },
  });
  const cfg = s.getNotify();
  assert.equal(cfg.whatsapps.length, 1);
  assert.equal(cfg.whatsapps[0].address, '13135550142');
  assert.deepEqual(cfg.whatsapps[0].events, ['donation']);
});

test('migration: the platform switches are carried across unchanged', () => {
  const s = new Store(':memory:');
  seedNotify(s, { events: { refund: { os: false, email: '', whatsapp: '', whatsappOn: false } } });
  const cfg = s.getNotify();
  assert.equal(cfg.events.refund.os, false, 'an admin who turned this off must stay turned off');
  assert.equal(cfg.events.donation.os, true, 'and an event the old blob said nothing about takes the default');
});

// ── The dev.2/dev.3 migration (the `whatsapp` key), still two generations back ─

/** Write the OLD shape straight into kv, as a 0.43.0-dev.2/3 box would hold it. */
function seedOldWhatsApp(s: Store, value: unknown): void {
  // Deliberately through the same kv table the old accessor used, since the accessor itself is gone.
  (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db
    .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
    .run('whatsapp', JSON.stringify(value));
}

/** Write a `notify` blob straight into kv — used for both the v0.43.0 shape and malformed rows. */
function seedNotify(s: Store, value: unknown): void {
  (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db
    .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
    .run('notify', JSON.stringify(value));
}

test('migration: a configured dev.3 box keeps its number on the events it had chosen', () => {
  const s = new Store(':memory:');
  seedOldWhatsApp(s, {
    enabled: true,
    numbers: ['447700900123', '447700900999'],
    groupId: '',
    events: { donation: true, refund: true, planStopped: false, paymentFailed: false, tuitionFailed: false },
    minAmount: 5000,
  });
  const cfg = s.getNotify();
  assert.equal(cfg.whatsapps.length, 1, 'the first number carries over as one row');
  assert.equal(cfg.whatsapps[0].address, '447700900123');
  // `donationRecovered` follows the `donation` choice — the same money, the same news. The order is
  // NOTIFY_EVENTS order, not the order they were written: normalizing on read is what keeps a stored
  // row and the panel's columns from ever disagreeing about which tick means what.
  assert.deepEqual(cfg.whatsapps[0].events, ['donation', 'donationRecovered', 'refund']);
  assert.equal(cfg.events.donation.os, true, 'the OS channel takes the same default a fresh install would');
  // Numbers 2..5 cannot survive a one-destination model, and the v0.43.0 release note said so. A
  // masjid on this path can now simply add the second number back.
});

test('migration: a group is carried over when there was no number', () => {
  const s = new Store(':memory:');
  seedOldWhatsApp(s, { enabled: true, numbers: [], groupId: '120363012345678901@g.us', events: { refund: true }, minAmount: 0 });
  const cfg = s.getNotify();
  assert.equal(cfg.whatsapps[0].address, '120363012345678901@g.us');
  assert.deepEqual(cfg.whatsapps[0].events, ['refund']);
});

test('migration: a box that had WhatsApp switched OFF gets no destinations at all', () => {
  const s = new Store(':memory:');
  seedOldWhatsApp(s, { enabled: false, numbers: ['447700900123'], events: { donation: true, refund: true } });
  assert.deepEqual(s.getNotify().whatsapps, []);
});

test('migration: a CORRUPT notify value falls back to the migration rather than to defaults', () => {
  // getJson answers {} for anything that will not parse, so "the key exists" is not enough — a
  // truncated write would otherwise drop a configured masjid onto defaults AND skip the migration.
  // DO NOT "simplify" this away; it is the reason a half-written file does not lose recipients.
  const s = new Store(':memory:');
  seedOldWhatsApp(s, { enabled: true, numbers: ['447700900123'], events: { refund: true } });
  (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db
    .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
    .run('notify', '{"events":');
  assert.equal(s.getNotify().whatsapps[0]?.address, '447700900123', 'the old settings must still be honored');
});

test('migration: once written, the new settings win and the old key is not consulted again', () => {
  const s = new Store(':memory:');
  seedOldWhatsApp(s, { enabled: true, numbers: ['447700900123'], events: { refund: true } });
  const id = s.getNotify().whatsapps[0].id;
  s.removeNotifyRecipient('whatsapps', id);
  assert.deepEqual(s.getNotify().whatsapps, [], 'removing it must stick');
});

test('migration: a fresh install with no old key is untouched by any of this', () => {
  const s = new Store(':memory:');
  const cfg = s.getNotify();
  assert.deepEqual(cfg.whatsapps, []);
  assert.deepEqual(cfg.emails, []);
  for (const e of NOTIFY_EVENTS) assert.equal(cfg.events[e as NotifyEventId].os, true);
});
// ── Bursts: an event that fires per EXTERNAL failure must gate itself ────────
//
// Kiosk found this the hard way and it applies here: `paymentFailed` fires once per PaymentIntent
// Stripe refuses, so one expired key on a Friday is one message per person who tried to give. The
// platform's 60-second per-recipient cooldown used to absorb that, and platform 0.51.1 removed it.
//
// `burst` in index.ts is the gate. It is reproduced here rather than imported because index.ts
// starts a server on import; what is asserted is the CONTRACT the real one has to keep, and the
// shapes are identical line for line. The property that matters is the SECOND one: a gate that
// drops the 2nd to the 200th silently leaves an admin unable to tell one unlucky donor from
// everybody, which are very different Fridays.

function makeBurst(nowRef: { t: number }) {
  const seen = new Map<string, { at: number; skipped: number }>();
  return (key: string, everyMs: number): { allow: boolean; skipped: number } => {
    const now = nowRef.t;
    const w = seen.get(key);
    if (w && now - w.at < everyMs) {
      w.skipped += 1;
      return { allow: false, skipped: w.skipped };
    }
    const skipped = w?.skipped ?? 0;
    seen.set(key, { at: now, skipped: 0 });
    return { allow: true, skipped };
  };
}

const HOUR = 3600_000;

test('burst: the first failure goes out, and the flood behind it does not', () => {
  const now = { t: 0 };
  const burst = makeBurst(now);
  assert.equal(burst('paymentFailed', HOUR).allow, true, 'the masjid must hear about it at once');
  for (let i = 0; i < 200; i++) assert.equal(burst('paymentFailed', HOUR).allow, false);
});

test('burst: what it swallowed is COUNTED and reported on the next message through', () => {
  const now = { t: 0 };
  const burst = makeBurst(now);
  burst('paymentFailed', HOUR); // the one that got through
  for (let i = 0; i < 41; i++) burst('paymentFailed', HOUR);
  now.t += HOUR + 1;
  const next = burst('paymentFailed', HOUR);
  assert.equal(next.allow, true);
  assert.equal(next.skipped, 41, 'an hour of "one donor or everybody?" has to be answerable');
});

test('burst: separate keys are separate — a tuition outage must not mute a donation one', () => {
  const now = { t: 0 };
  const burst = makeBurst(now);
  assert.equal(burst('paymentFailed:donation', HOUR).allow, true);
  assert.equal(burst('paymentFailed:tuition', HOUR).allow, true, 'a different failure is different news');
  assert.equal(burst('paymentFailed:donation', HOUR).allow, false);
});

test('burst: the counter resets after a message gets through, so counts never compound', () => {
  const now = { t: 0 };
  const burst = makeBurst(now);
  burst('x', HOUR);
  burst('x', HOUR);
  now.t += HOUR + 1;
  assert.equal(burst('x', HOUR).skipped, 1);
  now.t += HOUR + 1;
  assert.equal(burst('x', HOUR).skipped, 0, 'the second window had nothing held back');
});

test('the "and N more" sentence is only there when there were more', () => {
  // Mirrors alsoHeld() in index.ts.
  const alsoHeld = (n: number) => (n > 0 ? ` This has happened ${n} more time${n === 1 ? '' : 's'} since the last message.` : '');
  assert.equal(alsoHeld(0), '');
  assert.match(alsoHeld(1), /1 more time since/);
  assert.match(alsoHeld(41), /41 more times since/);
});

// ── WhatsApp gap windows (platform 0.52.0) ───────────────────────────────────
//
// The platform can now report periods when a masjid's WhatsApp link had silently expired: messages
// were accepted, reported `sent`, and never delivered. It cannot resend them (it deletes a message's
// contents on handover, deliberately), so it tells each app and each app decides.
//
// THIS APP DOES NOT RESEND — every WhatsApp message it sends is an admin notice about something
// already in the ledger, no donor is ever messaged, and `paymentFailed`/`tuitionFailed` are already
// self-healing. So the whole behaviour under test is "report each window exactly once".

test('a gap window is news exactly once, however often the platform re-reports it', () => {
  // The platform returns a window on EVERY poll while it is inside its retention, and this job runs
  // hourly — so without this, one expired link is one alarm per hour for a day.
  const s = new Store(':memory:');
  const w = { from: 1755900000000, to: 1755911000000, count: 9 };
  assert.equal(s.addWhatsAppGap(w), true, 'the first sighting is news');
  assert.equal(s.addWhatsAppGap(w), false, 'the second is not');
  assert.equal(s.getWhatsAppGaps().length, 1);
});

test('a genuinely different window IS a second alarm', () => {
  const s = new Store(':memory:');
  s.addWhatsAppGap({ from: 1755900000000, to: 1755911000000, count: 9 });
  assert.equal(s.addWhatsAppGap({ from: 1755990000000, to: 1755999000000, count: 2 }), true);
  const all = s.getWhatsAppGaps();
  assert.equal(all.length, 2);
  assert.equal(all[0].from, 1755990000000, 'newest first, so the panel leads with the recent one');
});

test('gaps are bounded and malformed rows are dropped rather than rendered', () => {
  // This drives a sentence shown to a masjid; "0 messages between 1970 and 1970" must be impossible.
  const s = new Store(':memory:');
  for (let i = 0; i < 30; i += 1) s.addWhatsAppGap({ from: 1_700_000_000_000 + i * 1000, to: 1_700_000_000_500 + i * 1000, count: 1 });
  assert.ok(s.getWhatsAppGaps().length <= 20, 'bounded');
  (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db
    .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
    .run('whatsapp_gaps', JSON.stringify([{ from: 0, to: 0, count: 5 }, { from: 5, to: 1, count: 1 }, 'nonsense', null]));
  assert.deepEqual(s.getWhatsAppGaps(), [], 'a window with no real bounds is not a window');
});

test('the gap event is a declared alert, like every other event', () => {
  // Covered by the contract test at the top of this file too, but named here so a future rename that
  // misses the manifest fails against the thing it broke rather than against a generic loop.
  assert.equal(NOTIFY_ALERT_ID.whatsappGap, 'whatsapp-gap');
  assert.ok(declaredAlertIds().includes('whatsapp-gap'), 'the platform 400s an id it was not told about');
});

test('a new email address hears about a gap, and a new WhatsApp row still does not', () => {
  // A gap is news about the notification channel itself, so it belongs with the alerts that hide a
  // problem. It must NOT make WhatsApp default to on — that rule has no exceptions (§13), and this is
  // the tempting one, since a gap is a WhatsApp fact.
  assert.ok(NEW_EMAIL_EVENTS.includes('whatsappGap'), 'an address should hear that its channel broke');
  assert.deepEqual(NOTIFY_DEFAULT.whatsapps, [], 'and no number is ever configured for a masjid');
});

// ── Reconciling reported ids back to our own notifications (0.51.1-dev.13) ───
//
// The platform now reports the message ids that fell in a gap, which is what we asked for. It turns
// "9 messages" into "at least one of them was the refund notice" — the difference between an admin
// shrugging and an admin checking. It is PARTIAL by construction and every test here says so.

/** Queue-time record: a message we sent, with the id the platform gave us back. */
function seedSent(s: Store, recipientId: string, event: string, msgId: string): void {
  s.setWhatsAppOutcome(`${recipientId}|${event}`, { state: 'sent', reason: '', at: '2026-08-23T12:00:00Z', msgId });
}

test('a reported id is mapped back to the notification it was', () => {
  const s = new Store(':memory:');
  const id = s.upsertNotifyRecipient('whatsapps', { address: '13135550142', events: ['refund', 'donation'] }).whatsapps[0].id;
  seedSent(s, id, 'refund', 'msg-aaa');
  seedSent(s, id, 'donation', 'msg-bbb');
  assert.deepEqual(s.eventsForMessageIds(['msg-aaa']), ['refund']);
  assert.deepEqual(s.eventsForMessageIds(['msg-bbb']), ['donation']);
});

test('several ids collapse to the distinct notifications they were', () => {
  const s = new Store(':memory:');
  let cfg = s.upsertNotifyRecipient('whatsapps', { address: '13135550142', events: ['refund'] });
  const a = cfg.whatsapps[0].id;
  cfg = s.upsertNotifyRecipient('whatsapps', { address: '13135550143', events: ['refund'] });
  const b = cfg.whatsapps.find((r) => r.id !== a)!.id;
  seedSent(s, a, 'refund', 'msg-1');
  seedSent(s, b, 'refund', 'msg-2');
  // Two people, same event: the admin needs the EVENT, and naming who was written to adds nothing.
  assert.deepEqual(s.eventsForMessageIds(['msg-1', 'msg-2']), ['refund']);
});

test('the result is ordered by NOTIFY_EVENTS, so the sentence reads the same every time', () => {
  const s = new Store(':memory:');
  const id = s.upsertNotifyRecipient('whatsapps', { address: '13135550142', events: [] }).whatsapps[0].id;
  seedSent(s, id, 'tuitionFailed', 'm-t');
  seedSent(s, id, 'donation', 'm-d');
  seedSent(s, id, 'refund', 'm-r');
  assert.deepEqual(s.eventsForMessageIds(['m-t', 'm-r', 'm-d']), ['donation', 'refund', 'tuitionFailed']);
});

test('an id we never saw matches nothing, and does not throw', () => {
  const s = new Store(':memory:');
  assert.deepEqual(s.eventsForMessageIds(['who-knows']), []);
  assert.deepEqual(s.eventsForMessageIds([]), []);
});

test('a record with no id cannot be matched, which is why the wording says "at least"', () => {
  // We keep the newest outcome per recipient+event, not a message log. A three-hour window holding
  // forty donation notices leaves us one id to match — so the platform's `count` stays the number we
  // quote, and this only ever ADDS detail to it.
  const s = new Store(':memory:');
  const id = s.upsertNotifyRecipient('whatsapps', { address: '13135550142', events: ['refund'] }).whatsapps[0].id;
  s.setWhatsAppOutcome(`${id}|refund`, { state: 'sent', reason: '', at: '2026-08-23T12:00:00Z' }); // pre-0.44.0 shape
  assert.deepEqual(s.eventsForMessageIds(['msg-aaa']), []);
});

test('the newest outcome overwrites the older id for the same recipient and event', () => {
  // Documenting the known limit rather than pretending it away: the second message's id is what
  // survives, so the first is unmatchable. This is the reason for "there may have been others".
  const s = new Store(':memory:');
  const id = s.upsertNotifyRecipient('whatsapps', { address: '13135550142', events: ['donation'] }).whatsapps[0].id;
  seedSent(s, id, 'donation', 'msg-first');
  seedSent(s, id, 'donation', 'msg-second');
  assert.deepEqual(s.eventsForMessageIds(['msg-second']), ['donation']);
  assert.deepEqual(s.eventsForMessageIds(['msg-first']), [], 'the earlier one is gone, by design');
});

test('a gap stores the cause, the truncation and the events it could name', () => {
  const s = new Store(':memory:');
  assert.equal(
    s.addWhatsAppGap({ from: 1755900000000, to: 1755911000000, count: 9, cause: 'session-expired', truncated: true, events: ['refund'] }),
    true,
  );
  const g = s.getWhatsAppGaps()[0];
  assert.equal(g.cause, 'session-expired');
  assert.equal(g.truncated, true);
  assert.deepEqual(g.events, ['refund']);
  assert.equal(g.count, 9, 'the platform’s count is what we quote, not the number we matched');
});

test('a gap read back drops an event id this build does not know', () => {
  const s = new Store(':memory:');
  (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db
    .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
    .run('whatsapp_gaps', JSON.stringify([{ from: 1, to: 2, count: 1, cause: 'unknown', truncated: false, events: ['refund', 'fromTheFuture'], at: '' }]));
  assert.deepEqual(s.getWhatsAppGaps()[0].events, ['refund']);
});

test('a seven-day window re-reported every hour is still one alarm', () => {
  // Platform 0.51.1-dev.13 retains a window for 7 days after the outage ends, so an hourly poll sees
  // the SAME immutable window about 168 times. Every one of those must be silent.
  const s = new Store(':memory:');
  const w = { from: 1755900000000, to: 1755911000000, count: 9, cause: 'session-expired' };
  assert.equal(s.addWhatsAppGap(w), true);
  for (let i = 0; i < 168; i += 1) assert.equal(s.addWhatsAppGap(w), false, `poll ${i + 2} must be silent`);
  assert.equal(s.getWhatsAppGaps().length, 1);
});

test('DEFENSIVE: a revised count could never become a second alarm', () => {
  // The platform snapshots a window at detection and never revises it, so this cannot currently
  // happen — an earlier version of this test asserted a GROWING count as though it were expected
  // platform behaviour, which was wrong and is corrected here rather than deleted. Keeping the count
  // out of the dedupe key costs nothing and means a future platform that did revise a figure could not
  // turn that into a second message to the masjid.
  const s = new Store(':memory:');
  assert.equal(s.addWhatsAppGap({ from: 1755900000000, to: 1755911000000, count: 9, cause: 'session-expired' }), true);
  assert.equal(s.addWhatsAppGap({ from: 1755900000000, to: 1755911000000, count: 11, cause: 'session-expired' }), false);
  assert.equal(s.addWhatsAppGap({ from: 1755900000000, to: 1755911000000, count: 9, cause: 'key-rejected' }), false, 'nor a revised cause');
  assert.equal(s.getWhatsAppGaps()[0].count, 9, 'and the first snapshot is what we keep quoting');
});

test('every event has a label, so the gap sentence can always name what was missed', () => {
  // The gap notification composes its own sentence server-side and sends it by email, so a new event
  // added without a label would print `undefined` to a masjid.
  for (const e of NOTIFY_EVENTS) {
    const label = NOTIFY_EVENT_LABEL[e];
    assert.ok(label, `${e} has no label`);
    // They are joined into "…were about: X; Y." — so each must be a noun phrase, not a sentence.
    // Deliberately NOT asserting a lowercase first letter: "WhatsApp messages going missing" is a
    // proper noun and reads correctly mid-sentence exactly as it is.
    assert.ok(!label.endsWith('.'), `${e}'s label should not be a full sentence`);
    assert.ok(label.split(/\s+/).join(' ') === label, `${e}'s label must be a single clean line`);
  }
});
