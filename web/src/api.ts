// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Typed client for the OpenMasjid Donations API. Responses use a { data | error }
 *  envelope; this unwraps `data` and turns `error` into a thrown friendly message. */
import { withBase } from './base';

export interface AppInfo {
  name: string;
  version: string;
  /** True when running embedded under OpenMasjidOS (Fabric available). */
  embedded: boolean;
  /** Platform base URL for live appearance sync; '' when standalone. */
  omosBase: string;
  /** Whether a valid Stripe publishable+secret pair is configured. */
  donationsConfigured: boolean;
  /** Whether the admin has completed first-run setup. */
  onboarded: boolean;
  /** Public base URL from the OS Fabric remote-access tunnel (manifest `domain: true`),
   *  e.g. "https://omos.example.org/donate". '' when remote access is off → use this
   *  device's address for share links. */
  publicUrl?: string;
  /** The path prefix this app is served under behind the tunnel, e.g. "/donate". */
  basePath?: string;
}

export interface Session {
  /** Standalone first-run: no admin password set yet (and not under SSO). */
  needsSetup: boolean;
  /** Signed in (via local password or a confirmed OpenMasjidOS SSO session). */
  authed: boolean;
  /** A local admin password exists. */
  hasPassword: boolean;
  /** SSO via OpenMasjidOS. `reachable` is false only when SSO is configured but the
   *  platform couldn't be contacted (down / migrated) — the UI then offers the local
   *  password recovery instead of looping on "open from the dashboard". */
  sso: { enabled: boolean; reachable: boolean; username?: string };
}

export interface NotifyTestResult {
  baseUrlSet: boolean;
  hasSecret: boolean;
  baseUrlLoopback: boolean;
  appId: string;
  delivered: boolean;
  reason?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withBase(path), {
    ...init,
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok || body.error) {
    throw new Error(body.error || 'Something went wrong. Please try again.');
  }
  return body.data as T;
}

export const getAppInfo = () => request<AppInfo>('/api/app');
export const getSession = () => request<Session>('/api/session');

export const setupAdmin = (password: string, name?: string) =>
  request<{ ok: true }>('/api/setup', { method: 'POST', body: JSON.stringify({ password, name }) });

export const login = (password: string) =>
  request<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) });

export const logout = () => request<{ ok: true }>('/api/logout', { method: 'POST' });

export const sendTestNotification = () =>
  request<NotifyTestResult>('/api/admin/notify-test', { method: 'POST' });

// ── Settings (masjid details + Stripe config + onboarding) ──────────────────

export interface MasjidProfile {
  name: string;
  address: string;
  email: string;
  phone: string;
  website: string;
  currency: string;
  logo: string;
}

export type StripeMode = 'test' | 'live' | 'unknown';

export interface VerifyResult {
  ok: boolean;
  mode?: StripeMode;
  message?: string;
}

/** Non-secret view of a Stripe account (the only thing the server returns). */
export interface StripeAccount {
  id: string;
  label: string;
  publishableKey: string;
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
  mode: StripeMode;
  configured: boolean;
  keysMismatch: boolean;
}
export type SaveAccountResult = StripeAccount & { verify?: VerifyResult };

/** Non-secret status of the platform-vaulted Stripe account (when embedded under
 *  OpenMasjidOS with the Stripe Fabric). `available` false = standalone / not set up.
 *  `chosenId` is the account the admin picked in-app ('' = the only/first vault account). */
export interface FabricStripeStatus {
  available: boolean;
  id?: string;
  label?: string;
  chosenId?: string;
  publishableKey?: string;
  hasSecretKey?: boolean;
  hasWebhookSecret?: boolean;
  mode?: StripeMode;
  configured?: boolean;
  keysMismatch?: boolean;
}

/** A non-secret reference to a vaulted Stripe account, for the in-app picker. */
export interface FabricStripeAccountRef {
  id: string;
  label: string;
}
export interface FabricStripeAccountsResult {
  accounts: FabricStripeAccountRef[];
  chosenId: string;
}

export interface Settings {
  masjid: MasjidProfile;
  stripeAccounts: StripeAccount[];
  fabricStripe: FabricStripeStatus;
  onboarded: boolean;
}

/** Post-donation thank-you content. heading/message support {name} {amount} {campaign}
 *  {masjid}. As a per-campaign override, an empty field inherits the global default. */
export interface ThankYou {
  heading: string;
  message: string;
  backgroundImage: string;
  accent: string;
}

/** Required campaign type — drives the card-fee rule (see forceCoverFees). */
export type CampaignType = 'donation' | 'zakat' | 'tuition';

/** Where an appeal's money goes. 'default' = the same account as the rest of the site;
 *  'openmasjidos' = an account vaulted in the dashboard; 'device' = keys held on this box. */
export type PaymentAccountSource = 'default' | 'openmasjidos' | 'device';
/** '' = fine. Anything else means this appeal is currently refusing donations. */
export type PaymentAccountStatus = 'ok' | 'no-account' | 'not-configured' | 'unreachable';

export interface Campaign {
  id: string;
  slug: string;
  token: string;
  title: string;
  type: CampaignType;
  description: string;
  coverImage: string;
  backgroundImage: string;
  logo: string;
  presetAmounts: number[]; // major units
  allowCustom: boolean;
  minAmount: number;
  maxAmount: number;
  /** LEGACY — the account bound at creation. Kept for older clients; not what the server reads. */
  stripeAccountId: string;
  /** '' = follow the site default, else 'fabric:<vault-id>' / 'local:<account-id>'. */
  paymentAccount: string;
  paymentAccountSource: PaymentAccountSource;
  /** The account's own name, or '' when it couldn't be resolved (never invented). */
  paymentAccountLabel: string;
  paymentAccountMode: StripeMode;
  paymentAccountStatus: PaymentAccountStatus;
  coverFees: boolean;
  /** Fee is mandatory (Zakat, or a Tuition the admin set to require it). */
  forceCoverFees: boolean;
  giftAid: boolean;
  allowMonthly: boolean;
  /** Opted in to the public embeddable widget (/w/<slug>). */
  widgetEnabled: boolean;
  goalAmount: number;
  active: boolean;
  sortOrder: number;
  /** Per-campaign thank-you override (empty fields inherit the global default). */
  thankYou: ThankYou;
  createdAt: string;
  raised: number;
  currency: string;
  url: string;
}
export type CampaignInput = Partial<
  Omit<
    Campaign,
    'id' | 'token' | 'createdAt' | 'raised' | 'currency' | 'url' | 'sortOrder'
    | 'paymentAccountSource' | 'paymentAccountLabel' | 'paymentAccountMode' | 'paymentAccountStatus'
  >
>;

export interface Donation {
  id: string;
  /** Short human-friendly reference shown in the table (e.g. "0065A17F"). */
  ref: string;
  campaignId: string;
  campaignTitle: string;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
  donorName: string;
  donorEmail: string;
  coverFees: boolean;
  giftAid: boolean;
  paymentIntentId: string;
  cardBrand: string;
  cardLast4: string;
  recurring: boolean;
  createdAt: string;
  /** How much of this donation has been given back (major units). 0 = none. */
  refundedAmount: number;
  /** ISO timestamp of the most recent refund, '' when none. */
  refundedAt: string;
  /** How the row should read: nothing refunded, part of it, or all of it. Derived on the
   *  server so the list, the detail window, the CSV and the alerts all agree. */
  refundState: RefundState;
  /** What is left to refund by OUR records (major units) — pre-fills the amount field and
   *  hides the button at zero. The server re-checks against Stripe before refunding, since a
   *  refund made in the Stripe dashboard may not have reached us yet. */
  refundable: number;
}
export interface DonationsResult {
  donations: Donation[];
  stats: { totalRaised: number; count: number; totalRefunded: number; currency: string };
}

// ── Refunds ─────────────────────────────────────────────────────────────────
export type RefundState = 'none' | 'partial' | 'full';
/** Stripe's three reasons, the only ones its API accepts. 'fraudulent' also marks the charge as
 *  fraud in Stripe (it feeds Radar), so it is never the default. */
export type RefundReason = 'requested_by_customer' | 'duplicate' | 'fraudulent';
export interface RefundResult {
  donation: Donation;
  /** What went back on THIS refund (major units) — not the running total. */
  refunded: number;
  currency: string;
  /** Stripe accepted it but hasn't settled it yet — normal for some payment methods. */
  pending: boolean;
  donorEmailed: boolean;
  /** Why the donor wasn't emailed: 'not-asked' | 'no-email' | 'no-fabric' | a provider reason. */
  donorEmailReason: string;
}
/** Refund a donation. `amount` omitted = everything left on it. `notifyDonor` emails the donor a
 *  branded refund notice (only possible when they gave an address and OS email is set up). */
export const refundDonation = (id: string, body: { amount?: number; reason?: RefundReason; notifyDonor?: boolean }) =>
  request<RefundResult>(`/api/admin/donations/${encodeURIComponent(id)}/refund`, { method: 'POST', body: JSON.stringify(body) });

export interface CampaignMetric {
  id: string;
  title: string;
  slug: string;
  active: boolean;
  goal: number;
  raised: number;
  count: number;
}
export interface MonthMetric {
  month: string;
  label: string;
  raised: number;
  count: number;
}
export interface Metrics {
  currency: string;
  /** Net of refunds, like every `raised` figure. */
  totalRaised: number;
  count: number;
  /** How much has gone back to donors, and on how many donations. Reported alongside the totals
   *  so a figure that dropped is explained on the same screen. */
  totalRefunded: number;
  refundedCount: number;
  average: number;
  thisMonthRaised: number;
  thisMonthCount: number;
  activeCampaigns: number;
  byCampaign: CampaignMetric[];
  monthly: MonthMetric[];
}

export interface SlugCheck {
  slug: string;
  available: boolean;
  reserved: boolean;
}

// ── Settings + accounts (admin) ─────────────────────────────────────────────
export const getSettings = () => request<Settings>('/api/settings');
export const saveMasjid = (patch: Partial<MasjidProfile>) =>
  request<MasjidProfile>('/api/settings/masjid', { method: 'PUT', body: JSON.stringify(patch) });
export const completeOnboarding = () => request<{ ok: true }>('/api/settings/complete-onboarding', { method: 'POST' });

// Global default thank-you screen (per-campaign overrides live on the campaign).
export const getThankYou = () => request<ThankYou>('/api/admin/thankyou');
export const saveThankYou = (patch: Partial<ThankYou>) =>
  request<ThankYou>('/api/admin/thankyou', { method: 'PUT', body: JSON.stringify(patch) });

// Global large-donation alternative (threshold in major units).
export const getLargeDonation = () => request<LargeDonation>('/api/admin/large-donation');
export const saveLargeDonation = (patch: Partial<LargeDonation>) =>
  request<LargeDonation>('/api/admin/large-donation', { method: 'PUT', body: JSON.stringify(patch) });

// Emailed donation receipt (sent via the OpenMasjidOS Fabric email provider when enabled).
/** Last email-send outcome, so the UI can show whether OS email is set up. 'ok' = a send
 *  succeeded; 'not_configured' = the admin hasn't set up email in OpenMasjidOS yet. */
export type EmailStatus = 'unknown' | 'ok' | 'not_configured' | 'rate_limited' | 'error' | 'no-fabric';
export interface EmailReceipt {
  enabled: boolean;
  subject: string;
  heading: string;
  body: string;
  accent: string;
  /** True when running embedded under OpenMasjidOS (email is a Fabric feature). */
  embedded: boolean;
  emailStatus: EmailStatus;
}
export type EmailReceiptPatch = Partial<Pick<EmailReceipt, 'enabled' | 'subject' | 'heading' | 'body' | 'accent'>>;
export const getEmailReceipt = () => request<EmailReceipt>('/api/admin/email-receipt');
export const saveEmailReceipt = (patch: EmailReceiptPatch) =>
  request<EmailReceipt>('/api/admin/email-receipt', { method: 'PUT', body: JSON.stringify(patch) });
/** Fire the `test` alert — the platform delivers it to the admin's own email/webhook (the app
 *  never learns the admin address). Confirms OpenMasjidOS can reach you. */
export const sendTestAlert = () =>
  request<{ delivered: boolean; reason?: string; email?: boolean; webhook?: boolean }>('/api/admin/test-alert', { method: 'POST' });

export type AccountInput = { label?: string; publishableKey?: string; secretKey?: string; webhookSecret?: string };
export const listAccounts = () => request<StripeAccount[]>('/api/admin/stripe-accounts');
export const createAccount = (body: AccountInput) =>
  request<SaveAccountResult>('/api/admin/stripe-accounts', { method: 'POST', body: JSON.stringify(body) });
export const updateAccount = (id: string, body: AccountInput) =>
  request<SaveAccountResult>(`/api/admin/stripe-accounts/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const deleteAccount = (id: string) =>
  request<{ ok: true }>(`/api/admin/stripe-accounts/${id}`, { method: 'DELETE' });
export const testAccount = (id: string) =>
  request<VerifyResult>(`/api/admin/stripe-accounts/${id}/test`, { method: 'POST' });

// In-app picker for the OpenMasjidOS-vault Stripe account (embedded). List = id+label only.
export const getFabricStripeAccounts = () =>
  request<FabricStripeAccountsResult>('/api/admin/stripe/fabric-accounts');
export const saveFabricStripeAccount = (accountId: string) =>
  request<FabricStripeStatus>('/api/admin/stripe/fabric-account', { method: 'PUT', body: JSON.stringify({ accountId }) });

// ── Campaigns (admin) ───────────────────────────────────────────────────────
export const listCampaigns = () => request<Campaign[]>('/api/admin/campaigns');
export const createCampaign = (body: CampaignInput) =>
  request<Campaign>('/api/admin/campaigns', { method: 'POST', body: JSON.stringify(body) });
export const updateCampaign = (id: string, body: CampaignInput) =>
  request<Campaign>(`/api/admin/campaigns/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const deleteCampaign = (id: string) =>
  request<{ ok: true }>(`/api/admin/campaigns/${id}`, { method: 'DELETE' });

// ── Image upload (admin) ────────────────────────────────────────────────────
/** Upload an image file; returns its served URL (e.g. /uploads/img_…png). */
export async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(withBase('/api/admin/upload'), { method: 'POST', body: form });
  const body = (await res.json().catch(() => ({}))) as { data?: { url: string }; error?: string };
  if (!res.ok || body.error || !body.data) throw new Error(body.error || 'Upload failed.');
  return body.data.url;
}

// ── Donations + metrics (admin) ─────────────────────────────────────────────
export const getDonations = () => request<DonationsResult>('/api/admin/donations');
export const getMetrics = () => request<Metrics>('/api/admin/metrics');
export const checkSlug = (slug: string, exceptId?: string) =>
  request<SlugCheck>(
    `/api/admin/campaigns/slug-check?slug=${encodeURIComponent(slug)}${exceptId ? `&exceptId=${encodeURIComponent(exceptId)}` : ''}`,
  );

// ── Monthly plans (recurring donations, admin) ──────────────────────────────
// The INDEX of plans is local (our own recurring donation rows), but the state of each one
// — status, next payment, card, when it ends — is read live from Stripe on request, because
// a masjid box is usually LAN-only and inbound webhooks can't be relied on. So a response
// carries `stripeReachable`: false means the rows below are still real, just showing what we
// know locally (status 'unknown', no next payment) and `message` says so in plain words.

/** One donor's recurring donation. Money figures are MAJOR units, dates ISO ('' = unknown). */
export interface Plan {
  /** The Stripe subscription id — also the key for every action route below. */
  id: string;
  /** Short display reference, from the plan's first donation (e.g. "0065A17F"). */
  ref: string;
  campaignId: string;
  campaignTitle: string;
  donorName: string;
  donorEmail: string;
  /** What is taken each time. */
  amount: number;
  currency: string;
  /** 'day' | 'week' | 'month' | 'year', or '' when we couldn't read it from Stripe. */
  interval: string;
  intervalCount: number;
  /** Ready-made words for the interval: 'Monthly', 'Every 3 months', … ('' when unknown). */
  frequency: string;
  status: 'active' | 'paused' | 'past_due' | 'unpaid' | 'incomplete' | 'trialing' | 'canceled' | 'unknown';
  /** The status in plain warm words — show this, never `status`. */
  statusLabel: string;
  cardBrand: string;
  cardLast4: string;
  startedAt: string;
  lastPaymentAt: string;
  /** '' when paused, stopped, or unknown. */
  nextPaymentAt: string;
  /** Everything this plan has given so far (summed from our own records). */
  collected: number;
  payments: number;
  /** When it stops, if an end is set; '' = it keeps going until stopped. */
  endsAt: string;
  /** True when this row was read from Stripe on this request (not local-only). */
  live: boolean;
}

/** One attempted payment on a plan. */
export interface PlanInvoice {
  id: string;
  number: string;
  date: string;
  amount: number;
  paid: number;
  currency: string;
  status: 'paid' | 'open' | 'draft' | 'void' | 'uncollectible' | 'unknown';
  statusLabel: string;
  attempts: number;
  /** '' or one friendly sentence explaining a failure. */
  failureReason: string;
  /** Stripe-hosted invoice page, or ''. */
  hostedUrl: string;
}

export interface PlansResult {
  plans: Plan[];
  stats: { active: number; plans: number; monthlyTotal: number; collected: number; currency: string };
  stripeReachable: boolean;
  message?: string;
}
export interface PlanDetailResult {
  plan: Plan;
  invoices: PlanInvoice[];
  /** True when the history couldn't be read at all — which is NOT the same as "no payments". */
  historyUnavailable: boolean;
  stripeReachable: boolean;
  message?: string;
}

/** When a plan should stop: never (until stopped by hand), on a date, or after N FURTHER payments. */
export type PlanSchedule =
  | { mode: 'open-ended' }
  | { mode: 'date'; endDate: string } // YYYY-MM-DD
  | { mode: 'count'; count: number }; // further payments, 1..120

/** `refresh` bypasses the server's short-lived cache (a deliberate, slower Stripe round-trip). */
export const getPlans = (refresh?: boolean) =>
  request<PlansResult>(`/api/admin/plans${refresh ? '?refresh=1' : ''}`);
export const getPlan = (id: string) => request<PlanDetailResult>(`/api/admin/plans/${encodeURIComponent(id)}`);
export const pausePlan = (id: string) =>
  request<{ plan: Plan }>(`/api/admin/plans/${encodeURIComponent(id)}/pause`, { method: 'POST', body: JSON.stringify({}) });
export const resumePlan = (id: string) =>
  request<{ plan: Plan }>(`/api/admin/plans/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify({}) });
/** Stops the plan straight away. There is deliberately no "stop at the end of the period"
 *  option: Stripe raises no further invoice for a period-end cancel, so it would take no
 *  extra payment — it would only look as though it did. A masjid that genuinely wants one
 *  more payment first uses `schedulePlanEnd` with `{ mode: 'count', count: 1 }`. */
export const cancelPlan = (id: string) =>
  request<{ plan: Plan }>(`/api/admin/plans/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
export const schedulePlanEnd = (id: string, body: PlanSchedule) =>
  request<{ plan: Plan }>(`/api/admin/plans/${encodeURIComponent(id)}/schedule`, { method: 'POST', body: JSON.stringify(body) });

/** Global large-donation alternative (major units on the client). threshold 0 = off. */
export interface LargeDonation {
  threshold: number;
  message: string;
  qrImage: string;
}

// ── Public donation flow ────────────────────────────────────────────────────
export interface PublicCampaign {
  slug: string;
  title: string;
  type: CampaignType;
  description: string;
  coverImage: string;
  backgroundImage: string;
  logo: string;
  presetAmounts: number[];
  allowCustom: boolean;
  minAmount: number;
  maxAmount: number;
  coverFees: boolean;
  /** Fee is mandatory — show a notice, not an opt-out checkbox. */
  feesForced: boolean;
  giftAid: boolean;
  allowMonthly: boolean;
  goalAmount: number;
  raised: number;
  currency: string;
  masjidName: string;
  masjidLogo: string;
  thankYou: ThankYou; // resolved (campaign override over global default)
  largeDonation?: LargeDonation; // global; advisory dialog above threshold
  /** Present only for a `tuition` campaign (a Students-billing shell). `available` false =
   *  OpenMasjid Students isn't installed / set up / reachable → show a friendly notice, not
   *  the Student ID form. `allowAdvance` = the school takes money with nothing due (so offer
   *  the amount field at a zero balance); `minAmount` is the floor for it, in major units. */
  students?: { available: boolean; schoolName: string; tagline: string; allowAdvance: boolean; minAmount: number };
  publishableKey: string;
  ready: boolean;
  /** Why the page can't take a card, when it can't. The donor is shown one friendly sentence built
   *  from this — never the word "Stripe", never "account". '' when all is well. */
  readyReason?: '' | 'no-account' | 'not-configured' | 'unreachable';
  /** This appeal is on a TEST-mode account: show a clear badge, because a page that looks real and
   *  takes no money is the worst of both (CLAUDE.md §6). */
  testMode?: boolean;
}
export interface IntentResponse {
  clientSecret: string;
  publishableKey: string;
  amount: number;
  currency: string;
  recurring: boolean;
}
export interface ConfirmResponse {
  status: string;
  succeeded: boolean;
  amount: number;
  currency: string;
  campaignTitle: string;
  donorName: string;
  recurring: boolean;
}
/** Build the public campaign API path. New links use the clean /<slug>; an optional
 *  `token` (only present on legacy /c/<slug>-<token> links) is appended for the
 *  server's back-compat resolver. */
const campaignPath = (slug: string, token?: string) =>
  `/api/public/campaign/${encodeURIComponent(slug)}${token ? `/${encodeURIComponent(token)}` : ''}`;

export const getPublicCampaign = (slug: string, token?: string) =>
  request<PublicCampaign>(campaignPath(slug, token));
export const createIntent = (
  slug: string,
  body: { amount: number; coverFees?: boolean; giftAid?: boolean; monthly?: boolean; donorName?: string; donorEmail?: string },
  token?: string,
) =>
  request<IntentResponse>(`${campaignPath(slug, token)}/intent`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
export const confirmDonation = (body: { paymentIntentId: string; slug: string; token?: string }) =>
  request<ConfirmResponse>('/api/public/confirm', { method: 'POST', body: JSON.stringify(body) });

// ── A monthly donor's own "stop these payments" page (/stop/<token>) ─────────
// The donor is emailed this link when their gift is set up; the token is the only credential, so
// it authorises exactly two things — read this description, and stop the payments. Both are POSTs
// with the token in the BODY: no GET may mutate (link-preview bots follow GET links), and it keeps
// the token out of URL logs.

/** What a donor may be told about their own monthly gift. Deliberately thin — the token can be
 *  forwarded or sit in a shared inbox, so there is no donor name, no email, no card and no ids. */
export interface PublicPlan {
  /** The short reference also printed in their email, so the masjid can find it if they ring up. */
  reference: string;
  /** What is taken each time (major units), in the currency it is charged in. */
  amount: number;
  currency: string;
  /** 'Monthly', 'Every 3 months', … or '' when we couldn't read it from Stripe. */
  frequency: string;
  campaignTitle: string;
  /** Relative path to the campaign's donation page ('/zakat'), or '' if it's gone/hidden. */
  campaignPath: string;
  masjidName: string;
  masjidLogo: string;
  contactEmail: string;
  contactPhone: string;
  contactWebsite: string;
  status: 'active' | 'paused' | 'past_due' | 'unpaid' | 'incomplete' | 'trialing' | 'canceled' | 'unknown';
  /** The status in plain warm words — show this, never `status`. */
  statusLabel: string;
  /** '' = we are not saying (unknown, paused, or finished). Never a guessed date. */
  nextPaymentAt: string;
  /** False when Stripe couldn't be read on this request — the page says so and offers a retry. */
  live: boolean;
  /** Is there anything left to stop? */
  canStop: boolean;
}
export interface PublicPlanStopped extends PublicPlan {
  stopped: true;
  /** True when it had already finished before they pressed — so we say "already stopped". */
  alreadyOver: boolean;
}
export const lookupPlan = (token: string) =>
  request<PublicPlan>('/api/public/plan/lookup', { method: 'POST', body: JSON.stringify({ token }) });
export const stopPlan = (token: string) =>
  request<PublicPlanStopped>('/api/public/plan/cancel', { method: 'POST', body: JSON.stringify({ token }) });

// ── Tuition (Students billing) — the `tuition` campaign flow ─────────────────
// Contract students/billing v2: the parent types a Student ID (no PIN), `identify` echoes the
// child's name back for confirmation, and only then does `lookup` reveal the balances.
/** One line of a bill (§11.0b) — e.g. "Monthly tuition" $200 and "Book fee" $50 under the same
 *  February bill. `payable` false = already settled, or a credit line (a bursary or correction,
 *  whose value is already deducted from the lines above): shown for information, never charged. */
export interface StudentInvoiceItemView {
  id: string;
  label: string;
  /** `tuition` | `charge` | `credit`, but an OPEN set — render an unfamiliar kind as a plain line. */
  kind: string;
  amount: number; // what's left on this line, major units
  billed: number; // what it was billed at, major units
  payable: boolean;
}
/** One open invoice a parent can choose to pay (amount in major units). */
export interface StudentInvoiceView {
  id: string;
  label: string;
  /** Which child this bill is for (v2 bills are per child) — a display name, or '' if unknown. */
  student: string;
  /** That child's opaque ref, so bills can be grouped under the child they belong to. */
  studentRef: string;
  dueDate: string;
  amount: number;
  /** The lines this bill is made of. Empty (or a single line) = render it as one row, as before. */
  items: StudentInvoiceItemView[];
}
/** Who a Student ID belongs to: a first name + last initial and nothing else — no balance, no
 *  family, no ids. This confirmation step is what replaced the PIN (contract §11.0). */
export interface StudentIdentity {
  /** The code as the server normalised it — pass this straight to `lookupStudent`. */
  studentCode: string;
  firstName: string;
  /** '' for a child recorded under a single name — render just the given name. */
  lastInitial: string;
}
export interface StudentIdentifyResult {
  found: boolean;
  student?: StudentIdentity;
}
/** The family a confirmed Student ID resolved to. Internal ids stay server-side (in the
 *  session); the browser only gets display data + the opaque `session` used for the pay step. */
export interface StudentLookupResult {
  found: boolean;
  session?: string;
  currency?: string;
  family?: {
    label: string;
    /** One entry per child with what THAT child owes and what they've paid ahead (major
     *  units). Both are non-negative and at most one of the pair is non-zero. `ref` is the
     *  opaque handle to pass back when paying money towards THIS child — with one ledger per
     *  child, "add $50" has to say for whom. */
    students: { ref: string; name: string; firstName: string; lastInitial: string; balance: number; credit: number }[];
    balance: number; // the household total, major units — what "pay full balance" charges
    /** The household's credit — money already paid ahead. A balance of 0 alone can't say
     *  whether a family is square or ahead, and once an advance settles its invoice this is
     *  the only signal left (openInvoices is empty by then). */
    credit: number;
    /** True when EVERY open bill arrived itemised, so the pay step accepts a line selection.
     *  Decided for the whole family: the provider honours ticked lines OR whole invoices, never
     *  a mixture, so the choice can't be made per bill. */
    itemised: boolean;
    openInvoices: StudentInvoiceView[];
  };
}
export interface TuitionIntentResponse {
  clientSecret: string;
  publishableKey: string;
  amount: number;
  currency: string;
}
export interface TuitionConfirmResponse {
  status: string;
  succeeded: boolean;
  amount: number;
  currency: string;
  schoolName: string;
  familyLabel: string;
}
/** What to pay: the whole balance, a chosen set of open invoices, or an amount the parent
 *  typed (an advance or part payment — allowed even with nothing due, when the school takes
 *  them; `amount` is in major units and the server floors it at `students.minAmount`). */
export type TuitionSelection =
  | { kind: 'full' }
  | { kind: 'invoices'; invoiceIds: string[] }
  /** The exact bill lines ticked (§11.0b) — used whenever the family's bills are itemised. */
  | { kind: 'items'; itemIds: string[] }
  /** A typed amount, optionally towards one child (`student` = their ref from the lookup). */
  | { kind: 'amount'; amount: number; student?: string };

/** Step 1: whose Student ID is this? Ask before showing any balance (contract §11.0). */
export const identifyStudent = (slug: string, body: { studentCode: string }) =>
  request<StudentIdentifyResult>(`${campaignPath(slug)}/students/identify`, { method: 'POST', body: JSON.stringify(body) });
/** Step 2, only after the parent confirmed the name: the Student ID alone — no PIN at v2. */
export const lookupStudent = (slug: string, body: { studentCode: string }) =>
  request<StudentLookupResult>(`${campaignPath(slug)}/students/lookup`, { method: 'POST', body: JSON.stringify(body) });
export const createTuitionIntent = (slug: string, body: { session: string; selection: TuitionSelection }) =>
  request<TuitionIntentResponse>(`${campaignPath(slug)}/students/intent`, { method: 'POST', body: JSON.stringify(body) });
export const confirmTuitionPayment = (slug: string, body: { paymentIntentId: string }) =>
  request<TuitionConfirmResponse>(`${campaignPath(slug)}/students/confirm`, { method: 'POST', body: JSON.stringify(body) });

// ── Cloudflare Tunnel (public access) ───────────────────────────────────────
export interface TunnelStatus {
  hasToken: boolean;
  enabled: boolean;
  /** Public address set up in Cloudflare (e.g. give.masjid.org); '' if none. */
  publicHostname: string;
  state: 'stopped' | 'starting' | 'running' | 'error';
  message: string;
}
export const getTunnel = () => request<TunnelStatus>('/api/admin/tunnel');
export const saveTunnel = (body: { token?: string; enabled?: boolean; publicHostname?: string }) =>
  request<TunnelStatus>('/api/admin/tunnel', { method: 'PUT', body: JSON.stringify(body) });

/** Format a major-unit amount in the given currency, e.g. 50 GBP → "£50.00". */
export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}
