// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the WhatsApp admin-command surface (manifest `commands:`, platform v0.51.0+).
//
// Three things are worth a test here, and they are not the formatting:
//
//  1. WHO IS ALLOWED TO ASK. `/fabric/commands/run` sits outside every `/api` guard and has no
//     cookie — the two headers ARE the authentication. Both must be checked, the secret in constant
//     time, and `omos:platform` must be exact: it is the one caller id no app can present, because
//     the colon is outside the charset app ids are validated against.
//  2. THE FOLLOW-UP CAN END WITHOUT US. Three minutes idle, twelve turns, "cancel", or a new `!`
//     command, and the answers simply stop arriving with no notification. So the token carries a
//     step and an attempt and NOTHING that a later turn must have — nothing here is half-applied
//     while waiting for a reply that may never come. (Every command is read-only, which is the
//     stronger version of the same guarantee.)
//  3. NO DONOR IS EVER NAMED. A WhatsApp message is forwardable and screenshottable, and the donor
//     never agreed to be in one. Every reply is aggregate.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// commands.ts reads `config` at import time, and a static `import` is HOISTED above these
// assignments — so the module must be pulled in dynamically, after the env is in place. (The same
// trap studentsFabric.test.ts documents; getting it wrong makes every auth test fail as a
// false negative, which reads exactly like a broken check.)
process.env.OPENMASJID_APP_SECRET = 'the-real-secret';
process.env.OPENMASJID_BASE_URL = 'https://os.test';

type Commands = typeof import('./commands');
let c: Commands;
before(async () => { c = await import('./commands'); });

/** $ from pence, so the assertions read like the message a masjid gets. */
const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const hdr = (secret: string, caller = 'omos:platform') => ({
  'x-openmasjid-app-secret': secret,
  'x-openmasjid-caller-app': caller,
});

// ── 1. Who may ask ───────────────────────────────────────────────────────────

test('auth: the platform, with both headers correct, is let in', () => {
  assert.equal(c.isPlatformCall(hdr('the-real-secret')), true);
});

test('auth: a wrong or missing secret is refused', () => {
  for (const bad of ['', 'nope', 'the-real-secre', 'the-real-secrett', 'THE-REAL-SECRET']) {
    assert.equal(c.isPlatformCall(hdr(bad)), false, `"${bad}" must not pass`);
  }
  assert.equal(c.isPlatformCall({ 'x-openmasjid-caller-app': 'omos:platform' }), false, 'no secret at all');
});

test('auth: the RIGHT secret with the wrong caller is still refused', () => {
  // The whole point of the second header. Another app that somehow learned our secret must not be
  // able to reach this handler through the app-to-app broker — a different trust boundary that
  // happens to share the /fabric prefix.
  for (const caller of ['students', 'omos', 'platform', 'omos:platform ', ' omos:platform', 'OMOS:PLATFORM', '']) {
    assert.equal(c.isPlatformCall(hdr('the-real-secret', caller)), false, `caller "${caller}" must not pass`);
  }
  assert.equal(c.isPlatformCall({ 'x-openmasjid-app-secret': 'the-real-secret' }), false, 'no caller header at all');
});

test('auth: a non-string header is refused rather than coerced', () => {
  assert.equal(c.isPlatformCall({ 'x-openmasjid-app-secret': ['the-real-secret'], 'x-openmasjid-caller-app': 'omos:platform' }), false);
});

// ── 2. The follow-up token ───────────────────────────────────────────────────

test('token: fits the platform’s charset and length, since it is echoed into a later request', () => {
  for (let i = 1; i <= 9; i++) {
    const t = c.pickToken(i);
    assert.match(t, /^[A-Za-z0-9._:-]{1,128}$/, `${t} must satisfy the platform's validator`);
  }
});

test('token: the attempt round-trips, and anything else reads as "not ours"', () => {
  assert.equal(c.pickAttempt(c.pickToken(1)), 1);
  assert.equal(c.pickAttempt(c.pickToken(2)), 2);
  // A token from another flow, a hand-made one, or none at all — all mean "no attempt so far",
  // which starts the count again rather than throwing.
  for (const junk of [undefined, '', 'appeal:pick', 'appeal:pick:0', 'sched-881', 'appeal:pick:x', 'appeal:pick:99', 'a'.repeat(129)]) {
    assert.equal(c.pickAttempt(junk), 0, `${JSON.stringify(junk)}`);
  }
});

test('token: the attempt is clamped, so a bug cannot produce an invalid token', () => {
  assert.equal(c.pickToken(0), 'appeal:pick:1');
  assert.equal(c.pickToken(-5), 'appeal:pick:1');
  assert.equal(c.pickToken(50), 'appeal:pick:9');
});

// ── 3. Choosing an appeal ────────────────────────────────────────────────────

const APPEALS = [
  { id: 'cmp_1', title: 'General Fund' },
  { id: 'cmp_2', title: 'Zakat' },
  { id: 'cmp_3', title: 'Ramadan Appeal 2026' },
];

test('choose: a menu number is 1-based, because that is what the message showed', () => {
  assert.equal(c.chooseAppeal('1', APPEALS)?.id, 'cmp_1');
  assert.equal(c.chooseAppeal('3', APPEALS)?.id, 'cmp_3');
  assert.equal(c.chooseAppeal(' 2 ', APPEALS)?.id, 'cmp_2');
});

test('choose: a number off the end is a miss, not the nearest appeal', () => {
  for (const n of ['0', '4', '99']) assert.equal(c.chooseAppeal(n, APPEALS), null, n);
});

test('choose: a name match is generous, because people type on phones', () => {
  assert.equal(c.chooseAppeal('zakat', APPEALS)?.id, 'cmp_2');
  assert.equal(c.chooseAppeal('ZAKAT', APPEALS)?.id, 'cmp_2');
  assert.equal(c.chooseAppeal('ramadan', APPEALS)?.id, 'cmp_3');
  assert.equal(c.chooseAppeal('  General Fund  ', APPEALS)?.id, 'cmp_1');
});

test('choose: an AMBIGUOUS name is refused rather than guessed', () => {
  // Reporting the wrong appeal's total, confidently, is worse than asking again.
  const two = [{ id: 'a', title: 'Building Fund' }, { id: 'b', title: 'Building Fund Phase 2' }];
  assert.equal(c.chooseAppeal('building', two), null, 'two matches must be a miss');
  assert.equal(c.chooseAppeal('Building Fund', two)?.id, 'a', 'but an exact title still wins');
});

test('choose: nothing sensible is a miss', () => {
  for (const junk of ['', '   ', 'nonsense', '!!!']) assert.equal(c.chooseAppeal(junk, APPEALS), null, junk);
  assert.equal(c.chooseAppeal('1', []), null, 'no appeals at all');
});

// ── 4. The replies ───────────────────────────────────────────────────────────

test('today: reads as a sentence, and says so plainly when nothing has come in', () => {
  assert.equal(
    c.replyToday({ todayMinor: 31200, todayCount: 9, monthMinor: 128050, monthCount: 41 }, money),
    'Today: $312.00 from 9 donations.\nThis month: $1280.50 from 41 donations.',
  );
  assert.match(c.replyToday({ todayMinor: 0, todayCount: 0, monthMinor: 5000, monthCount: 1 }, money), /^Nothing has come in today yet\./);
});

test('today: one donation is singular', () => {
  assert.match(c.replyToday({ todayMinor: 5000, todayCount: 1, monthMinor: 5000, monthCount: 1 }, money), /1 donation\./);
});

test('month: compares against ALL of last month, and says that', () => {
  // A half-finished month against a finished one is not a like-for-like, so the wording has to
  // carry the qualifier or the comparison is alarming and wrong.
  const t = c.replyMonth({ monthMinor: 40000, monthCount: 12, lastMonthMinor: 100000, monthLabel: 'August', lastMonthLabel: 'July' }, money);
  assert.match(t, /\$600\.00 less than all of July/);
  const up = c.replyMonth({ monthMinor: 150000, monthCount: 30, lastMonthMinor: 100000, monthLabel: 'August', lastMonthLabel: 'July' }, money);
  assert.match(up, /\$500\.00 more than all of July/);
});

test('month: a first month has nothing to compare with, and does not pretend otherwise', () => {
  assert.match(
    c.replyMonth({ monthMinor: 40000, monthCount: 12, lastMonthMinor: 0, monthLabel: 'August', lastMonthLabel: 'July' }, money),
    /Nothing came in during July\./,
  );
});

test('totals: an empty ledger says so instead of printing zeroes', () => {
  assert.equal(c.replyTotals({ totalMinor: 0, count: 0, averageMinor: 0, refundedMinor: 0, liveAppeals: 2 }, money), 'No donations have been recorded yet.');
});

test('totals: refunds are mentioned only when there are some — and explained', () => {
  const none = c.replyTotals({ totalMinor: 500000, count: 100, averageMinor: 5000, refundedMinor: 0, liveAppeals: 3 }, money);
  assert.ok(!/refund/i.test(none), 'no refunds, no line about refunds');
  const some = c.replyTotals({ totalMinor: 500000, count: 100, averageMinor: 5000, refundedMinor: 2500, liveAppeals: 3 }, money);
  assert.match(some, /\$25\.00 has been refunded \(already taken off the total above\)/);
});

test('appeal: a goal becomes a percentage and a remainder', () => {
  const t = c.replyAppeal({ title: 'Ramadan Appeal', raisedMinor: 250000, count: 40, goalMinor: 1000000, active: true }, money);
  assert.match(t, /^Ramadan Appeal: \$2500\.00 from 40 donations\./);
  assert.match(t, /25% of the \$10000\.00 goal — \$7500\.00 to go/);
});

test('appeal: a met goal is celebrated, not reported as "-$12 to go"', () => {
  const t = c.replyAppeal({ title: 'Roof', raisedMinor: 1200000, count: 90, goalMinor: 1000000, active: true }, money);
  assert.match(t, /goal has been reached/);
  assert.ok(!/to go/.test(t));
});

test('appeal: no goal means no progress line at all', () => {
  const t = c.replyAppeal({ title: 'General Fund', raisedMinor: 250000, count: 40, goalMinor: 0, active: true }, money);
  assert.ok(!/goal/.test(t));
});

test('appeal: a hidden appeal says so — otherwise a flat total looks like a bug', () => {
  assert.match(c.replyAppeal({ title: 'Old', raisedMinor: 100, count: 1, goalMinor: 0, active: false }, money), /hidden from the donation site/);
});

test('appeal menu: numbered, and the re-ask apologizes rather than repeating itself', () => {
  const first = c.replyAppealMenu(APPEALS, false);
  assert.match(first, /^Which appeal\?\n1\. General Fund\n2\. Zakat\n3\. Ramadan Appeal 2026/);
  assert.match(first, /Reply with a number, or part of the name\./);
  assert.match(c.replyAppealMenu(APPEALS, true), /didn’t recognize that one/);
});

test('monthly: nobody yet is a sentence, not a row of zeroes', () => {
  assert.equal(c.replyMonthly({ donors: 0, perMonthMinor: 0, thisMonthMinor: 0 }, money), 'Nobody has set up a monthly donation yet.');
});

test('monthly: says what they give and what has arrived this month', () => {
  const t = c.replyMonthly({ donors: 12, perMonthMinor: 24000, thisMonthMinor: 18000 }, money);
  assert.match(t, /12 monthly donors, giving about \$240\.00 a month\./);
  assert.match(t, /\$180\.00 of this month’s donations came from them\./);
});

// ── 5. The promise that spans every reply ────────────────────────────────────

test('PRIVACY: no reply can name a donor, because no reply is given one', () => {
  // The formatters take counts and totals — there is no parameter anywhere in this surface that
  // could carry a donor's name, email or reference. This test exists to make that structural fact
  // fail loudly if a future change adds one.
  const all = [
    c.replyToday({ todayMinor: 1, todayCount: 1, monthMinor: 1, monthCount: 1 }, money),
    c.replyMonth({ monthMinor: 1, monthCount: 1, lastMonthMinor: 1, monthLabel: 'August', lastMonthLabel: 'July' }, money),
    c.replyTotals({ totalMinor: 1, count: 1, averageMinor: 1, refundedMinor: 1, liveAppeals: 1 }, money),
    c.replyAppeal({ title: 'Zakat', raisedMinor: 1, count: 1, goalMinor: 2, active: true }, money),
    c.replyMonthly({ donors: 1, perMonthMinor: 1, thisMonthMinor: 1 }, money),
    c.replyAppealMenu(APPEALS, false),
  ];
  for (const t of all) {
    assert.ok(!/@/.test(t), `no email address may appear: ${t}`);
    assert.ok(t.length <= 1000, 'the platform caps a reply at 1000 characters');
    // No control characters: the platform strips them, and a reply must not try to look like
    // several messages.
    assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t), 'no control characters');
  }
});

// ── 6. A masjid with more appeals than fit in one message ────────────────────
//
// The menu is capped so one WhatsApp message stays readable. The list SEARCHED must not be, or the
// thirteenth appeal is unreachable by every route at once: not by number (never printed) and not by
// name either (not in the list being matched). That is a silent, permanent "no" to a fair question.

const MANY = Array.from({ length: 15 }, (_, i) => ({ id: `cmp_${i + 1}`, title: `Appeal ${i + 1}` }));
const MENU = MANY.slice(0, 12);

test('choose: a name finds an appeal that did not fit in the menu', () => {
  assert.equal(c.chooseAppeal('Appeal 15', MENU, MANY)?.id, 'cmp_15');
  assert.equal(c.chooseAppeal('appeal 13', MENU, MANY)?.id, 'cmp_13');
});

test('choose: a NUMBER only ever means a line of the menu that was shown', () => {
  // 13 was never printed, so it cannot mean the thirteenth appeal — reading it that way would
  // report a total for something the sender was never offered.
  assert.equal(c.chooseAppeal('13', MENU, MANY), null);
  assert.equal(c.chooseAppeal('12', MENU, MANY)?.id, 'cmp_12');
});

test('choose: one list still behaves exactly as it did', () => {
  assert.equal(c.chooseAppeal('2', APPEALS)?.id, 'cmp_2');
  assert.equal(c.chooseAppeal('zakat', APPEALS)?.id, 'cmp_2');
});

test('appeal menu: says how many did not fit, so none of them look lost', () => {
  const t = c.replyAppealMenu(MENU, false, MANY.length - MENU.length);
  assert.match(t, /12\. Appeal 12/);
  assert.match(t, /…and 3 more/);
  assert.ok(!/13\. /.test(t), 'a capped menu must not number past its own end');
  assert.ok(!/more/.test(c.replyAppealMenu(APPEALS, false, 0)), 'nothing extra when they all fit');
});

// ── 7. Monthly donors: a plan that stopped is not a current donor ────────────

test('monthly: a dormant plan is explained, not silently missing from the figure', () => {
  const t = c.replyMonthly({ donors: 4, perMonthMinor: 8000, thisMonthMinor: 8000, dormant: 6 }, money);
  assert.match(t, /4 monthly donors, giving about \$80\.00 a month\./);
  assert.match(t, /6 other plans/);
  assert.ok(!/10 monthly donors/.test(t), 'a stopped plan must never be counted as a current donor');
});

test('monthly: all of them dormant reads as nobody giving NOW, not as nobody ever', () => {
  const t = c.replyMonthly({ donors: 0, perMonthMinor: 0, thisMonthMinor: 0, dormant: 3 }, money);
  assert.match(t, /Nobody is giving monthly at the moment/);
  assert.match(t, /3 plans used to/);
  // And a genuinely fresh masjid still gets the simple sentence.
  assert.equal(c.replyMonthly({ donors: 0, perMonthMinor: 0, thisMonthMinor: 0 }, money), 'Nobody has set up a monthly donation yet.');
});
