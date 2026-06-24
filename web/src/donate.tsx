/** The public donation page for a single campaign, at the clean path /<slug>.
 *  Flow: pick an amount → Stripe Payment Element → confirm on return by asking the
 *  server to RETRIEVE the PaymentIntent (never trusting the client) → thank-you. */
import { useEffect, useMemo, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { HandCoins, HeartHandshake, Lock, ShieldCheck } from 'lucide-react';
import {
  confirmDonation,
  createIntent,
  getPublicCampaign,
  money,
  type ConfirmResponse,
  type IntentResponse,
  type PublicCampaign,
} from './api';
import { resolveTheme, usePrefs } from './prefs';

/** The donation page's own background. Unlike the rest of the app it does NOT inherit
 *  the dashboard wallpaper: it shows the campaign's own background image when set, and
 *  otherwise the default theme scene. The URL can be admin-entered, so sanitise it
 *  before putting it in a CSS url() (accept only http(s)/data:image; reject quotes,
 *  backslashes and whitespace). */
function DonateScene({ image }: { image?: string }) {
  const v = (image ?? '').trim();
  const safe = /^(https?:\/\/|data:image\/)/i.test(v) && !/["\\\s]/.test(v) ? v : '';
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

export function DonatePage({ slug, token }: { slug: string; token?: string }) {
  const [campaign, setCampaign] = useState<PublicCampaign | null>(null);
  const [loadError, setLoadError] = useState('');
  const [intent, setIntent] = useState<IntentResponse | null>(null);
  const [result, setResult] = useState<ConfirmResponse | null>(null);

  // The public donation page is its own world: pin the scene to the default wallpaper
  // so it never shows the dashboard's inherited wallpaper. The actual backdrop is the
  // campaign's own background image (or the default theme scene) via <DonateScene>.
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.getAttribute('data-wallpaper');
    html.setAttribute('data-wallpaper', 'aurora');
    return () => {
      if (prev) html.setAttribute('data-wallpaper', prev);
      else html.removeAttribute('data-wallpaper');
    };
  }, []);

  // If Stripe redirected back here (some payment methods do), it appends
  // ?payment_intent=…&redirect_status=…. Confirm it with the server on mount.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const pi = params.get('payment_intent');
    if (pi) {
      confirmDonation({ paymentIntentId: pi, slug, token })
        .then((r) => {
          setResult(r);
          history.replaceState(null, '', location.pathname); // drop the query
        })
        .catch(() => setLoadError('We couldn’t confirm your donation. If you were charged, please contact the masjid.'));
      return;
    }
    getPublicCampaign(slug, token)
      .then(setCampaign)
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'This donation page isn’t available.'));
  }, [slug, token]);

  return (
    <div className="shell">
      <DonateScene image={campaign?.backgroundImage} />
      <main className="donate-wrap">
        {result ? (
          <ThankYou result={result} />
        ) : loadError ? (
          <section className="glass-raised donate-card">
            <div className="donate-emblem" aria-hidden="true"><HeartHandshake size={30} /></div>
            <h1 className="donate-title">Sorry</h1>
            <p className="muted">{loadError}</p>
          </section>
        ) : !campaign ? (
          <section className="glass-raised donate-card"><span className="spinner" aria-label="Loading" /></section>
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
  const [coverFees, setCoverFees] = useState(false);
  const [giftAid, setGiftAid] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const effective = customMode ? Number(custom) : amount;
  const fmt = (n: number) => money(n, campaign.currency);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!campaign.ready) return setError('Donations aren’t set up for this page yet.');
    if (!Number.isFinite(effective) || effective <= 0) return setError('Please enter an amount.');
    if (campaign.allowCustom && campaign.minAmount && effective < campaign.minAmount)
      return setError(`The minimum is ${fmt(campaign.minAmount)}.`);
    if (campaign.allowCustom && campaign.maxAmount && effective > campaign.maxAmount)
      return setError(`The maximum is ${fmt(campaign.maxAmount)}.`);
    setBusy(true);
    try {
      const i = await createIntent(campaign.slug, {
        amount: effective,
        coverFees: coverFees && campaign.coverFees,
        giftAid: giftAid && campaign.giftAid,
        donorName: name.trim() || undefined,
        donorEmail: email.trim() || undefined,
      });
      onIntent(i);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  const pct = campaign.goalAmount > 0 ? Math.min(100, Math.round((campaign.raised / campaign.goalAmount) * 100)) : 0;

  return (
    <section className="glass-raised donate-card">
      {campaign.coverImage ? <img className="donate-cover" src={campaign.coverImage} alt="" /> : null}
      <div className="donate-emblem" aria-hidden="true"><HandCoins size={30} /></div>
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
            <label className="label" htmlFor="dn">Your name (optional)</label>
            <input id="dn" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </div>
          <div className="field">
            <label className="label" htmlFor="de">Email for a receipt (optional)</label>
            <input id="de" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
        </div>

        {campaign.coverFees && (
          <label className="check-row">
            <input type="checkbox" checked={coverFees} onChange={(e) => setCoverFees(e.target.checked)} />
            <span>Add a little to cover card fees, so the masjid receives the full amount.</span>
          </label>
        )}
        {campaign.giftAid && (
          <label className="check-row">
            <input type="checkbox" checked={giftAid} onChange={(e) => setGiftAid(e.target.checked)} />
            <span>I’m a UK taxpayer — Gift Aid my donation (the masjid can reclaim 25%).</span>
          </label>
        )}

        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn--primary btn--block donate-cta glow-accent" type="submit" disabled={busy || !campaign.ready}>
          {busy ? <span className="spinner" /> : <HeartHandshake size={18} />}
          {Number.isFinite(effective) && effective > 0 ? ` Donate ${fmt(effective)}` : ' Donate'}
        </button>
      </form>
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
  const prefs = usePrefs();
  const stripePromise = useMemo(() => stripeFor(intent.publishableKey), [intent.publishableKey]);
  const theme = resolveTheme(prefs.theme) === 'light' ? 'stripe' : 'night';

  return (
    <section className="glass-raised donate-card">
      <div className="donate-emblem" aria-hidden="true"><HandCoins size={30} /></div>
      <h1 className="donate-title">Donate {money(intent.amount, intent.currency)}</h1>
      <p className="donate-sub muted">{campaign.title}</p>
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
        {busy ? <span className="spinner" /> : <Lock size={16} />} Pay {money(intent.amount, intent.currency)}
      </button>
      <p className="hint pay-hint"><ShieldCheck size={12} /> Your card details go straight to Stripe — never to this app.</p>
    </form>
  );
}

function ThankYou({ result }: { result: ConfirmResponse }) {
  const ok = result.succeeded;
  return (
    <section className="glass-raised donate-card donate-thanks">
      <div className={`donate-emblem${ok ? ' is-success' : ''}`} aria-hidden="true">
        <HeartHandshake size={34} />
      </div>
      <h1 className="donate-title">{ok ? 'JazākAllāhu khayran!' : 'Thank you'}</h1>
      {ok ? (
        <p className="donate-desc">
          Your donation of <b>{money(result.amount, result.currency)}</b> to <b>{result.campaignTitle}</b> was received.
          May Allah accept it and reward you.
        </p>
      ) : result.status === 'processing' ? (
        <p className="donate-desc">Your payment is processing. You’ll receive confirmation shortly, in shā’ Allah.</p>
      ) : (
        <p className="donate-desc">Your payment didn’t complete. No charge was made — you’re welcome to try again.</p>
      )}
    </section>
  );
}
