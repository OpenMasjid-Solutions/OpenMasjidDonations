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
 *  OpenMasjidOS with the Stripe Fabric). `available` false = standalone / not set up. */
export interface FabricStripeStatus {
  available: boolean;
  id?: string;
  label?: string;
  accountName?: string;
  publishableKey?: string;
  hasSecretKey?: boolean;
  hasWebhookSecret?: boolean;
  mode?: StripeMode;
  configured?: boolean;
  keysMismatch?: boolean;
}

export interface Settings {
  masjid: MasjidProfile;
  stripeAccounts: StripeAccount[];
  fabricStripe: FabricStripeStatus;
  onboarded: boolean;
}

export interface Campaign {
  id: string;
  slug: string;
  token: string;
  title: string;
  description: string;
  coverImage: string;
  backgroundImage: string;
  logo: string;
  presetAmounts: number[]; // major units
  allowCustom: boolean;
  minAmount: number;
  maxAmount: number;
  stripeAccountId: string;
  coverFees: boolean;
  giftAid: boolean;
  allowMonthly: boolean;
  goalAmount: number;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  raised: number;
  currency: string;
  url: string;
}
export type CampaignInput = Partial<Omit<Campaign, 'id' | 'token' | 'createdAt' | 'raised' | 'currency' | 'url' | 'sortOrder'>>;

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
}
export interface DonationsResult {
  donations: Donation[];
  stats: { totalRaised: number; count: number; currency: string };
}

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
  totalRaised: number;
  count: number;
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

// ── Public donation flow ────────────────────────────────────────────────────
export interface PublicCampaign {
  slug: string;
  title: string;
  description: string;
  coverImage: string;
  backgroundImage: string;
  logo: string;
  presetAmounts: number[];
  allowCustom: boolean;
  minAmount: number;
  maxAmount: number;
  coverFees: boolean;
  giftAid: boolean;
  allowMonthly: boolean;
  goalAmount: number;
  raised: number;
  currency: string;
  masjidName: string;
  masjidLogo: string;
  publishableKey: string;
  ready: boolean;
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
