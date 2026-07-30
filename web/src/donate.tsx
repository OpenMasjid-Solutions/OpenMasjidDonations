// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The public donation page for a single campaign, at the clean path /<slug>.
 *  Flow: pick an amount → Stripe Payment Element → confirm on return by asking the
 *  server to RETRIEVE the PaymentIntent (never trusting the client) → thank-you. */
import { useEffect, useMemo, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { GraduationCap, HandCoins, HeartHandshake, Lock, Repeat, Search, ShieldCheck, UserCheck } from 'lucide-react';
import {
  confirmDonation,
  confirmTuitionPayment,
  createIntent,
  createTuitionIntent,
  getPublicCampaign,
  identifyStudent,
  lookupStudent,
  money,
  type ConfirmResponse,
  type IntentResponse,
  type PublicCampaign,
  type StudentIdentity,
  type StudentLookupResult,
  type TuitionConfirmResponse,
  type TuitionIntentResponse,
  type TuitionSelection,
} from './api';
import { useReadableTheme } from './prefs';
import { asset } from './base';

/** Sanitise an admin-entered image URL for use in a CSS url()/<img> (accept only
 *  http(s)/data:image; reject quotes, backslashes and whitespace), else ''. A same-origin
 *  uploaded image is prefixed with the tunnel base path so it loads behind the tunnel too. */
function bgUrl(image?: string): string {
  const v = (image ?? '').trim();
  if (/^\/uploads\/[\w.-]+$/.test(v)) return asset(v); // same-origin uploaded image
  return /^(https?:\/\/|data:image\/)/i.test(v) && !/["\\\s]/.test(v) ? v : '';
}

/** The donation page's own background. Unlike the rest of the app it does NOT inherit
 *  the dashboard wallpaper: it shows the campaign's own background image when set, and
 *  otherwise the default theme scene. */
function DonateScene({ image }: { image?: string }) {
  const safe = bgUrl(image);
  if (safe) return <div className="scene-img" aria-hidden="true" style={{ backgroundImage: `url("${safe}")` }} />;
  return <div className="scene" aria-hidden="true" />;
}

// One Stripe instance per publishable key (loadStripe is expensive).
const stripeCache = new Map<string, Promise<Stripe | null>>();
function stripeFor(pk: string): Promise<Stripe | null> {
  let p = stripeCache.get(pk);
  if (!p) {
    p = loadStripe(pk);
    stripeCache.set(pk, p);
  }
  return p;
}

export function DonatePage({ slug, token, widget }: { slug: string; token?: string; widget?: boolean }) {
  const [campaign, setCampaign] = useState<PublicCampaign | null>(null);
  const [loadError, setLoadError] = useState('');
  const [intent, setIntent] = useState<IntentResponse | null>(null);
  const [result, setResult] = useState<ConfirmResponse | null>(null);

  // On the thank-you screen, prefer the thank-you's own background (when set); otherwise
  // the campaign's. The scene + readable theme both follow whatever is actually shown.
  const activeBg = (result && campaign?.thankYou?.backgroundImage) || campaign?.backgroundImage;

  // The public donation page is its own world: pin the scene to the default wallpaper
  // (never the dashboard's inherited one) and pick a theme that reads on the active
  // background — light text on dark images, dark text on light ones, as readable as can be.
  const readable = useReadableTheme(bgUrl(activeBg) || undefined, 'dark');
  useEffect(() => {
    const html = document.documentElement;
    const prevW = html.getAttribute('data-wallpaper');
    const prevT = html.getAttribute('data-theme');
    const prevS = html.getAttribute('data-scene');
    html.setAttribute('data-wallpaper', 'aurora');
    return () => {
      if (prevW) html.setAttribute('data-wallpaper', prevW); else html.removeAttribute('data-wallpaper');
      if (prevT) html.setAttribute('data-theme', prevT); else html.removeAttribute('data-theme');
      if (prevS) html.setAttribute('data-scene', prevS); else html.removeAttribute('data-scene');
    };
  }, []);
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute('data-theme', readable); // card adapts to the campaign background
    if (readable === 'light') html.setAttribute('data-scene', 'light'); // on-scene text too
    else html.removeAttribute('data-scene');
  }, [readable]);

  // Load the campaign on mount / slug change (needed for both the donation flow and the
  // thank-you screen's custom message/accent/background on a redirect return).
  useEffect(() => {
    let cancelled = false;
    getPublicCampaign(slug, token)
      .then((c) => { if (!cancelled) setCampaign(c); })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'This donation page isn’t available.'); });
    return () => { cancelled = true; };
  }, [slug, token]);

  // If Stripe redirected back here (some payment methods do), it appends ?payment_intent=…
  // Confirm it once the campaign is known. Tuition (Students-billing) has its OWN flow +
  // redirect handling inside TuitionShell, so this path only covers donation campaigns.
  useEffect(() => {
    if (!campaign || campaign.type === 'tuition' || result) return;
    const pi = new URLSearchParams(location.search).get('payment_intent');
    if (!pi) return;
    confirmDonation({ paymentIntentId: pi, slug, token })
      .then((r) => { setResult(r); history.replaceState(null, '', location.pathname); })
      .catch(() => setLoadError('We couldn’t confirm your donation. If you were charged, please contact the masjid.'));
  }, [campaign, slug, token, result]);

  return (
    <div className={`shell${widget ? ' shell--widget' : ''}`}>
      <DonateScene image={activeBg} />
      <main className="donate-wrap">
        {result ? (
          <ThankYou result={result} campaign={campaign} />
        ) : loadError ? (
          <section className="glass-raised donate-card">
            <div className="donate-emblem" aria-hidden="true"><HeartHandshake size={30} /></div>
            <h1 className="donate-title">Sorry</h1>
            <p className="muted">{loadError}</p>
          </section>
        ) : !campaign ? (
          <section className="glass-raised donate-card"><span className="spinner" aria-label="Loading" /></section>
        ) : campaign.type === 'tuition' ? (
          <TuitionShell campaign={campaign} />
        ) : intent ? (
          <PayStep campaign={campaign} intent={intent} onBack={() => setIntent(null)} onDone={setResult} />
        ) : (
          <AmountStep campaign={campaign} onIntent={setIntent} />
        )}
        <p className="donate-foot faint">
          <Lock size={11} /> Secured by Stripe · {campaign?.masjidName || 'OpenMasjid Donations'}
        </p>
      </main>
    </div>
  );
}

function AmountStep({ campaign, onIntent }: { campaign: PublicCampaign; onIntent: (i: IntentResponse) => void }) {
  const presets = campaign.presetAmounts.length ? campaign.presetAmounts : [10, 25, 50, 100];
  const [amount, setAmount] = useState<number>(presets[0] ?? 10);
  const [customMode, setCustomMode] = useState(false);
  const [custom, setCustom] = useState('');
  const [frequency, setFrequency] = useState<'once' | 'monthly'>('once');
  const [coverFees, setCoverFees] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmMonthly, setConfirmMonthly] = useState(false);
  const [showLargeGift, setShowLargeGift] = useState(false);

  // Lock background scroll while either dialog is open (no scrollbar behind it).
  useEffect(() => {
    if (!confirmMonthly && !showLargeGift) return;
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { html.style.overflow = prev; };
  }, [confirmMonthly, showLargeGift]);

  // For a forced-fee campaign (Zakat / required Tuition) the fee is always added by the
  // server. Send coverFees:true so the client agrees; the exact total (with the fee) is
  // shown on the payment step. The server enforces it regardless of this flag.
  useEffect(() => { if (campaign.feesForced) setCoverFees(true); }, [campaign.feesForced]);

  const monthly = frequency === 'monthly' && campaign.allowMonthly;
  const effective = customMode ? Number(custom) : amount;
  // The global large-donation nudge, shown whenever a threshold is set (the dialog carries a
  // built-in default message when the admin left the message + QR blank).
  const ld = campaign.largeDonation;
  const largeAlt = !!ld && ld.threshold > 0;
  const fmt = (n: number) => money(n, campaign.currency);
  const amountLabel = (n: number) => `${fmt(n)}${monthly ? ' / month' : ''}`;

  const validate = (): string => {
    if (!campaign.ready) return 'Donations aren’t set up for this page yet.';
    if (!Number.isFinite(effective) || effective <= 0) return 'Please enter an amount.';
    if (campaign.allowCustom && campaign.minAmount && effective < campaign.minAmount) return `The minimum is ${fmt(campaign.minAmount)}.`;
    if (campaign.allowCustom && campaign.maxAmount && effective > campaign.maxAmount) return `The maximum is ${fmt(campaign.maxAmount)}.`;
    if (monthly && !name.trim()) return 'Please add your name — it’s required for a monthly donation.';
    if (monthly && !email.trim()) return 'Please add your email — it’s required for a monthly donation.';
    return '';
  };

  const runIntent = async () => {
    setConfirmMonthly(false);
    setBusy(true);
    setError('');
    try {
      const i = await createIntent(campaign.slug, {
        amount: effective,
        coverFees: coverFees && campaign.coverFees,
        monthly,
        donorName: name.trim() || undefined,
        donorEmail: email.trim() || undefined,
      });
      onIntent(i);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  // Continue past the large-donation nudge — the donor chose to pay by card anyway.
  const proceedDespiteLarge = () => {
    setShowLargeGift(false);
    if (monthly) setConfirmMonthly(true);
    else void runIntent();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const err = validate();
    if (err) return setError(err);
    setError('');
    // Big gifts: gently suggest the fee-free alternative first. The donor can still pay by
    // card (proceedDespiteLarge). Compare the BASE amount, before any fee gross-up.
    if (largeAlt && ld && effective >= ld.threshold) return setShowLargeGift(true);
    // Remind the donor before committing to a recurring charge.
    if (monthly) setConfirmMonthly(true);
    else void runIntent();
  };

  const pct = campaign.goalAmount > 0 ? Math.min(100, Math.round((campaign.raised / campaign.goalAmount) * 100)) : 0;

  return (
    <section className="glass-raised donate-card">
      {bgUrl(campaign.coverImage) ? <img className="donate-cover" src={bgUrl(campaign.coverImage)} alt="" /> : null}
      {bgUrl(campaign.logo || campaign.masjidLogo) ? (
        <img className="donate-logo" src={bgUrl(campaign.logo || campaign.masjidLogo)} alt={campaign.masjidName || 'Logo'} />
      ) : (
        <div className="donate-emblem" aria-hidden="true"><HandCoins size={30} /></div>
      )}
      <h1 className="donate-title">{campaign.title}</h1>
      {campaign.masjidName ? <p className="donate-sub muted">{campaign.masjidName}</p> : null}
      {campaign.description ? <p className="donate-desc">{campaign.description}</p> : null}

      {campaign.goalAmount > 0 && (
        <div className="goal">
          <div className="goal-bar"><div className="goal-fill" style={{ width: `${pct}%` }} /></div>
          <p className="hint">{fmt(campaign.raised)} raised of {fmt(campaign.goalAmount)} goal</p>
        </div>
      )}

      <form onSubmit={submit}>
        {campaign.allowMonthly && (
          <div className="freq-toggle" role="group" aria-label="How often to give">
            <button type="button" className={`freq-opt${!monthly ? ' is-active' : ''}`} onClick={() => setFrequency('once')}>One-time</button>
            <button type="button" className={`freq-opt${monthly ? ' is-active' : ''}`} onClick={() => setFrequency('monthly')}><Repeat size={13} /> Monthly</button>
          </div>
        )}

        <div className="amount-grid">
          {presets.map((p) => (
            <button
              type="button"
              key={p}
              className={`amount-btn${!customMode && amount === p ? ' is-active' : ''}`}
              onClick={() => { setCustomMode(false); setAmount(p); }}
            >
              {fmt(p)}
            </button>
          ))}
          {campaign.allowCustom && (
            <button type="button" className={`amount-btn${customMode ? ' is-active' : ''}`} onClick={() => setCustomMode(true)}>
              Other
            </button>
          )}
        </div>

        {customMode && (
          <div className="field">
            <label className="label" htmlFor="custom">Your amount ({campaign.currency})</label>
            <input id="custom" className="input" type="number" min={campaign.minAmount || 1} step="0.01" inputMode="decimal" value={custom} onChange={(e) => setCustom(e.target.value)} autoFocus />
          </div>
        )}

        <div className="grid2">
          <div className="field">
            <label className="label" htmlFor="dn">{monthly ? 'Your name (required for monthly)' : 'Your name (optional)'}</label>
            <input id="dn" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required={monthly} />
          </div>
          <div className="field">
            <label className="label" htmlFor="de">{monthly ? 'Email (required for monthly)' : 'Email for a receipt (optional)'}</label>
            <input id="de" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required={monthly} />
          </div>
        </div>

        {campaign.feesForced ? (
          // Zakat / required-Tuition: the fee is covered by the donor, no opt-out shown.
          <p className="hint">
            The card fee is added{campaign.type === 'zakat' ? ' (required for Zakat)' : ''} so the masjid receives the full amount.
          </p>
        ) : campaign.coverFees ? (
          <label className="check-row">
            <input type="checkbox" checked={coverFees} onChange={(e) => setCoverFees(e.target.checked)} />
            <span>Add a little to cover card fees, so the masjid receives the full amount.</span>
          </label>
        ) : null}

        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn--primary btn--block donate-cta glow-accent" type="submit" disabled={busy || !campaign.ready}>
          {busy ? <span className="spinner" /> : monthly ? <Repeat size={18} /> : <HeartHandshake size={18} />}
          {Number.isFinite(effective) && effective > 0 ? ` Donate ${amountLabel(effective)}` : ' Donate'}
        </button>
      </form>

      {confirmMonthly && (
        <div className="modal-backdrop" onClick={() => setConfirmMonthly(false)}>
          <div className="modal glass-raised confirm-modal" role="dialog" aria-modal="true" aria-label="Confirm monthly donation" onClick={(e) => e.stopPropagation()}>
            <div className="donate-emblem" aria-hidden="true"><Repeat size={28} /></div>
            <h3 className="donate-title">Set up a monthly donation?</h3>
            <p className="donate-desc">
              You’re about to give <b>{fmt(effective)} every month</b> to {campaign.title}. Your card will be charged
              today and on the same day each month, until you ask the masjid to stop.
            </p>
            <div className="confirm-actions">
              <button className="btn btn--ghost" type="button" onClick={() => setConfirmMonthly(false)}>Cancel</button>
              <button className="btn btn--primary glow-accent" type="button" onClick={runIntent}><Repeat size={16} /> Yes, give monthly</button>
            </div>
          </div>
        </div>
      )}

      {showLargeGift && ld && (
        <div className="modal-backdrop" onClick={() => setShowLargeGift(false)}>
          <div className="modal glass-raised confirm-modal" role="dialog" aria-modal="true" aria-label="A cheaper way to give" onClick={(e) => e.stopPropagation()}>
            <div className="donate-emblem" aria-hidden="true"><HandCoins size={28} /></div>
            <h3 className="donate-title">Before you give {fmt(effective)}</h3>
            <p className="donate-desc">
              {ld.message?.trim() || 'For a gift this size, a bank transfer avoids card fees — so the masjid receives your full donation. You can still pay by card below.'}
            </p>
            {bgUrl(ld.qrImage) ? <img className="donate-cover" src={bgUrl(ld.qrImage)} alt="How to give another way" style={{ maxHeight: '13rem', objectFit: 'contain' }} /> : null}
            <div className="confirm-actions">
              <button className="btn btn--ghost" type="button" onClick={() => setShowLargeGift(false)}>Back</button>
              <button className="btn btn--primary glow-accent" type="button" onClick={proceedDespiteLarge}><HeartHandshake size={16} /> Donate {fmt(effective)} by card</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function PayStep({
  campaign,
  intent,
  onBack,
  onDone,
}: {
  campaign: PublicCampaign;
  intent: IntentResponse;
  onBack: () => void;
  onDone: (r: ConfirmResponse) => void;
}) {
  const stripePromise = useMemo(() => stripeFor(intent.publishableKey), [intent.publishableKey]);
  // Match Stripe's Payment Element to the page's (readability-adjusted) theme.
  const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
  const theme = isLight ? 'stripe' : 'night';

  return (
    <section className="glass-raised donate-card">
      {bgUrl(campaign.logo || campaign.masjidLogo) ? (
        <img className="donate-logo" src={bgUrl(campaign.logo || campaign.masjidLogo)} alt="" />
      ) : (
        <div className="donate-emblem" aria-hidden="true">{intent.recurring ? <Repeat size={30} /> : <HandCoins size={30} />}</div>
      )}
      <h1 className="donate-title">Donate {money(intent.amount, intent.currency)}{intent.recurring ? ' / month' : ''}</h1>
      <p className="donate-sub muted">{campaign.title}{intent.recurring ? ' · monthly' : ''}</p>
      <Elements stripe={stripePromise} options={{ clientSecret: intent.clientSecret, appearance: { theme } }}>
        <PayForm campaign={campaign} intent={intent} onDone={onDone} />
      </Elements>
      <button className="btn btn--ghost btn--sm donate-back" type="button" onClick={onBack}>Change amount</button>
    </section>
  );
}

function PayForm({
  campaign,
  intent,
  onDone,
}: {
  campaign: PublicCampaign;
  intent: IntentResponse;
  onDone: (r: ConfirmResponse) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError('');
    // Confirm; only redirect for methods that require it. Cards resolve inline.
    const { error: err, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${location.origin}${location.pathname}` },
      redirect: 'if_required',
    });
    if (err) {
      setError(err.message || 'Your payment could not be completed.');
      setBusy(false);
      return;
    }
    // Inline success path — verify with the server (it retrieves the intent).
    const piId = paymentIntent?.id ?? '';
    try {
      const r = await confirmDonation({ paymentIntentId: piId, slug: campaign.slug });
      onDone(r);
    } catch {
      setError('Payment taken, but we couldn’t confirm it here. Please contact the masjid if charged.');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="pay-form">
      <PaymentElement />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn btn--primary btn--block donate-cta glow-accent" type="submit" disabled={!stripe || busy}>
        {busy ? <span className="spinner" /> : <Lock size={16} />} Pay {money(intent.amount, intent.currency)}{intent.recurring ? ' / month' : ''}
      </button>
      <p className="hint pay-hint"><ShieldCheck size={12} /> Your card details go straight to Stripe — never to this app.</p>
    </form>
  );
}

/** Substitute the thank-you variables. When {name} is empty, an adjacent comma/space is
 *  cleaned up so "Thank you, {name}!" reads "Thank you!" rather than "Thank you, !". */
function fillVars(tpl: string, v: { name: string; amount: string; campaign: string; masjid: string }): string {
  let out = tpl;
  if (!v.name.trim()) out = out.replace(/,?\s*\{name\}\s*,?/g, ' ');
  out = out
    .replace(/\{name\}/g, v.name)
    .replace(/\{amount\}/g, v.amount)
    .replace(/\{campaign\}/g, v.campaign)
    .replace(/\{masjid\}/g, v.masjid);
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([!?.,])/g, '$1').trim();
}

function ThankYou({ result, campaign }: { result: ConfirmResponse; campaign: PublicCampaign | null }) {
  const ok = result.succeeded;
  const t = campaign?.thankYou;
  const vars = {
    name: result.donorName || '',
    amount: money(result.amount, result.currency),
    campaign: result.campaignTitle,
    masjid: campaign?.masjidName || '',
  };
  // Accent override (a hex like #1FA37A) tints the emblem + heading on success.
  const accent = ok && t?.accent && /^#[0-9a-fA-F]{3,8}$/.test(t.accent.trim()) ? t.accent.trim() : '';
  // Fill the template, then fall back if it resolved to empty (e.g. a heading of just "{name}"
  // with no donor name). For non-success states the heading is fixed.
  const heading = ok ? fillVars(t?.heading || 'JazākAllāhu khayran!', vars) || 'JazākAllāhu khayran!' : 'Thank you';
  const message = fillVars(t?.message || 'Your donation of {amount} to {campaign} was received. May Allah accept it and reward you.', vars) || 'May Allah accept it and reward you.';
  return (
    <section className="glass-raised donate-card donate-thanks" style={accent ? ({ ['--color-accent' as string]: accent }) : undefined}>
      <div className={`donate-emblem${ok ? ' is-success' : ''}`} aria-hidden="true" style={accent ? { color: accent } : undefined}>
        <HeartHandshake size={34} />
      </div>
      <h1 className="donate-title" style={accent ? { color: accent } : undefined}>{heading}</h1>
      {ok ? (
        <>
          <p className="donate-desc">{message}</p>
          {result.recurring && <p className="donate-desc"><b>This is a monthly donation</b> — it'll repeat automatically until you cancel.</p>}
        </>
      ) : result.status === 'processing' ? (
        <p className="donate-desc">Your payment is processing. You’ll receive confirmation shortly, in shā’ Allah.</p>
      ) : (
        <p className="donate-desc">Your payment didn’t complete. No charge was made — you’re welcome to try again.</p>
      )}
    </section>
  );
}

// ── Tuition (Students billing) ───────────────────────────────────────────────
// A `tuition` campaign is a thin shell around OpenMasjid Students (contract v2): Student ID →
// "is this <child>?" → the family's balances (fetched over the OS Fabric) → pay all or pick
// months → Stripe → recorded in the Students ledger. There is no PIN: the parent confirming
// the child's name is the safeguard that replaced it, so we never call `lookup` before that
// confirmation. Everything says "payment", never "donation" (tuition isn't a gift).

/** A child's display name. A first name + last initial is all the contract ever returns, and a
 *  child recorded under a single name comes back with no initial — show just the given name. */
const childName = (st: { firstName: string; lastInitial: string }): string =>
  st.lastInitial ? `${st.firstName} ${st.lastInitial}.` : st.firstName;

/** What to pay: the whole balance, particular lines/months, or an amount the parent types (an
 *  advance or part payment — the only option when there's nothing due). */
type PayMode = 'full' | 'pick' | 'amount';

/** The tickable rows on the "choose what to pay" list. When a family's bills are itemised
 *  (§11.0b) a row is one LINE of a bill — "Book fee", $50 — so a parent can pay the book fee
 *  without the month's tuition. Otherwise a row is a whole bill, exactly as before. Settled and
 *  credit lines are never rows: they're shown for information and can't be charged. */
const payableRowKeys = (f: NonNullable<StudentLookupResult['family']>): string[] =>
  f.itemised
    ? f.openInvoices.flatMap((inv) => inv.items.filter((it) => it.payable).map((it) => it.id))
    : f.openInvoices.map((inv) => inv.id);

function TuitionShell({ campaign }: { campaign: PublicCampaign }) {
  const [code, setCode] = useState('');
  const [student, setStudent] = useState<StudentIdentity | null>(null); // the child awaiting confirmation
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [lookup, setLookup] = useState<StudentLookupResult | null>(null);
  const [mode, setMode] = useState<PayMode>('full');
  const [custom, setCustom] = useState(''); // the typed amount, major units
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [intent, setIntent] = useState<TuitionIntentResponse | null>(null);
  const [result, setResult] = useState<TuitionConfirmResponse | null>(null);
  const [confirming, setConfirming] = useState(
    () => typeof location !== 'undefined' && !!new URLSearchParams(location.search).get('payment_intent'),
  );

  const fam = lookup?.family;
  const ccy = lookup?.currency || campaign.currency;
  const fmt = (n: number) => money(n, ccy);
  const school = campaign.students?.schoolName || campaign.title;

  // A redirect-return (some payment methods bounce back with ?payment_intent=): confirm it.
  useEffect(() => {
    const pi = new URLSearchParams(location.search).get('payment_intent');
    if (!pi) return;
    confirmTuitionPayment(campaign.slug, { paymentIntentId: pi })
      .then((r) => { setResult(r); history.replaceState(null, '', location.pathname); })
      .catch(() => setError('We couldn’t confirm your payment. If you were charged, please contact the school.'))
      .finally(() => setConfirming(false));
  }, [campaign.slug]);

  const minAmount = campaign.students?.minAmount || 1;
  const canAdvance = !!campaign.students?.allowAdvance;
  const typedAmount = Number.parseFloat(custom);
  // Every tickable row with its amount, whether that's a bill line or a whole bill. The amounts
  // are only for the running total the parent sees — the server recomputes the charge from its
  // own copy of the session, so a tampered figure here buys nothing.
  const payRows: { key: string; amount: number }[] = !fam
    ? []
    : fam.itemised
      ? fam.openInvoices.flatMap((inv) => inv.items.filter((it) => it.payable).map((it) => ({ key: it.id, amount: it.amount })))
      : fam.openInvoices.map((inv) => ({ key: inv.id, amount: inv.amount }));
  const pickedKeys = payRows.filter((r) => checked[r.key]).map((r) => r.key);
  const selectionAmount = !fam
    ? 0
    : mode === 'full'
      ? fam.balance
      : mode === 'pick'
        ? payRows.filter((r) => checked[r.key]).reduce((s, r) => s + r.amount, 0)
        : Number.isFinite(typedAmount) && typedAmount > 0
          ? typedAmount
          : 0;

  // Step 1 — who does this Student ID belong to? No balance is revealed yet.
  const runIdentify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return setError('Please enter the Student ID.');
    setBusy(true); setError(''); setNotFound(false);
    try {
      const r = await identifyStudent(campaign.slug, { studentCode: code.trim() });
      if (!r.found || !r.student) setNotFound(true);
      else setStudent(r.student);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tuition payments are temporarily unavailable.');
    } finally { setBusy(false); }
  };

  // Step 2 — the parent said "yes, that's my child", so now fetch the balances. A not-found
  // here (the code was locked or switched off between the two calls) returns them to the ID
  // step with the same uniform message, never a hint about what changed.
  const confirmStudent = async () => {
    if (!student) return;
    setBusy(true); setError('');
    try {
      const r = await lookupStudent(campaign.slug, { studentCode: student.studentCode });
      if (!r.found || !r.session || !r.family) { setStudent(null); setNotFound(true); }
      else {
        setLookup(r);
        // Everything starts ticked, so switching to "choose what to pay" and paying the lot stays
        // one tap — a parent unticks the lines they're not paying rather than hunting for the ones
        // they are.
        setChecked(Object.fromEntries(payableRowKeys(r.family).map((k) => [k, true])));
        // With something due, start on "pay the balance"; with nothing due, the only thing to
        // offer is an advance. Either way the amount field is pre-filled with the balance when
        // there is one and left blank when there isn't (§11.0a).
        const bal = r.family.balance;
        setMode(bal > 0 ? 'full' : 'amount');
        setCustom(bal > 0 ? String(bal) : '');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tuition payments are temporarily unavailable.');
    } finally { setBusy(false); }
  };

  /** Back to the ID field keeping what was typed (so a typo is a quick fix, not a retype). */
  const editCode = () => { setStudent(null); setError(''); };
  /** Back to a clean ID field — a different child entirely. */
  const startOver = () => { setLookup(null); setStudent(null); setCode(''); setNotFound(false); setError(''); setCustom(''); };

  const startPayment = async () => {
    if (!fam || !lookup?.session) return;
    if (mode === 'pick' && pickedKeys.length === 0) return setError('Please choose at least one item to pay.');
    if (mode === 'amount') {
      if (!Number.isFinite(typedAmount) || typedAmount <= 0) return setError('Please enter an amount.');
      // The school's own floor, so a parent is stopped here by a friendly line rather than by
      // a card decline. The server re-checks it against its own copy.
      if (typedAmount < minAmount) return setError(`The smallest payment we can take is ${money(minAmount, ccy)}.`);
    }
    const selection: TuitionSelection =
      mode === 'full'
        ? { kind: 'full' }
        : mode === 'pick'
          ? // Itemised bills pay by LINE (the ticked line is the one Students settles, and stays
            // settled); otherwise by whole bill, as before.
            fam.itemised
            ? { kind: 'items', itemIds: pickedKeys }
            : { kind: 'invoices', invoiceIds: pickedKeys }
          : { kind: 'amount', amount: typedAmount };
    setBusy(true); setError('');
    try {
      setIntent(await createTuitionIntent(campaign.slug, { session: lookup.session, selection }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally { setBusy(false); }
  };

  const Emblem = () =>
    bgUrl(campaign.logo || campaign.masjidLogo) ? (
      <img className="donate-logo" src={bgUrl(campaign.logo || campaign.masjidLogo)} alt="" />
    ) : (
      <div className="donate-emblem" aria-hidden="true"><GraduationCap size={30} /></div>
    );

  if (result) return <TuitionThanks result={result} />;
  if (confirming) return <section className="glass-raised donate-card"><span className="spinner" aria-label="Confirming your payment" /></section>;

  // Students not installed / set up / reachable → a friendly notice, never the ID form.
  if (!campaign.students?.available) {
    return (
      <section className="glass-raised donate-card">
        <div className="donate-emblem" aria-hidden="true"><GraduationCap size={30} /></div>
        <h1 className="donate-title">{campaign.title}</h1>
        <p className="muted">Tuition payments aren’t available right now. Please check back shortly, or contact the school office.</p>
      </section>
    );
  }

  if (intent) return <TuitionPayStep campaign={campaign} intent={intent} label={fam?.label ?? ''} onBack={() => setIntent(null)} onDone={setResult} />;

  // Balance step — the family's balance + selectable open invoices.
  if (fam) {
    return (
      <section className="glass-raised donate-card">
        <Emblem />
        <h1 className="donate-title">{fam.label || school}</h1>
        {school && school !== fam.label ? <p className="donate-sub muted">{school}</p> : null}
        {/* The child (or, with siblings, each child and where they stand) so the parent can see
            it's the right family. First name + last initial only, always plain text. */}
        {fam.students.length === 1 && <p className="donate-sub muted">{childName(fam.students[0])}</p>}
        {/* A balance of zero means two different things — square, or paid ahead — so say which.
            Credit isn't a footnote here: once an advance settles its invoice it's the only
            record of it the parent can see (there are no open months left to show). */}
        {fam.balance > 0 ? (
          <p className="donate-desc">Balance due: <b>{fmt(fam.balance)}</b></p>
        ) : fam.credit > 0 ? (
          <p className="donate-desc">Nothing due — you’re <b>{fmt(fam.credit)}</b> in credit, which comes off the next bill.</p>
        ) : (
          <p className="donate-desc">Nothing due right now. JazākAllāhu khayran.</p>
        )}
        {fam.students.length > 1 && (
          // v2 bills each child separately, so a household total can't say who is behind or
          // ahead — show each child, and whether their figure is owed or in credit.
          <div style={{ display: 'grid', gap: '0.2rem', marginBlockEnd: '0.6rem' }}>
            {fam.students.map((st, i) => (
              <div className="row-between hint" key={`${st.firstName}-${i}`}>
                <span>{childName(st)}</span>
                <span>{st.credit > 0 ? `${fmt(st.credit)} in credit` : st.balance > 0 ? fmt(st.balance) : 'nothing due'}</span>
              </div>
            ))}
          </div>
        )}
        {/* What to pay. "Choose what to pay" only exists when there are months to tick, and
            "Another amount" only when the school takes payments in advance. */}
        {(fam.openInvoices.length > 0 || canAdvance) && fam.balance > 0 && (
          <div className="freq-toggle" role="group" aria-label="What to pay">
            <button type="button" className={`freq-opt${mode === 'full' ? ' is-active' : ''}`} onClick={() => setMode('full')}>Pay the balance</button>
            {fam.openInvoices.length > 0 && (
              <button type="button" className={`freq-opt${mode === 'pick' ? ' is-active' : ''}`} onClick={() => setMode('pick')}>Choose what to pay</button>
            )}
            {canAdvance && (
              <button type="button" className={`freq-opt${mode === 'amount' ? ' is-active' : ''}`} onClick={() => setMode('amount')}>Another amount</button>
            )}
          </div>
        )}
        {mode === 'pick' && (
          <div style={{ display: 'grid', gap: '0.4rem', marginBlock: '0.4rem' }}>
            {fam.openInvoices.map((inv) => {
              const sub = `${inv.student ? `${inv.student}` : ''}${inv.student && inv.dueDate ? ' · ' : ''}${inv.dueDate ? `due ${inv.dueDate}` : ''}`;
              // A bill of one line needs no breakdown — one row, exactly as before. More than one
              // and the bill becomes a heading with its lines beneath it, so "$200 tuition + $50
              // book fee" can be paid separately instead of only as $250.
              const itemised = fam.itemised && inv.items.length > 1;
              if (!itemised) {
                return (
                  <label key={inv.id} className="check-row">
                    <input
                      type="checkbox"
                      checked={!!checked[fam.itemised ? (inv.items.find((i) => i.payable)?.id ?? inv.id) : inv.id]}
                      onChange={(e) => {
                        const key = fam.itemised ? (inv.items.find((i) => i.payable)?.id ?? inv.id) : inv.id;
                        setChecked((c) => ({ ...c, [key]: e.target.checked }));
                      }}
                    />
                    <span>{inv.label}{sub ? ` · ${sub}` : ''} — <b>{fmt(inv.amount)}</b></span>
                  </label>
                );
              }
              return (
                <div key={inv.id} style={{ display: 'grid', gap: '0.15rem' }}>
                  <p className="hint" style={{ marginBlock: '0.25rem 0', fontWeight: 600 }}>
                    {inv.label}{sub ? ` · ${sub}` : ''}
                  </p>
                  <div style={{ paddingInlineStart: '0.35rem' }}>
                    {inv.items.map((it) =>
                      it.payable ? (
                        <label key={it.id} className="check-row">
                          <input type="checkbox" checked={!!checked[it.id]} onChange={(e) => setChecked((c) => ({ ...c, [it.id]: e.target.checked }))} />
                          <span>{it.label} — <b>{fmt(it.amount)}</b></span>
                        </label>
                      ) : (
                        // Settled lines and credit lines are both unpayable. Shown, not hidden: on
                        // a part-paid bill "already paid" is the answer to "why is this less than
                        // I remember", and a bursary is why the total is lower than the fees.
                        <p key={it.id} className="hint" style={{ marginBlock: '0.3rem', paddingInlineStart: '1.35rem' }}>
                          {it.label} — {it.kind === 'credit' ? (it.billed !== 0 ? fmt(it.billed) : 'credit applied') : 'already paid'}
                        </p>
                      ),
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {mode === 'amount' && canAdvance && (
          <div className="field">
            <label className="label" htmlFor="tamt">Amount to pay ({ccy})</label>
            <input
              id="tamt"
              className="input"
              type="number"
              min={minAmount}
              step="0.01"
              inputMode="decimal"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              autoFocus={fam.balance <= 0}
            />
            <p className="hint">
              {fam.balance > 0
                ? `Pay part of the balance, or more to build up credit. Smallest payment ${money(minAmount, ccy)}.`
                : `Paying ahead is fine — it sits as credit and comes off the next bill. Smallest payment ${money(minAmount, ccy)}.`}
            </p>
          </div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        {/* Nothing due AND the school doesn't take money in advance → there is genuinely nothing
            to offer, so say so instead of a dead "Pay 0" button. A zero selection while ticking
            months keeps the button (disabled), which reads as "tick one". */}
        {fam.balance <= 0 && !canAdvance ? (
          <p className="hint">This school isn’t taking payments in advance right now — there’s nothing to pay today.</p>
        ) : (
          <button className="btn btn--primary btn--block donate-cta glow-accent" type="button" disabled={busy || !campaign.ready || selectionAmount <= 0} onClick={startPayment}>
            {busy ? <span className="spinner" /> : <Lock size={16} />} Pay {fmt(selectionAmount)}
          </button>
        )}
        <button className="btn btn--ghost btn--sm donate-back" type="button" onClick={startOver}>Look up a different student</button>
      </section>
    );
  }

  // Confirmation step — echo the child's name back BEFORE any balance appears. This is the
  // safeguard that replaced the PIN: it catches the realistic failure, a mistyped ID.
  if (student) {
    return (
      <section className="glass-raised donate-card">
        <Emblem />
        <h1 className="donate-title">Is this {childName(student)}?</h1>
        <p className="donate-desc">
          Student ID <b>{student.studentCode}</b>. If that’s your child, continue to see the balance and pay.
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn--primary btn--block donate-cta glow-accent" type="button" disabled={busy} onClick={confirmStudent}>
          {busy ? <span className="spinner" /> : <UserCheck size={18} />} Yes, show the balance
        </button>
        <button className="btn btn--ghost btn--sm donate-back" type="button" onClick={editCode}>No — check the Student ID</button>
      </section>
    );
  }

  // Student ID step — one field, nothing else (no PIN at v2, no amount box ever).
  return (
    <section className="glass-raised donate-card">
      <Emblem />
      <h1 className="donate-title">{campaign.title}</h1>
      {school && school !== campaign.title ? <p className="donate-sub muted">{school}</p> : null}
      <p className="donate-desc">{campaign.students.tagline || 'Enter your child’s Student ID to see your balance and pay.'}</p>
      <form onSubmit={runIdentify}>
        <div className="field">
          <label className="label" htmlFor="scode">Student ID</label>
          <input
            id="scode"
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={32}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus
          />
          <p className="hint">It’s on your statement — three letters and four numbers, like YUS1234.</p>
        </div>
        {notFound && <p className="hint" role="alert">We couldn’t find that Student ID. Please check it, or ask the school office.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn--primary btn--block donate-cta glow-accent" type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : <Search size={18} />} Find my balance
        </button>
      </form>
    </section>
  );
}

function TuitionPayStep({ campaign, intent, label, onBack, onDone }: {
  campaign: PublicCampaign; intent: TuitionIntentResponse; label: string; onBack: () => void; onDone: (r: TuitionConfirmResponse) => void;
}) {
  const stripePromise = useMemo(() => stripeFor(intent.publishableKey), [intent.publishableKey]);
  const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
  const theme = isLight ? 'stripe' : 'night';
  return (
    <section className="glass-raised donate-card">
      <div className="donate-emblem" aria-hidden="true"><GraduationCap size={30} /></div>
      <h1 className="donate-title">Pay {money(intent.amount, intent.currency)}</h1>
      {label ? <p className="donate-sub muted">{label}</p> : null}
      <Elements stripe={stripePromise} options={{ clientSecret: intent.clientSecret, appearance: { theme } }}>
        <TuitionPayForm campaign={campaign} intent={intent} onDone={onDone} />
      </Elements>
      <button className="btn btn--ghost btn--sm donate-back" type="button" onClick={onBack}>Back</button>
    </section>
  );
}

function TuitionPayForm({ campaign, intent, onDone }: {
  campaign: PublicCampaign; intent: TuitionIntentResponse; onDone: (r: TuitionConfirmResponse) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true); setError('');
    const { error: err, paymentIntent } = await stripe.confirmPayment({
      elements, confirmParams: { return_url: `${location.origin}${location.pathname}` }, redirect: 'if_required',
    });
    if (err) { setError(err.message || 'Your payment could not be completed.'); setBusy(false); return; }
    try {
      onDone(await confirmTuitionPayment(campaign.slug, { paymentIntentId: paymentIntent?.id ?? '' }));
    } catch {
      setError('Payment taken, but we couldn’t confirm it here. Please contact the school if charged.');
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="pay-form">
      <PaymentElement />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn btn--primary btn--block donate-cta glow-accent" type="submit" disabled={!stripe || busy}>
        {busy ? <span className="spinner" /> : <Lock size={16} />} Pay {money(intent.amount, intent.currency)}
      </button>
      <p className="hint pay-hint"><ShieldCheck size={12} /> Your card details go straight to Stripe — never to this app.</p>
    </form>
  );
}

function TuitionThanks({ result }: { result: TuitionConfirmResponse }) {
  const ok = result.succeeded;
  return (
    <section className="glass-raised donate-card donate-thanks">
      <div className={`donate-emblem${ok ? ' is-success' : ''}`} aria-hidden="true"><GraduationCap size={34} /></div>
      <h1 className="donate-title">{ok ? 'Payment received' : 'Payment not completed'}</h1>
      {ok ? (
        <p className="donate-desc">
          Your payment of {money(result.amount, result.currency)}{result.schoolName ? ` to ${result.schoolName}` : ''} has been recorded. JazākAllāhu khayran.
        </p>
      ) : result.status === 'processing' ? (
        <p className="donate-desc">Your payment is processing. You’ll receive confirmation shortly, in shā’ Allah.</p>
      ) : (
        <p className="donate-desc">Your payment didn’t complete. No charge was made — you’re welcome to try again.</p>
      )}
    </section>
  );
}
