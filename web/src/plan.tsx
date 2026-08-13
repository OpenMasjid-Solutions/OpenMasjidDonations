// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * A monthly donor's own page for stopping their payments, at /stop/<token>.
 *
 * The token comes from the link in the email they were sent when the gift was set up. There is no
 * sign-in, so this page is written for a stranger who may be worried: it says plainly what is
 * running, changes nothing until they press the button, asks once, and never shows them a code.
 *
 * Deliberately its OWN lazy chunk, separate from donate.tsx: that module pulls in Stripe.js, and
 * nobody stopping a payment needs a card field. It carries no admin chrome either — no Brand, no
 * Clock, no account menu — for the same reason the donation page doesn't.
 *
 * The words follow one rule: "monthly donation" and "these payments", never "plan",
 * "subscription", "unsubscribe" or "token". A donor is not administering anything.
 */
import { useEffect, useState } from 'react';
import { CalendarClock, HeartHandshake, Lock, Repeat, ShieldCheck, XCircle } from 'lucide-react';
import { lookupPlan, money, stopPlan, type PublicPlan } from './api';
import { asset, withBase } from './base';

/** "3 September 2026" in the READER's own locale — they are the one watching their bank. '' in, '' out. */
function fmtDay(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** The masjid's contact details as one sentence, or '' when they've set none. */
function contactSentence(p: PublicPlan): string {
  const bits = [p.contactEmail, p.contactPhone].filter((s) => s.trim());
  if (!bits.length) return '';
  return `${p.masjidName || 'the masjid'} — ${bits.join(' · ')}`;
}

/** One label/value row. Label and value are separate cells, so RTL is a layout concern rather than
 *  a grammar one. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{value}</span>
    </div>
  );
}

/** A same-origin uploaded logo needs the tunnel base path; an external one is used as-is. Anything
 *  that isn't a plain http(s) or /uploads path is dropped rather than rendered. */
function logoSrc(v: string): string {
  const s = (v ?? '').trim();
  if (/^\/uploads\/[\w.-]+$/.test(s)) return asset(s);
  return /^https?:\/\//i.test(s) && !/["\\\s]/.test(s) ? s : '';
}

export function PlanStopPage({ token }: { token: string }) {
  const [plan, setPlan] = useState<PublicPlan | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopError, setStopError] = useState('');
  const [stopped, setStopped] = useState(false);
  const [alreadyOver, setAlreadyOver] = useState(false);

  // This page is its own world, like the donation page: the default scene, never the dashboard's
  // inherited wallpaper (a donor has no dashboard), and the dark theme the scene is designed for.
  useEffect(() => {
    const html = document.documentElement;
    const prevW = html.getAttribute('data-wallpaper');
    const prevT = html.getAttribute('data-theme');
    html.setAttribute('data-wallpaper', 'aurora');
    html.setAttribute('data-theme', 'dark');
    return () => {
      if (prevW) html.setAttribute('data-wallpaper', prevW); else html.removeAttribute('data-wallpaper');
      if (prevT) html.setAttribute('data-theme', prevT); else html.removeAttribute('data-theme');
    };
  }, []);

  const load = () => {
    setStopError('');
    lookupPlan(token)
      .then((p) => { setPlan(p); setNotFound(false); })
      .catch(() => setNotFound(true));
  };
  useEffect(load, [token]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setAsking(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const doStop = async () => {
    setBusy(true); setStopError('');
    try {
      const r = await stopPlan(token);
      setPlan(r);
      setAlreadyOver(r.alreadyOver);
      setStopped(true);
      setAsking(false);
    } catch (e) {
      setStopError(e instanceof Error ? e.message : 'We couldn’t stop these payments just now, so nothing has changed.');
      setAsking(false);
    } finally {
      setBusy(false);
    }
  };

  const shell = (children: React.ReactNode, foot?: string) => (
    <div className="shell">
      <div className="scene" aria-hidden="true" />
      <main className="donate-wrap">
        {children}
        <p className="donate-foot faint">
          <Lock size={11} /> Secured by Stripe · {foot || 'OpenMasjid Donations'}
        </p>
      </main>
    </div>
  );

  // ── 5. The link doesn't work ──
  // ONE page for every reason (unknown, malformed, a plan that was never ours), carrying nothing
  // derived from a plan — so it can't be used to test whether a token exists.
  if (notFound) {
    return shell(
      <section className="glass-raised donate-card">
        <div className="donate-emblem" aria-hidden="true"><XCircle size={30} /></div>
        <h1 className="donate-title">This link doesn’t work</h1>
        <p className="donate-desc">
          Links like this one stop working once a monthly donation has ended, and a copied or very old link may not open at all.
          Nothing has changed, and nothing has been taken from your card.
        </p>
        <p className="donate-desc muted">
          If you’d like to stop a monthly donation, or you’re not sure whether one is running, the masjid can check for you and
          sort it out in a moment.
        </p>
        <a className="btn btn--ghost" href={withBase('/')}>Go to the donation page</a>
      </section>,
    );
  }

  if (!plan) {
    return shell(<section className="glass-raised donate-card"><span className="spinner" aria-label="Loading" /></section>);
  }

  const logo = logoSrc(plan.masjidLogo);
  const amount = money(plan.amount, plan.currency);
  const contact = contactSentence(plan);
  const nextDay = fmtDay(plan.nextPaymentAt);
  const finished = plan.status === 'canceled';
  const paused = plan.status === 'paused';
  const header = (
    <>
      {logo
        ? <img className="donate-logo" src={logo} alt={plan.masjidName} />
        : <div className="donate-emblem" aria-hidden="true"><Repeat size={30} /></div>}
    </>
  );

  // ── 1b. Just stopped ──
  if (stopped && !alreadyOver) {
    return shell(
      <section className="glass-raised donate-card donate-thanks">
        <div className="donate-emblem is-success" aria-hidden="true"><HeartHandshake size={34} /></div>
        <h1 className="donate-title">These payments have stopped</h1>
        <p className="donate-desc">
          Nothing more will be taken from your card. JazākAllāhu khayran for what you’ve already given — that stays with
          {' '}{plan.masjidName || 'the masjid'} and isn’t sent back.
        </p>
        <p className="donate-desc muted">
          If you’d like to give again one day, as a monthly gift or a one-off, their donation page is always there.
        </p>
        <a className="btn btn--ghost" href={withBase(plan.campaignPath || '/')}>Visit the donation page</a>
        {contact && <p className="donate-foot faint">Anything not quite right? Contact {contact}.</p>}
      </section>,
      plan.masjidName,
    );
  }

  // ── 2. Already stopped (either found that way, or they pressed twice) ──
  if (finished || (stopped && alreadyOver)) {
    return shell(
      <section className="glass-raised donate-card">
        {header}
        <h1 className="donate-title">These payments have already stopped</h1>
        <p className="donate-desc">Nothing more is being taken from your card, so there’s nothing left to do here.</p>
        <p className="donate-desc muted">
          If you didn’t expect that, or you’d like to start a monthly gift again{contact ? <>, contact {contact}</> : ''}.
        </p>
        {plan.campaignPath && <a className="btn btn--ghost" href={withBase(plan.campaignPath)}>Visit the donation page</a>}
      </section>,
      plan.masjidName,
    );
  }

  // ── 1/3/4. Running, paused, or showing what's on file because Stripe was unreachable ──
  return shell(
    <>
      <section className="glass-raised donate-card">
        {header}
        <h1 className="donate-title">
          Your monthly donation{plan.masjidName ? <> to {plan.masjidName}</> : null}
        </h1>
        {/* "every month" is the honest fallback when Stripe couldn't be read: this app only ever
            creates monthly subscriptions (createSubscription hardcodes the interval), and the page
            can only reach a plan in our own local index — so there is no plan here whose real
            interval is anything else. A quarterly plan would have to have been made elsewhere, and
            those are structurally unreachable from this token. */}
        <p className="donate-sub muted">
          {amount} {plan.frequency ? plan.frequency.toLowerCase().replace(/^monthly$/, 'every month') : 'every month'}
          {plan.campaignTitle ? ` · ${plan.campaignTitle}` : ''}
        </p>

        {!plan.live ? (
          // 4. We couldn't read Stripe. Say so, show only what we hold locally, and offer a retry —
          // never a blank or guessed next-payment date.
          <p className="muted plan-note">
            <CalendarClock size={14} aria-hidden="true" />
            We couldn’t check the latest details just now, so this shows what’s on file here. Nothing has changed and nothing
            has been taken. Please try again in a moment.
          </p>
        ) : paused ? (
          // 3. Paused is not stopped, and a donor needs telling — otherwise they stop a gift that
          // was already costing them nothing, or leave one they meant to end.
          <p className="donate-desc">
            {plan.masjidName || 'The masjid'} has paused this gift for now, so nothing is being taken from your card, and the
            months that pass while it’s paused are never billed to you afterwards. It will start again if they resume it.
          </p>
        ) : (
          <p className="donate-desc">
            This gift is running. {amount} will go to {plan.masjidName || 'the masjid'}
            {nextDay ? <> on {nextDay}, and every month after that,</> : <> each month</>} until it’s stopped.
          </p>
        )}

        <div className="detail-grid">
          <Row label="Monthly amount" value={amount} />
          {plan.live && (paused ? <Row label="Next payment" value="Paused — nothing is due" /> : nextDay ? <Row label="Next payment" value={nextDay} /> : null)}
          {plan.campaignTitle && <Row label="Fund" value={plan.campaignTitle} />}
          <Row label="Reference" value={plan.reference} />
        </div>

        {paused && <p className="donate-desc muted">Paused isn’t the same as stopped. If you’d like it to end for good, you can do that here.</p>}

        {stopError && <p className="form-error" role="alert">{stopError}{contact ? ` Or contact ${contact} and they’ll stop them for you.` : ''}</p>}

        <div className="confirm-actions">
          {!plan.live && <button className="btn btn--ghost" type="button" onClick={load}>Try again</button>}
          {plan.canStop && (
            <button className="btn btn--danger" type="button" onClick={() => setAsking(true)} disabled={busy}>
              <XCircle size={16} /> Stop these payments
            </button>
          )}
        </div>

        <p className="donate-foot faint">
          <ShieldCheck size={11} /> Nothing happens until you press that button.
          {contact ? ` If this doesn’t look like yours, please leave it and ask us — ${contact}.` : ''}
        </p>
      </section>

      {asking && (
        <div className="modal-backdrop" onClick={() => setAsking(false)}>
          <div className="modal glass-raised confirm-modal" role="dialog" aria-modal="true" aria-label="Stop this monthly donation" onClick={(e) => e.stopPropagation()}>
            <div className="donate-emblem" aria-hidden="true"><XCircle size={28} /></div>
            <h3 className="donate-title">Stop this monthly donation?</h3>
            <p className="muted" style={{ marginBlockStart: '0.4rem' }}>
              {amount} a month to {plan.masjidName || 'the masjid'} will end, and nothing more will be taken from your card.
              {paused
                ? ' This gift is paused now, so stopping it means it won’t start again.'
                : ' Anything you’ve already given stays with the masjid — this doesn’t send any of it back.'}
              {' '}You can start a new monthly gift from their donation page whenever you like.
            </p>
            {/* Safe choice first, as everywhere else in this app: the first Tab must never land on
                the button that ends somebody's donation. */}
            <div className="confirm-actions">
              <button className="btn btn--ghost" type="button" onClick={() => setAsking(false)} disabled={busy}>Keep it going</button>
              <button className="btn btn--danger" type="button" onClick={doStop} disabled={busy}>
                {busy ? <span className="spinner" /> : <XCircle size={16} />} Stop payments
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
    plan.masjidName,
  );
}
