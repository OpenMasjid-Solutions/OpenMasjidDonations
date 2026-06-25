/** Stripe helpers. The SECRET key lives only here and in the store — it is never
 *  returned to the browser or logged. The publishable key is the only key the
 *  browser ever sees. The Stripe API version is pinned by the SDK version in
 *  package.json (we don't pass apiVersion, so it can't silently drift). */
import Stripe from 'stripe';
import type { StripeConfig } from './store';

export type StripeMode = 'test' | 'live' | 'unknown';

/** A Stripe client with a sane network timeout + one retry, so a slow/unreachable
 *  Stripe never hangs a donor request (the SDK default is 80s). */
function client(secretKey: string): Stripe {
  return new Stripe(secretKey, { timeout: 20_000, maxNetworkRetries: 1 });
}

const PK_RE = /^pk_(test|live)_[A-Za-z0-9]+$/;
const SK_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/;
const WHSEC_RE = /^whsec_[A-Za-z0-9]+$/;

export function looksLikePublishable(k: string): boolean {
  return PK_RE.test(k);
}
export function looksLikeSecret(k: string): boolean {
  return SK_RE.test(k);
}
export function looksLikeWebhookSecret(k: string): boolean {
  return WHSEC_RE.test(k);
}

/** Test vs live, inferred from the key prefixes (no network call). */
export function stripeMode(cfg: Pick<StripeConfig, 'publishableKey' | 'secretKey'>): StripeMode {
  const k = cfg.secretKey || cfg.publishableKey;
  if (/^[a-z]+_test_/.test(k)) return 'test';
  if (/^[a-z]+_live_/.test(k)) return 'live';
  return 'unknown';
}

/** Configured = a valid-looking publishable + secret pair, in the SAME mode. */
export function stripeConfigured(cfg: StripeConfig): boolean {
  if (!looksLikePublishable(cfg.publishableKey) || !looksLikeSecret(cfg.secretKey)) return false;
  const pkMode = cfg.publishableKey.split('_')[1];
  const skMode = cfg.secretKey.split('_')[1];
  return pkMode === skMode; // both test or both live
}

/** The non-secret view of the Stripe config, safe to send to the browser. */
export function publicStripeStatus(cfg: StripeConfig) {
  return {
    publishableKey: cfg.publishableKey, // safe — the browser needs this
    hasSecretKey: !!cfg.secretKey,
    hasWebhookSecret: !!cfg.webhookSecret,
    mode: stripeMode(cfg),
    configured: stripeConfigured(cfg),
    keysMismatch: !!cfg.publishableKey && !!cfg.secretKey && looksLikePublishable(cfg.publishableKey) && looksLikeSecret(cfg.secretKey) && cfg.publishableKey.split('_')[1] !== cfg.secretKey.split('_')[1],
  };
}

/** Ask Stripe to confirm the secret key actually works (a cheap balance.retrieve).
 *  Returns a friendly result; never throws. */
export async function verifySecretKey(secretKey: string): Promise<{ ok: boolean; mode?: StripeMode; message?: string }> {
  if (!looksLikeSecret(secretKey)) {
    return { ok: false, message: 'That doesn’t look like a Stripe secret key — it should start with sk_.' };
  }
  try {
    const stripe = client(secretKey);
    const balance = await stripe.balance.retrieve();
    return { ok: true, mode: balance.livemode ? 'live' : 'test' };
  } catch (err) {
    const e = err as { type?: string };
    if (e.type === 'StripeAuthenticationError') {
      return { ok: false, message: 'Stripe didn’t accept that secret key. Check you copied the whole key.' };
    }
    return { ok: false, message: 'Couldn’t reach Stripe to check the key. Check your connection and try again.' };
  }
}

// ── Currency minor units ──────────────────────────────────────────────────────
// Stripe charges in the smallest currency unit. Most currencies have 2 decimals,
// but several are zero-decimal (the amount is already the smallest unit).
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** Major units (e.g. 10.50) → minor units (1050), respecting zero-decimal currencies. */
export function toMinor(major: number, currency: string): number {
  return Math.round(major * 10 ** currencyDecimals(currency));
}

/** Minor units → major (for display). */
export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyDecimals(currency);
}

/** Gross up a net amount (minor units) so the masjid receives ~net after Stripe's
 *  fee, when the donor opts to cover fees. The fee model is an approximation
 *  (Stripe's real fee varies by card/country) shown transparently to the donor. */
const FEE_PCT = 0.029; // 2.9%
const FEE_FIXED_MAJOR = 0.3; // + 30¢/30p
export function withCoveredFees(netMinor: number, currency: string): number {
  const fixed = toMinor(FEE_FIXED_MAJOR, currency);
  return Math.round((netMinor + fixed) / (1 - FEE_PCT));
}

// ── Payments ──────────────────────────────────────────────────────────────────
export interface IntentResult {
  id: string;
  clientSecret: string;
}

/** Create a one-time PaymentIntent on the given account. Amount in minor units. */
export async function createPaymentIntent(
  account: StripeConfig,
  amountMinor: number,
  currency: string,
  metadata: Record<string, string>,
  idempotencyKey: string,
): Promise<IntentResult> {
  const stripe = client(account.secretKey);
  const pi = await stripe.paymentIntents.create(
    {
      amount: amountMinor,
      currency: currency.toLowerCase(),
      metadata,
      automatic_payment_methods: { enabled: true },
    },
    { idempotencyKey },
  );
  return { id: pi.id, clientSecret: pi.client_secret ?? '' };
}

export interface SubscriptionResult {
  subscriptionId: string;
  paymentIntentId: string;
  clientSecret: string;
}

/** Create (once) a reusable Stripe Product to hang recurring donation prices off. */
export async function createProduct(account: StripeConfig, name: string): Promise<string> {
  const product = await client(account.secretKey).products.create({ name });
  return product.id;
}

/** Create a monthly (recurring) donation: a Customer + a Subscription with an inline
 *  monthly price (on the given product) for the chosen amount. Returns the first
 *  invoice's PaymentIntent so the donor can confirm it; Stripe then charges monthly. */
export async function createSubscription(
  account: StripeConfig,
  amountMinor: number,
  currency: string,
  email: string,
  name: string,
  productId: string,
  metadata: Record<string, string>,
  idempotencyKey: string,
): Promise<SubscriptionResult> {
  const stripe = client(account.secretKey);
  const customer = await stripe.customers.create(
    { email: email || undefined, name: name || undefined, metadata },
    { idempotencyKey: `${idempotencyKey}:cust` },
  );
  const sub = await stripe.subscriptions.create(
    {
      customer: customer.id,
      items: [
        {
          price_data: {
            currency: currency.toLowerCase(),
            product: productId,
            unit_amount: amountMinor,
            recurring: { interval: 'month' },
          },
        },
      ],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      metadata,
      expand: ['latest_invoice.payment_intent'],
    },
    { idempotencyKey },
  );
  const inv = sub.latest_invoice && typeof sub.latest_invoice !== 'string' ? sub.latest_invoice : null;
  const piRaw = inv ? (inv as { payment_intent?: unknown }).payment_intent : null;
  const pi = piRaw && typeof piRaw !== 'string' ? (piRaw as { id?: string; client_secret?: string }) : null;
  return { subscriptionId: sub.id, paymentIntentId: pi?.id ?? '', clientSecret: pi?.client_secret ?? '' };
}

/** Verify a Stripe webhook signature and return the event, or null if it doesn't
 *  verify. The webhook secret is per-account. */
export function constructWebhookEvent(secretKey: string, rawBody: string, signature: string, webhookSecret: string): Stripe.Event | null {
  try {
    return client(secretKey).webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    return null;
  }
}

export interface RetrievedIntent {
  status: string;
  amount: number;
  currency: string;
  receiptEmail: string;
  billingName: string;
  /** Card brand (e.g. "visa", "mastercard") + last 4 digits, when paid by card. */
  cardBrand: string;
  cardLast4: string;
}

/** Retrieve a PaymentIntent to verify its real status server-side (never trust the
 *  client's word). Returns null on error. */
export async function retrievePaymentIntent(account: StripeConfig, id: string): Promise<RetrievedIntent | null> {
  try {
    const stripe = client(account.secretKey);
    const pi = await stripe.paymentIntents.retrieve(id, { expand: ['latest_charge'] });
    const charge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;
    const card = charge?.payment_method_details?.card ?? null;
    return {
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency.toUpperCase(),
      receiptEmail: pi.receipt_email ?? charge?.billing_details?.email ?? '',
      billingName: charge?.billing_details?.name ?? '',
      cardBrand: card?.brand ?? '',
      cardLast4: card?.last4 ?? '',
    };
  } catch {
    return null;
  }
}
