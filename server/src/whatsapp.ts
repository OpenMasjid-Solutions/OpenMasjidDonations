// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * WhatsApp via the OpenMasjidOS Fabric (manifest `whatsapp: true`, platform v0.51.0+).
 *
 * The masjid installs the OpenWA gateway and links THEIR OWN phone number in OpenMasjidOS. We POST
 * to the platform and it does the sending; we never see the gateway, its credentials, or the number.
 *
 * **Minimum platform versions.** Sending needs OpenMasjidOS **0.51.0+**; the durable queue and the
 * message-status endpoint need **0.51.1+**. `outcomes` on the status probe is how we tell, and an
 * absent field means false — never assume the newer platform.
 *
 * Two properties of the channel decide the shape of everything below:
 *
 *  1. **It QUEUES.** A success is `202 {queued:true, id}` and never "sent". There is no delivery
 *     receipt from WhatsApp, so nothing here may block on a send or report one as delivered.
 *
 *     **The pacing changed in platform 0.51.1, and the consequence is ours.** Quiet hours, the
 *     hourly and daily caps, the per-recipient and per-group cooldowns, the warm-up ramp and the
 *     random 6–20s gap are all GONE — a message now goes out within seconds, after a typing
 *     indicator. The platform used to refuse to send too much; it no longer does. Ban risk still
 *     attaches to the NUMBER, it is shared by every app on the box, and a blocked number cannot be
 *     recovered — the masjid loses the number their parents reach them on. So the bound has to live
 *     here: see `makeSendBudget`, and note that this app deliberately sends ONE message per event
 *     rather than looping over recipients.
 *  2. **Nothing auth-critical may ride on it, and nothing may DEPEND on it arriving.** It is an
 *     unofficial client and the number can be restricted or banned. In this app it carries admin
 *     notifications only — never a receipt a donor is waiting on, never a payment confirmation,
 *     never anything resembling a code.
 *
 *     Note the precise claim, which changed in v0.43.0: WhatsApp is NOT necessarily a second copy
 *     of something that also went out by email. Per-event notification settings make
 *     `{os: false, whatsapp: '…'}` one click, and an admin is entitled to choose it. What still
 *     holds is that nothing depends on the message: the donation is in the database and in the
 *     panel either way, no donor outcome and no money movement waits on it, and every event stays
 *     reachable through the platform's own alerts matrix.
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
  /** Does `GET /api/fabric/whatsapp/status/<id>` exist (platform 0.51.1+)? **Absent means NO**, for
   *  the same reason as `media`: on an older platform every status poll would 404 and we would
   *  report "we don't know" as though it were an answer. */
  outcomes: boolean;
}

const UNAVAILABLE: WhatsAppStatus = { available: false, reason: 'unreachable', media: false, maxMediaBytes: 0, outcomes: false };

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
 *  the real authorization is the platform's approved-list check, which answers 403. */
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
    // 429/5xx is NO INFORMATION — the platform never answered the question. Caching it would turn
    // one throttled probe into a minute of "OpenMasjidOS isn't allowing this app to send", which
    // sends an admin to check a permission that was never off; and during that minute `raise()`
    // would skip the WhatsApp leg of every notification. So serve the last good answer when we
    // have one, and do not overwrite it. (403 is different, and is cached below: "you don't hold
    // this capability" is an answer.)
    if (res.status === 429 || res.status >= 500) return statusCache?.value ?? { ...UNAVAILABLE, reason: 'unknown' };
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
      outcomes: j?.outcomes === true, // absent means NO — an older platform has no status endpoint
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
  /** The platform's id for this message, when it accepted one. Keep it: it is the only way to ask
   *  later what became of the message (`whatsappOutcome`), which is what makes "did the treasurer
   *  actually get told about that refund?" an answerable question. '' on refusal, and '' on a
   *  platform too old to issue one. */
  id: string;
  /** Why not, for the admin — the platform's own sentence when it sent one. '' when queued. */
  error: string;
  /** True when trying again later could plausibly work (an outage, a full media queue). */
  retry: boolean;
  /** The platform REFUSED this message and said why: a 4xx. Distinct from an outage, because the
   *  two want opposite handling — a refusal is a fact to show the admin ("that group is no longer
   *  approved", "that is the number WhatsApp is linked to"), while an outage is worth nothing more
   *  than a log line. Swallowing the difference is what made a refused message look identical to a
   *  lost one. */
  refused: boolean;
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
  if (!fabricReady()) return { queued: false, id: '', error: 'This device isn’t connected to OpenMasjidOS.', retry: false, refused: false };
  const body = 'to' in target ? { to: target.to, text } : { group: target.group, text };
  // Refused by the platform as "The message is empty." anyway; caught here so the round trip is
  // not spent finding out. (With `media`, `text` would be a CAPTION capped at 1024 rather than
  // 4096 — this app attaches no image, so that limit cannot bite it.)
  if (!text.trim()) return { queued: false, id: '', error: 'There was nothing to send.', retry: false, refused: true };
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
    const j = (await res.json().catch(() => null)) as { queued?: boolean; error?: string; id?: unknown } | null;
    if (res.status === 202 && j?.queued === true) {
      // The id is optional on a 0.51.0 platform, which has no status endpoint to use it with.
      return { queued: true, id: typeof j.id === 'string' ? j.id.slice(0, 128) : '', error: '', retry: false, refused: false };
    }
    // The platform's own sentence is written for an admin, so pass it through when there is one.
    // Log the STATUS only — the body it refused holds the message.
    const error = typeof j?.error === 'string' && j.error ? j.error : whyFailed(res.status);
    const transient = res.status === 429 || res.status >= 500;
    log.warn(`WhatsApp not queued (HTTP ${res.status})`);
    // 4xx is a REFUSAL with a reason worth showing an admin; 429/5xx is an outage that may pass.
    return { queued: false, id: '', error, retry: transient, refused: !transient };
  } catch (err) {
    log.debug(`WhatsApp send failed: ${err instanceof Error ? err.message : String(err)}`);
    return { queued: false, id: '', error: 'We couldn’t reach OpenMasjidOS to send that message.', retry: true, refused: false };
  }
}

/** What became of one message (platform 0.51.1+, gated on `status.outcomes`).
 *
 *  **`sent` is a success state, and that is a trap worth naming** (found by OpenMasjidDisplay, whose
 *  dedupe asked "is there a queued row?" as a proxy for "has this been handled?" — true only while
 *  `queued` was the only success, and false the moment delivery is confirmed, so the next tick sent
 *  it again). This app cannot hit that: it never retries a send, it keys nothing on the presence of
 *  a `queued` row, and the one place that reads the state is the panel deciding whether to show a
 *  problem. Keep it that way — if a dedupe or retry is ever added here, key it on the message id,
 *  never on a state. And treat `expired` as a failure: the recipient still has nothing. */
export type WhatsAppState = 'queued' | 'sent' | 'failed' | 'expired';
export interface WhatsAppMessageOutcome {
  state: WhatsAppState;
  /** Only on failed/expired. */
  reason: string;
  /** Epoch ms, as the platform reports it. */
  at: number;
  target: 'person' | 'group' | '';
}

/**
 * Ask what became of a message we queued.
 *
 * Scoped to our own app — another app's id 404s exactly like an unknown one, which is also what a
 * platform without the endpoint returns, so **a null answer never means "it failed"**. That reading
 * is load-bearing and stays correct whatever the bounds are: 404 covers an unknown id, another
 * app's, an evicted record, and a platform too old to have the endpoint.
 *
 * The bounds, corrected in platform 0.51.1-dev.8: **the most recent 500 PER APP, kept 24 hours** —
 * it used to be 200 shared across every app, which meant a busy neighbour could evict our records
 * (and its own earliest, which are the ones most likely to have failed). Status reads also have
 * their own 600/minute budget now, separate from sending, so polling can no longer refuse a send
 * and a send can no longer refuse a poll. None of that changes what this app does — it asks once,
 * ~45s after queueing, which fits inside any of those numbers — but it is why asking once is a
 * choice rather than a workaround.
 *
 * Holds no message text and no recipient, by the platform's design — so nothing here can leak a
 * donor's figures or an admin's number into our own logs or database.
 */
export async function whatsappOutcome(id: string): Promise<WhatsAppMessageOutcome | null> {
  if (!fabricReady() || !id) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp/status/${encodeURIComponent(id)}`, {
      headers: headers(),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) return null; // 404 = unknown, not ours, or a platform without the endpoint
    const j = (await res.json().catch(() => null)) as Partial<WhatsAppMessageOutcome> | null;
    const state = j && typeof j.state === 'string' && isState(j.state) ? j.state : null;
    if (!state) return null;
    return {
      state,
      reason: typeof j?.reason === 'string' ? j.reason.slice(0, 200) : '',
      at: typeof j?.at === 'number' ? j.at : 0,
      target: j?.target === 'person' || j?.target === 'group' ? j.target : '',
    };
  } catch (err) {
    log.debug(`WhatsApp status check failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Why the link was down. Platform 0.51.1-dev.13; **more values may be added**, and an unrecognized
 *  one must read as `unknown` rather than being rendered raw at a masjid. */
export type WhatsAppGapCause = 'session-expired' | 'needs-relink' | 'key-rejected' | 'unknown';
const CAUSES: readonly WhatsAppGapCause[] = ['session-expired', 'needs-relink', 'key-rejected', 'unknown'];

/** A period during which our messages were reported `sent` but may never have arrived. */
export interface WhatsAppSuspectWindow {
  /** Epoch ms. */
  from: number;
  to: number;
  /** How many of OUR messages were reported sent inside it — the platform scopes this to our app id. */
  count: number;
  /** What went wrong, so the sentence an admin reads is the platform's fact and not our guess. */
  cause: WhatsAppGapCause;
  /** The ids of our messages in the window, for exact reconciliation. Capped at 500 per app per
   *  window by the platform — so this may be SHORTER than `count`, and `truncated` says when. */
  ids: string[];
  /** The platform's own admission that the id cap bit. Kept rather than inferred from
   *  `ids.length < count`, because those two can also differ for reasons of ours. */
  truncated: boolean;
}

/**
 * Ask whether any of our messages fall in a period the platform no longer trusts (platform 0.52.0).
 *
 * WHY THIS EXISTS. A masjid's WhatsApp session expired on its own, the way WhatsApp Desktop signs
 * itself out. The platform did not notice for over a day: the gateway kept accepting messages, every
 * one came back `202 {queued}` and was then recorded `sent`, and none of them was delivered. The
 * platform now spots that within ~10 minutes and HOLDS messages instead of losing them, but there is
 * a residual window between the link dying and the detection — and the platform cannot resend those,
 * because it deletes a message's contents the moment it hands it to the gateway (deliberately: a
 * child's name and a family's fees should not sit on disk). Only the app that has the source data
 * can do anything about them.
 *
 * On the READ budget (600/min), not the send budget, so polling this costs us no sends.
 *
 * **Retention: 7 days after the outage ENDS** (platform 0.51.1-dev.13). It used to answer only while
 * the outage was open, so re-linking the phone closed the window and destroyed the evidence exactly
 * when an admin would come looking — Kiosk found that. Two consequences here: hourly polling is
 * sufficient (there is no longer a race to catch it before it closes), and a window is now re-reported
 * on roughly 168 consecutive polls, every one of which `store.addWhatsAppGap` must answer silently.
 *
 * **A window is IMMUTABLE** — bounds, cause, counts and ids are snapshotted at detection and never
 * revised, because the queue pauses then and nothing else writes outcome records. `cause` therefore
 * cannot change mid-window either: one incident, one cause, and a session expiry followed by a key
 * rotation during recovery arrives as two separate windows. (Both confirmed by the platform team
 * against their source, 2026-08-23, after this file assumed the opposite.)
 *
 * A non-ok answer is `[]`, not an error, and that is the same reading as `whatsappOutcome`: a 404 is
 * a platform too old to have the endpoint, and nothing about an absent answer is evidence that
 * anything went wrong. This must never become "assume a gap" — the fallback has to be the quiet one,
 * because the loud one would raise a false alarm on every older platform.
 */
export async function whatsappSuspect(): Promise<WhatsAppSuspectWindow[]> {
  if (!fabricReady()) return [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp/suspect`, {
      headers: headers(),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) return []; // 404 = a platform without the endpoint. Not evidence of a gap.
    const j = (await res.json().catch(() => null)) as { ok?: unknown; windows?: unknown } | null;
    // `ok` (platform 0.51.1-dev.13) exists because of exactly the trap Students named on `/groups`: an
    // empty list is indistinguishable from "we could not tell you". A body that does not say ok is
    // NO INFORMATION, so it takes the same quiet fallback as a 404 — never "there is no gap".
    // Absent `ok` is tolerated: 0.52.0 shipped the endpoint before the field, and on that platform an
    // HTTP 200 was the only signal there was.
    if (j?.ok !== undefined && j.ok !== true) return [];
    const raw = Array.isArray(j?.windows) ? j.windows : [];
    const out: WhatsAppSuspectWindow[] = [];
    // Bounded and validated: this drives a notification to the masjid, so a malformed row must be
    // dropped rather than rendered as "0 messages between 1970 and 1970".
    for (const v of raw.slice(0, 50)) {
      if (!v || typeof v !== 'object') continue;
      const o = v as Record<string, unknown>;
      const from = typeof o.from === 'number' ? o.from : 0;
      const to = typeof o.to === 'number' ? o.to : 0;
      const count = typeof o.count === 'number' ? Math.max(0, Math.round(o.count)) : 0;
      if (from <= 0 || to < from || count <= 0) continue;
      // An unrecognized cause reads as `unknown`, because the platform says more values may be added
      // and a raw enum token is not a sentence to show a masjid.
      const causeRaw = typeof o.cause === 'string' ? o.cause : '';
      const cause = (CAUSES as readonly string[]).includes(causeRaw) ? (causeRaw as WhatsAppGapCause) : 'unknown';
      const ids = Array.isArray(o.ids)
        ? o.ids.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 500)
        : [];
      // `truncated` is taken from the platform, and ALSO inferred when it plainly must be true — an
      // older platform sends no flag, and `ids` shorter than `count` would otherwise let us imply we
      // had accounted for every message when we had not.
      const truncated = o.truncated === true || ids.length < count;
      out.push({ from, to, count, cause, ids, truncated });
    }
    return out;
  } catch (err) {
    log.debug(`WhatsApp suspect check failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function isState(v: string): v is WhatsAppState {
  return v === 'queued' || v === 'sent' || v === 'failed' || v === 'expired';
}

/**
 * OUR OWN send budget, because the platform no longer has one.
 *
 * Until platform 0.51.1 the queue refused to send too much: per-recipient cooldowns, hourly and
 * daily caps, quiet hours. All of that is gone and a message now leaves within seconds. What has
 * not changed is that ban risk attaches to the masjid's PHONE NUMBER, that the number is shared
 * with every other app on the box, and that a blocked number is not recoverable.
 *
 * The event this exists for is "a donation was received", which fires once per transaction: a busy
 * Friday, or a Ramadan appeal, is hundreds — and `minAmount` is opt-in, so a masjid that never set
 * it has no protection at all. A sliding hour per destination is enough to make that safe without
 * getting in the way of the events that matter (a refund, a broken payment setup) which arrive a
 * handful of times a year.
 *
 * Suppression is COUNTED rather than silent: an admin who is told "12 WhatsApp messages were held
 * back in the last hour" can act on it, where an admin whose phone simply went quiet cannot.
 */
export interface SendBudget {
  /** Take a slot for this destination. False = do not send. */
  take(key: string): boolean;
  /** How many sends this destination has had held back, ever (since boot). */
  suppressed(key: string): number;
  /** Total held back across every destination, for the panel. */
  totalSuppressed(): number;
}

export function makeSendBudget(perHour: number, now: () => number = Date.now): SendBudget {
  const hits = new Map<string, number[]>();
  const held = new Map<string, number>();
  return {
    take(key: string): boolean {
      const t = now();
      const cutoff = t - 3600_000;
      const list = (hits.get(key) ?? []).filter((at) => at > cutoff);
      if (list.length >= perHour) {
        hits.set(key, list);
        held.set(key, (held.get(key) ?? 0) + 1);
        return false;
      }
      list.push(t);
      hits.set(key, list);
      if (hits.size > 200) for (const [k, v] of hits) if (!v.some((at) => at > cutoff)) hits.delete(k);
      return true;
    },
    suppressed(key: string): number {
      return held.get(key) ?? 0;
    },
    totalSuppressed(): number {
      let n = 0;
      for (const v of held.values()) n += v;
      return n;
    },
  };
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
