// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the Stripe-style receipt renderer: the details block (amount/date/method/fund) renders
// separately from the paragraph, contact info appears, and the security property holds — NO value
// (admin template, donor {name}, or masjid contact fields) can inject HTML, and only http(s)
// images/links are emitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReceipt, renderRefundNotice, renderMonthlySetup, fillVars, type ReceiptTemplate, type ReceiptContext, type RefundContext, type MonthlySetupContext } from './email';

const TPL: ReceiptTemplate = {
  subject: 'Your donation receipt — {masjid}',
  heading: 'JazākAllāhu khayran, {name}!',
  body: 'Thank you for your gift to {masjid}.\n\nPlease keep this for your records.',
  accent: '',
};
const CTX: ReceiptContext = {
  name: 'Yusuf',
  amountText: '£50.00',
  campaignTitle: 'General Fund',
  masjidName: 'An-Noor',
  masjidLogo: '',
  datePaid: 'Jul 15, 2026, 6:03 PM UTC',
  paymentMethod: 'Visa •••• 4242',
  reference: '0065A17F',
  contactEmail: 'info@annoor.org',
  contactPhone: '718-555-5839',
  contactWebsite: 'https://annoor.org',
};

test('fills variables in subject/heading/body', () => {
  const r = renderReceipt(TPL, CTX);
  assert.equal(r.subject, 'Your donation receipt — An-Noor');
  assert.ok(r.html.includes('JazākAllāhu khayran, Yusuf!'));
  assert.ok(r.html.includes('Thank you for your gift to An-Noor.'));
});

test('the receipt DETAILS block renders amount/date/method/fund (separate from the paragraph)', () => {
  const r = renderReceipt(TPL, CTX);
  for (const s of ['Amount paid', '£50.00', 'Date paid', 'Jul 15, 2026, 6:03 PM UTC', 'Payment method', 'Visa •••• 4242', 'Fund', 'General Fund', '0065A17F']) {
    assert.ok(r.html.includes(s), `html should contain "${s}"`);
    assert.ok(r.text.includes(s.replace('Amount paid', 'Amount paid').replace('Date paid', 'Date paid')), `text should contain "${s}"`);
  }
});

test('contact info appears (mailto + phone + website)', () => {
  const r = renderReceipt(TPL, CTX);
  assert.ok(r.html.includes('mailto:info@annoor.org'));
  assert.ok(r.html.includes('info@annoor.org'));
  assert.ok(r.html.includes('718-555-5839'));
  assert.ok(r.html.includes('https://annoor.org'));
});

test('empty {name} is tidied (no dangling comma)', () => {
  const r = renderReceipt(TPL, { ...CTX, name: '' });
  assert.ok(r.html.includes('JazākAllāhu khayran!'));
  assert.ok(!r.html.includes('{name}'));
});

test('SECURITY: a donor name with HTML is escaped, never injected', () => {
  const r = renderReceipt(TPL, { ...CTX, name: '<img src=x onerror=alert(1)>' });
  assert.ok(!r.html.includes('<img src=x onerror'), 'raw tag must not appear');
  assert.ok(r.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('SECURITY: an admin body with a <script> is escaped', () => {
  const r = renderReceipt({ ...TPL, body: 'Hi <script>steal()</script>' }, CTX);
  assert.ok(!r.html.includes('<script>steal'));
  assert.ok(r.html.includes('&lt;script&gt;'));
});

test('SECURITY: a malicious contact field cannot break out of the mailto/markup', () => {
  const r = renderReceipt(TPL, { ...CTX, contactEmail: 'x"><script>evil()</script>@e.org' });
  assert.ok(!r.html.includes('<script>evil'));
});

test('body newlines become <br>', () => {
  assert.ok(renderReceipt(TPL, CTX).html.includes('gift to An-Noor.<br><br>Please keep this'));
});

test('masjid logo: http(s) is embedded; javascript:/data: is rejected', () => {
  assert.ok(renderReceipt(TPL, { ...CTX, masjidLogo: 'https://ex.org/logo.png' }).html.includes('<img src="https://ex.org/logo.png"'));
  assert.ok(!renderReceipt(TPL, { ...CTX, masjidLogo: 'javascript:alert(1)' }).html.includes('<img'));
  assert.ok(!renderReceipt(TPL, { ...CTX, masjidLogo: 'data:image/png;base64,AAAA' }).html.includes('<img'));
  // No logo → the masjid name is shown as the header instead.
  assert.ok(renderReceipt(TPL, { ...CTX, masjidLogo: '' }).html.includes('An-Noor'));
});

test('accent: valid hex used; invalid falls back to default (no CSS injection)', () => {
  assert.ok(renderReceipt({ ...TPL, accent: '#D4AF37' }, CTX).html.includes('#D4AF37'));
  const bad = renderReceipt({ ...TPL, accent: 'red;}body{display:none' }, CTX).html;
  assert.ok(bad.includes('#1FA37A'));
  assert.ok(!bad.includes('display:none'));
});

test('fillVars preserves newlines but collapses runs of spaces', () => {
  assert.equal(fillVars('a\n\nb    c', { name: 'x', amount: 'y', campaign: 'z', masjid: 'm' }), 'a\n\nb c');
});

// ── DONATIONS-023 ────────────────────────────────────────────────────────────
// The subject is built from the admin's template with the DONOR's own name substituted in, and the
// donor is an unauthenticated stranger. The finished subject becomes an SMTP header at the platform,
// so a CR/LF in a name is a header-injection attempt. Fails before the fix: the raw name went
// through with its newlines intact.
test('receipt subject: a donor name cannot inject an email header (CR/LF collapsed)', () => {
  const evil = 'Ahmed\r\nBcc: attacker@evil.example\r\n\r\nInjected body';
  const { subject } = renderReceipt({ ...TPL, subject: 'Receipt for {name}' }, { ...CTX, name: evil });
  assert.ok(!/[\r\n]/.test(subject), `subject must be one line, got ${JSON.stringify(subject)}`);
  assert.ok(!/\u2028|\u2029|\v|\f|\0/.test(subject), 'and no exotic line separators either');
  assert.ok(subject.startsWith('Receipt for Ahmed'), 'the legitimate part of the name survives');
  assert.ok(subject.includes('Bcc:'), 'the text is neutralised by flattening, not silently dropped');
});

test('receipt subject: ordinary names and unicode are untouched', () => {
  const ok = renderReceipt({ ...TPL, subject: 'Receipt for {name}' }, { ...CTX, name: 'Yūsuf Al-Ḥasan' }).subject;
  assert.equal(ok, 'Receipt for Yūsuf Al-Ḥasan');
});

// ── Refund notice ─────────────────────────────────────────────────────────────
// The refund email is NOT admin-editable, so there is no template to inject through — but every
// value in it still comes from somewhere: the donor's own name (unauthenticated), the masjid's
// contact fields, and the accent. The same three properties are locked as for the receipt: nothing
// can inject markup, only http(s) images/links are emitted, and the subject stays one line.
const RCTX: RefundContext = {
  name: 'Yusuf',
  amountText: '£50.00',
  refundAmountText: '£20.00',
  full: false,
  campaignTitle: 'General Fund',
  masjidName: 'An-Noor',
  masjidLogo: '',
  dateRefunded: 'Aug 10, 2026, 6:03 PM UTC',
  paymentMethod: 'Visa •••• 4242',
  reference: '0065A17F',
  contactEmail: 'info@annoor.org',
  contactPhone: '718-555-5839',
  contactWebsite: 'https://annoor.org',
};

test('refund notice: a PART refund names both figures, so nobody thinks it was all of it', () => {
  const r = renderRefundNotice('', RCTX);
  assert.equal(r.subject, 'Your donation to An-Noor has been refunded');
  assert.ok(r.html.includes('Part of your donation has been refunded'));
  for (const s of ['Refunded', '£20.00', 'Original donation', '£50.00', 'Date refunded', 'Visa •••• 4242', 'General Fund']) {
    assert.ok(r.html.includes(s), `html should contain "${s}"`);
  }
  assert.ok(r.text.includes('£20.00') && r.text.includes('£50.00'));
});

test('refund notice: a FULL refund says so, and does not repeat the amount as an "original"', () => {
  const r = renderRefundNotice('', { ...RCTX, full: true, refundAmountText: '£50.00' });
  assert.ok(r.html.includes('Your donation has been refunded'));
  assert.ok(!r.html.includes('Part of your donation'));
  assert.ok(!r.html.includes('Original donation'), 'a full refund has nothing to compare against');
  assert.ok(r.html.includes('refunded in full'));
});

test('refund notice: it tells the donor how long to wait and who to ask', () => {
  const r = renderRefundNotice('', RCTX);
  assert.ok(r.html.includes('5–10 days'), 'a donor watching their bank must be told to wait');
  assert.ok(r.html.includes('mailto:info@annoor.org'));
  assert.ok(r.text.includes('718-555-5839'));
});

test('refund notice: an empty {name} is tidied, exactly as in the receipt', () => {
  const r = renderRefundNotice('', { ...RCTX, name: '' });
  assert.ok(!r.html.includes('{name}'));
  assert.ok(!r.html.includes(' ,'));
});

test('SECURITY: a donor name with HTML is escaped in the refund notice too', () => {
  const r = renderRefundNotice('', { ...RCTX, name: '<img src=x onerror=alert(1)>' });
  assert.ok(!r.html.includes('<img src=x onerror'));
  assert.ok(r.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('SECURITY: the refund subject cannot carry an injected email header (DONATIONS-023)', () => {
  const evil = 'Ahmed\r\nBcc: attacker@evil.example\r\n\r\nInjected body';
  const { subject } = renderRefundNotice('', { ...RCTX, name: evil, masjidName: evil });
  assert.ok(!/[\r\n]/.test(subject), `subject must be one line, got ${JSON.stringify(subject)}`);
  assert.ok(!/\u2028|\u2029|\v|\f|\0/.test(subject));
});

test('SECURITY: the refund notice accent takes a hex colour or the default, never CSS', () => {
  assert.ok(renderRefundNotice('#D4AF37', RCTX).html.includes('#D4AF37'));
  const bad = renderRefundNotice('red;}body{display:none', RCTX).html;
  assert.ok(bad.includes('#1FA37A'));
  assert.ok(!bad.includes('display:none'));
});

test('SECURITY: the refund notice logo takes http(s) only', () => {
  assert.ok(renderRefundNotice('', { ...RCTX, masjidLogo: 'https://ex.org/l.png' }).html.includes('<img src="https://ex.org/l.png"'));
  assert.ok(!renderRefundNotice('', { ...RCTX, masjidLogo: 'javascript:alert(1)' }).html.includes('<img'));
});

test('receipt and refund notice share one layout, so a donor reads the same letter twice', () => {
  const a = renderReceipt(TPL, CTX).html;
  const b = renderRefundNotice('', RCTX).html;
  for (const marker of ['max-width:540px', 'border-radius:14px', 'Sent by OpenMasjid Donations · Secured by Stripe']) {
    assert.ok(a.includes(marker) && b.includes(marker), `both must use "${marker}"`);
  }
});

// ── Monthly plan set up ───────────────────────────────────────────────────────
// This letter is the donor's ONLY self-service route out of a recurring charge on their card, so
// three properties are locked here and nowhere else:
//
//  1. THE LINK SURVIVES. It must appear in both the HTML and the plain-text part, and in the text
//     part it must sit on its own line with no trailing punctuation — a full stop folded into a URL
//     by a mail client is a dead link and a donor who can't stop their payments.
//  2. THE NO-LINK VARIANT IS COMPLETE. A LAN-only masjid has no public address, and the letter must
//     then tell the donor to get in touch rather than print a URL they cannot reach.
//  3. NOTHING INJECTS. The masjid's own accent/logo and the DONOR's name (unauthenticated) both
//     reach the markup, and the subject becomes an SMTP header at the platform (DONATIONS-023).
const MCTX: MonthlySetupContext = {
  name: 'Yusuf',
  amountText: '£25.00',
  monthlyAmountText: '£25.00',
  firstPaymentDate: 'Aug 3, 2026, 6:03 PM UTC',
  stopUrl: 'https://masjid.example.org/donate/stop/0123456789abcdef0123456789abcdef',
  campaignTitle: 'Zakat',
  masjidName: 'An-Noor',
  masjidLogo: '',
  paymentMethod: 'Visa •••• 4242',
  reference: '0065A17F',
  contactEmail: 'info@annoor.org',
  contactPhone: '718-555-5839',
  contactWebsite: 'https://annoor.org',
};

test('monthly letter: says what was set up, with the figures a donor recognises', () => {
  const r = renderMonthlySetup('', MCTX);
  assert.equal(r.subject, 'Your monthly donation to An-Noor is set up');
  assert.ok(r.html.includes('Your monthly donation is set up'));
  for (const s of ['Monthly amount', '£25.00', 'First payment', 'Zakat', '0065A17F']) {
    assert.ok(r.html.includes(s), `html should contain "${s}"`);
  }
  assert.ok(r.html.includes('every month until you decide to stop'));
});

test('monthly letter: the stop link is in BOTH parts, and alone on its own text line', () => {
  const r = renderMonthlySetup('', MCTX);
  assert.ok(r.html.includes(`href="${MCTX.stopUrl}"`), 'html must link it');
  assert.ok(r.html.includes('Stop these payments'));
  // The URL must also be readable as text in the HTML, for a client that strips the button.
  assert.ok(r.html.split(MCTX.stopUrl).length - 1 >= 2, 'href AND visible text');
  const line = r.text.split('\n').find((l) => l.includes('/stop/'));
  assert.equal(line, MCTX.stopUrl, 'the text part must carry the URL alone, with nothing appended');
});

test('monthly letter: tells them to keep it, and why', () => {
  const r = renderMonthlySetup('', MCTX);
  for (const part of [r.html, r.text]) {
    assert.ok(/Keep this email/.test(part), 'must ask them to keep it');
    assert.ok(/only works from here/.test(part), 'must say why it matters');
    assert.ok(/contact us/.test(part), 'and must name the fallback if they lose it');
  }
});

test('monthly letter: with NO public address there is no link, but there is still a way out', () => {
  const r = renderMonthlySetup('', { ...MCTX, stopUrl: '' });
  assert.ok(!r.html.includes('Stop these payments'), 'no button');
  assert.ok(!r.html.includes('/stop/'), 'and no URL anywhere');
  assert.ok(!r.text.includes('/stop/'));
  assert.ok(/get in touch/.test(r.html), 'it must still tell them how to stop it');
  assert.ok(!/Keep this email/.test(r.html), 'and must not ask them to keep an email with no link in it');
  // The figures are unchanged — the letter is still their confirmation.
  assert.ok(r.html.includes('£25.00') && r.html.includes('Zakat'));
});

test('monthly letter: a non-https stop URL is dropped rather than linked', () => {
  for (const bad of ['javascript:alert(1)', 'http://x.example/stop/a" onmouseover="evil()', 'ftp://x/y']) {
    const r = renderMonthlySetup('', { ...MCTX, stopUrl: bad });
    assert.ok(!r.html.includes('onmouseover'), 'no attribute break-out');
    assert.ok(!r.html.includes('javascript:'), 'no javascript: href');
    assert.ok(!r.html.includes('Stop these payments'), `"${bad}" must fall back to the no-link letter`);
  }
  // A plain http URL on a private host is still a URL we were given deliberately — but safeUrl
  // allows http, so assert the ONE thing that matters: it is escaped into the href.
  const okHttp = renderMonthlySetup('', { ...MCTX, stopUrl: 'http://192.168.1.9:7870/stop/abc' });
  assert.ok(okHttp.html.includes('href="http://192.168.1.9:7870/stop/abc"'));
});

test('SECURITY: the monthly subject cannot carry an injected email header (DONATIONS-023)', () => {
  const evil = 'Ahmed\r\nBcc: attacker@evil.example\r\n\r\nInjected body';
  const { subject } = renderMonthlySetup('', { ...MCTX, name: evil, masjidName: evil });
  assert.ok(!/[\r\n]/.test(subject), `subject must be one line, got ${JSON.stringify(subject)}`);
  assert.ok(!/\u2028|\u2029|\v|\f|\0/.test(subject));
});

test('SECURITY: a donor name with HTML is escaped in the monthly letter', () => {
  const r = renderMonthlySetup('', { ...MCTX, name: '<img src=x onerror=alert(1)>' });
  assert.ok(!r.html.includes('<img src=x onerror'));
  assert.ok(r.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('SECURITY: the monthly letter accent takes a hex colour or the default, never CSS', () => {
  assert.ok(renderMonthlySetup('#D4AF37', MCTX).html.includes('#D4AF37'));
  const bad = renderMonthlySetup('red;}body{display:none', MCTX).html;
  assert.ok(bad.includes('#1FA37A'));
  assert.ok(!bad.includes('display:none'));
});

test('all three letters share one layout', () => {
  const htmls = [renderReceipt(TPL, CTX).html, renderRefundNotice('', RCTX).html, renderMonthlySetup('', MCTX).html];
  for (const marker of ['max-width:540px', 'border-radius:14px', 'Sent by OpenMasjid Donations · Secured by Stripe']) {
    for (const h of htmls) assert.ok(h.includes(marker), `every letter must use "${marker}"`);
  }
});
