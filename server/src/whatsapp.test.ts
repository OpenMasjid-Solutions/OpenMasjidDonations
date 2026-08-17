// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the Fabric WhatsApp WIRE contract as this app speaks it (platform v0.51.0+, OpenMasjidOS
// docs/WHATSAPP.md + packages/core/src/api/fabric.ts).
//
// This file exists because three details were wrong in the brief this feature was built from, and
// every one of them fails SILENTLY — the app would look fine and simply never message anybody:
//
//   1. GET /api/fabric/whatsapp/groups returns `{ groups: [...] }`, NOT a bare array. Parsing it as
//      an array yields no groups, so the picker is empty and the admin concludes none are approved.
//   2. `reason` is always a word, never null — it is `"ready"` when available. Testing for a null
//      reason as "available" gets it exactly backwards.
//   3. `media` ABSENT means no. An older platform omits it, and reading absence as yes means
//      base64-ing half a megabyte into a request that was never going to work.
//
// It also pins the two rules the channel itself imposes: a success is 202 `{queued:true}` and is
// never reported as delivered, and a number without a country code is REFUSED rather than repaired.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// whatsapp.ts reads `config` at import time, so the Fabric env must be set BEFORE it loads.
process.env.OPENMASJID_BASE_URL = 'https://os.test';
process.env.OPENMASJID_APP_SECRET = 'our-app-secret';

type WA = typeof import('./whatsapp');
let wa: WA;

interface Call { url: string; method: string; secret: string; body: Record<string, unknown> }
let calls: Call[] = [];
let queued: { status: number; payload: unknown }[] = [];
const realFetch = globalThis.fetch;

const reply = (payload: unknown, status = 200): void => { queued.push({ status, payload }); };

before(async () => {
  globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      secret: init?.headers?.['x-openmasjid-app-secret'] ?? '',
      body: JSON.parse(init?.body ?? '{}') as Record<string, unknown>,
    });
    const n = queued.shift() ?? { status: 200, payload: {} };
    return {
      ok: n.status >= 200 && n.status < 300,
      status: n.status,
      json: async () => n.payload,
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  wa = await import('./whatsapp');
});

beforeEach(() => { calls = []; queued = []; });
after(() => { globalThis.fetch = realFetch; });

// ── 1. A number is never repaired ────────────────────────────────────────────

test('a number without a country code is REFUSED, never guessed at', () => {
  // The whole point. "07700900123" is a real number in the UK and a different real number
  // elsewhere; prefixing our guess would send a masjid's donation figures to a stranger.
  //
  // Note "07700900123" specifically: it is ELEVEN digits, so the length floor alone lets it through
  // — the platform's own `toDigits` accepts it and would address it as `07700900123@c.us`. A leading
  // zero is a national trunk prefix and never a country code (no E.164 country code starts with 0),
  // and catching it here is what makes the "include the country code" error honest rather than
  // aspirational. Found by probing the live route, not by reading the code.
  for (const bad of ['07700', '5550123', '', '   ', 'abc', '+44', '07700900123', '00447700900123']) {
    assert.equal(wa.toWhatsAppDigits(bad), null, `"${bad}" must be refused`);
  }
});

test('a full international number is reduced to digits, however it was typed', () => {
  for (const good of ['447700900123', '+447700900123', '+44 7700 900123', '(44) 7700-900123']) {
    assert.equal(wa.toWhatsAppDigits(good), '447700900123', `"${good}"`);
  }
});

test('a number longer than E.164 allows is refused', () => {
  assert.equal(wa.toWhatsAppDigits('1'.repeat(15)), '1'.repeat(15), '15 digits is the maximum, and allowed');
  assert.equal(wa.toWhatsAppDigits('1'.repeat(16)), null, '16 is not a phone number');
});

test('a group id is shape-checked, and a person can never be mistaken for one', () => {
  assert.ok(wa.looksLikeGroupId('120363012345678901@g.us'));
  assert.ok(wa.looksLikeGroupId('120363012345678901-1234567890@g.us'), 'legacy id with a creation suffix');
  for (const bad of ['447700900123@c.us', '447700900123', '@g.us', 'x@g.us', '120363012345678901@lid', '']) {
    assert.equal(wa.looksLikeGroupId(bad), false, `"${bad}" must not pass as a group`);
  }
});

// ── 2. The availability probe ────────────────────────────────────────────────

test('availability: reason is a WORD, never null — "ready" is what available looks like', async () => {
  reply({ available: true, reason: 'ready', media: true, maxMediaBytes: 2097152 });
  const s = await wa.whatsappStatus(true);
  assert.equal(s.available, true);
  assert.equal(s.reason, 'ready');
  assert.equal(s.media, true);
  assert.equal(s.maxMediaBytes, 2097152);
  assert.equal(calls[0].secret, 'our-app-secret', 'the per-app secret must be presented');
  assert.match(calls[0].url, /\/api\/fabric\/whatsapp$/);
});

test('availability: each not-ready reason is carried through, because each has its own fix', async () => {
  for (const reason of ['not-configured', 'not-linked', 'unreachable'] as const) {
    reply({ available: false, reason });
    const s = await wa.whatsappStatus(true);
    assert.equal(s.available, false);
    assert.equal(s.reason, reason, 'the reason must survive — the panel says a different sentence for each');
    assert.notEqual(wa.whatsappUnavailableMessage(reason), '', 'and each must have a sentence');
  }
  // Four different situations, four different people to go and talk to.
  const said = new Set(['not-configured', 'not-linked', 'unreachable', 'not-allowed'].map((r) => wa.whatsappUnavailableMessage(r as never)));
  assert.equal(said.size, 4, 'the sentences must not collapse into one another');
});

test('availability: `media` ABSENT means no', async () => {
  // An older platform omits the field. Reading absence as "yes" means rendering a poster and
  // base64-ing it into a request that cannot work.
  reply({ available: true, reason: 'ready' });
  const s = await wa.whatsappStatus(true);
  assert.equal(s.media, false, 'absent must not be read as permitted');
  assert.equal(s.maxMediaBytes, 0);
});

test('availability: a 200 is not by itself a yes', async () => {
  // A 200 carrying reason 'not-linked' is a no, and so is a 200 with no reason at all.
  reply({ available: true, reason: 'not-linked' });
  assert.equal((await wa.whatsappStatus(true)).available, false, 'the reason wins over a stale `available`');
  reply({});
  assert.equal((await wa.whatsappStatus(true)).available, false, 'an empty body is not permission');
});

test('availability: a 403 is "not allowed", not an outage', async () => {
  reply({ available: false, reason: 'not-allowed' }, 403);
  const s = await wa.whatsappStatus(true);
  assert.equal(s.available, false);
  assert.equal(s.reason, 'not-allowed');
});

test('availability: an unreachable platform never throws, and never overwrites what we knew', async () => {
  // Establish a known-good cached answer first…
  reply({ available: true, reason: 'ready', media: true, maxMediaBytes: 1 });
  assert.equal((await wa.whatsappStatus(true)).available, true);

  // …then take the platform away. The probe must report the outage to ITS caller…
  const boom = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof globalThis.fetch;
  const s = await wa.whatsappStatus(true);
  assert.equal(s.available, false);
  assert.equal(s.reason, 'unreachable');
  globalThis.fetch = boom;

  // …without writing that outage into the cache, or one dropped packet would hide the feature
  // from the admin for a full minute. A cached read still sees the good answer, and makes no call.
  calls = [];
  assert.equal((await wa.whatsappStatus()).available, true, 'the outage must not have replaced the cached answer');
  assert.equal(calls.length, 0, 'and that read came from the cache');
});

// ── 3. Groups ────────────────────────────────────────────────────────────────

test('groups: the payload is { groups: [...] }, NOT a bare array', async () => {
  // Parsing this as an array silently yields no groups — the picker is empty and the admin
  // concludes the platform approved none.
  reply({ groups: [{ id: '120363012345678901@g.us', label: 'Trustees' }] });
  const g = await wa.whatsappGroups();
  assert.deepEqual(g, [{ id: '120363012345678901@g.us', label: 'Trustees' }]);
});

test('groups: a bare array (the shape in the brief) yields nothing, and that is correct', async () => {
  reply([{ id: '120363012345678901@g.us', label: 'Trustees' }]);
  assert.deepEqual(await wa.whatsappGroups(), [], 'we read `groups`, and there is none here');
});

test('groups: anything that is not a real group id is dropped', async () => {
  reply({ groups: [
    { id: '120363012345678901@g.us', label: 'Trustees' },
    { id: '447700900123@c.us', label: 'A person, somehow' },
    { id: 12345, label: 'Not a string' },
    { label: 'No id at all' },
  ] });
  const g = await wa.whatsappGroups();
  assert.equal(g.length, 1, 'only the real group survives');
  assert.equal(g[0].id, '120363012345678901@g.us');
});

test('groups: a failure is an empty list, never a throw — the picker hides itself', async () => {
  reply({ groups: [], error: 'nope' }, 403);
  assert.deepEqual(await wa.whatsappGroups(), []);
});

// ── 4. Sending ───────────────────────────────────────────────────────────────

test('send: 202 {queued:true} is the ONLY success, and it means queued — never delivered', async () => {
  reply({ queued: true }, 202);
  const r = await wa.sendWhatsApp({ to: '447700900123' }, 'A donation was received.');
  assert.deepEqual(r, { queued: true, error: '', retry: false });
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { to: '447700900123', text: 'A donation was received.' });
});

test('send: a 200 is NOT a success — the contract says 202', async () => {
  reply({ queued: true }, 200);
  assert.equal((await wa.sendWhatsApp({ to: '447700900123' }, 'x')).queued, false);
});

test('send: a group goes as `group`, and never alongside `to`', async () => {
  reply({ queued: true }, 202);
  await wa.sendWhatsApp({ group: '120363012345678901@g.us' }, 'Appeal update');
  assert.deepEqual(calls[0].body, { group: '120363012345678901@g.us', text: 'Appeal update' });
  assert.ok(!('to' in calls[0].body), 'both keys together is a 400 at the platform');
});

test('send: the platform’s own sentence is passed through to the admin', async () => {
  reply({ queued: false, error: 'That group has not been approved for sending in OpenMasjidOS.' }, 403);
  const r = await wa.sendWhatsApp({ group: '120363012345678901@g.us' }, 'x');
  assert.equal(r.queued, false);
  assert.match(r.error, /not been approved/);
  assert.equal(r.retry, false, '403 cannot be fixed by trying again');
});

test('send: only 429 and 5xx are worth retrying', async () => {
  reply({ queued: false }, 429);
  assert.equal((await wa.sendWhatsApp({ to: '447700900123' }, 'x')).retry, true);
  reply({ queued: false }, 503);
  assert.equal((await wa.sendWhatsApp({ to: '447700900123' }, 'x')).retry, true);
  for (const status of [400, 403, 413]) {
    reply({ queued: false }, status);
    assert.equal((await wa.sendWhatsApp({ to: '447700900123' }, 'x')).retry, false, `${status} must not be retried`);
  }
});

test('send: an empty message never reaches the platform', async () => {
  const r = await wa.sendWhatsApp({ to: '447700900123' }, '   ');
  assert.equal(r.queued, false);
  assert.equal(calls.length, 0, 'nothing should have been sent');
});

test('send: a transport failure is reported as retryable, never as queued', async () => {
  const boom = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof globalThis.fetch;
  const r = await wa.sendWhatsApp({ to: '447700900123' }, 'x');
  globalThis.fetch = boom;
  assert.equal(r.queued, false);
  assert.equal(r.retry, true);
});
