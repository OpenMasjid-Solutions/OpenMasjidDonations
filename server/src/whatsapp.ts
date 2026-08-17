// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * WhatsApp via the OpenMasjidOS Fabric (manifest `whatsapp: true`, platform v0.51.0+).
 *
 * The masjid installs the OpenWA gateway and links THEIR OWN phone number in OpenMasjidOS. We POST
 * to the platform and it does the sending; we never see the gateway, its credentials, or the number.
 *
 * Two properties of the channel decide the shape of everything below:
 *
 *  1. **It QUEUES.** A success is `202 {queued:true}` and never "sent". Ban risk attaches to the
 *     NUMBER rather than to whoever sent a message, so one platform-wide queue paces every app at
 *     once — randomised 6–20s gaps, per-recipient cooldowns, hourly and daily caps, and quiet hours
 *     that defer rather than drop. Delivery is seconds to hours away and there is no receipt. So
 *     nothing here may block on a send, report one as delivered, or retry on a timeout.
 *  2. **Nothing auth-critical may ride on it.** It is an unofficial client and the number can be
 *     restricted or banned. In this app it carries admin notifications only — never a receipt a
 *     donor is waiting on, never a payment confirmation, never anything resembling a code. Email
 *     and the alert channels stay the fallback, and WhatsApp is only ever additive.
 *
 * In Donations this is an ADMIN channel. The platform's alerts matrix deliberately has no WhatsApp
 * column for an app, because it routes to the admin's one number while an app's messages are
 * generally for donors — so "which events, and to whom" is a setting in OUR app. The masjid enters
 * their own number(s), or picks a group the platform admin approved. We never collect a donor's
 * phone number and never message one.
 *
 * Message bodies are NEVER logged — here or at the platform. They routinely carry a donor's name
 * and how much they gave.
 */
import { config } from './config';
import { makeLog } from './logger';

const log = makeLog('whatsapp');

/** Why WhatsApp is or isn't usable, in the platform's own four-word vocabulary. `not-allowed`
 *  (we lack the capability) and `unknown` (rate-limited) come back on 403/429. */
export type WhatsAppReason = 'ready' | 'not-configured' | 'not-linked' | 'unreachable' | 'not-allowed' | 'unknown';

export interface WhatsAppStatus {
  available: boolean;
  reason: WhatsAppReason;
  /** May we attach an image? **Absent means NO** — an older platform omits the field entirely, and
   *  reading absence as "yes" means base64-ing half a megabyte into a request that cannot work. */
  media: boolean;
  maxMediaBytes: number;
}

const UNAVAILABLE: WhatsAppStatus = { available: false, reason: 'unreachable', media: false, maxMediaBytes: 0 };

/** A group the masjid's admin approved for THIS app. `label` is their own nickname for it — never
 *  the group's WhatsApp subject, which the platform deliberately does not send us. Show it as-is. */
export interface WhatsAppGroup {
  id: string;
  label: string;
}

/**
 * Reduce a typed number to the digits the platform wants, or null.
 *
 * Mirrors the platform's own `toDigits`: strip everything that is not a digit, then require 8–15 of
 * them. **It never guesses a country code** — "555 0123" could be in any country, and prefixing our
 * guess would send a masjid's donation figures to a stranger. A number without one is refused, not
 * repaired, and the admin is told to add it.
 *
 * A leading `+` is fine to type (it is stripped here); what matters is that the country code is
 * actually present in the digits.
 */
export function toWhatsAppDigits(raw: string): string | null {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 15) return null; // E.164 allows at most 15
  // A LEADING ZERO is a national trunk prefix, never a country code — no E.164 country code begins
  // with 0. We are stricter than the platform here on purpose: its length floor alone accepts
  // "07700900123" (eleven digits) and would address it as `07700900123@c.us`, which is somebody
  // else's number or nobody's. This is the check that makes "include the country code" a real
  // refusal rather than a hopeful error message, and it is the same class of mistake as the floor —
  // refuse, never repair, because repairing means guessing whose number it is.
  if (digits.startsWith('0')) return null;
  return digits;
}

/** A group id as the platform issues them. Shape-checked before use so a junk value never travels;
 *  the real authorisation is the platform's approved-list check, which answers 403. */
export function looksLikeGroupId(v: string): boolean {
  return /^[0-9]{5,32}(-[0-9]{1,20})?@g\.us$/.test((v ?? '').trim());
}

// The availability probe is rendered on every load of the admin Settings screen, so cache it —
// but briefly, because "the admin just linked their phone" should show up without a restart.
let statusCache: { at: number; value: WhatsAppStatus } | null = null;
const STATUS_CACHE_MS = 60_000;

function headers(): Record<string, string> {
  return { 'x-openmasjid-app-secret': config.omosAppSecret };
}

/** Configured at all? (Both env vars present — the same test the rest of the Fabric uses.) */
function fabricReady(): boolean {
  return !!config.omosBaseUrl && !!config.omosAppSecret;
}

/**
 * Can this masjid send WhatsApp right now?
 *
 * Asked BEFORE the feature is offered, not when a message is due: without it, "WhatsApp
 * notifications" is a switch that looks available on every install and fails only on the ones where
 * no gateway was ever set up — and only at the moment a real notification was owed.
 *
 * Never throws. An unreachable platform reports `unreachable`, which the panel turns into a sentence
 * rather than an error.
 */
export async function whatsappStatus(force = false): Promise<WhatsAppStatus> {
  if (!fabricReady()) return { ...UNAVAILABLE, reason: 'not-configured' };
  const now = Date.now();
  if (!force && statusCache && now - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp`, {
      headers: headers(),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    // 403 = we don't hold the capability (an older platform, or it was withdrawn). That is an
    // answer, not an outage, and it is worth caching like any other.
    const j = (await res.json().catch(() => null)) as Partial<WhatsAppStatus> | null;
    const reason: WhatsAppReason =
      j && typeof j.reason === 'string' && isReason(j.reason) ? j.reason : res.ok ? 'unreachable' : 'not-allowed';
    const value: WhatsAppStatus = {
      // Trust the platform's own `available` when it sends one; otherwise derive it. Never infer
      // "available" from a 200 alone — a 200 carrying reason 'not-linked' is a no.
      available: j?.available === true && reason === 'ready',
      reason,
      media: j?.media === true, // absent means NO
      maxMediaBytes: typeof j?.maxMediaBytes === 'number' ? j.maxMediaBytes : 0,
    };
    statusCache = { at: now, value };
    return value;
  } catch (err) {
    log.debug(`WhatsApp status check failed: ${err instanceof Error ? err.message : String(err)}`);
    return UNAVAILABLE; // not cached — an outage must not stick for a minute
  }
}

function isReason(v: string): v is WhatsAppReason {
  return ['ready', 'not-configured', 'not-linked', 'unreachable', 'not-allowed', 'unknown'].includes(v);
}

/**
 * The groups the masjid's admin approved for THIS app — never the gateway's own list, which would
 * name every group the masjid's phone is in, personal ones included.
 *
 * An empty list means "no groups available": hide the picker rather than erroring, since the admin
 * can withdraw approval at any time. Fails soft to `[]`.
 *
 * NOTE the response shape: the platform returns `{ groups: [...] }`, not a bare array.
 */
export async function whatsappGroups(): Promise<WhatsAppGroup[]> {
  if (!fabricReady()) return [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp/groups`, {
      headers: headers(),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const j = (await res.json().catch(() => null)) as { groups?: unknown } | null;
    const list = Array.isArray(j?.groups) ? j!.groups : [];
    return list
      .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object' && typeof (g as { id?: unknown }).id === 'string')
      .map((g) => ({ id: String(g.id), label: typeof g.label === 'string' && g.label ? g.label.slice(0, 80) : String(g.id) }))
      .filter((g) => looksLikeGroupId(g.id));
  } catch (err) {
    log.debug(`WhatsApp group list failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Where one message goes. Exactly one of these — the platform 400s on both or neither. */
export type WhatsAppTarget = { to: string } | { group: string };

export interface WhatsAppSendResult {
  /** Accepted for LATER delivery. Never "sent" — there is no delivery receipt. */
  queued: boolean;
  /** Why not, for the admin. '' when queued. */
  error: string;
  /** True when trying again later could plausibly work (an outage, a full media queue). */
  retry: boolean;
}

/**
 * Queue ONE message to ONE recipient.
 *
 * One recipient per call is the platform's API shape and it is deliberate — an array would invite
 * the cold blast that gets numbers banned. A caller wanting several recipients loops, and the
 * platform's queue paces the loop correctly.
 *
 * Never throws. Never logs `text`.
 */
export async function sendWhatsApp(target: WhatsAppTarget, text: string): Promise<WhatsAppSendResult> {
  if (!fabricReady()) return { queued: false, error: 'This device isn’t connected to OpenMasjidOS.', retry: false };
  const body = 'to' in target ? { to: target.to, text } : { group: target.group, text };
  if (!text.trim()) return { queued: false, error: 'There was nothing to send.', retry: false };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp`, {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    const j = (await res.json().catch(() => null)) as { queued?: boolean; error?: string } | null;
    if (res.status === 202 && j?.queued === true) return { queued: true, error: '', retry: false };
    // The platform's own sentence is written for an admin, so pass it through when there is one.
    // Log the STATUS only — the body it refused holds the message.
    const error = typeof j?.error === 'string' && j.error ? j.error : whyFailed(res.status);
    log.warn(`WhatsApp not queued (HTTP ${res.status})`);
    // 4xx is our fault and retrying the same request cannot help; 429/5xx may pass later.
    return { queued: false, error, retry: res.status === 429 || res.status >= 500 };
  } catch (err) {
    log.debug(`WhatsApp send failed: ${err instanceof Error ? err.message : String(err)}`);
    return { queued: false, error: 'We couldn’t reach OpenMasjidOS to send that message.', retry: true };
  }
}

/**
 * What to tell the admin when WhatsApp isn't usable.
 *
 * The platform's four words describe four different situations with four different fixes, and
 * collapsing them into "WhatsApp isn't working" sends an admin looking in the wrong place — most
 * expensively when the answer is "you linked the gateway but never scanned the code".
 */
export function whatsappUnavailableMessage(reason: WhatsAppReason): string {
  switch (reason) {
    case 'not-configured':
      return 'WhatsApp isn’t set up on this server yet — an admin can add it in OpenMasjidOS → Settings → WhatsApp.';
    case 'not-linked':
      return 'WhatsApp is set up, but no phone is linked to it yet. Finish linking it in OpenMasjidOS → Settings → WhatsApp.';
    case 'not-allowed':
      return 'OpenMasjidOS isn’t allowing this app to send WhatsApp messages. Check that it’s permitted in OpenMasjidOS → Settings → WhatsApp.';
    case 'unreachable':
      return 'The WhatsApp gateway isn’t responding. Please try again in a moment.';
    case 'unknown':
      return 'We couldn’t check WhatsApp just now. Please try again in a moment.';
    default:
      return '';
  }
}

/** A friendly sentence for a status the platform didn't explain itself. */
function whyFailed(status: number): string {
  if (status === 403) return 'OpenMasjidOS isn’t allowing this app to send WhatsApp messages.';
  if (status === 429) return 'Too many messages just now — please try again in a moment.';
  if (status === 413) return 'That message was too large to send.';
  if (status >= 500) return 'OpenMasjidOS couldn’t send that message just now.';
  return 'That message couldn’t be sent.';
}
