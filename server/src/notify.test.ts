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
//  1. The OS channel is on by default for every event, and WhatsApp is off for every event. The
//     first is Hasan's call and the second is not negotiable — an update must never start sending
//     WhatsApp on a masjid's behalf. The known cost of the first is volume on `donation`, which
//     fires per transaction; `minAmount` is the mitigation and lives beside it in the panel.
//  2. A 0.43.0-dev WhatsApp configuration must survive the upgrade. Those masjids typed in real
//     recipients; losing them would mean the refund notification they set up simply stops.
//  3. The WhatsApp switch is separate from the number, and a row written before that switch existed
//     reads a stored number as ON — otherwise the upgrade that added the switch would silently stop
//     the messages it was meant to make clearer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, NOTIFY_EVENTS, NOTIFY_ALERT_ID, NOTIFY_DEFAULT, type NotifyEventId } from './store';

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
  // this gets an email per donation. `minAmount` is the mitigation, which is why the donation row
  // carries that field beside its switches. If this ever needs revisiting, change the default here
  // and say so in the release note; do not let it drift.
  for (const event of NOTIFY_EVENTS) {
    assert.equal(NOTIFY_DEFAULT.events[event].os, true, `${event} should default to the channel the masjid already has`);
  }
});

test('email and WhatsApp are off by default for every event — nothing is switched on for a masjid', () => {
  for (const event of NOTIFY_EVENTS) {
    assert.equal(NOTIFY_DEFAULT.events[event].email, '', `${event} must not default to an address`);
    assert.equal(NOTIFY_DEFAULT.events[event].whatsapp, '', `${event} must not default to a WhatsApp destination`);
  }
});

test('a fresh store reads back the defaults', () => {
  const s = new Store(':memory:');
  const cfg = s.getNotify();
  assert.equal(cfg.events.donation.os, true);
  assert.equal(cfg.events.refund.os, true);
  assert.equal(cfg.events.donation.whatsappOn, false, 'WhatsApp is never switched on for a masjid');
  assert.equal(cfg.minAmount, 0);
  assert.equal(cfg.defaultEmail, '');
});

// ── Partial writes ───────────────────────────────────────────────────────────

test('one channel can be changed without restating the others', () => {
  const s = new Store(':memory:');
  s.setNotify({ events: { refund: { email: 'treasurer@masjid.org' } } });
  const cfg = s.getNotify();
  assert.equal(cfg.events.refund.email, 'treasurer@masjid.org');
  assert.equal(cfg.events.refund.os, true, 'the OS channel must be untouched');
  assert.equal(cfg.events.refund.whatsapp, '');
  assert.equal(cfg.events.donation.email, '', 'and no other event may be affected');
});

test('an unknown event id in a patch is ignored rather than stored', () => {
  const s = new Store(':memory:');
  s.setNotify({ events: { nonsense: { os: false } } as never });
  const cfg = s.getNotify();
  assert.ok(!Object.keys(cfg.events).includes('nonsense'));
  for (const e of NOTIFY_EVENTS) assert.ok(typeof cfg.events[e].os === 'boolean');
});

test('minAmount is clamped to a whole non-negative number of minor units', () => {
  const s = new Store(':memory:');
  assert.equal(s.setNotify({ minAmount: -500 }).minAmount, 0);
  assert.equal(s.setNotify({ minAmount: 1050.7 }).minAmount, 1051);
});

// ── The dev.2/dev.3 migration ────────────────────────────────────────────────

/** Write the OLD shape straight into kv, as a 0.43.0-dev.2/3 box would hold it. */
function seedOldWhatsApp(s: Store, value: unknown): void {
  // Deliberately through the same kv table the old accessor used, since the accessor itself is gone.
  (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db
    .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
    .run('whatsapp', JSON.stringify(value));
}

test('migration: a configured dev.3 box keeps its recipient on the events it had chosen', () => {
  const s = new Store(':memory:');
  seedOldWhatsApp(s, {
    enabled: true,
    numbers: ['447700900123', '447700900999'],
    groupId: '',
    events: { donation: true, refund: true, planStopped: false, paymentFailed: false, tuitionFailed: false },
    minAmount: 5000,
  });
  const cfg = s.getNotify();
  assert.equal(cfg.events.donation.whatsapp, '447700900123', 'the first number carries over');
  assert.equal(cfg.events.refund.whatsapp, '447700900123');
  assert.equal(cfg.events.planStopped.whatsapp, '', 'an event that was off stays off');
  assert.equal(cfg.minAmount, 5000, 'the minimum they chose is preserved');
  assert.equal(cfg.defaultWhatsapp, '447700900123', 'and is offered as the prefill');
  // Numbers 2..5 cannot survive a one-destination model. The release note says so and points at a
  // group, which is strictly better anyway: one message, one queue slot.
  assert.equal(cfg.events.donation.os, true, 'and the OS channel takes the same default a fresh install would');
  assert.equal(cfg.events.donation.whatsappOn, true, 'an event that WAS on must come back on, not merely keep a number');
  assert.equal(cfg.events.planStopped.whatsappOn, false);
});

test('migration: a group is carried over when there was no number', () => {
  const s = new Store(':memory:');
  seedOldWhatsApp(s, {
    enabled: true,
    numbers: [],
    groupId: '120363012345678901@g.us',
    events: { refund: true },
    minAmount: 0,
  });
  assert.equal(s.getNotify().events.refund.whatsapp, '120363012345678901@g.us');
});

test('migration: a box that had WhatsApp switched OFF gets no destinations at all', () => {
  const s = new Store(':memory:');
  seedOldWhatsApp(s, { enabled: false, numbers: ['447700900123'], events: { donation: true, refund: true } });
  const cfg = s.getNotify();
  for (const e of NOTIFY_EVENTS) assert.equal(cfg.events[e].whatsapp, '', `${e} must have no destination`);
});

test('migration: donationRecovered follows the donation choice — the same money, the same news', () => {
  const s = new Store(':memory:');
  seedOldWhatsApp(s, { enabled: true, numbers: ['447700900123'], events: { donation: true } });
  assert.equal(s.getNotify().events.donationRecovered.whatsapp, '447700900123');
});

test('migration: a CORRUPT notify value falls back to the migration rather than to defaults', () => {
  // getJson answers {} for anything that will not parse, so "the key exists" is not enough — a
  // truncated write would otherwise drop a configured masjid onto defaults AND skip the migration.
  const s = new Store(':memory:');
  seedOldWhatsApp(s, { enabled: true, numbers: ['447700900123'], events: { refund: true } });
  (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db
    .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
    .run('notify', '{"events":');
  assert.equal(s.getNotify().events.refund.whatsapp, '447700900123', 'the old settings must still be honored');
});

test('migration: once written, the new settings win and the old key is not consulted again', () => {
  const s = new Store(':memory:');
  seedOldWhatsApp(s, { enabled: true, numbers: ['447700900123'], events: { refund: true } });
  s.setNotify({ events: { refund: { whatsapp: '' } } });
  assert.equal(s.getNotify().events.refund.whatsapp, '', 'turning it off must stick');
});

test('migration: a fresh install with no old key is untouched by any of this', () => {
  const s = new Store(':memory:');
  const cfg = s.getNotify();
  assert.equal(cfg.defaultWhatsapp, '');
  for (const e of NOTIFY_EVENTS) assert.equal(cfg.events[e as NotifyEventId].whatsapp, '');
});

test('the WhatsApp switch is separate from the number, so turning it off keeps the number', () => {
  const s = new Store(':memory:');
  s.setNotify({ events: { refund: { whatsapp: '447700900123', whatsappOn: true } } });
  s.setNotify({ events: { refund: { whatsappOn: false } } });
  const c = s.getNotify().events.refund;
  assert.equal(c.whatsappOn, false, 'the channel is off');
  assert.equal(c.whatsapp, '447700900123', 'but the number they typed is still there');
});

test('a row written before the switch existed treats a stored number as ON', () => {
  // Otherwise the upgrade that ADDED the switch would silently stop a masjid's WhatsApp messages,
  // which is the worst kind of change: nothing on screen says anything happened.
  const s = new Store(':memory:');
  (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db
    .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
    .run('notify', JSON.stringify({ events: { refund: { os: true, email: '', whatsapp: '447700900123' } } }));
  assert.equal(s.getNotify().events.refund.whatsappOn, true);
});
