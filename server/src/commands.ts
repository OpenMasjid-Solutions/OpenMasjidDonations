// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Admin commands over WhatsApp (manifest `commands:`, platform v0.51.0+).
 *
 * An authorized admin messages the masjid's number — `!donations` — and the platform renders a
 * numbered menu, checks who may run what, and POSTs the chosen one to `/fabric/commands/run` on our
 * own web port. We are asked only to execute it and answer in plain text.
 *
 * Everything here is READ-ONLY and aggregate, deliberately:
 *
 *  • **Stats only.** No command changes anything. The blast radius of a mistake in a channel this
 *    informal should be a wrong number on a screen, not a closed appeal or a refunded donation.
 *  • **No donor is ever named.** Not a name, not an email, not a reference. A WhatsApp message is
 *    forwardable and screenshottable, and the donor never agreed to appear in one — so a command
 *    answers "$312 from 9 donations", never "$50 from Yusuf". The panel is where donor records live,
 *    behind a login.
 *  • **Local data only.** There is a 10-second timeout and someone is holding a phone, so every
 *    figure comes from SQLite. Nothing here calls Stripe: a live plan sync can take seconds per
 *    plan, and a stat that arrives late is worse than one that is a few minutes stale.
 *
 * The formatters are pure and take a `fmt` for money, so the whole reply surface is unit-testable
 * without a store, a server, or a currency.
 */
import crypto from 'node:crypto';
import { config } from './config';

/** The platform, and only the platform. The colon is outside the charset every app id is validated
 *  against, so no installed app can ever present this value. */
const PLATFORM_CALLER = 'omos:platform';

/** The request the platform POSTs us. `followUpToken` is present only mid-conversation. */
export interface CommandRequest {
  command: string;
  text: string;
  requestId: string;
  locale: string;
  followUpToken?: string;
}

/** Our answer. `followUp` keeps the exchange open — the sender's next message comes back to us
 *  with this token and no `!` prefix. Omit it to finish. */
export type CommandReply =
  | { ok: true; text: string; followUp?: { token: string } }
  | { ok: false; error: string };

/**
 * Is this really the platform asking?
 *
 * BOTH headers, and the secret compared in constant time. `x-openmasjid-app-secret` must equal our
 * own per-app secret, and `x-openmasjid-caller-app` must be exactly `omos:platform` — which no app
 * id can be. Without the second check, any app that learned our secret could reach this handler
 * through the app-to-app broker, which is a different trust boundary sharing a path prefix (the
 * platform refuses `commands` in `fabric.provides` for the same reason).
 */
export function isPlatformCall(headers: Record<string, unknown>): boolean {
  const secret = config.omosAppSecret;
  if (!secret) return false; // standalone: there is no platform, so nothing can be from it
  const presented = headers['x-openmasjid-app-secret'];
  const caller = headers['x-openmasjid-caller-app'];
  if (typeof presented !== 'string' || typeof caller !== 'string') return false;
  if (caller !== PLATFORM_CALLER) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Follow-up tokens ─────────────────────────────────────────────────────────
//
// The token is OURS: the platform stores it against that one sender, hands it back, and keeps no
// other state. Charset `A-Za-z0-9._:-`, max 128 — validated by the platform before it is echoed,
// because it lands in a later request body.
//
// We keep it to a step name and an attempt counter, and deliberately do NOT encode the list of
// appeals in it. A list would blow the 128 characters on a masjid with a dozen appeals, and the
// alternative — re-deriving the same ordered list on the next turn — is both simpler and safe
// enough, because THE REPLY ALWAYS NAMES THE APPEAL IT IS REPORTING ON. If the admin somehow
// reordered their appeals inside the three-minute window, they see the wrong name and ask again.

const TOKEN_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** `appeal:pick:<attempt>` — the only conversation this app holds. */
export function pickToken(attempt: number): string {
  return `appeal:pick:${Math.max(1, Math.min(9, Math.round(attempt)))}`;
}

/** The attempt number from a token, or 0 when it isn't one of ours. */
export function pickAttempt(token: string | undefined): number {
  if (!token || !TOKEN_RE.test(token)) return 0;
  const m = /^appeal:pick:([1-9])$/.exec(token);
  return m ? Number(m[1]) : 0;
}

// ── Choosing an appeal from a reply ──────────────────────────────────────────

export interface AppealChoice {
  id: string;
  title: string;
}

/**
 * Which appeal did they mean? A menu number first, then a name.
 *
 * Numbers are 1-based because that is what the message showed. A name match is deliberately
 * generous — case-insensitive, and a substring counts — since somebody typing on a phone will send
 * "ramadan" rather than "Ramadan Appeal 2026". An ambiguous substring is a miss rather than a guess:
 * reporting the wrong appeal's total confidently is worse than asking again.
 *
 * TWO LISTS, and the split is the point. A number can only mean a line of the menu that was
 * actually shown, so it indexes `menu`. A NAME is searched across `all` — every appeal the masjid
 * has — because the menu is capped to keep one WhatsApp message readable, and searching only the
 * capped list meant a masjid with thirteen appeals could never ask about the thirteenth at all:
 * not by number (it was never listed) and not by name either (it was not in the list being
 * searched). Every answer names the appeal it reports on, so a name that reaches past the menu is
 * still unambiguous to whoever reads the reply.
 */
export function chooseAppeal(reply: string, menu: AppealChoice[], all: AppealChoice[] = menu): AppealChoice | null {
  const t = (reply ?? '').trim().toLowerCase();
  if (!t) return null;

  if (/^\d{1,2}$/.test(t)) {
    const i = Number(t) - 1;
    return i >= 0 && i < menu.length ? menu[i] : null;
  }
  if (all.length === 0) return null;
  const exact = all.filter((a) => a.title.trim().toLowerCase() === t);
  if (exact.length === 1) return exact[0];
  const partial = all.filter((a) => a.title.toLowerCase().includes(t));
  return partial.length === 1 ? partial[0] : null;
}

// ── The replies ──────────────────────────────────────────────────────────────
//
// Plain text, short, and no markup: the platform strips control characters, collapses blank lines
// and trims to the message cap, so a reply cannot be made to look like several messages. One idea
// per line. A WhatsApp message read on a phone is not a report.

/** How money is rendered — passed in so these stay pure and currency-agnostic. */
export type Money = (minorUnits: number) => string;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export interface TodayStats {
  todayMinor: number;
  todayCount: number;
  monthMinor: number;
  monthCount: number;
}

export function replyToday(s: TodayStats, fmt: Money): string {
  const head =
    s.todayCount === 0
      ? 'Nothing has come in today yet.'
      : `Today: ${fmt(s.todayMinor)} from ${plural(s.todayCount, 'donation')}.`;
  return `${head}\nThis month: ${fmt(s.monthMinor)} from ${plural(s.monthCount, 'donation')}.`;
}

export interface MonthStats {
  monthMinor: number;
  monthCount: number;
  lastMonthMinor: number;
  monthLabel: string;
  lastMonthLabel: string;
}

export function replyMonth(s: MonthStats, fmt: Money): string {
  const lines = [`${s.monthLabel}: ${fmt(s.monthMinor)} from ${plural(s.monthCount, 'donation')}.`];
  if (s.lastMonthMinor > 0) {
    const diff = s.monthMinor - s.lastMonthMinor;
    // Against the WHOLE of last month, and say so — comparing a half-finished month with a
    // finished one and calling it "down 40%" would be alarming and wrong.
    const how = diff === 0 ? 'the same as' : diff > 0 ? `${fmt(diff)} more than` : `${fmt(-diff)} less than`;
    lines.push(`That is ${how} all of ${s.lastMonthLabel} (${fmt(s.lastMonthMinor)}).`);
  } else {
    lines.push(`Nothing came in during ${s.lastMonthLabel}.`);
  }
  return lines.join('\n');
}

export interface TotalStats {
  totalMinor: number;
  count: number;
  averageMinor: number;
  refundedMinor: number;
  liveAppeals: number;
}

export function replyTotals(s: TotalStats, fmt: Money): string {
  if (s.count === 0) return 'No donations have been recorded yet.';
  const lines = [
    `${fmt(s.totalMinor)} raised in total, from ${plural(s.count, 'donation')}.`,
    `Average gift: ${fmt(s.averageMinor)}.`,
    `${plural(s.liveAppeals, 'appeal')} currently taking donations.`,
  ];
  // Only worth a line when it happened — and worth one then, because it explains a total that
  // went down since somebody last looked.
  if (s.refundedMinor > 0) lines.push(`${fmt(s.refundedMinor)} has been refunded (already taken off the total above).`);
  return lines.join('\n');
}

export interface AppealStats {
  title: string;
  raisedMinor: number;
  count: number;
  goalMinor: number;
  active: boolean;
}

export function replyAppeal(s: AppealStats, fmt: Money): string {
  const lines = [`${s.title}: ${fmt(s.raisedMinor)} from ${plural(s.count, 'donation')}.`];
  if (s.goalMinor > 0) {
    const pct = Math.floor((s.raisedMinor / s.goalMinor) * 100);
    const left = s.goalMinor - s.raisedMinor;
    lines.push(
      left > 0
        ? `That is ${pct}% of the ${fmt(s.goalMinor)} goal — ${fmt(left)} to go.`
        : `The ${fmt(s.goalMinor)} goal has been reached.`,
    );
  }
  if (!s.active) lines.push('This appeal is currently hidden from the donation site.');
  return lines.join('\n');
}

/** The "which appeal?" question. Numbered, because a number is the easiest thing to type back.
 *
 *  `hidden` is how many appeals did not fit in the menu. It is SAID rather than silently dropped:
 *  an admin who cannot see the appeal they want would otherwise conclude the app has lost it, when
 *  typing part of its name works perfectly well. */
export function replyAppealMenu(appeals: AppealChoice[], again: boolean, hidden = 0): string {
  const list = appeals.map((a, i) => `${i + 1}. ${a.title}`).join('\n');
  const more = hidden > 0 ? `\n…and ${hidden} more — type part of the name for one of those.` : '';
  return `${again ? 'Sorry — I didn’t recognize that one. Which appeal?' : 'Which appeal?'}\n${list}${more}\n\nReply with a number, or part of the name.`;
}

export interface MonthlyStats {
  donors: number;
  perMonthMinor: number;
  thisMonthMinor: number;
  /** Plans that HAVE given but not lately — see `Store.monthlyGiving`. Reported, never hidden. */
  dormant?: number;
}

export function replyMonthly(s: MonthlyStats, fmt: Money): string {
  if (s.donors === 0) {
    return s.dormant
      ? `Nobody is giving monthly at the moment. ${plural(s.dormant, 'plan')} used to and hasn’t been charged lately — the Monthly tab shows why.`
      : 'Nobody has set up a monthly donation yet.';
  }
  const lines = [
    `${plural(s.donors, 'monthly donor')}, giving about ${fmt(s.perMonthMinor)} a month.`,
    `${fmt(s.thisMonthMinor)} of this month’s donations came from them.`,
  ];
  // Said out loud, because otherwise the figure above simply looks lower than the masjid expected
  // and there is nothing on the screen to explain why.
  if (s.dormant) {
    lines.push(`${plural(s.dormant, 'other plan')} hasn’t been charged in the last two months — stopped, paused, or a card worth looking at.`);
  }
  lines.push('Open the Monthly tab in the panel for each plan and its next payment.');
  return lines.join('\n');
}
