// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Renders the branded emails this app sends a donor: a donation RECEIPT and a REFUND notice. Both
 * share one layout (see `shell`) so a donor who receives both reads the same letter twice.
 *
 * The receipt is a clean, Stripe-style receipt: the masjid logo,
 * a short thank-you paragraph (admin-editable), then a details table (amount paid, date/time,
 * payment method + last 4, fund) kept SEPARATE from the paragraph, and a contact line. PURE +
 * unit-tested. The actual send goes through the OpenMasjidOS Fabric (fabric.ts `fabricEmail`).
 *
 * SECURITY: the template subject/heading/body are treated as PLAIN TEXT and fully HTML-escaped
 * (newlines → <br>), and EVERY value — including the donor's own name (from the *unauthenticated*
 * public intent) and the masjid contact fields — is escaped. So nothing can inject markup. Images
 * (the masjid logo) and links (website) are only emitted for http(s) URLs.
 */

export interface ReceiptTemplate {
  subject: string;
  heading: string;
  /** The thank-you paragraph. Supports {name} {amount} {campaign} {masjid}. */
  body: string;
  /** Accent colour (hex) for the heading + links, or '' for the default emerald. */
  accent: string;
}

/** Everything auto-filled from the donation + masjid settings (NOT admin free text). */
export interface ReceiptContext {
  name: string;
  amountText: string;
  campaignTitle: string;
  masjidName: string;
  /** ALREADY-RESOLVED absolute http(s) logo URL, or '' (caller resolves /uploads → public URL). */
  masjidLogo: string;
  datePaid: string;
  paymentMethod: string;
  reference: string;
  contactEmail: string;
  contactPhone: string;
  contactWebsite: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const ACCENT_DEFAULT = '#1FA37A';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Substitute {name}/{amount}/{campaign}/{masjid}. Empty {name} → tidy an adjacent comma/space.
 *  Collapses runs of spaces/tabs (NOT newlines — paragraph breaks in the body are preserved). */
export function fillVars(tpl: string, v: { name: string; amount: string; campaign: string; masjid: string }): string {
  let out = tpl;
  if (!v.name.trim()) out = out.replace(/,?[ \t]*\{name\}[ \t]*,?/g, ' ');
  out = out
    .replace(/\{name\}/g, v.name)
    .replace(/\{amount\}/g, v.amount)
    .replace(/\{campaign\}/g, v.campaign)
    .replace(/\{masjid\}/g, v.masjid);
  return out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([!?.,])/g, '$1').trim();
}

/** Collapse anything that could break out of a single header line into a space.
 *
 *  The subject is built from the admin's template with the DONOR's own name substituted in, and the
 *  donor is an unauthenticated stranger (`donorName` comes straight off the public intent body).
 *  We hand the finished subject to the OpenMasjidOS Fabric as JSON, and the platform is what turns
 *  it into a real SMTP header — so a name containing CR/LF is a header-injection attempt aimed at
 *  the platform's mailer (`Bcc:`, a forged `From:`, an injected body). Sanitising at the sender is
 *  cheap, harmless to every legitimate name, and does not depend on the platform getting it right;
 *  the platform-side counterpart is recorded in docs/audit/ACTION_REQUIRED.md (DONATIONS-023). */
function oneLine(s: string): string {
  // Escapes, NEVER literal characters: U+2028/U+2029 are line terminators in JavaScript SOURCE,
  // so pasting them into a regex silently ends the expression. U+0085 (NEL) and NUL are treated
  // as line breaks or string terminators by some mail libraries, so they go too.
  return s.replace(/[\r\n\u2028\u2029\u0085\v\f\0]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Only an http(s) absolute URL with no quotes/whitespace is allowed (img src / link href). */
function safeUrl(url: string): string {
  const u = (url ?? '').trim();
  return /^https?:\/\/[^"'\\\s]+$/i.test(u) ? u : '';
}

/** One "label / value" row of the receipt details table. */
function row(label: string, value: string, opts: { bold?: boolean; first?: boolean } = {}): string {
  const border = opts.first ? '' : 'border-top:1px solid #eef1f3;';
  const val = `padding:11px 0;text-align:right;color:#16242b;${border}${opts.bold ? 'font-weight:700;font-size:16px;' : ''}`;
  return `<tr><td style="padding:11px 0;color:#7a8892;${border}">${escapeHtml(label)}</td><td style="${val}">${escapeHtml(value)}</td></tr>`;
}

/** The one email layout this app sends: logo, reference, heading, a paragraph, a details table,
 *  then contact details. Shared by the receipt and the refund notice so a donor who gets both
 *  reads the same letter twice, and so a change to the design can only be made in one place.
 *  Every caller passes ALREADY-ESCAPED html for the parts that came from a person. */
function shell(parts: { accent: string; header: string; refLine: string; heading: string; bodyHtml: string; details: string; contactLine: string; websiteLine: string }): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f9">
  <div style="max-width:540px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16242b">
    <div style="background:#ffffff;border:1px solid #e6eaed;border-radius:14px">
      <div style="padding:30px 30px 6px;text-align:center">
        ${parts.header}
        ${parts.refLine}
      </div>
      <div style="padding:14px 30px 4px;text-align:center">
        <h1 style="margin:0 0 12px;font-size:21px;line-height:1.25;color:${escapeHtml(parts.accent)}">${escapeHtml(parts.heading)}</h1>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#42535c">${parts.bodyHtml}</p>
      </div>
      <div style="padding:14px 30px 4px">
        <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">${parts.details}</table>
      </div>
      <div style="padding:16px 30px 28px;margin-top:8px;border-top:1px solid #eef1f3;text-align:center">
        ${parts.contactLine}
        ${parts.websiteLine}
      </div>
    </div>
    <p style="text-align:center;font-size:11px;color:#9aa7af;margin-top:14px">Sent by OpenMasjid Donations · Secured by Stripe</p>
  </div>
</body></html>`;
}

/** The masjid's header block: its logo when we have a loadable one, else its name, else nothing. */
function headerBlock(logo: string, masjid: string): string {
  if (logo) return `<img src="${escapeHtml(logo)}" alt="${escapeHtml(masjid)}" style="max-height:60px;max-width:220px;height:auto">`;
  return masjid ? `<div style="font-size:20px;font-weight:700;color:#16242b">${escapeHtml(masjid)}</div>` : '';
}

/** The small uppercase reference line under the logo, e.g. "Receipt · 0065A17F". */
function refBlock(label: string, reference: string): string {
  if (!reference) return '';
  return `<div style="margin-top:12px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#9aa7af">${escapeHtml(label)} · ${escapeHtml(reference)}</div>`;
}

/** "Questions about this donation? Contact …" + an optional website line. */
function contactBlocks(accent: string, masjid: string, ctx: Pick<ReceiptContext, 'contactEmail' | 'contactPhone' | 'contactWebsite'>): { contactLine: string; websiteLine: string } {
  const website = safeUrl(ctx.contactWebsite);
  const inner: string[] = [];
  if (ctx.contactEmail.trim()) inner.push(`<a href="mailto:${escapeHtml(ctx.contactEmail.trim())}" style="color:${escapeHtml(accent)};text-decoration:none">${escapeHtml(ctx.contactEmail.trim())}</a>`);
  if (ctx.contactPhone.trim()) inner.push(escapeHtml(ctx.contactPhone.trim()));
  return {
    contactLine: inner.length
      ? `<p style="margin:0;font-size:13px;line-height:1.6;color:#7a8892">Questions about this donation? Contact ${escapeHtml(masjid || 'us')} — ${inner.join(' · ')}.</p>`
      : `<p style="margin:0;font-size:13px;color:#7a8892">Questions about this donation? Please contact ${escapeHtml(masjid || 'the masjid')}.</p>`,
    websiteLine: website
      ? `<p style="margin:6px 0 0;font-size:13px"><a href="${escapeHtml(website)}" style="color:${escapeHtml(accent)};text-decoration:none">${escapeHtml(website.replace(/^https?:\/\//, ''))}</a></p>`
      : '',
  };
}

/** Resolve a hex accent, falling back to the default emerald for anything that isn't one (so an
 *  unvalidated value can never reach a style attribute). */
function resolveAccent(accent: string | undefined): string {
  return /^#[0-9a-fA-F]{3,8}$/.test((accent || '').trim()) ? (accent as string).trim() : ACCENT_DEFAULT;
}

/** The plain-text tail every email ends with: how to reach the masjid. */
function contactTextLines(masjid: string, ctx: Pick<ReceiptContext, 'contactEmail' | 'contactPhone' | 'contactWebsite'>): string[] {
  const out: string[] = [];
  const bits = [ctx.contactEmail, ctx.contactPhone].filter((s) => s && s.trim());
  if (bits.length) out.push(`Questions? Contact ${masjid || 'us'} — ${bits.join(' · ')}`);
  if (ctx.contactWebsite.trim()) out.push(ctx.contactWebsite.trim());
  return out;
}

/** Build the subject/text/html of a receipt email. `html` is a light, Stripe-style receipt. */
export function renderReceipt(tpl: ReceiptTemplate, ctx: ReceiptContext): RenderedEmail {
  const accent = resolveAccent(tpl.accent);
  const vars = { name: ctx.name, amount: ctx.amountText, campaign: ctx.campaignTitle, masjid: ctx.masjidName };
  // oneLine BEFORE the length cap, so a 200-char slice can never end mid-escape or leave a CR.
  const subject = (oneLine(fillVars(tpl.subject || 'Your donation receipt', vars)) || 'Your donation receipt').slice(0, 200);
  const heading = fillVars(tpl.heading || 'JazākAllāhu khayran!', vars) || 'JazākAllāhu khayran!';
  const paragraph = fillVars(tpl.body || 'Your donation was received. May Allah accept it from you and reward you abundantly.', vars);
  const masjid = ctx.masjidName.trim();

  // ── Plain-text part ──
  const lines = [
    heading,
    '',
    paragraph,
    '',
    `Amount paid:    ${ctx.amountText}`,
    `Date paid:      ${ctx.datePaid}`,
    `Payment method: ${ctx.paymentMethod}`,
    ctx.campaignTitle ? `Fund:           ${ctx.campaignTitle}` : '',
    ctx.reference ? `Receipt:        ${ctx.reference}` : '',
    '',
    ...contactTextLines(masjid, ctx),
  ];
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // ── HTML part (everything escaped) ──
  const details = [
    row('Amount paid', ctx.amountText, { bold: true, first: true }),
    row('Date paid', ctx.datePaid),
    row('Payment method', ctx.paymentMethod),
    ctx.campaignTitle ? row('Fund', ctx.campaignTitle) : '',
  ].join('');
  const html = shell({
    accent,
    header: headerBlock(safeUrl(ctx.masjidLogo), masjid),
    refLine: refBlock('Receipt', ctx.reference),
    heading,
    bodyHtml: escapeHtml(paragraph).replace(/\n/g, '<br>'),
    details,
    ...contactBlocks(accent, masjid, ctx),
  });

  return { subject, text, html };
}

// ── Refund notice ─────────────────────────────────────────────────────────────

/** Everything the donor's refund email needs. Same shape of data as a receipt (and the same
 *  escaping rules apply to every field), plus the two figures a refund is about: what is coming
 *  back, and what the original donation was. */
export interface RefundContext extends Omit<ReceiptContext, 'datePaid'> {
  /** What is being returned, already formatted, e.g. "£20.00". */
  refundAmountText: string;
  /** When the refund was made, formatted for reading. */
  dateRefunded: string;
  /** True when the WHOLE donation is coming back — the wording differs, and a masjid being told
   *  "£20 of your £50 has been returned" when it was all of it would cause a phone call. */
  full: boolean;
}

// ── Monthly plan set up ───────────────────────────────────────────────────────

/** Everything the "your monthly donation is set up" letter needs.
 *
 *  Every figure here is a LOCAL fact — what the donor agreed to, when the first payment landed,
 *  which fund, the reference. Nothing needs a Stripe call, and that is deliberate: this letter is
 *  re-rendered by the receipt outbox up to three days later, so a field that needed live Stripe
 *  state (the next payment date, the card) would either block the retry or print a stale promise. */
export interface MonthlySetupContext extends Omit<ReceiptContext, 'datePaid'> {
  /** The recurring amount, already formatted — `amountText` is the same figure for a monthly gift. */
  monthlyAmountText: string;
  /** When the first payment went through, formatted for reading. */
  firstPaymentDate: string;
  /** The absolute https URL of the donor's own stop page, or '' when this masjid has no public
   *  address. '' is a REAL case (a LAN-only box) and switches the letter to the "get in touch and
   *  we'll stop it for you" wording — never a link to a host the reader cannot resolve. */
  stopUrl: string;
}

/** The letter a monthly donor gets once their first payment has gone through: what they set up, and
 *  how to stop it themselves.
 *
 *  Deliberately NOT admin-editable. It is the donor's only self-service route out of a recurring
 *  card charge, so its wording is not something a masjid should be able to weaken by accident — and
 *  a link is not a thing to hand to a template engine. The masjid's branding (logo, accent, contact
 *  details) still carries through, so it reads as their letter.
 *
 *  The URL is linkified HERE, through the same `safeUrl` allowlist as every other link in this file,
 *  and escaped into both the href and the visible text — so even though the caller builds it, no
 *  value of it can break out of the markup. */
export function renderMonthlySetup(accentRaw: string, ctx: MonthlySetupContext): RenderedEmail {
  const accent = resolveAccent(accentRaw);
  const masjid = ctx.masjidName.trim();
  const vars = { name: ctx.name, amount: ctx.monthlyAmountText, campaign: ctx.campaignTitle, masjid };
  const stop = safeUrl(ctx.stopUrl);

  const subject = (oneLine(fillVars(masjid ? 'Your monthly donation to {masjid} is set up' : 'Your monthly donation is set up', vars)) || 'Your monthly donation is set up').slice(0, 200);
  const heading = 'Your monthly donation is set up';
  const opening = fillVars(
    'Assalāmu ʿalaykum {name}, and jazākAllāhu khayran. Your first payment has gone through, and from now on {amount} will go to {masjid} every month until you decide to stop.',
    vars,
  );
  // Two endings, because a masjid with no public address cannot offer a link that would work.
  const howToStop = stop
    ? 'If you ever want to stop it, you can do that yourself with the link below — there is nothing to sign in to and nobody to phone.'
    : 'Whenever you’d like to stop it, or change anything about it, just get in touch using the details at the bottom of this email and we’ll take care of it for you.';
  const paragraph = `${opening} ${howToStop}`;
  const keepSafe =
    'Keep this email if you can — that link only works from here, and it’s the one way to stop the payments yourself. ' +
    'If you lose it, no problem at all: contact us using the details below and we’ll stop them for you.';
  const closing = 'Nothing else is needed from you. Your payment will simply arrive each month, and we’ll be grateful for every one of them.';

  // ── Plain-text part ──
  // The URL goes on a line of its OWN with no trailing punctuation, so no mail client folds a full
  // stop into the link and breaks it.
  const lines = [
    heading,
    '',
    paragraph,
    '',
    `Monthly amount: ${ctx.monthlyAmountText}`,
    ctx.firstPaymentDate ? `First payment:  ${ctx.firstPaymentDate}` : '',
    ctx.campaignTitle ? `Fund:           ${ctx.campaignTitle}` : '',
    ctx.reference ? `Reference:      ${ctx.reference}` : '',
    '',
    ...(stop ? ['Stop these payments:', stop, '', keepSafe, ''] : []),
    closing,
    '',
    ...contactTextLines(masjid, ctx),
  ];
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // ── HTML part (everything escaped) ──
  const details = [
    row('Monthly amount', ctx.monthlyAmountText, { bold: true, first: true }),
    ctx.firstPaymentDate ? row('First payment', ctx.firstPaymentDate) : '',
    ctx.campaignTitle ? row('Fund', ctx.campaignTitle) : '',
    ctx.reference ? row('Reference', ctx.reference) : '',
  ].join('');
  const stopBlock = stop
    ? `<div style="margin:18px 0 0;text-align:center">
        <a href="${escapeHtml(stop)}" style="display:inline-block;padding:11px 20px;border-radius:9px;background:${escapeHtml(accent)};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">Stop these payments</a>
        <div style="margin-top:10px;font-size:12px;word-break:break-all;color:#7a8892">${escapeHtml(stop)}</div>
        <p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#42535c;text-align:start">${escapeHtml(keepSafe)}</p>
      </div>`
    : '';
  const html = shell({
    accent,
    header: headerBlock(safeUrl(ctx.masjidLogo), masjid),
    refLine: refBlock('Monthly gift', ctx.reference),
    heading,
    bodyHtml: escapeHtml(paragraph).replace(/\n/g, '<br>'),
    details,
    // The stop block and the closing line ride with the contact footer so the shell keeps its
    // single details table — the link belongs BELOW the figures it refers to.
    contactLine: `${stopBlock}<p style="margin:18px 0 14px;font-size:13px;line-height:1.6;color:#7a8892">${escapeHtml(closing)}</p>${contactBlocks(accent, masjid, ctx).contactLine}`,
    websiteLine: contactBlocks(accent, masjid, ctx).websiteLine,
  });

  return { subject, text, html };
}

/** The refund notice sent to a donor, when the admin chooses to tell them.
 *
 *  Deliberately NOT admin-editable, unlike the receipt. A refund is a factual notice about
 *  somebody's money — how long it takes to appear, and who to ask — and the wording is the part
 *  most likely to worry a donor if it were got wrong. The masjid's branding (logo, accent, contact
 *  details) still carries through, so it reads as their letter.
 *
 *  `accent` is the admin's receipt accent; anything that isn't a hex colour falls back to the
 *  default, so an unvalidated value can never reach the markup. Every value is escaped and the
 *  subject is flattened to one line — the donor's own name is in it, and the donor is an
 *  unauthenticated stranger (DONATIONS-023). */
export function renderRefundNotice(accentRaw: string, ctx: RefundContext): RenderedEmail {
  const accent = resolveAccent(accentRaw);
  const masjid = ctx.masjidName.trim();
  const vars = { name: ctx.name, amount: ctx.refundAmountText, campaign: ctx.campaignTitle, masjid: masjid };

  const subject = (oneLine(fillVars('Your donation to {masjid} has been refunded', vars)) || 'Your donation has been refunded').slice(0, 200);
  const heading = fillVars(ctx.full ? 'Your donation has been refunded' : 'Part of your donation has been refunded', vars);
  const paragraph = fillVars(
    ctx.full
      ? 'Assalāmu ʿalaykum {name}, your donation of {amount} to {masjid} has been refunded in full. ' +
          'It should be back on your card within 5–10 days, depending on your bank. ' +
          'If you weren’t expecting this, please get in touch with us using the details below.'
      : '{name}, {amount} of your donation to {masjid} has been refunded. ' +
          'It should be back on your card within 5–10 days, depending on your bank. ' +
          'If you weren’t expecting this, please get in touch with us using the details below.',
    vars,
  );

  // ── Plain-text part ──
  const lines = [
    heading,
    '',
    paragraph,
    '',
    `Refunded:       ${ctx.refundAmountText}`,
    ctx.full ? '' : `Original gift:  ${ctx.amountText}`,
    `Date refunded:  ${ctx.dateRefunded}`,
    `Payment method: ${ctx.paymentMethod}`,
    ctx.campaignTitle ? `Fund:           ${ctx.campaignTitle}` : '',
    ctx.reference ? `Reference:      ${ctx.reference}` : '',
    '',
    ...contactTextLines(masjid, ctx),
  ];
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // ── HTML part (everything escaped) ──
  const details = [
    row('Refunded', ctx.refundAmountText, { bold: true, first: true }),
    // Only worth a row when it differs from the refund — on a full refund it would just repeat.
    ctx.full ? '' : row('Original donation', ctx.amountText),
    row('Date refunded', ctx.dateRefunded),
    row('Payment method', ctx.paymentMethod),
    ctx.campaignTitle ? row('Fund', ctx.campaignTitle) : '',
  ].join('');
  const html = shell({
    accent,
    header: headerBlock(safeUrl(ctx.masjidLogo), masjid),
    refLine: refBlock('Refund', ctx.reference),
    heading,
    bodyHtml: escapeHtml(paragraph).replace(/\n/g, '<br>'),
    details,
    ...contactBlocks(accent, masjid, ctx),
  });

  return { subject, text, html };
}
