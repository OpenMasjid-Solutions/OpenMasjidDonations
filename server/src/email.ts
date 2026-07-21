// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Renders a branded donation-receipt email from the admin's editable template + the
 * donation's variables. PURE + unit-tested. The actual send goes through the OpenMasjidOS
 * Fabric (fabric.ts `fabricEmail`) — this module only builds {subject, text, html}.
 *
 * SECURITY: the template body/heading are treated as PLAIN TEXT and fully HTML-escaped
 * (newlines → <br>), and every substituted variable — including the donor's own name, which
 * arrives from the *unauthenticated* public intent endpoint — is escaped too. So no value
 * (admin- or donor-supplied) can inject markup into the email HTML. Images come ONLY from the
 * dedicated header-image field, and only as an http(s) URL (never javascript:/data:).
 */

export interface ReceiptTemplate {
  subject: string;
  heading: string;
  body: string;
  /** Header image — an ALREADY-RESOLVED absolute http(s) URL, or '' (the caller resolves
   *  /uploads/… to a public URL when remote access is on; otherwise passes ''). */
  image: string;
  /** Accent colour (hex) for the heading + top bar, or '' for the default emerald. */
  accent: string;
}

export interface ReceiptVars {
  name: string;
  amount: string;
  campaign: string;
  masjid: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const ACCENT_DEFAULT = '#1FA37A';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Substitute {name}/{amount}/{campaign}/{masjid}. When {name} is empty, tidy an adjacent
 *  comma/space so "JazakAllah, {name}!" reads "JazakAllah!". Collapses runs of spaces/tabs
 *  (NOT newlines — paragraph breaks in the body are preserved). */
export function fillVars(tpl: string, v: ReceiptVars): string {
  let out = tpl;
  if (!v.name.trim()) out = out.replace(/,?[ \t]*\{name\}[ \t]*,?/g, ' ');
  out = out
    .replace(/\{name\}/g, v.name)
    .replace(/\{amount\}/g, v.amount)
    .replace(/\{campaign\}/g, v.campaign)
    .replace(/\{masjid\}/g, v.masjid);
  return out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([!?.,])/g, '$1').trim();
}

/** Only an http(s) absolute URL with no quotes/whitespace is allowed as an <img src>. */
function safeImage(url: string): string {
  const u = (url ?? '').trim();
  return /^https?:\/\/[^"'\\\s]+$/i.test(u) ? u : '';
}

/** Build the subject/text/html of a receipt email. `html` is a simple, inline-styled,
 *  email-client-friendly card. */
export function renderReceipt(tpl: ReceiptTemplate, vars: ReceiptVars): RenderedEmail {
  const accent = /^#[0-9a-fA-F]{3,8}$/.test((tpl.accent || '').trim()) ? tpl.accent.trim() : ACCENT_DEFAULT;
  const subject = (fillVars(tpl.subject || 'Your donation receipt', vars) || 'Your donation receipt').slice(0, 200);
  const headingText = fillVars(tpl.heading || 'JazākAllāhu khayran!', vars) || 'JazākAllāhu khayran!';
  const bodyText = fillVars(tpl.body || 'Your donation of {amount} to {campaign} was received. May Allah accept it from you and reward you abundantly.', vars);
  const img = safeImage(tpl.image);
  const masjid = vars.masjid.trim();

  // Plain-text part (accessible + a fallback for text-only clients).
  const text = [headingText, '', bodyText, '', masjid ? `— ${masjid}` : '']
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // HTML part — every dynamic value escaped; body newlines → <br>.
  const bodyHtml = escapeHtml(bodyText).replace(/\n/g, '<br>');
  const imgHtml = img
    ? `<div style="text-align:center;margin:0 0 20px"><img src="${escapeHtml(img)}" alt="" style="max-width:180px;max-height:90px;height:auto"></div>`
    : '';
  const footerHtml = masjid
    ? `<p style="margin:24px 0 0;font-size:13px;color:#8a9a92;text-align:center">${escapeHtml(masjid)}</p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#0e1814">
  <div style="max-width:520px;margin:0 auto;padding:28px 20px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e8f0ec">
    <div style="background:#152420;border:1px solid #24382f;border-top:4px solid ${escapeHtml(accent)};border-radius:14px;padding:28px 26px">
      ${imgHtml}
      <h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:${escapeHtml(accent)};text-align:center">${escapeHtml(headingText)}</h1>
      <p style="margin:0;font-size:15px;line-height:1.6;color:#c8d6cf;text-align:center">${bodyHtml}</p>
      ${footerHtml}
    </div>
    <p style="margin:16px 0 0;font-size:11px;color:#5f6f67;text-align:center">Secured by Stripe · Sent by OpenMasjid Donations</p>
  </div>
</body></html>`;

  return { subject, text, html };
}
