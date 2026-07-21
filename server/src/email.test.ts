// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the receipt-email renderer: variable substitution + the security property that NO
// value (admin template or donor-supplied {name}) can inject HTML, and only http(s) images
// are embedded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReceipt, fillVars } from './email';

const TPL = {
  subject: 'Your donation to {masjid}',
  heading: 'JazākAllāhu khayran, {name}!',
  body: 'Your gift of {amount} to {campaign} was received.\n\nThank you.',
  image: '',
  accent: '',
};
const VARS = { name: 'Yusuf', amount: '£50.00', campaign: 'General Fund', masjid: 'An-Noor' };

test('fills variables in subject/heading/body', () => {
  const r = renderReceipt(TPL, VARS);
  assert.equal(r.subject, 'Your donation to An-Noor');
  assert.ok(r.html.includes('JazākAllāhu khayran, Yusuf!'));
  assert.ok(r.html.includes('Your gift of £50.00 to General Fund was received.'));
  assert.ok(r.text.includes('Your gift of £50.00 to General Fund was received.'));
});

test('empty {name} is tidied (no dangling comma)', () => {
  const r = renderReceipt(TPL, { ...VARS, name: '' });
  assert.ok(r.html.includes('JazākAllāhu khayran!'), 'comma+placeholder collapse');
  assert.ok(!r.html.includes('{name}'));
});

test('SECURITY: a donor name with HTML is escaped, never injected', () => {
  const r = renderReceipt(TPL, { ...VARS, name: '<img src=x onerror=alert(1)>' });
  assert.ok(!r.html.includes('<img src=x onerror'), 'raw tag must not appear');
  assert.ok(r.html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped instead');
});

test('SECURITY: an admin body with a <script> is escaped (body is plain text)', () => {
  const r = renderReceipt({ ...TPL, body: 'Hi <script>steal()</script>' }, VARS);
  assert.ok(!r.html.includes('<script>'), 'no live script tag');
  assert.ok(r.html.includes('&lt;script&gt;'), 'escaped');
});

test('body newlines become <br> in html', () => {
  const r = renderReceipt(TPL, VARS);
  assert.ok(r.html.includes('received.<br><br>Thank you.'));
});

test('image: http(s) is embedded; javascript:/data: is rejected', () => {
  assert.ok(renderReceipt({ ...TPL, image: 'https://ex.org/logo.png' }, VARS).html.includes('<img src="https://ex.org/logo.png"'));
  assert.ok(!renderReceipt({ ...TPL, image: 'javascript:alert(1)' }, VARS).html.includes('<img'));
  assert.ok(!renderReceipt({ ...TPL, image: 'data:image/png;base64,AAAA' }, VARS).html.includes('<img'));
  assert.ok(!renderReceipt({ ...TPL, image: 'https://ex.org/a".png' }, VARS).html.includes('<img'), 'quote in url rejected');
});

test('accent: a valid hex is used; an invalid one falls back to the default', () => {
  assert.ok(renderReceipt({ ...TPL, accent: '#D4AF37' }, VARS).html.includes('#D4AF37'));
  const bad = renderReceipt({ ...TPL, accent: 'red; }body{display:none' }, VARS).html;
  assert.ok(bad.includes('#1FA37A'), 'default emerald');
  assert.ok(!bad.includes('display:none'), 'no CSS injection via accent');
});

test('subject/heading fall back when blank', () => {
  const r = renderReceipt({ ...TPL, subject: '', heading: '' }, { ...VARS, name: '' });
  assert.ok(r.subject.length > 0);
  assert.ok(r.html.includes('JazākAllāhu khayran!'));
});

test('fillVars preserves newlines (paragraphs) but collapses runs of spaces', () => {
  assert.equal(fillVars('a\n\nb    c', VARS), 'a\n\nb c');
});
