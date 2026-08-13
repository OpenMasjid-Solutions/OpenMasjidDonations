// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The login-protected admin area: first-run setup, then manage Stripe accounts,
 *  campaigns (donation pages), and the donations log. Stripe SECRET keys are sent to
 *  the server and never returned to the browser. */
import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Ban, Bell, CalendarClock, CalendarDays, CheckCircle2, CloudOff, Coins, Copy, CreditCard, Download, ExternalLink, Eye, EyeOff, Globe, GraduationCap, HandCoins, HeartHandshake,
  KeyRound, Landmark, LayoutDashboard, Link2, LogIn, LogOut, Mail, Megaphone, Pause, Pencil, Play, Plus, QrCode, ReceiptText, RefreshCw, Repeat, Send,
  Settings as SettingsIcon, ShieldCheck, Sparkles, TrendingUp, Trash2, Undo2, Upload, Wallet, X,
} from 'lucide-react';
import {
  cancelPlan, checkSlug, completeOnboarding, createAccount, createCampaign, deleteAccount, deleteCampaign, getDonations, getEmailReceipt,
  getFabricStripeAccounts, getLargeDonation, getMetrics, getPlan, getPlans, getSession, getSettings, getThankYou, getTunnel, listCampaigns, login, logout, money,
  pausePlan, refundDonation, resumePlan, saveEmailReceipt, saveFabricStripeAccount, saveLargeDonation, saveMasjid, saveThankYou, saveTunnel,
  schedulePlanEnd, sendTestAlert, sendTestNotification, setupAdmin, testAccount, updateAccount, updateCampaign, uploadImage,
  type AccountInput, type AppInfo, type Campaign, type CampaignInput, type CampaignType, type Donation, type DonationsResult,
  type EmailReceipt, type EmailReceiptPatch, type FabricStripeAccountRef, type FabricStripeStatus, type LargeDonation, type MasjidProfile, type Metrics, type Plan, type PlanDetailResult, type PlanSchedule, type PlansResult, type RefundReason, type Session, type Settings, type StripeAccount, type ThankYou, type TunnelStatus, type VerifyResult,
} from './api';
import { useReadableTheme } from './prefs';
import { BASE, asset, withBase } from './base';

const SOURCE_URL = 'https://github.com/OpenMasjid-Solutions/OpenMasjidDonations';
const STRIPE_KEYS_URL = 'https://dashboard.stripe.com/apikeys';

export function AdminApp({ info }: { info: AppInfo | null }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  const refresh = () => getSession().then(setSession).catch(() => setSession(null)).finally(() => setLoaded(true));
  useEffect(() => void refresh(), []);

  if (!loaded) return <Centered><span className="spinner" aria-label="Loading" /></Centered>;
  if (session?.authed) return <AdminConsole info={info} session={session} onSignedOut={refresh} />;
  if (session?.needsSetup) return <Setup onDone={refresh} />;
  // Embedded under OpenMasjidOS: sign in via the dashboard. But a local password is
  // always available as a recovery, and if the platform is unreachable we lead with it
  // so a migrated/down OS can never lock the admin out.
  if (session?.sso.enabled) return <SsoGate session={session} onDone={refresh} />;
  return <Login onDone={refresh} />;
}

const Centered = ({ children }: { children: React.ReactNode }) => <main className="auth-wrap">{children}</main>;

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

// ── Sign-in states ────────────────────────────────────────────────────────────
function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="auth-wrap">
      <section className="glass-raised auth-card">
        <div className="auth-logo" aria-hidden="true"><ShieldCheck size={34} /></div>
        <h1 className="auth-title">{title}</h1>
        {children}
      </section>
    </main>
  );
}

function Setup({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Please choose a password of at least 8 characters.');
    if (password !== confirm) return setError('The two passwords don’t match.');
    setBusy(true);
    try { await setupAdmin(password); onDone(); } catch (err) { setError(msg(err)); setBusy(false); }
  };
  return (
    <AuthCard title="Create your admin password">
      <p className="auth-sub muted">First run — choose a password to protect your donation settings. You’ll use it to sign in.</p>
      <form onSubmit={submit}>
        <Field id="pw" label="New password"><input id="pw" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></Field>
        <Field id="pw2" label="Confirm password"><input id="pw2" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn--primary btn--block" type="submit" disabled={busy}>{busy ? <span className="spinner" /> : <KeyRound size={16} />} Set password &amp; continue</button>
      </form>
    </AuthCard>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try { await login(password); onDone(); } catch (err) { setError(msg(err)); setBusy(false); }
  };
  return (
    <AuthCard title="Sign in">
      <p className="auth-sub muted">Enter your admin password to manage your donation pages.</p>
      <form onSubmit={submit}>
        <Field id="pw" label="Password"><input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></Field>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn--primary btn--block" type="submit" disabled={busy}>{busy ? <span className="spinner" /> : <LogIn size={16} />} Sign in</button>
      </form>
    </AuthCard>
  );
}

/** Embedded sign-in. Normally you open the app from the OpenMasjidOS dashboard and SSO
 *  signs you in. If the platform is unreachable (it was migrated to a new machine, or is
 *  briefly down), we surface that clearly and offer the always-available local password
 *  so the panel can never become un-enterable. The password path also stays available as
 *  a fallback even when the platform IS reachable. */
function SsoGate({ session, onDone }: { session: Session; onDone: () => void }) {
  const [showPassword, setShowPassword] = useState(false);
  const reachable = session.sso.reachable;

  // The local password recovery: sign in if one exists, otherwise set one now.
  if (showPassword) {
    return session.hasPassword ? <Login onDone={onDone} /> : <Setup onDone={onDone} />;
  }

  if (!reachable) {
    return (
      <AuthCard title="Can’t reach OpenMasjidOS">
        <p className="auth-sub muted">
          We couldn’t contact your OpenMasjidOS dashboard to sign you in. It may be starting up, or its address
          changed (for example after restoring a backup onto a new machine). You can try again, or get in with a password.
        </p>
        <button className="btn btn--primary btn--block" onClick={onDone}><RefreshCw size={16} /> Try again</button>
        <button className="btn btn--ghost btn--block" onClick={() => setShowPassword(true)} style={{ marginTop: '0.5rem' }}>
          <KeyRound size={16} /> {session.hasPassword ? 'Sign in with a password instead' : 'Set a password to get in'}
        </button>
      </AuthCard>
    );
  }

  // Platform reachable: sign in via the dashboard. Offer the password path only if a
  // recovery password already exists — when none exists we deliberately don't offer to
  // set one here (the server refuses local setup while the platform is reachable, so a
  // passer-by can't claim the admin before the real admin; they sign in via OpenMasjidOS).
  return (
    <AuthCard title="Sign in through OpenMasjidOS">
      <p className="auth-sub muted">This app uses your OpenMasjidOS login. Open it from your dashboard — press <b>Open</b> on the Donations app — and you’ll be signed in automatically.</p>
      {session.hasPassword && (
        <button className="btn btn--ghost btn--block" onClick={() => setShowPassword(true)} style={{ marginTop: '0.25rem' }}>
          <KeyRound size={16} /> Use a password instead
        </button>
      )}
    </AuthCard>
  );
}

// ── Console ─────────────────────────────────────────────────────────────────
function AdminConsole({ info, session, onSignedOut }: { info: AppInfo | null; session: Session; onSignedOut: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reload = () => getSettings().then(setSettings).catch(() => setSettings(null)).finally(() => setLoaded(true));
  useEffect(() => void reload(), []);

  if (!loaded) return <Centered><span className="spinner" aria-label="Loading" /></Centered>;
  if (!settings) return <Centered><p className="muted">Couldn’t load your settings. Please refresh.</p></Centered>;
  if (!settings.onboarded) return <Onboarding settings={settings} publicBase={info?.publicUrl ?? ''} embedded={!!info?.embedded} onReload={reload} />;
  return <AdminHome info={info} session={session} settings={settings} onReload={reload} onSignedOut={onSignedOut} />;
}

function Onboarding({ settings, publicBase, embedded, onReload }: { settings: Settings; publicBase: string; embedded: boolean; onReload: () => void }) {
  const [finishing, setFinishing] = useState(false);
  const finish = async () => { setFinishing(true); try { await completeOnboarding(); onReload(); } catch { setFinishing(false); } };
  return (
    <main className="admin">
      <div className="page-head">
        <h1 className="page-title">Let’s set up your donations</h1>
        <p className="page-sub">Your masjid details and a Stripe account — then create your first appeal.</p>
      </div>
      <MasjidCard masjid={settings.masjid} onSaved={onReload} />
      <StripeAccountsCard accounts={settings.stripeAccounts} fabric={settings.fabricStripe} publicBase={publicBase} embedded={embedded} onChanged={onReload} />
      <section className="glass panel">
        <div className="row-between">
          <p className="muted" style={{ margin: 0 }}>
            {!settings.masjid.name.trim() ? 'Add and save your masjid name to finish.'
              : settings.fabricStripe.available && settings.fabricStripe.configured ? 'Stripe is connected through OpenMasjidOS ✓ — you’re ready.'
              : settings.stripeAccounts.some((a) => a.configured) ? 'Stripe is connected ✓ — you can change anything later.'
              : 'You can add Stripe now or later — change anything anytime.'}
          </p>
          <button className="btn btn--primary" onClick={finish} disabled={finishing || !settings.masjid.name.trim()}>
            {finishing ? <span className="spinner" /> : <CheckCircle2 size={16} />} Finish setup
          </button>
        </div>
      </section>
    </main>
  );
}

// Primary navigation — a bottom dock, like the other OpenMasjidOS apps. Each tab is a
// distinct section; the Donations records get their own tab.
type AdminTab = 'overview' | 'campaigns' | 'donations' | 'plans' | 'thankyou' | 'largegift' | 'payments' | 'settings';
const ADMIN_TABS: { id: AdminTab; label: string; Icon: typeof Megaphone }[] = [
  { id: 'overview', label: 'Overview', Icon: LayoutDashboard },
  { id: 'campaigns', label: 'Campaigns', Icon: Megaphone },
  { id: 'donations', label: 'Donations', Icon: ReceiptText },
  { id: 'plans', label: 'Monthly', Icon: Repeat },
  { id: 'thankyou', label: 'Thank-you', Icon: HeartHandshake },
  { id: 'largegift', label: 'Large gifts', Icon: HandCoins },
  { id: 'payments', label: 'Payments', Icon: CreditCard },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
];

/** Which tab a URL hash like "#settings" selects (defaults to overview). */
function tabFromHash(): AdminTab {
  const h = typeof location !== 'undefined' ? location.hash.replace(/^#/, '') : '';
  return ADMIN_TABS.some((t) => t.id === h) ? (h as AdminTab) : 'overview';
}

function Dock({ tab, setTab }: { tab: AdminTab; setTab: (t: AdminTab) => void }) {
  return (
    <div className="dock-wrap">
      <nav className="dock glass-raised" aria-label="Sections">
        {ADMIN_TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`nav-item${tab === id ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            aria-label={label}
            title={label}
          >
            <Icon size={20} />
            <span className="nav-label">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function AdminHome({ info, session, settings, onReload, onSignedOut }: {
  info: AppInfo | null; session: Session; settings: Settings; onReload: () => void; onSignedOut: () => void;
}) {
  const embedded = !!info?.embedded;
  // Public base for share links / QR / the Stripe webhook URL: the OS Fabric remote-access
  // address (manifest `domain: true`) when the admin has turned remote access on in
  // OpenMasjidOS; '' otherwise (cards fall back to the in-app tunnel or this device).
  const publicBase = info?.publicUrl ?? '';
  // Tab is reflected in the URL hash so the profile menu's "Settings" (→ /admin#settings)
  // and refresh/back land on the right section.
  const [tab, setTabState] = useState<AdminTab>(() => tabFromHash());
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const setTab = (t: AdminTab) => {
    if (typeof location !== 'undefined') history.replaceState(null, '', `${location.pathname}#${t}`);
    setTabState(t);
  };
  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => { setSigningOut(true); try { await logout(); } catch { /* ignore */ } onSignedOut(); };

  const meta: Record<AdminTab, { title: string; sub: string }> = {
    overview: { title: 'Dashboard', sub: `${session.sso.username ? `Signed in as ${session.sso.username}` : 'Signed in'}${embedded ? ' · via OpenMasjidOS' : ''}` },
    campaigns: { title: 'Campaigns', sub: 'Create and manage your donation appeals.' },
    donations: { title: 'Donations', sub: 'Every gift your masjid has received.' },
    plans: { title: 'Monthly plans', sub: 'Donors who give every month — and how to pause or stop a plan.' },
    thankyou: { title: 'Thank-you', sub: 'The message donors see right after they give.' },
    largegift: { title: 'Large gifts', sub: 'Gently suggest a fee-free way to give for big donations.' },
    payments: { title: 'Payments', sub: 'Your Stripe accounts and optional public access.' },
    settings: { title: 'Settings', sub: 'Masjid details, notifications and your account.' },
  };

  return (
    <>
      <main className={`admin${tab === 'donations' || tab === 'plans' ? ' admin--wide' : ''}`}>
        <div className="page-head">
          <h1 className="page-title">{meta[tab].title}</h1>
          <p className="page-sub">{meta[tab].sub}</p>
        </div>

        {tab === 'overview' && <MetricsDashboard />}
        {tab === 'campaigns' && <CampaignsCard accounts={settings.stripeAccounts} fabric={settings.fabricStripe} currency={settings.masjid.currency} masjidName={settings.masjid.name} masjidLogo={settings.masjid.logo} publicBase={publicBase} />}
        {tab === 'donations' && <DonationsCard />}
        {tab === 'plans' && <PlansCard />}
        {tab === 'thankyou' && (
          <div style={{ display: 'grid', gap: '1rem' }}>
            <ThankYouCard masjidName={settings.masjid.name} currency={settings.masjid.currency} />
            <EmailDesignCard masjid={settings.masjid} currency={settings.masjid.currency} />
          </div>
        )}
        {tab === 'largegift' && <LargeDonationCard currency={settings.masjid.currency} />}
        {tab === 'payments' && (
          <>
            <StripeAccountsCard accounts={settings.stripeAccounts} fabric={settings.fabricStripe} publicBase={publicBase} embedded={embedded} onChanged={onReload} />
            {/* Remote access is the platform's job when embedded (the OS runs Cloudflare and
                we get our public URL from the Fabric). Only show the app's own tunnel standalone. */}
            {!embedded && <PublicAccessCard />}
          </>
        )}
        {tab === 'settings' && (
          <>
            <MasjidCard masjid={settings.masjid} onSaved={onReload} />
            <Notifications embedded={embedded} />
            <EmailSetupCard />
            <section className="glass panel">
              <div className="row-between">
                <div className="row"><ShieldCheck size={18} className="panel-ico" aria-hidden="true" /><span className="muted">{embedded ? 'Signed in with your OpenMasjidOS login.' : 'Signed in with your local admin password.'}</span></div>
                {embedded ? (
                  // Under SSO the platform owns the session — clearing our local cookie is
                  // instantly undone by the omos_session cookie, so point to the dashboard.
                  <span className="hint">Sign out from your OpenMasjidOS dashboard</span>
                ) : (
                  <button className="btn btn--ghost btn--sm" onClick={signOut} disabled={signingOut}>{signingOut ? <span className="spinner" /> : <LogOut size={15} />} Sign out</button>
                )}
              </div>
            </section>
            <p className="admin-foot faint">OpenMasjid Donations v{info?.version ?? __APP_VERSION__} · <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener">Source code <ExternalLink size={12} /></a> · AGPL-3.0</p>
          </>
        )}
      </main>
      <Dock tab={tab} setTab={setTab} />
    </>
  );
}

// ── Metrics dashboard ─────────────────────────────────────────────────────────
function MetricsDashboard() {
  const reduce = useReducedMotion();
  const [m, setM] = useState<Metrics | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    getMetrics().then(setM).catch(() => setFailed(true));
  }, []);

  if (failed) return null; // the dashboard is a nicety — never block the rest of the panel
  if (!m) return <section className="glass panel metrics-skel"><span className="spinner" aria-label="Loading totals" /></section>;

  const fmt = (n: number) => money(n, m.currency);
  const hasMoney = m.totalRaised > 0;
  const tiles: { icon: React.ReactNode; label: string; value: string; sub?: string; accent?: boolean }[] = [
    {
      icon: <Coins size={17} />,
      label: 'Total raised',
      value: fmt(m.totalRaised),
      // The headline is already net of refunds, so when any money HAS gone back the tile says so
      // in its own sub-line — a total that quietly dropped is otherwise unexplainable from here.
      sub: m.totalRefunded > 0 ? `after ${fmt(m.totalRefunded)} refunded` : undefined,
      accent: true,
    },
    { icon: <CalendarDays size={17} />, label: 'This month', value: fmt(m.thisMonthRaised), sub: `${m.thisMonthCount} donation${m.thisMonthCount === 1 ? '' : 's'}` },
    { icon: <TrendingUp size={17} />, label: 'Donations', value: String(m.count), sub: `${m.activeCampaigns} live appeal${m.activeCampaigns === 1 ? '' : 's'}` },
    { icon: <Sparkles size={17} />, label: 'Average gift', value: m.count ? fmt(m.average) : '—' },
  ];
  const maxRaised = Math.max(1, ...m.byCampaign.map((c) => c.raised));
  const maxMonth = Math.max(1, ...m.monthly.map((x) => x.raised));
  const rise = (i: number) =>
    reduce ? {} : { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { delay: 0.05 * i, duration: 0.4, ease: 'easeOut' as const } };

  return (
    <section className="metrics">
      <div className="stat-grid">
        {tiles.map((t, i) => (
          <motion.div key={t.label} className={`glass stat-widget${t.accent ? ' stat-widget--accent' : ''}`} {...rise(i)}>
            <span className="stat-tile__icon" aria-hidden="true">{t.icon}</span>
            <span className="stat-tile__label">{t.label}</span>
            <span className="stat-tile__value">{t.value}</span>
            <span className="stat-tile__sub">{t.sub ?? ' '}</span>
          </motion.div>
        ))}
      </div>

      {hasMoney && m.byCampaign.length > 0 && (
        <div className="metric-block">
          <h3 className="metric-h">Where it’s going</h3>
          <div className="metric-bars">
            {m.byCampaign.map((c) => (
              <div key={c.id} className="metric-bar-row">
                <div className="metric-bar-top">
                  <span className="metric-bar-name">{c.title}{!c.active && <span className="faint"> · hidden</span>}</span>
                  <span className="metric-bar-amt">{fmt(c.raised)} <span className="faint">· {c.count}</span></span>
                </div>
                <div className="metric-bar-track"><div className="metric-bar-fill" style={{ width: `${Math.round((c.raised / maxRaised) * 100)}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasMoney && (
        <div className="metric-block">
          <h3 className="metric-h">Last 6 months</h3>
          <div className="trend-chart" role="img" aria-label="Donations over the last six months">
            {m.monthly.map((x) => (
              <div key={x.month} className="trend-col" title={`${x.label}: ${fmt(x.raised)} (${x.count})`}>
                <div className="trend-bar-wrap"><div className="trend-bar" style={{ height: `${Math.max(2, Math.round((x.raised / maxMonth) * 100))}%` }} /></div>
                <span className="trend-label">{x.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ── Masjid details ──────────────────────────────────────────────────────────
function MasjidCard({ masjid, onSaved }: { masjid: MasjidProfile; onSaved: () => void }) {
  const [form, setForm] = useState<MasjidProfile>(masjid);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof MasjidProfile) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    setBusy(true); setError(''); setSaved(false);
    try { await saveMasjid(form); setSaved(true); onSaved(); } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  };
  return (
    <section className="glass panel">
      <div className="card-head"><Landmark size={18} className="panel-ico" aria-hidden="true" /><div><h2 className="section-title-inline">Your masjid</h2><p className="muted">Shown on your donation pages. Currency applies to all campaigns.</p></div></div>
      <div className="grid2">
        <Field id="m-name" label="Masjid name"><input id="m-name" className="input" value={form.name} onChange={set('name')} placeholder="e.g. Madani Masjid" /></Field>
        <Field id="m-cur" label="Currency (ISO code)"><input id="m-cur" className="input" value={form.currency} onChange={set('currency')} placeholder="GBP" maxLength={8} /></Field>
      </div>
      <div className="grid2">
        <Field id="m-email" label="Contact email (optional)"><input id="m-email" className="input" type="email" value={form.email} onChange={set('email')} /></Field>
        <Field id="m-phone" label="Phone (optional)"><input id="m-phone" className="input" value={form.phone} onChange={set('phone')} /></Field>
      </div>
      <ImageField id="m-logo" label="Masjid logo (optional)" hint="Shown on your donation pages." value={form.logo} onChange={(v) => setForm({ ...form, logo: v })} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="row-between"><span className="hint">{saved ? 'Saved ✓' : ''}</span><button className="btn btn--primary btn--sm" onClick={save} disabled={busy}>{busy ? <span className="spinner" /> : null} Save masjid details</button></div>
    </section>
  );
}

// ── Stripe accounts ───────────────────────────────────────────────────────────
function ModeBadge({ a }: { a: StripeAccount }) {
  if (a.mode === 'test') return <span className="badge badge--test">TEST</span>;
  if (a.mode === 'live') return <span className="badge badge--live">LIVE</span>;
  return null;
}

/** In-app picker for which OpenMasjidOS-vault Stripe account this app uses. Lists the
 *  masjid's accounts (no keys) and saves the chosen id. Renders nothing until the list
 *  loads, and nothing if none are configured (the "Set up in OpenMasjidOS" prompt shows). */
function FabricAccountPicker({ chosenId, onSaved }: { chosenId: string; onSaved: () => void }) {
  const [accounts, setAccounts] = useState<FabricStripeAccountRef[] | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { getFabricStripeAccounts().then((r) => setAccounts(r.accounts)).catch(() => setAccounts([])); }, []);
  if (accounts === null) return <p className="hint" style={{ marginTop: '0.5rem' }}>Loading your OpenMasjidOS accounts…</p>;
  if (accounts.length === 0) return null; // none yet → the status pill already says "Set up in OpenMasjidOS"
  const pick = async (id: string) => { setSaving(true); try { await saveFabricStripeAccount(id); onSaved(); } catch { /* keep current */ } finally { setSaving(false); } };
  return (
    <div className="field" style={{ marginTop: '0.6rem' }}>
      <label className="label" htmlFor="fab-acct">Default account for this site</label>
      <select id="fab-acct" className="input" value={chosenId} disabled={saving} onChange={(e) => pick(e.target.value)}>
        {accounts.length > 1 && <option value="">First account in OpenMasjidOS</option>}
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
      </select>
      <span className="hint">Appeals use this account unless you choose a different one on the appeal itself. Accounts come from OpenMasjidOS → Settings → Payments; switching takes effect right away.</span>
    </div>
  );
}

function StripeAccountsCard({ accounts, fabric, publicBase, embedded, onChanged }: { accounts: StripeAccount[]; fabric?: FabricStripeStatus; publicBase?: string; embedded?: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState('');
  const [showLocal, setShowLocal] = useState(false);
  const [webhookBase, setWebhookBase] = useState(publicBase ?? '');
  useEffect(() => {
    if (publicBase) { setWebhookBase(publicBase); return; }
    getTunnel()
      .then((t) => setWebhookBase(t.enabled && t.publicHostname ? `https://${t.publicHostname}` : originBase()))
      .catch(() => setWebhookBase(originBase()));
  }, [publicBase]);
  // When embedded under OpenMasjidOS, payments are the platform's job: the admin sets Stripe
  // up ONCE in OpenMasjidOS (Settings → Payments) and every app shares it via the Fabric. We
  // lead with that — whether or not it's connected yet — and tuck the on-device keys (the
  // standalone fallback) behind a toggle. Standalone, we show the local accounts directly.
  const osManaged = !!embedded;
  const fabricConfigured = !!fabric?.configured;
  return (
    <section className="glass panel">
      <div className="card-head">
        <Wallet size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Payments (Stripe accounts)</h2>
          <p className="muted">
            {osManaged
              ? 'Managed in OpenMasjidOS — set up Stripe once in your dashboard (Settings → Payments) and every app shares it. Nothing to enter here.'
              : 'Add one or more Stripe accounts — e.g. a separate account for Zakat. Secret keys stay on this device.'}
          </p>
        </div>
      </div>
      {osManaged && (
        <>
          <div className="list">
            <div className="list-row">
              <Landmark size={16} className="muted" aria-hidden="true" />
              <div className="list-row__main">
                <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
                  <span className="list-row__title">{fabric?.label || 'OpenMasjidOS payments'}</span>
                  {fabric?.mode === 'test' && <span className="badge badge--test">TEST</span>}
                  {fabric?.mode === 'live' && <span className="badge badge--live">LIVE</span>}
                  {fabricConfigured
                    ? <span className="status-pill status-pill--ok"><CheckCircle2 size={12} /> Connected via OpenMasjidOS</span>
                    : <span className="status-pill">Set up in OpenMasjidOS → Settings → Payments</span>}
                </div>
                <p className="muted" style={{ margin: '0.2rem 0 0' }}>
                  {fabricConfigured
                    ? 'Manage these keys in OpenMasjidOS — they’re backed up and moved with your dashboard.'
                    : 'Add a Stripe account in OpenMasjidOS and it’ll appear here automatically.'}
                </p>
              </div>
            </div>
          </div>
          <FabricAccountPicker chosenId={fabric?.chosenId ?? ''} onSaved={onChanged} />
          <button className="btn btn--ghost btn--sm" onClick={() => setShowLocal((v) => !v)}>
            {showLocal ? 'Hide' : 'Use a Stripe account stored on this device instead'}
          </button>
          {!showLocal && <p className="hint" style={{ marginTop: '0.4rem' }}>Only needed if OpenMasjidOS payments aren’t set up — keys entered here stay on this device.</p>}
        </>
      )}
      {(!osManaged || showLocal) && (
        <>
      <StripeInstructions />
      <div className="list">
        {accounts.map((a) => (
          <div key={a.id}>
            <div className="list-row">
              <Wallet size={16} className="muted" aria-hidden="true" />
              <div className="list-row__main">
                <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
                  <span className="list-row__title">{a.label}</span>
                  <ModeBadge a={a} />
                  {a.configured ? <span className="status-pill status-pill--ok"><CheckCircle2 size={12} /> Connected</span> : <span className="status-pill">Needs keys</span>}
                </div>
                {a.keysMismatch && <p className="form-error" style={{ margin: '0.2rem 0 0' }}>Keys are in different modes (one test, one live).</p>}
              </div>
              <button className="icon-btn" title="Edit" onClick={() => setEditId(editId === a.id ? '' : a.id)}><Pencil size={15} /></button>
            </div>
            {editId === a.id && <AccountForm account={a} webhookBase={webhookBase} onDone={() => { setEditId(''); onChanged(); }} />}
          </div>
        ))}
        {accounts.length === 0 && <p className="muted" style={{ padding: '0.5rem 0' }}>No Stripe accounts yet.</p>}
      </div>
      {adding ? (
        <AccountForm webhookBase={webhookBase} onDone={() => { setAdding(false); onChanged(); }} />
      ) : (
        <button className="btn btn--ghost btn--sm" onClick={() => setAdding(true)}><Plus size={15} /> Add Stripe account</button>
      )}
        </>
      )}
    </section>
  );
}

function AccountForm({ account, webhookBase, onDone }: { account?: StripeAccount; webhookBase?: string; onDone: () => void }) {
  const editing = !!account;
  const [label, setLabel] = useState(account?.label ?? '');
  const [pk, setPk] = useState(account?.publishableKey ?? '');
  const [sk, setSk] = useState('');
  const [showSk, setShowSk] = useState(false);
  const [whsec, setWhsec] = useState('');
  const [showWh, setShowWh] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [error, setError] = useState('');
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const webhookUrl = account ? `${webhookBase || originBase()}/api/stripe/webhook/${account.id}` : '';

  const save = async () => {
    setBusy(true); setError(''); setVerify(null);
    try {
      const body: AccountInput = { label: label.trim() || 'Stripe account' };
      if (!editing || pk !== account?.publishableKey) body.publishableKey = pk.trim();
      if (sk.trim()) body.secretKey = sk.trim();
      if (whsec.trim()) body.webhookSecret = whsec.trim();
      const res = editing ? await updateAccount(account!.id, body) : await createAccount(body);
      if (res.verify) setVerify(res.verify);
      if (!res.verify || res.verify.ok) { onDone(); return; }
    } catch (err) { setError(msg(err)); }
    setBusy(false);
  };
  const test = async () => {
    if (!account) return;
    setBusy(true); setError('');
    try { setVerify(await testAccount(account.id)); } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!account) return;
    setDel(true); setError('');
    try { await deleteAccount(account.id); onDone(); } catch (err) { setError(msg(err)); setDel(false); }
  };

  return (
    <div className="subform glass-inset">
      <Field id="al" label="Label"><input id="al" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. General fund, Zakat" /></Field>
      <Field id="apk" label="Publishable key (pk_…)"><input id="apk" className="input mono" value={pk} onChange={(e) => setPk(e.target.value)} placeholder="pk_test_…" autoComplete="off" spellCheck={false} /></Field>
      <Field id="ask" label={account?.hasSecretKey ? 'Secret key (sk_…) — saved; blank keeps it' : 'Secret key (sk_…)'}>
        <div className="input-affix">
          <input id="ask" className="input mono" type={showSk ? 'text' : 'password'} value={sk} onChange={(e) => setSk(e.target.value)} placeholder={account?.hasSecretKey ? '•••••••• (unchanged)' : 'sk_test_…'} autoComplete="off" spellCheck={false} />
          <button type="button" className="affix-btn" onClick={() => setShowSk((s) => !s)} aria-label={showSk ? 'Hide' : 'Show'}>{showSk ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        </div>
      </Field>
      {editing && (
        <details className="steps-details">
          <summary>Recurring webhook (optional)</summary>
          <p className="hint" style={{ marginBlock: '0.3rem 0.5rem' }}>
            Only needed to log ongoing monthly charges, and only when public access is on. In Stripe, add a webhook to the
            URL below (events <code>invoice.paid</code>), then paste its signing secret here.
          </p>
          <Field id="awhurl" label="Webhook URL — paste into Stripe">
            <div className="input-affix">
              <input id="awhurl" className="input mono" readOnly value={webhookUrl} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="affix-btn" aria-label="Copy" onClick={async () => { try { await navigator.clipboard.writeText(webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } }}>{copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}</button>
            </div>
          </Field>
          <Field id="awh" label={account?.hasWebhookSecret ? 'Signing secret (whsec_…) — saved; blank keeps it' : 'Signing secret (whsec_…)'}>
            <div className="input-affix">
              <input id="awh" className="input mono" type={showWh ? 'text' : 'password'} value={whsec} onChange={(e) => setWhsec(e.target.value)} placeholder={account?.hasWebhookSecret ? '•••••••• (unchanged)' : 'whsec_…'} autoComplete="off" spellCheck={false} />
              <button type="button" className="affix-btn" onClick={() => setShowWh((s) => !s)} aria-label={showWh ? 'Hide' : 'Show'}>{showWh ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </div>
          </Field>
        </details>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {verify && <p className={verify.ok ? 'hint' : 'form-error'} role="status">{verify.ok ? `Stripe accepted your key${verify.mode ? ` (${verify.mode} mode)` : ''}. ✓` : verify.message}</p>}
      <div className="row-between" style={{ marginBlockStart: '0.4rem' }}>
        <div className="row" style={{ gap: '0.4rem' }}>
          {editing && <button className="btn btn--ghost btn--sm" onClick={test} disabled={busy}><RefreshCw size={14} /> Test</button>}
          {editing && <button className="btn btn--ghost btn--sm" onClick={remove} disabled={del} title="Delete account"><Trash2 size={14} /> Delete</button>}
        </div>
        <div className="row" style={{ gap: '0.4rem' }}>
          <button className="btn btn--ghost btn--sm" type="button" onClick={onDone}>Cancel</button>
          <button className="btn btn--primary btn--sm" onClick={save} disabled={busy}>{busy ? <span className="spinner" /> : null} {editing ? 'Save' : 'Add account'}</button>
        </div>
      </div>
    </div>
  );
}

function StripeInstructions() {
  return (
    <details className="steps-details">
      <summary>Where do I get Stripe keys?</summary>
      <ol className="steps">
        <li>Create a free account at <a href="https://stripe.com" target="_blank" rel="noreferrer noopener">stripe.com</a> (or sign in).</li>
        <li>Keep <b>Test mode</b> on while you try things out; switch to live keys when ready for real money.</li>
        <li>Open <a href={STRIPE_KEYS_URL} target="_blank" rel="noreferrer noopener">Developers → API keys <ExternalLink size={11} /></a>. Copy the <b>Publishable key</b> (<code>pk_</code>) and reveal + copy the <b>Secret key</b> (<code>sk_</code>).</li>
        <li>Paste them here and save. Your secret key stays on this device and is never shown again.</li>
      </ol>
    </details>
  );
}

// ── Campaigns ───────────────────────────────────────────────────────────────
function CampaignsCard({ accounts, fabric, currency, masjidName, masjidLogo, publicBase }: { accounts: StripeAccount[]; fabric?: FabricStripeStatus; currency: string; masjidName: string; masjidLogo: string; publicBase: string }) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [editId, setEditId] = useState('');
  // The base for shareable links + QR codes: the OpenMasjidOS public address when the
  // admin has enabled remote access there; else the in-app Cloudflare tunnel (standalone);
  // else this device's address. Seed from publicBase so the QR isn't briefly path-less.
  const [shareBase, setShareBase] = useState(publicBase || '');
  const reload = () => listCampaigns().then(setCampaigns).catch(() => setCampaigns([]));
  useEffect(() => void reload(), []);
  useEffect(() => {
    if (publicBase) { setShareBase(publicBase); return; }
    getTunnel()
      .then((t) => setShareBase(t.enabled && t.publicHostname ? `https://${t.publicHostname}` : originBase()))
      .catch(() => setShareBase(originBase()));
  }, [publicBase]);

  // A campaign needs somewhere for money to go: a local Stripe account OR the
  // OpenMasjidOS Fabric account (embedded installs have no local account at all).
  const noAccount = accounts.length === 0 && !fabric?.available;
  return (
    <section className="glass panel">
      <div className="card-head">
        <Megaphone size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Campaigns</h2>
          <p className="muted">Each appeal gets its own link you choose — e.g. <span className="mono">/zakat</span>. Point different appeals at different Stripe accounts.</p>
        </div>
      </div>
      {noAccount && <p className="hint">Connect Stripe first (Payments tab, or in OpenMasjidOS → Settings → Payments), then create a campaign.</p>}
      <div className="list">
        {(campaigns ?? []).map((c) => (
          <div key={c.id}>
            <div className="list-row">
              <CampaignPreview variant="thumb" currency={c.currency} data={c} masjidLogo={masjidLogo} />
              <div className="list-row__main">
                <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
                  <span className="list-row__title">{c.title}</span>
                  {c.active ? <span className="status-pill status-pill--ok">Live</span> : <span className="status-pill">Hidden</span>}
                  {/* An appeal that can't take a card is a 100% outage on that page, and it would
                      otherwise be invisible from here — the donor just meets a dead button. */}
                  {c.paymentAccountStatus !== 'ok' && <span className="status-pill status-pill--warn">Not taking donations</span>}
                  {c.paymentAccountStatus === 'ok' && c.paymentAccountMode === 'test' && <span className="status-pill">TEST</span>}
                </div>
                <CampaignLink url={c.url} base={shareBase} />
                <p className="list-row__sub">{money(c.raised, c.currency)} raised{c.goalAmount ? ` of ${money(c.goalAmount, c.currency)}` : ''}</p>
                {/* Named only when it ISN'T the site default, so a masjid with one account never
                    reads about accounts at all. */}
                {c.paymentAccountSource !== 'default' && c.paymentAccountLabel && (
                  <p className="list-row__sub faint">Pays into {c.paymentAccountLabel}</p>
                )}
                {c.paymentAccountStatus !== 'ok' && (
                  <p className="list-row__sub form-error" style={{ marginBlockEnd: 0 }}>
                    {c.paymentAccountStatus === 'unreachable'
                      ? 'We couldn’t reach OpenMasjidOS to check the account this appeal pays into. Nothing has been sent anywhere else.'
                      : c.paymentAccountStatus === 'not-configured'
                        ? 'The account this appeal pays into isn’t finished being set up. Open it to choose another.'
                        : 'The account this appeal pays into isn’t available any more. Open it to choose another.'}
                  </p>
                )}
              </div>
              <button className="icon-btn" title="Edit" onClick={() => setEditId(editId === c.id ? '' : c.id)}><Pencil size={15} /></button>
            </div>
            {editId === c.id && <CampaignForm campaign={c} accounts={accounts} fabric={fabric} currency={currency} masjidName={masjidName} masjidLogo={masjidLogo} shareBase={shareBase} onDone={() => { setEditId(''); reload(); }} onCancel={() => setEditId('')} />}
          </div>
        ))}
        {campaigns && campaigns.length === 0 && !creating && <p className="muted" style={{ padding: '0.5rem 0' }}>No campaigns yet.</p>}
      </div>
      {creating ? (
        <CampaignForm accounts={accounts} fabric={fabric} currency={currency} masjidName={masjidName} masjidLogo={masjidLogo} shareBase={shareBase} onDone={() => { setCreating(false); reload(); }} onCancel={() => setCreating(false)} />
      ) : (
        <button className="btn btn--primary btn--sm" disabled={noAccount} onClick={() => setCreating(true)}><Plus size={15} /> New campaign</button>
      )}
    </section>
  );
}

/** The copy-paste <iframe> embed snippet for a campaign's public widget (/w/<slug>). */
function WidgetEmbed({ url, title, isPublic }: { url: string; title: string; isPublic: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!url) return <p className="hint" style={{ marginBlockStart: '0.4rem' }}>Choose a link above first — the widget lives at that link under <span className="mono">/w/…</span>.</p>;
  const safeTitle = (title || 'Donate').replace(/"/g, '');
  const snippet = `<iframe src="${url}" title="${safeTitle}" style="width:100%;max-width:480px;height:680px;border:0;border-radius:16px" allow="payment"></iframe>`;
  const copy = async () => { try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  return (
    <div className="subform glass-inset" style={{ marginBlockStart: '0.4rem' }}>
      <p className="hint" style={{ marginBlockStart: 0 }}>Paste this into any website to embed this campaign. Save the campaign first{isPublic ? '.' : '; turn on public access (Payments tab) so it works off your network.'}</p>
      <textarea className="input mono" rows={3} readOnly value={snippet} onFocus={(e) => e.currentTarget.select()} aria-label="Embed code" />
      <button type="button" className="btn btn--ghost btn--sm" onClick={copy}>{copied ? <><CheckCircle2 size={14} /> Copied</> : <><Copy size={14} /> Copy embed code</>}</button>
    </div>
  );
}

function CampaignLink({ url, base }: { url: string; base: string }) {
  const full = (base || originBase()) + url;
  const shown = full.replace(/^https?:\/\//, '');
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(full); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  return (
    <div className="camp-link">
      <a href={full} target="_blank" rel="noreferrer noopener" className="mono">{shown}</a>
      <button className="icon-btn" title="Copy link" onClick={copy}>{copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}</button>
    </div>
  );
}

/** "Where this appeal's money goes" — the per-appeal Stripe account.
 *
 *  The default option comes FIRST and is worded so a masjid with a single account can ignore this
 *  entirely. Vaulted accounts and on-device accounts are grouped, because "shared with your other
 *  apps and backed up with your dashboard" and "keys live on this box only" are genuinely different
 *  promises about somebody's money.
 *
 *  A stored value we can no longer resolve is pinned at the top as a selected option rather than
 *  snapping back to the default — silently reverting it would re-route the money on the next save,
 *  which is exactly the accident this whole feature exists to prevent.
 */
function PaymentAccountField({ value, onChange, accounts, vault, fabric, status, resolvedLabel }: {
  value: string;
  onChange: (v: string) => void;
  accounts: StripeAccount[];
  vault: FabricStripeAccountRef[];
  fabric?: FabricStripeStatus;
  status?: Campaign['paymentAccountStatus'];
  resolvedLabel?: string;
}) {
  const local = accounts.map((a) => ({ value: `local:${a.id}`, label: `${a.label}${a.configured ? '' : ' · not finished setting up'}${a.mode === 'test' ? ' · TEST' : ''}` }));
  const vaulted = vault.map((a) => ({ value: `fabric:${a.id}`, label: a.label }));
  const known = new Set([...local, ...vaulted].map((o) => o.value));
  // A choice we can't place any more (the account was deleted in the dashboard, say).
  const orphan = value && !known.has(value) ? value : '';
  const siteDefault = fabric?.available && fabric.label ? `Same account as the rest of the site — ${fabric.label}` : 'Same account as the rest of the site';
  const nothingAnywhere = local.length === 0 && vaulted.length === 0;

  return (
    <Field id="cacct" label="Where this appeal’s money goes">
      <select id="cacct" className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{siteDefault}</option>
        {orphan && <option value={orphan}>No longer available — “{orphan.replace(/^(fabric|local):/, '')}”</option>}
        {vaulted.length > 0 && (
          <optgroup label="In OpenMasjidOS">
            {vaulted.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
        )}
        {local.length > 0 && (
          <optgroup label="On this device">
            {local.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
        )}
      </select>
      {/* Why this appeal currently turns donors away. The middle clause is the point: it answers the
          question an admin actually has, which is "did it just send the money somewhere else?" */}
      {status && status !== 'ok' && (
        <p className="form-error" role="alert" style={{ marginBlockEnd: 0 }}>
          {status === 'unreachable'
            ? 'We couldn’t reach OpenMasjidOS to check this account just now, so this page isn’t taking donations for the moment. Nothing has been sent anywhere else.'
            : status === 'not-configured'
              ? 'This account isn’t finished being set up, so donors can’t give on this page — we won’t quietly send the money to a different account instead. Choose another account, or finish setting this one up.'
              : 'The account this appeal pays into isn’t available any more, so donors can’t give on this page — we won’t quietly send the money to a different account instead. Please choose another.'}
        </p>
      )}
      {nothingAnywhere ? (
        <p className="hint">Add a Stripe account first — on the <b>Payments</b> tab, or in OpenMasjidOS → Settings → Payments.</p>
      ) : (
        <p className="hint">
          Leave this alone unless this appeal should settle somewhere else — a separate Zakat account, say.
          Accounts <b>in OpenMasjidOS</b> are set up once in your dashboard and shared with your other apps;
          an account <b>on this device</b> keeps its keys here only.
          {resolvedLabel && value ? <> Currently paying into <b>{resolvedLabel}</b>.</> : null}
        </p>
      )}
    </Field>
  );
}

function CampaignForm({ campaign, accounts, fabric, currency, masjidName, masjidLogo, shareBase, onDone, onCancel }: {
  campaign?: Campaign; accounts: StripeAccount[]; fabric?: FabricStripeStatus; currency: string; masjidName: string; masjidLogo: string; shareBase: string; onDone: () => void; onCancel?: () => void;
}) {
  const editing = !!campaign;
  const [title, setTitle] = useState(campaign?.title ?? '');
  const [type, setType] = useState<CampaignType>(campaign?.type ?? 'donation');
  const [slug, setSlug] = useState(campaign?.slug ?? '');
  const [slugInfo, setSlugInfo] = useState<{ slug: string; available: boolean; reserved: boolean } | null>(null);
  const [description, setDescription] = useState(campaign?.description ?? '');
  const [coverImage, setCoverImage] = useState(campaign?.coverImage ?? '');
  const [backgroundImage, setBackgroundImage] = useState(campaign?.backgroundImage ?? '');
  const [logo, setLogo] = useState(campaign?.logo ?? '');
  const [presets, setPresets] = useState((campaign?.presetAmounts ?? [10, 25, 50, 100]).join(', '));
  const [allowCustom, setAllowCustom] = useState(campaign?.allowCustom ?? true);
  const [minAmount, setMinAmount] = useState(String(campaign?.minAmount ?? 1));
  // LEGACY. No longer editable — "Where this appeal's money goes" below replaces it — but still
  // posted, because on CREATE the server uses it to record the campaign's original account binding,
  // which is the fallback for an appeal that never picks one explicitly. Read-only on purpose: the
  // server now ignores an empty value on edit, so this can never blank a real id.
  const [stripeAccountId] = useState(campaign?.stripeAccountId ?? accounts[0]?.id ?? '');
  // Where this appeal's money goes. '' = the same account as the rest of the site, which is what
  // every existing appeal has and what a new one starts as — a masjid with one account never has to
  // think about this field at all.
  const [paymentAccount, setPaymentAccount] = useState(campaign?.paymentAccount ?? '');
  // Vaulted accounts, fetched on demand so the picker can offer them by name. Only when embedded.
  const [vault, setVault] = useState<FabricStripeAccountRef[]>([]);
  useEffect(() => {
    if (!fabric?.available) return;
    getFabricStripeAccounts().then((r) => setVault(r.accounts)).catch(() => setVault([]));
  }, [fabric?.available]);
  const [coverFees, setCoverFees] = useState(campaign?.coverFees ?? false);
  const [forceCoverFees, setForceCoverFees] = useState(campaign?.forceCoverFees ?? false);
  // Keep the local fee state honest with the server's type→fee rule as the admin switches
  // type, so the preview/labels match what will actually be saved (server re-derives too).
  useEffect(() => {
    if (type === 'zakat') { setForceCoverFees(true); setCoverFees(true); }
    else if (type === 'tuition') { setForceCoverFees(false); setCoverFees(false); } // Students shell: no card-fee
    else setForceCoverFees(false); // donation
  }, [type]);
  const [allowMonthly, setAllowMonthly] = useState(campaign?.allowMonthly ?? false);
  const [goalAmount, setGoalAmount] = useState(String(campaign?.goalAmount ?? 0));
  const [active, setActive] = useState(campaign?.active ?? true);
  const [widgetEnabled, setWidgetEnabled] = useState(campaign?.widgetEnabled ?? false);
  const [thankYou, setThankYou] = useState<ThankYou>(campaign?.thankYou ?? { ...TY_EMPTY });
  const [tyOpen, setTyOpen] = useState(false);
  const [tyDefault, setTyDefault] = useState<ThankYou | null>(null);
  useEffect(() => { getThankYou().then(setTyDefault).catch(() => {}); }, []);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [error, setError] = useState('');

  // Live link-availability feedback (debounced). Checks the chosen slug, or the slug
  // we'd derive from the title when the field is left blank.
  useEffect(() => {
    const desired = slug.trim() || title.trim();
    if (!desired) { setSlugInfo(null); return; }
    let live = true;
    const t = setTimeout(() => {
      checkSlug(desired, campaign?.id).then((r) => live && setSlugInfo(r)).catch(() => {});
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [slug, title, campaign?.id]);

  const save = async () => {
    setBusy(true); setError('');
    const body: CampaignInput = {
      title: title.trim(),
      type,
      slug: slug.trim() || undefined,
      description: description.trim(),
      coverImage: coverImage.trim(),
      backgroundImage: backgroundImage.trim(),
      logo: logo.trim(),
      presetAmounts: presets.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
      allowCustom,
      minAmount: Number(minAmount) || 0,
      stripeAccountId,
      paymentAccount,
      // Donation offers coverFees; Zakat/Tuition offer it only when the fee is enforced.
      // The server re-derives this authoritatively (deriveFees) — this just keeps them in sync.
      coverFees: type === 'donation' ? coverFees : forceCoverFees,
      forceCoverFees,
      allowMonthly,
      widgetEnabled,
      goalAmount: Number(goalAmount) || 0,
      active,
      thankYou,
    };
    if (!body.title) { setError('Please enter a title.'); setBusy(false); return; }
    try { editing ? await updateCampaign(campaign!.id, body) : await createCampaign(body); onDone(); }
    catch (err) { setError(msg(err)); setBusy(false); }
  };
  const remove = async () => {
    if (!campaign) return;
    setDel(true);
    try { await deleteCampaign(campaign.id); onDone(); } catch (err) { setError(msg(err)); setDel(false); }
  };

  // Live preview reflects the form as you type; the share URL + QR use the computed
  // slug and the public (Cloudflare) base when set, else this device's address.
  const previewPresets = presets.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const previewData = {
    title, description, coverImage, backgroundImage, logo,
    presetAmounts: previewPresets, allowCustom,
    goalAmount: Number(goalAmount) || 0, raised: campaign?.raised ?? 0,
  };
  const computedSlug = slugifyClient(slug.trim() || title);
  const shareUrl = computedSlug ? `${shareBase || originBase()}/${computedSlug}` : '';

  return (
    <div className="subform glass-inset">
      <div className="cprev-head"><span className="hint">Live preview</span></div>
      <CampaignPreview variant="full" data={previewData} currency={currency} masjidName={masjidName} masjidLogo={masjidLogo} />
      <Field id="ct" label="Title"><input id="ct" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. General Fund, Zakat, Building Fund" /></Field>
      <Field id="ctype" label="Type">
        <select id="ctype" className="input" value={type} onChange={(e) => setType(e.target.value as CampaignType)}>
          <option value="donation">Donation</option>
          <option value="zakat">Zakat</option>
          <option value="tuition">Tuition</option>
        </select>
        <span className="hint">
          {type === 'zakat' ? 'Zakat always covers the card fee, so the full Zakat reaches the masjid.'
            : type === 'tuition' ? 'Tuition is powered by OpenMasjid Students — parents look up their child by Student ID and pay the school balance. Amounts and records come from Students.'
            : 'For a donation you can offer donors the option to cover the card fee.'}
        </span>
      </Field>
      <Field id="cslug" label="Link to share">
        <div className="slug-field">
          <span className="slug-prefix" aria-hidden="true"><Link2 size={13} /> {linkHost()}/</span>
          <input id="cslug" className="input mono" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={slugifyClient(title) || 'zakat'} autoComplete="off" spellCheck={false} />
        </div>
        <SlugHint info={slugInfo} hasInput={!!(slug.trim() || title.trim())} />
      </Field>
      {shareUrl && <ShareLink url={shareUrl} isPublic={!!shareBase && /^https:/.test(shareBase)} />}
      <Field id="cd" label="Description (optional)"><textarea id="cd" className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <ImageField id="cimg" label="Cover image (optional)" hint="Shown inside the page." value={coverImage} onChange={setCoverImage} />
      <ImageField id="cbg" label="Background image (optional)" hint="This page's full background. Leave empty for the default look (it won't use the dashboard wallpaper)." value={backgroundImage} onChange={setBackgroundImage} />
      <ImageField id="clogo" label="Campaign logo (optional)" hint="Shown as this campaign's icon. Leave empty to use your masjid logo." value={logo} onChange={setLogo} />
      {/* Amount + goal fields only apply to donation/zakat. A tuition campaign takes the
          exact school balance from OpenMasjid Students, so it has no presets/min/goal. */}
      {type !== 'tuition' && (
        <>
          <Field id="cp" label={`Suggested amounts (${currency}, comma-separated)`}><input id="cp" className="input" value={presets} onChange={(e) => setPresets(e.target.value)} placeholder="10, 25, 50, 100" /></Field>
          <div className="grid2">
            <Field id="cmin" label={`Minimum custom amount (${currency})`}><input id="cmin" className="input" type="number" min="0" step="0.01" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} /></Field>
            <Field id="cgoal" label={`Goal (${currency}, 0 = none)`}><input id="cgoal" className="input" type="number" min="0" step="0.01" value={goalAmount} onChange={(e) => setGoalAmount(e.target.value)} /></Field>
          </div>
        </>
      )}
      <PaymentAccountField
        value={paymentAccount}
        onChange={setPaymentAccount}
        accounts={accounts}
        vault={vault}
        fabric={fabric}
        status={campaign?.paymentAccountStatus}
        resolvedLabel={campaign?.paymentAccountLabel ?? ''}
      />
      {type === 'tuition' && (
        <div className="glass-inset" style={{ padding: '0.7rem 0.85rem', display: 'grid', gap: '0.35rem' }}>
          <p className="hint" style={{ marginBlock: 0 }}>
            <GraduationCap size={13} /> This is a <b>tuition</b> page powered by <b>OpenMasjid Students</b>. Parents enter their child’s <b>Student ID</b> (printed on the statement), confirm the child’s name, then see the balance and open months and pay by card — the payment is recorded straight into Students.
          </p>
          <p className="hint" style={{ marginBlock: 0 }}>
            Set <b>Where this appeal’s money goes</b> to the <b>same account OpenMasjid Students uses</b>, so tuition lands in the school’s account and reconciles there. Nothing else on this page (amounts, goals, fees) applies — Students owns all of that.
          </p>
        </div>
      )}
      {type !== 'tuition' && (
        <>
          <label className="check-row"><input type="checkbox" checked={allowCustom} onChange={(e) => setAllowCustom(e.target.checked)} /><span>Allow donors to enter their own amount</span></label>
          {/* Card-fee control, driven by the campaign type (server re-derives + enforces). */}
          {type === 'zakat' ? (
            <p className="hint">Card fees are covered by the donor (required for Zakat) — the masjid receives the full Zakat.</p>
          ) : (
            <label className="check-row"><input type="checkbox" checked={coverFees} onChange={(e) => setCoverFees(e.target.checked)} /><span>Offer donors the option to cover card fees</span></label>
          )}
          <label className="check-row"><input type="checkbox" checked={allowMonthly} onChange={(e) => setAllowMonthly(e.target.checked)} /><span>Offer a monthly (recurring) option</span></label>
          {/* Per-campaign thank-you override — empty fields inherit the global "Thank-you" tab. */}
          <details className="ty-override" open={tyOpen} onToggle={(e) => setTyOpen((e.target as HTMLDetailsElement).open)}>
            <summary className="check-row" style={{ cursor: 'pointer' }}><HeartHandshake size={15} /><span>Custom thank-you for this campaign (optional)</span></summary>
            <div style={{ marginBlockStart: '0.6rem' }}>
              <p className="hint" style={{ marginBlockStart: 0 }}>Leave a field blank to use your default thank-you. Variables: {'{name}'}, {'{amount}'}, {'{campaign}'}, {'{masjid}'}.</p>
              {tyOpen && <ThankYouPreview value={{ heading: thankYou.heading || tyDefault?.heading || '', message: thankYou.message || tyDefault?.message || '', backgroundImage: thankYou.backgroundImage || tyDefault?.backgroundImage || '', accent: thankYou.accent || tyDefault?.accent || '' }} masjidName={masjidName} currency={currency} />}
              <ThankYouFields value={thankYou} onChange={setThankYou} placeholders={tyDefault ?? undefined} />
            </div>
          </details>
        </>
      )}
      {/* Embeddable widget — paste the campaign into any website (served at /w/<slug>). */}
      <label className="check-row"><input type="checkbox" checked={widgetEnabled} onChange={(e) => setWidgetEnabled(e.target.checked)} /><span>Let this campaign be embedded on other websites (widget)</span></label>
      {widgetEnabled && <WidgetEmbed url={computedSlug ? `${shareBase || originBase()}/w/${computedSlug}` : ''} title={title} isPublic={!!shareBase && /^https:/.test(shareBase)} />}
      <label className="check-row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /><span>Live (visible to donors)</span></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="row-between" style={{ marginBlockStart: '0.4rem' }}>
        {editing ? <button className="btn btn--ghost btn--sm" onClick={remove} disabled={del}><Trash2 size={14} /> Delete</button> : <span />}
        <div className="row" style={{ gap: '0.4rem' }}>
          <button className="btn btn--ghost btn--sm" type="button" onClick={onCancel ?? onDone}>Cancel</button>
          <button className="btn btn--primary btn--sm" onClick={save} disabled={busy}>{busy ? <span className="spinner" /> : null} {editing ? 'Save campaign' : 'Create campaign'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Donations log ───────────────────────────────────────────────────────────
/** Compact "06/20/2026 10:04"-style stamp. */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
/** Compact "12 Mar 2026" stamp — for dates where the time of day tells the admin nothing
 *  (when a plan started, when the next payment is due). '' in, '' out. */
function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
/** "Mastercard - 5319" or '—'. Takes anything card-shaped (a donation or a monthly plan). */
function cardLabel(d: { cardBrand: string; cardLast4: string }): string {
  if (!d.cardBrand && !d.cardLast4) return '';
  const brand = d.cardBrand ? d.cardBrand.charAt(0).toUpperCase() + d.cardBrand.slice(1) : 'Card';
  return d.cardLast4 ? `${brand} - ${d.cardLast4}` : brand;
}
/** Identify a donor across transactions: prefer email, fall back to name. */
function donorKey(d: Donation): string {
  return (d.donorEmail || '').trim().toLowerCase() || (d.donorName || '').trim().toLowerCase();
}
/** What a donation is worth to the masjid after any refund — the figure the totals are built on. */
function netAmount(d: Donation): number {
  return Math.max(0, d.amount - d.refundedAmount);
}
/** The small grey pill that marks a refunded row, or null. Shown in the list AND in the window's
 *  header, so a refund is never something you have to open a row to discover. */
function RefundPill({ d }: { d: Donation }) {
  if (d.refundState === 'none') return null;
  return (
    <span className="don-status don-status--refunded">{d.refundState === 'full' ? 'refunded' : 'part refunded'}</span>
  );
}

function DonationsCard() {
  const [data, setData] = useState<DonationsResult | null>(null);
  const [sel, setSel] = useState<Donation | null>(null);
  const load = async () => {
    const fresh = await getDonations();
    setData(fresh);
    // Keep the open window pointed at the SAME donation's new row, so the totals behind it and the
    // details in front of it can never disagree after a refund.
    setSel((s) => (s ? fresh.donations.find((d) => d.id === s.id) ?? s : s));
  };
  useEffect(() => { void load().catch(() => setData(null)); }, []);
  return (
    <section className="don-page">
      <div className="card-head">
        <ReceiptText size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title-inline">Donations</h2>
            {data && data.donations.length > 0 && <a className="btn btn--ghost btn--sm" href={withBase('/api/admin/donations.csv')}><Download size={14} /> Export CSV</a>}
          </div>
          {data && (
            <p className="muted">
              {money(data.stats.totalRaised, data.stats.currency)} raised · {data.stats.count} donation{data.stats.count === 1 ? '' : 's'}
              {/* Named only when there is something to name — otherwise every masjid reads about a
                  thing that has never happened to them. The total above is already net of it. */}
              {data.stats.totalRefunded > 0 && <> · {money(data.stats.totalRefunded, data.stats.currency)} refunded</>}
            </p>
          )}
        </div>
      </div>
      {!data ? <span className="spinner" /> : data.donations.length === 0 ? (
        <p className="muted">No donations yet. When someone gives, it’ll appear here with full details.</p>
      ) : (
        <div className="don-scroll">
          <table className="don-table">
            <thead><tr>
              <th>ID &amp; Date</th><th>Campaign</th><th>Contact</th><th>Donor</th><th>Amount</th><th>Type</th><th>Card</th><th>Status</th>
            </tr></thead>
            <tbody>
              {data.donations.slice(0, 200).map((d) => (
                <tr key={d.id}>
                  <td>
                    <button className="don-id" onClick={() => setSel(d)} title="View transaction details">{d.ref}</button>
                    <div className="don-date">{fmtDateTime(d.createdAt)}</div>
                  </td>
                  <td>{d.campaignTitle}</td>
                  <td>{d.donorEmail ? <span className="don-contact">{d.donorEmail}</span> : <span className="faint">—</span>}</td>
                  <td>{d.donorName ? <button className="don-id" onClick={() => setSel(d)}>{d.donorName}</button> : <span className="faint">—</span>}</td>
                  {/* What was taken stays the headline figure — it is what the donor's statement
                      says — with what came back named underneath it, so the row explains its own
                      contribution to a total that is net of refunds. */}
                  <td>
                    {money(d.amount, d.currency)}
                    {d.refundState !== 'none' && <div className="don-date">−{money(d.refundedAmount, d.currency)} refunded</div>}
                  </td>
                  <td><span className="don-type">Stripe<span className="faint"> · {d.recurring ? 'Monthly' : 'One-time'} · Web</span></span></td>
                  <td>{cardLabel(d) || <span className="faint">—</span>}</td>
                  <td>
                    <span className={`don-status don-status--${d.status}`}>{d.status}</span>
                    {d.refundState !== 'none' && <div><RefundPill d={d} /></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sel && data && (
        <DonationDetail
          donation={sel}
          all={data.donations}
          onClose={() => setSel(null)}
          onPick={setSel}
          onRefunded={() => void load().catch(() => { /* the window already shows the new state */ })}
        />
      )}
    </section>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className={`detail-value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  );
}

/** Full details for one transaction, the refund controls, and every other donation from the
 *  same donor. `onRefunded` lets the list behind the window follow along. */
function DonationDetail({ donation, all, onClose, onPick, onRefunded }: {
  donation: Donation; all: Donation[]; onClose: () => void; onPick: (d: Donation) => void; onRefunded: () => void;
}) {
  // The window's own copy of the row, so a refund updates what's on screen the instant Stripe
  // confirms it — the list reloads in the background and flows back in through the prop.
  const [don, setDon] = useState(donation);
  useEffect(() => setDon(donation), [donation]);
  const [confirm, setConfirm] = useState<{ amount?: number; reason?: RefundReason; notifyDonor: boolean } | null>(null);

  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden'; // lock background scroll while the window is open
    return () => { html.style.overflow = prev; };
  }, []);
  useEffect(() => {
    // Escape backs out of the refund confirmation first, then closes the window — so it can never
    // dismiss both at once and leave the admin unsure which one they cancelled.
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirm) setConfirm(null); else onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, confirm]);

  const k = donorKey(don);
  const related = k ? all.filter((x) => donorKey(x) === k) : [don];
  const others = related.filter((x) => x.id !== don.id);
  const succeeded = related.filter((x) => x.status === 'succeeded');
  // Net, so a donor's lifetime giving doesn't include money that was handed back to them.
  const lifetime = succeeded.reduce((s, x) => s + netAmount(x), 0);

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal glass-raised win" role="dialog" aria-modal="true" aria-label={`Transaction ${don.ref}`} onClick={(e) => e.stopPropagation()}>
          <div className="tl-bar">
            <button className="tl tl--red" onClick={onClose} aria-label="Close" title="Close"><X size={9} strokeWidth={3.5} /></button>
          </div>
          <div className="modal-head">
            <div>
              <h3 className="modal-title">Transaction {don.ref}</h3>
              <p className="muted" style={{ fontSize: '0.85rem' }}>{fmtDateTime(don.createdAt)}</p>
            </div>
            <RefundPill d={don} />
          </div>

          <div className="detail-grid">
            <DetailRow label="Amount" value={money(don.amount, don.currency)} />
            <DetailRow label="Status" value={<span className={`don-status don-status--${don.status}`}>{don.status}</span>} />
            {don.refundState !== 'none' && (
              <>
                <DetailRow label="Refunded" value={`${money(don.refundedAmount, don.currency)}${don.refundedAt ? ` · ${fmtDateTime(don.refundedAt)}` : ''}`} />
                {/* The figure that reconciles with the totals — worth spelling out on a part
                    refund, where neither the amount nor the refund is the answer. */}
                <DetailRow label="Kept by the masjid" value={money(netAmount(don), don.currency)} />
              </>
            )}
            <DetailRow label="Campaign" value={don.campaignTitle} />
            <DetailRow label="Type" value={`Stripe · ${don.recurring ? 'Monthly' : 'One-time'} · Web`} />
            <DetailRow label="Card" value={cardLabel(don) || '—'} />
            <DetailRow label="Covered fees" value={don.coverFees ? 'Yes' : 'No'} />
            <DetailRow label="Donor" value={don.donorName || '—'} />
            <DetailRow label="Contact" value={don.donorEmail || '—'} />
            <DetailRow label="Payment reference" value={don.paymentIntentId || '—'} mono />
          </div>

          <RefundSection donation={don} onAsk={setConfirm} />

          <div className="detail-section">
            <h4 className="metric-h">From this donor</h4>
            {!k ? (
              <p className="muted">No name or email was given, so we can’t link other donations.</p>
            ) : (
              <>
                <p className="hint">{related.length} donation{related.length === 1 ? '' : 's'} · {money(lifetime, don.currency)} given in total.</p>
                {others.length > 0 && (
                  <div className="don-scroll">
                    <table className="don-table">
                      <thead><tr><th>ID &amp; Date</th><th>Campaign</th><th>Amount</th><th>Status</th></tr></thead>
                      <tbody>
                        {others.map((o) => (
                          <tr key={o.id}>
                            <td><button className="don-id" onClick={() => onPick(o)}>{o.ref}</button><div className="don-date">{fmtDateTime(o.createdAt)}</div></td>
                            <td>{o.campaignTitle}</td>
                            <td>
                              {money(o.amount, o.currency)}
                              {o.refundState !== 'none' && <div className="don-date">−{money(o.refundedAmount, o.currency)} refunded</div>}
                            </td>
                            <td>
                              <span className={`don-status don-status--${o.status}`}>{o.status}</span>
                              {o.refundState !== 'none' && <div><RefundPill d={o} /></div>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {confirm && (
        <RefundConfirm
          donation={don}
          request={confirm}
          onClose={() => setConfirm(null)}
          onRefunded={(fresh) => { setDon(fresh); onRefunded(); }}
        />
      )}
    </>
  );
}

/** The refund controls for one donation: what can be given back, how much, why, and whether to
 *  tell the donor. Collecting the choices here and confirming them in a second window means the
 *  irreversible click is always a considered one — the same shape as stopping a monthly plan. */
function RefundSection({ donation: d, onAsk }: {
  donation: Donation; onAsk: (r: { amount?: number; reason?: RefundReason; notifyDonor: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [part, setPart] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<RefundReason>('requested_by_customer');
  const [notifyDonor, setNotifyDonor] = useState(true);
  const [error, setError] = useState('');

  const canEmail = !!d.donorEmail.trim();
  // Only a payment that actually went through can be given back, and only what's left of it.
  const refundable = d.status === 'succeeded' ? d.refundable : 0;
  const typed = Number(amount);
  const partValid = Number.isFinite(typed) && typed > 0 && typed <= refundable + 1e-9;
  const going = part ? (partValid ? typed : 0) : refundable;

  const start = () => {
    setError('');
    if (part && !partValid) {
      setError(typed > refundable ? `That’s more than the ${money(refundable, d.currency)} left on this donation.` : 'Please enter an amount to refund.');
      return;
    }
    onAsk({ amount: part ? typed : undefined, reason, notifyDonor: notifyDonor && canEmail });
  };

  return (
    <div className="detail-section">
      <h4 className="metric-h">Refund</h4>
      {d.status !== 'succeeded' ? (
        <p className="muted">
          Nothing was taken for this donation, so there’s nothing to refund.
          {d.status === 'pending' && ' If the donor’s card did go through, it’ll be picked up automatically and this will change.'}
        </p>
      ) : d.refundState === 'full' ? (
        <p className="muted">
          All {money(d.refundedAmount, d.currency)} of this donation has been refunded{d.refundedAt ? ` on ${fmtDate(d.refundedAt)}` : ''}.
          It can take 5–10 days to reach the donor’s bank.
        </p>
      ) : !open ? (
        <div className="row-between">
          <p className="muted" style={{ margin: 0 }}>
            {d.refundState === 'partial'
              ? `${money(d.refundedAmount, d.currency)} has already gone back — ${money(refundable, d.currency)} of this donation is left.`
              : `Send this donation back to the donor. ${money(refundable, d.currency)} can be refunded.`}
          </p>
          <button className="btn btn--ghost btn--sm" type="button" onClick={() => setOpen(true)}><Undo2 size={14} /> Refund…</button>
        </div>
      ) : (
        <div className="subform glass-inset">
          {d.recurring && (
            <p className="hint">
              This is one payment of a monthly gift. Refunding it doesn’t stop the plan — use the <b>Monthly</b> tab for that.
            </p>
          )}
          <label className="check-row">
            <input type="radio" name={`refund-${d.id}`} checked={!part} onChange={() => { setPart(false); setError(''); }} />
            <span>Refund all of it — {money(refundable, d.currency)}</span>
          </label>
          <label className="check-row">
            <input type="radio" name={`refund-${d.id}`} checked={part} onChange={() => { setPart(true); setError(''); }} />
            <span>Refund part of it</span>
          </label>
          {part && (
            <Field id={`refund-amount-${d.id}`} label={`How much to refund (${d.currency})`}>
              <input
                id={`refund-amount-${d.id}`}
                className="input plan-in"
                type="number"
                min="0"
                step="0.01"
                max={refundable}
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setError(''); }}
                placeholder={String(refundable)}
                autoFocus
              />
            </Field>
          )}
          <Field id={`refund-reason-${d.id}`} label="Why (recorded in Stripe)">
            <select id={`refund-reason-${d.id}`} className="input plan-in" value={reason} onChange={(e) => setReason(e.target.value as RefundReason)}>
              <option value="requested_by_customer">The donor asked for it back</option>
              <option value="duplicate">It was a duplicate payment</option>
              <option value="fraudulent">The payment was fraudulent</option>
            </select>
          </Field>
          <label className="check-row">
            <input type="checkbox" checked={notifyDonor && canEmail} disabled={!canEmail} onChange={(e) => setNotifyDonor(e.target.checked)} />
            <span>
              Email the donor about it
              {!canEmail && <span className="faint"> — they didn’t leave an email address</span>}
              {canEmail && <span className="faint"> — {d.donorEmail}</span>}
            </span>
          </label>
          {error && <p className="form-error">{error}</p>}
          {/* Safe choice first, as everywhere else in this panel: the first Tab must never land on
              the button that moves money. */}
          <div className="confirm-actions">
            <button className="btn btn--ghost" type="button" onClick={() => { setOpen(false); setError(''); }}>Cancel</button>
            <button className="btn btn--danger" type="button" onClick={start} disabled={part && !partValid}>
              <Undo2 size={16} /> Refund {money(going, d.currency)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The last word before money leaves. Does the refund itself, so the admin sees the result — the
 *  amount that went back, whether the donor was told, and whether Stripe is still settling it —
 *  rather than a window that closes and leaves them wondering.
 *
 *  The fresh row is handed back the MOMENT Stripe confirms, not when this window is dismissed.
 *  Otherwise clicking outside (or pressing Escape) to dismiss the success would throw away the
 *  update, and the panel behind would go on showing a donation that had already been refunded. */
function RefundConfirm({ donation: d, request, onClose, onRefunded }: {
  donation: Donation;
  request: { amount?: number; reason?: RefundReason; notifyDonor: boolean };
  onClose: () => void;
  onRefunded: (fresh: Donation) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // `full` is captured here rather than recomputed on render: `d` is refreshed by the refund we
  // just made, so re-deriving it afterwards would read the NEW balance and could flip the wording.
  const [done, setDone] = useState<{ refunded: number; currency: string; pending: boolean; full: boolean; donorEmailed: boolean; donorEmailReason: string } | null>(null);
  const going = request.amount ?? d.refundable;

  const go = async () => {
    setBusy(true); setError('');
    try {
      const r = await refundDonation(d.id, request);
      setDone({
        refunded: r.refunded,
        currency: r.currency,
        pending: r.pending,
        // The server's own verdict on whether anything is left, not our arithmetic.
        full: r.donation.refundState === 'full',
        donorEmailed: r.donorEmailed,
        donorEmailReason: r.donorEmailReason,
      });
      onRefunded(r.donation);
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };

  // Why the donor wasn't emailed, in words the admin can act on. 'not-asked' needs no sentence —
  // they chose not to — so it is the one case that says nothing at all.
  const emailNote = (reason: string): string => {
    if (reason === 'not-asked') return '';
    if (reason === 'no-email') return 'They didn’t leave an email address, so please let them know yourself.';
    if (reason === 'no-fabric' || reason === 'not_configured') {
      return 'Email isn’t set up in OpenMasjidOS yet, so we couldn’t write to them — please let them know yourself.';
    }
    return 'We couldn’t email them just now — please let them know yourself.';
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal glass-raised confirm-modal" role="dialog" aria-modal="true" aria-label="Refund this donation" onClick={(e) => e.stopPropagation()}>
        <div className="donate-emblem" aria-hidden="true">{done ? <CheckCircle2 size={28} /> : <Undo2 size={28} />}</div>
        {done ? (
          <>
            <h3 className="modal-title">{money(done.refunded, done.currency)} is on its way back</h3>
            <p className="muted" style={{ marginBlockStart: '0.4rem' }}>
              {done.pending
                ? 'Stripe has accepted the refund and is settling it now.'
                : 'Stripe has sent it back to the donor’s card.'}{' '}
              It can take 5–10 days to appear, depending on their bank.
              {done.full ? ' This donation has come off your totals.' : ' Your totals have gone down by that much.'}
            </p>
            <p className="hint" style={{ marginBlockStart: '0.5rem' }}>
              {done.donorEmailed ? 'The donor has been emailed about it.' : emailNote(done.donorEmailReason)}
            </p>
            <div className="confirm-actions">
              <button className="btn btn--primary" type="button" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <h3 className="modal-title">Refund {money(going, d.currency)}?</h3>
            <p className="muted" style={{ marginBlockStart: '0.4rem' }}>
              {request.amount === undefined || request.amount >= d.refundable - 1e-9
                ? 'The whole donation'
                : `${money(going, d.currency)} of ${d.donorName ? `${d.donorName}’s` : 'this'} ${money(d.amount, d.currency)} donation`}
              {' '}goes back to the card it was paid with, and comes off what your masjid has raised. This can’t be undone.
            </p>
            {request.notifyDonor && <p className="hint" style={{ marginBlockStart: '0.5rem' }}>The donor will be emailed about it.</p>}
            {error && <p className="form-error" style={{ marginBlockStart: '0.5rem' }}>{error}</p>}
            <div className="confirm-actions">
              <button className="btn btn--ghost" type="button" onClick={onClose} disabled={busy}>Keep it</button>
              <button className="btn btn--danger" type="button" onClick={go} disabled={busy}>
                {busy ? <span className="spinner" /> : <Undo2 size={16} />} Refund {money(going, d.currency)}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Monthly plans (recurring donations) ─────────────────────────────────────
/** How many plan rows the table draws. Plenty for any masjid, and it keeps the tab quick on a
 *  Pi; anything past it is named under the table rather than quietly dropped. */
const PLAN_ROWS = 200;
/** The words that follow an amount: "a month", "a year", "every 3 months". Empty when we
 *  couldn't read how often the plan repeats (Stripe unreachable). */
function everyPhrase(p: { interval: string; intervalCount: number; frequency: string }): string {
  if (p.intervalCount === 1) {
    if (p.interval === 'month') return 'a month';
    if (p.interval === 'year') return 'a year';
    if (p.interval === 'week') return 'a week';
    if (p.interval === 'day') return 'a day';
  }
  // Anything else ("Every 3 months") reads fine after an amount once it's lower-cased.
  return p.frequency ? p.frequency.toLowerCase() : '';
}
/** "£25 a month" — or just "£25" when how often it repeats isn't known. */
function planAmount(p: Plan): string {
  const every = everyPhrase(p);
  return every ? `${money(p.amount, p.currency)} ${every}` : money(p.amount, p.currency);
}
/** The plan's status in the donor-friendly words the server chose for it. Uses the phrase
 *  variant of the pill: these labels are short sentences ("Payment failed", "Not known") and
 *  the donations table's uppercase treatment would shout them. */
function PlanStatus({ p }: { p: Plan }) {
  return <span className={`don-status don-status--phrase don-status--${p.status}`}>{p.statusLabel}</span>;
}
/** "YYYY-MM-DD" for a date input, from an ISO stamp ('' stays ''). */
function isoDay(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
/** Step an ISO date on by `n` billing intervals. Used ONLY to show the admin, in words, which
 *  payment will be the last one before they save "stop after N more" — the server does the
 *  real cancel_at maths. Month/year steps clamp to the end of a short month (31 Jan + 1 month
 *  is 28 Feb, not 2 Mar) so the sentence matches what Stripe will actually bill. */
function addIntervals(iso: string, n: number, interval: string, intervalCount: number): Date | null {
  const start = new Date(iso);
  if (Number.isNaN(start.getTime()) || n < 0) return null;
  const step = n * Math.max(1, intervalCount);
  const out = new Date(start.getTime());
  const day = out.getUTCDate();
  if (interval === 'day') out.setUTCDate(out.getUTCDate() + step);
  else if (interval === 'week') out.setUTCDate(out.getUTCDate() + step * 7);
  else if (interval === 'month') out.setUTCMonth(out.getUTCMonth() + step);
  else if (interval === 'year') out.setUTCFullYear(out.getUTCFullYear() + step);
  else return null;
  // A month/year step that overflowed (e.g. into 2 March) rolls back to the last day of the
  // month we meant.
  if ((interval === 'month' || interval === 'year') && out.getUTCDate() < day) out.setUTCDate(0);
  return out;
}

/** Every monthly (recurring) plan the masjid has. The list of plans comes from our own
 *  records; each plan's current state is read live from Stripe, so this page still works —
 *  minus statuses — when the box can't reach the internet. */
function PlansCard() {
  const [data, setData] = useState<PlansResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); // the Refresh button only — never the whole page
  const [sel, setSel] = useState<Plan | null>(null);
  // Only asked for when there are no plans at all, to tell "nobody has signed up yet" apart
  // from "no appeal even offers monthly giving" — two very different things to say to an admin.
  const [monthlyOffered, setMonthlyOffered] = useState<boolean | null>(null);

  const load = async (refresh?: boolean) => {
    if (refresh) setBusy(true);
    try { setData(await getPlans(refresh)); setError(''); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!data || data.plans.length > 0 || monthlyOffered !== null) return;
    listCampaigns()
      .then((cs) => setMonthlyOffered(cs.some((c) => c.active && c.allowMonthly && c.type !== 'tuition')))
      .catch(() => { /* the empty state simply stays general */ });
  }, [data, monthlyOffered]);

  const stats = data?.stats;
  const plans = data?.plans ?? [];
  const shown = plans.slice(0, PLAN_ROWS);
  // With no live state every plan comes back 'unknown', so nothing counts as active and
  // "£0.00 a month from 0 active plans" would be a measurement we never took. Only the two
  // halves that come from our own records are true then. Keyed on whether any row actually
  // carries live state — Stripe being reachable isn't enough, since a plan whose Stripe keys
  // have gone reaches Stripe fine and still tells us nothing.
  const liveStats = !!data?.stripeReachable && plans.some((p) => p.live);
  return (
    <section className="don-page">
      <div className="card-head">
        <Repeat size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title-inline">Monthly plans</h2>
            <button className="btn btn--ghost btn--sm" onClick={() => void load(true)} disabled={busy}>
              {busy ? <span className="spinner" /> : <RefreshCw size={14} />} Refresh
            </button>
          </div>
          {stats && (
            <p className="muted">
              {liveStats && (
                <>
                  {money(stats.monthlyTotal, stats.currency)} a month from {stats.active} active plan{stats.active === 1 ? '' : 's'}
                  {' · '}
                </>
              )}
              {stats.plans} plan{stats.plans === 1 ? '' : 's'} in all
              {' · '}{money(stats.collected, stats.currency)} collected so far
            </p>
          )}
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {data && !data.stripeReachable && (
        <p className="muted plan-note">
          <CloudOff size={14} aria-hidden="true" />
          {data.message || 'We couldn’t reach Stripe just now, so this is what your own records say. The amounts and dates are right; each plan’s current status will fill in once Stripe can be reached again.'}
        </p>
      )}
      {data && data.stripeReachable && data.message && <p className="muted plan-note">{data.message}</p>}

      {!data ? (error ? null : <span className="spinner" aria-label="Loading monthly plans" />) : plans.length === 0 ? (
        monthlyOffered === false ? (
          <p className="muted">
            None of your appeals offer monthly giving yet. Open one on the <b>Campaigns</b> tab and tick
            “Offer a monthly (recurring) option” — donors can then choose to give every month, and their plans
            will appear here.
          </p>
        ) : (
          <p className="muted">
            No monthly plans yet. When a donor chooses to give every month, their plan appears here with everything
            they’ve given so far — and you can pause or stop it from here.
          </p>
        )
      ) : (
        <div className="don-scroll">
          <table className="don-table">
            <thead><tr>
              <th>Plan</th><th>Donor</th><th>Campaign</th><th>Amount</th><th>Collected</th><th>Last paid</th><th>Next payment</th><th>Card</th><th>Status</th>
            </tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id}>
                  <td>
                    <button className="don-id" onClick={() => setSel(p)} title="Manage this monthly plan">{p.ref}</button>
                    <div className="don-date">started {fmtDate(p.startedAt)}</div>
                  </td>
                  <td>
                    {p.donorName
                      ? <button className="don-id" onClick={() => setSel(p)}>{p.donorName}</button>
                      : <span className="faint">Not given</span>}
                    <div className="don-date">{p.donorEmail || '—'}</div>
                  </td>
                  <td>{p.campaignTitle || <span className="faint">—</span>}</td>
                  <td>{planAmount(p)}</td>
                  <td>{money(p.collected, p.currency)}<span className="faint"> · {p.payments} payment{p.payments === 1 ? '' : 's'}</span></td>
                  <td>{fmtDate(p.lastPaymentAt) || <span className="faint">—</span>}</td>
                  <td>{fmtDate(p.nextPaymentAt) || <span className="faint">—</span>}</td>
                  <td>{cardLabel(p) || <span className="faint">—</span>}</td>
                  <td><PlanStatus p={p} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Say so rather than let the older rows simply disappear off the bottom. */}
          {plans.length > shown.length && (
            <p className="hint">Showing the {shown.length} newest of {plans.length} plans.</p>
          )}
        </div>
      )}
      {sel && <PlanDetail seed={sel} onClose={() => setSel(null)} onChanged={() => void load()} />}
    </section>
  );
}

/** One plan, with everything the masjid can do to it. The window opens on what the list
 *  already knew (so it never flashes empty), then fills in the live detail + payment history. */
function PlanDetail({ seed, onClose, onChanged }: { seed: Plan; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<PlanDetailResult | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [stopOpen, setStopOpen] = useState(false);
  const [acting, setActing] = useState(''); // which action is running ('' = none)
  const [actErr, setActErr] = useState('');
  const [done, setDone] = useState('');

  const load = async () => {
    try { setDetail(await getPlan(seed.id)); setLoadErr(''); }
    catch (e) { setLoadErr(msg(e)); }
  };
  useEffect(() => { void load(); }, [seed.id]);

  // Lock the page behind the window while it's open. Deliberately its own effect: the Escape
  // handler below re-runs as state changes, and re-capturing the scroll value each time would
  // restore the wrong one on close.
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { html.style.overflow = prev; };
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (stopOpen) setStopOpen(false); else onClose(); // back out of the confirm first
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, stopOpen]);

  const plan = detail?.plan ?? seed;
  const reachable = detail ? detail.stripeReachable : seed.live;
  const stopped = plan.status === 'canceled';
  const paused = plan.status === 'paused';

  /** Run one action on the plan: busy state, a friendly error, the fresh plan, and the list
   *  behind the window kept in step. Never leave the admin guessing whether it worked. */
  const act = async (key: string, fn: () => Promise<{ plan: Plan }>, okWords: string) => {
    setActing(key); setActErr(''); setDone('');
    try {
      const { plan: fresh } = await fn();
      setDetail((d) => (d ? { ...d, plan: fresh } : d));
      setDone(okWords);
      onChanged();
      void load(); // the history and the next payment date will have moved
    } catch (e) { setActErr(msg(e)); } finally { setActing(''); }
  };

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal glass-raised win plan-modal" role="dialog" aria-modal="true" aria-label={`Monthly plan ${plan.ref}`} onClick={(e) => e.stopPropagation()}>
          <div className="tl-bar">
            <button className="tl tl--red" onClick={onClose} aria-label="Close" title="Close"><X size={9} strokeWidth={3.5} /></button>
          </div>
          <div className="modal-head">
            <div>
              <h3 className="modal-title">Monthly plan {plan.ref}</h3>
              <p className="muted" style={{ fontSize: '0.85rem' }}>{plan.donorName || 'A donor'} · started {fmtDate(plan.startedAt)}</p>
            </div>
            <PlanStatus p={plan} />
          </div>

          {!reachable && (
            <p className="muted plan-note">
              <CloudOff size={14} aria-hidden="true" />
              {detail?.message || 'We couldn’t reach Stripe just now. Everything below comes from your own records — the plan’s current status and its next payment will show once Stripe can be reached again.'}
            </p>
          )}

          <div className="detail-grid">
            {/* No Status row: the pill in the window's header above already says it. */}
            <DetailRow label="Amount" value={planAmount(plan)} />
            <DetailRow label="Campaign" value={plan.campaignTitle || '—'} />
            <DetailRow label="Donor" value={plan.donorName || '—'} />
            <DetailRow label="Contact" value={plan.donorEmail || '—'} />
            <DetailRow label="Card" value={cardLabel(plan) || '—'} />
            <DetailRow label="Started" value={fmtDate(plan.startedAt) || '—'} />
            <DetailRow label="Last payment" value={fmtDate(plan.lastPaymentAt) || 'None yet'} />
            <DetailRow
              label="Next payment"
              value={fmtDate(plan.nextPaymentAt) || (
                paused ? 'Nothing while paused'
                  : stopped ? 'None — this plan has stopped'
                  // An end set at or before the next charge means Stripe will take nothing more,
                  // even though the plan is still 'active'. Saying "Not known" there would read as
                  // a fault right beside the end date the admin has just chosen.
                  : plan.endsAt ? `None — this plan ends on ${fmtDate(plan.endsAt)}`
                  // These two we also KNOW nothing more is coming: Stripe has given up retrying
                  // an unpaid plan, and one that never finished never took a first payment.
                  : plan.status === 'unpaid' ? 'None — the payments kept failing, so Stripe stopped trying'
                  : plan.status === 'incomplete' ? 'None — the first payment never went through'
                  : 'Not known'
              )}
            />
            <DetailRow label="Collected so far" value={`${money(plan.collected, plan.currency)} · ${plan.payments} payment${plan.payments === 1 ? '' : 's'}`} />
            {/* A plan stopped by hand has an end date in the past, so it must not read as a
                schedule — and if Stripe didn't give us one, "it keeps going" would be a flat
                contradiction of the "Stopped" pill two rows above. */}
            <DetailRow
              label={stopped ? 'Stopped' : 'Ends'}
              value={stopped ? fmtDate(plan.endsAt) || 'This plan has stopped' : fmtDate(plan.endsAt) || 'No end set — it keeps going'}
            />
            <DetailRow label="Plan reference" value={plan.id} mono />
          </div>

          <div className="detail-section">
            <h4 className="metric-h">Manage this plan</h4>
            {stopped ? (
              <p className="muted">This plan has stopped, so there’s nothing left to change. The donor can start a new monthly gift from your donation page whenever they like.</p>
            ) : !reachable ? (
              <p className="muted">Changing a plan needs Stripe, and we couldn’t reach it just now. Close this window and press <b>Refresh</b> in a moment.</p>
            ) : (
              <div className="list">
                <div className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">{paused ? 'Payments are paused' : 'Pause payments'}</div>
                    <div className="list-row__sub">
                      {paused
                        ? 'Nothing is being taken from the donor’s card. The months missed while paused are never billed afterwards — resume whenever you like and payments simply start again.'
                        : 'Stop taking payments for a while. Nothing is taken from the donor’s card while paused, and the missed months are never billed later. You can resume any time.'}
                    </div>
                  </div>
                  <button
                    className="btn btn--ghost btn--sm"
                    disabled={!!acting}
                    onClick={() => paused
                      ? void act('resume', () => resumePlan(plan.id), 'Payments have started again.')
                      : void act('pause', () => pausePlan(plan.id), 'Payments are paused — nothing will be taken until you resume.')}
                  >
                    {acting === (paused ? 'resume' : 'pause') ? <span className="spinner" /> : paused ? <Play size={14} /> : <Pause size={14} />}
                    {paused ? 'Resume payments' : 'Pause payments'}
                  </button>
                </div>

                <PlanEnd
                  plan={plan}
                  busy={!!acting}
                  saving={acting === 'schedule'}
                  onSave={(body, words) => void act('schedule', () => schedulePlanEnd(plan.id, body), words)}
                />

                <div className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">Stop this plan</div>
                    <div className="list-row__sub">End this monthly gift for good. Nothing already given is refunded, and the donor is never charged again.</div>
                  </div>
                  <button className="btn btn--ghost btn--sm" disabled={!!acting} onClick={() => setStopOpen(true)}>
                    {acting === 'cancel' ? <span className="spinner" /> : <Ban size={14} />} Stop plan…
                  </button>
                </div>
              </div>
            )}
            {actErr && <p className="form-error" role="alert">{actErr}</p>}
            {done && !actErr && <p className="hint plan-ok" role="status">{done}</p>}
          </div>

          <div className="detail-section">
            <h4 className="metric-h">Payment history</h4>
            {loadErr ? <p className="muted">{loadErr}</p>
              : !detail ? <span className="spinner" aria-label="Loading payments" />
              // "Couldn't read it" must never be shown as "there are none" — the figures above
              // come from our own records and would contradict it.
              : detail.historyUnavailable ? <p className="muted">We couldn’t load this plan’s payments just now. The totals above come from your own records and are unaffected.</p>
              : detail.invoices.length === 0 ? <p className="muted">No payments on this plan yet.</p>
              : (
                <div className="don-scroll">
                  <table className="don-table">
                    <thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Tries</th><th>What happened</th></tr></thead>
                    <tbody>
                      {detail.invoices.map((iv) => (
                        <tr key={iv.id}>
                          <td>
                            {fmtDate(iv.date) || '—'}
                            {iv.number && <div className="don-date">{iv.number}</div>}
                          </td>
                          <td>{money(iv.paid > 0 ? iv.paid : iv.amount, iv.currency)}</td>
                          <td><span className={`don-status don-status--phrase don-status--${iv.status}`}>{iv.statusLabel}</span></td>
                          <td>{iv.attempts > 0 ? iv.attempts : <span className="faint">—</span>}</td>
                          <td className="plan-why">
                            {iv.failureReason || <span className="faint">—</span>}
                            {iv.hostedUrl && (
                              <> <a href={iv.hostedUrl} target="_blank" rel="noreferrer noopener">Open in Stripe <ExternalLink size={11} /></a></>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </div>
        </div>
      </div>
      {/* A sibling of the window, not a child: the glass card's backdrop-filter would trap a
          fixed-position dialog inside it. */}
      {stopOpen && (
        <PlanStopConfirm
          plan={plan}
          onClose={() => setStopOpen(false)}
          onStop={() => {
            setStopOpen(false);
            void act('cancel', () => cancelPlan(plan.id), 'This plan has stopped — the donor won’t be charged again.');
          }}
        />
      )}
    </>
  );
}

/** "When it ends": keep going, finish on a chosen day, or take a set number of FURTHER
 *  payments and stop. The consequence is spelled out before saving, because this is exactly
 *  where a masjid would otherwise take one payment too many or one too few. */
function PlanEnd({ plan, busy, saving, onSave }: {
  plan: Plan; busy: boolean; saving: boolean; onSave: (body: PlanSchedule, words: string) => void;
}) {
  const [mode, setMode] = useState<'open-ended' | 'date' | 'count'>(plan.endsAt ? 'date' : 'open-ended');
  const [date, setDate] = useState(() => isoDay(plan.endsAt));
  const [count, setCount] = useState('3');
  const [err, setErr] = useState('');
  // Seed the form from the plan when a DIFFERENT plan is shown — deliberately not on
  // `plan.endsAt`. Saving "stop after 5 further payments" makes the server derive an end date,
  // and re-seeding on that would flip the admin's own choice to "End on a day" underneath them,
  // contradicting the success line and turning the next Save into a plain date (which would
  // replace the race-safe cancel_at the count path sets).
  useEffect(() => {
    setMode(plan.endsAt ? 'date' : 'open-ended');
    setDate(isoDay(plan.endsAt));
    setErr('');
  }, [plan.id]);

  const nextIso = plan.nextPaymentAt;
  const canCount = !!nextIso && !!plan.interval;
  // Why counting from the next payment isn't on offer — and how to get it back. An end already
  // set at or before the next charge leaves us no next payment to count from, which is a very
  // different thing from not knowing when it is.
  // An existing end date is checked FIRST: it is the one thing the admin must clear before
  // counting works, so leading with "resume payments" on a paused plan that also has an end set
  // would send them round twice.
  const countBlocked = canCount ? ''
    : plan.endsAt
      ? 'This plan already has an end date — choose “Keep going until I stop it” and save, then you can count from the next payment.'
      : plan.status === 'paused'
        ? 'Payments are paused, so there’s no next payment to count from — resume payments, then you can count from it.'
        : 'We don’t know when the next payment is due yet, so we can’t count from it.';
  const n = Number(count);
  const countOk = Number.isInteger(n) && n >= 1 && n <= 120;
  // The last payment is at the next one plus (n − 1) further intervals; the server then ends
  // the plan between that charge and the one after it.
  const lastPay = canCount && countOk ? addIntervals(nextIso, n - 1, plan.interval, plan.intervalCount) : null;
  const endMoment = date ? new Date(`${date}T23:59:59Z`) : null;
  const endsBeforeNext = !!(endMoment && nextIso && endMoment.getTime() < new Date(nextIso).getTime());

  let consequence = 'It keeps going until you stop it.';
  if (mode === 'date') {
    if (!endMoment || Number.isNaN(endMoment.getTime())) consequence = 'Pick the day this plan should finish.';
    else if (endsBeforeNext) consequence = `No further payment will be taken — the plan ends on ${fmtDate(endMoment.toISOString())}.`;
    else consequence = `Payments carry on until ${fmtDate(endMoment.toISOString())}, then it ends.`;
  } else if (mode === 'count') {
    // The reason sits under the radio itself in this case, so don't say it twice.
    if (!canCount) consequence = '';
    else if (!countOk) consequence = 'Choose between 1 and 120 further payments.';
    else if (lastPay) consequence = `Last payment ${fmtDate(lastPay.toISOString())}, then it ends.`;
    else consequence = `${n} more payment${n === 1 ? '' : 's'}, then it ends.`;
  }

  const save = () => {
    setErr('');
    if (mode === 'open-ended') return onSave({ mode: 'open-ended' }, 'This plan will now keep going until you stop it.');
    if (mode === 'date') {
      if (!date || !endMoment || Number.isNaN(endMoment.getTime())) return setErr('Please pick the day this plan should end.');
      if (endMoment.getTime() <= Date.now()) return setErr('Please pick a day in the future.');
      return onSave({ mode: 'date', endDate: date }, `This plan will end on ${fmtDate(endMoment.toISOString())}.`);
    }
    if (!canCount) return setErr(countBlocked);
    if (!countOk) return setErr('Please enter a number of further payments between 1 and 120.');
    onSave({ mode: 'count', count: n }, lastPay
      ? `Set — last payment ${fmtDate(lastPay.toISOString())}, then this plan ends.`
      : `Set — this plan will stop after ${n} more payment${n === 1 ? '' : 's'}.`);
  };

  const radio = (value: 'open-ended' | 'date' | 'count', label: string, disabled?: boolean) => (
    <label className="check-row">
      <input type="radio" name={`plan-end-${plan.id}`} checked={mode === value} disabled={disabled} onChange={() => { setMode(value); setErr(''); }} />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="list-row">
      <div className="list-row__main">
        <div className="list-row__title">When it ends</div>
        <div className="list-row__sub">Let this gift run on, finish it on a day you choose, or take a set number of further payments and then stop.</div>
        <div className="subform glass-inset plan-end">
          {radio('open-ended', 'Keep going until I stop it')}
          {radio('date', 'End on a day')}
          {mode === 'date' && (
            <Field id={`plan-end-date-${plan.id}`} label="Day this plan ends">
              <input id={`plan-end-date-${plan.id}`} className="input plan-in" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          )}
          {radio('count', 'Stop after a set number of further payments', !canCount)}
          {/* The disabled radio explains itself, right where it is greyed out. */}
          {countBlocked && <p className="hint">{countBlocked}</p>}
          {mode === 'count' && (
            <Field id={`plan-end-count-${plan.id}`} label="Number of further payments">
              <input id={`plan-end-count-${plan.id}`} className="input plan-in" type="number" min={1} max={120} step={1} value={count} onChange={(e) => setCount(e.target.value)} />
            </Field>
          )}
          {consequence && <p className="hint">{consequence}</p>}
          {err && <p className="form-error" role="alert" style={{ marginBlockEnd: 0 }}>{err}</p>}
          <button className="btn btn--primary btn--sm plan-save" onClick={save} disabled={busy}>
            {saving ? <span className="spinner" /> : <CalendarClock size={14} />} Save when it ends
          </button>
        </div>
      </div>
    </div>
  );
}

/** Stopping is the one change that can't be undone, so it asks first — the confirm pattern
 *  from the donor page, in admin words.
 *
 *  Stopping is ONE action: straight away. There is no "stop after the next payment" here,
 *  because Stripe raises no further invoice for a plan cancelled at the end of its period —
 *  and for a donation there is no service period to run out either, so the two would have
 *  been financially identical while promising the masjid money that never arrives. The way
 *  to take one more payment and then stop is "When it ends", pointed at below. */
function PlanStopConfirm({ plan, onClose, onStop }: {
  plan: Plan; onClose: () => void; onStop: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal glass-raised confirm-modal" role="dialog" aria-modal="true" aria-label="Stop this monthly plan" onClick={(e) => e.stopPropagation()}>
        <div className="donate-emblem" aria-hidden="true"><Ban size={28} /></div>
        <h3 className="modal-title">Stop this monthly plan?</h3>
        <p className="muted" style={{ marginBlockStart: '0.4rem' }}>
          {plan.donorName ? `${plan.donorName}’s` : 'This'} gift of {planAmount(plan)} will end and they won’t be charged again.
          Nothing already given goes back, and they can start a new monthly gift whenever they like.
        </p>
        <p className="hint" style={{ marginBlockStart: '0.5rem' }}>
          Need to send a past payment back? Open it in <b>Donations</b> and refund it there.
        </p>
        <p className="hint" style={{ marginBlockStart: '0.5rem' }}>
          Want one more payment first? Set “Stop after a set number of further payments” to 1 under <b>When it ends</b>.
        </p>
        {/* Safe choice first, as on the donor page — the first Tab must never land on the
            irreversible button. */}
        <div className="confirm-actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Keep it going</button>
          <button className="btn btn--danger" type="button" onClick={onStop}><Ban size={16} /> Stop now</button>
        </div>
      </div>
    </div>
  );
}

// ── Public access (Cloudflare Tunnel) ─────────────────────────────────────────
function PublicAccessCard() {
  const [t, setT] = useState<TunnelStatus | null>(null);
  const [token, setToken] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState('');
  const [showTok, setShowTok] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => getTunnel().then((s) => { setT(s); setEnabled(s.enabled); setHost(s.publicHostname); }).catch(() => { /* ignore */ });
  useEffect(() => void load(), []);
  // While on, poll so the admin sees starting → connected.
  useEffect(() => {
    if (!t?.enabled) return;
    const iv = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(iv);
  }, [t?.enabled]);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const body: { token?: string; enabled?: boolean; publicHostname?: string } = { enabled, publicHostname: host.trim() };
      if (token.trim()) body.token = token.trim();
      const updated = await saveTunnel(body);
      setT(updated);
      setHost(updated.publicHostname);
      setToken('');
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  };

  const dot = t?.state === 'running' ? '' : t?.state === 'error' ? ' status-dot--warn' : ' status-dot--idle';
  const stateText = !t ? ''
    : t.state === 'running' ? 'Connected — reachable publicly'
    : t.state === 'starting' ? 'Connecting…'
    : t.state === 'error' ? (t.message || 'Disconnected')
    : 'Off';

  return (
    <section className="glass panel">
      <div className="card-head">
        <Globe size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Public access (Cloudflare Tunnel)</h2>
          <p className="muted">Optional — take donations from outside the masjid network over secure HTTPS, with no port-forwarding. Only enable this if you want your donation links reachable on the public internet.</p>
        </div>
      </div>
      <details className="steps-details">
        <summary>How to set up a tunnel</summary>
        <ol className="steps">
          <li>Create a free <a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer noopener">Cloudflare account <ExternalLink size={11} /></a> and add a domain.</li>
          <li>Go to <b>Zero Trust → Networks → Tunnels</b> → <b>Create a tunnel</b> (Cloudflared).</li>
          <li>Add a <b>Public hostname</b> (e.g. <code>give.yourmasjid.org</code>) → service <code>http://localhost:8080</code>.</li>
          <li>Copy the tunnel’s <b>token</b>, paste it below, and turn it on.</li>
        </ol>
      </details>
      <Field id="tok" label={t?.hasToken ? 'Tunnel token — saved; blank keeps it' : 'Tunnel token'}>
        <div className="input-affix">
          <input id="tok" className="input mono" type={showTok ? 'text' : 'password'} value={token} onChange={(e) => setToken(e.target.value)} placeholder={t?.hasToken ? '•••••••• (unchanged)' : 'eyJ…'} autoComplete="off" spellCheck={false} />
          <button type="button" className="affix-btn" onClick={() => setShowTok((s) => !s)} aria-label={showTok ? 'Hide' : 'Show'}>{showTok ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        </div>
      </Field>
      <Field id="pubhost" label="Public address (the domain you set up in Cloudflare)">
        <input id="pubhost" className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="give.yourmasjid.org" autoComplete="off" spellCheck={false} />
        <span className="hint">{host.trim()
          ? `Your campaign links + QR codes use https://${host.trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '')}`
          : 'The public hostname from step 3 above. Used to build your shareable donation links + QR codes.'}</span>
      </Field>
      <label className="check-row"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span>Turn on public access</span></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="row-between" style={{ marginBlockStart: '0.4rem' }}>
        <span className="row" style={{ gap: '0.45rem' }}>{t && <><span className={`status-dot${dot}`} /><span className="hint">{stateText}</span></>}</span>
        <button className="btn btn--primary btn--sm" onClick={save} disabled={busy}>{busy ? <span className="spinner" /> : null} Save</button>
      </div>
    </section>
  );
}

// ── Notifications ─────────────────────────────────────────────────────────────
function Notifications({ embedded }: { embedded: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ delivered: boolean; reason?: string; baseUrlSet: boolean; hasSecret: boolean } | null>(null);
  const [error, setError] = useState('');
  const test = async () => {
    setBusy(true); setError(''); setResult(null);
    try { setResult(await sendTestNotification()); } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  };
  const text = result
    ? result.delivered ? 'Sent! Check your masjid’s notification channel.'
      : result.reason === 'disabled' ? 'Notifications aren’t turned on in OpenMasjidOS yet (Settings → Notifications).'
      : !result.baseUrlSet || !result.hasSecret ? 'Notifications work when this app is launched from OpenMasjidOS.'
      : 'Couldn’t deliver right now — check your OpenMasjidOS notification settings.'
    : '';
  return (
    <section className="glass panel">
      <div className="row-between">
        <div className="row"><Bell size={18} className="panel-ico" aria-hidden="true" /><div><h2 className="section-title-inline">Notifications</h2><p className="muted">{embedded ? 'New donations are relayed to your masjid’s channel via OpenMasjidOS.' : 'When launched from OpenMasjidOS, new donations alert your masjid’s channel.'}</p></div></div>
        <button className="btn btn--sm" onClick={test} disabled={busy}>{busy ? <span className="spinner" /> : <Bell size={15} />} Send test</button>
      </div>
      {(text || error) && <p className={error ? 'form-error' : 'hint'} role="status" style={{ marginBlockStart: '0.6rem' }}>{error || text}</p>}
    </section>
  );
}

// ── Thank-you editor (global default + per-campaign override) ────────────────
const TY_VARS = ['{name}', '{amount}', '{campaign}', '{masjid}'];
const TY_EMPTY: ThankYou = { heading: '', message: '', backgroundImage: '', accent: '' };

/** Substitute the thank-you variables for the live preview (mirrors the donor page). */
function fillVars(tpl: string, v: { name: string; amount: string; campaign: string; masjid: string }): string {
  let out = tpl;
  if (!v.name.trim()) out = out.replace(/,?\s*\{name\}\s*,?/g, ' ');
  out = out.replace(/\{name\}/g, v.name).replace(/\{amount\}/g, v.amount).replace(/\{campaign\}/g, v.campaign).replace(/\{masjid\}/g, v.masjid);
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([!?.,])/g, '$1').trim();
}

const tyAccent = (a: string) => (/^#[0-9a-fA-F]{3,8}$/.test(a.trim()) ? a.trim() : '');

/** Live preview of the thank-you screen, with sample variable values filled in. */
function ThankYouPreview({ value, masjidName, currency }: { value: ThankYou; masjidName: string; currency: string }) {
  const vars = { name: 'Yusuf', amount: money(50, currency || 'USD'), campaign: 'General Fund', masjid: masjidName || 'Your Masjid' };
  const bg = safeImg(value.backgroundImage);
  const accent = tyAccent(value.accent);
  const readable = useReadableTheme(bg || undefined, 'dark');
  return (
    <div className="cprev" data-theme={readable} aria-label="Thank-you preview">
      <div className={`cprev-bg${bg ? '' : ' cprev-bg--default'}`} style={bg ? { backgroundImage: `url("${bg}")` } : undefined} />
      <div className="cprev-card glass-raised">
        <div className="cprev-emblem" aria-hidden="true" style={accent ? { color: accent } : undefined}><HeartHandshake size={18} /></div>
        <div className="cprev-title" style={accent ? { color: accent } : undefined}>{fillVars(value.heading || 'JazākAllāhu khayran!', vars)}</div>
        <p className="cprev-desc">{fillVars(value.message || 'Your donation was received. May Allah accept it and reward you.', vars)}</p>
      </div>
    </div>
  );
}

/** The editable fields shared by the global default and the per-campaign override. */
function ThankYouFields({ value, onChange, placeholders }: { value: ThankYou; onChange: (v: ThankYou) => void; placeholders?: ThankYou }) {
  const set = (patch: Partial<ThankYou>) => onChange({ ...value, ...patch });
  return (
    <>
      <Field id="ty-h" label="Heading"><input id="ty-h" className="input" value={value.heading} placeholder={placeholders?.heading || 'JazākAllāhu khayran, {name}!'} onChange={(e) => set({ heading: e.target.value })} /></Field>
      <Field id="ty-m" label="Message"><textarea id="ty-m" className="input" rows={3} value={value.message} placeholder={placeholders?.message || 'Your donation of {amount} to {campaign} was received…'} onChange={(e) => set({ message: e.target.value })} /></Field>
      <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap', margin: '-0.2rem 0 0.6rem' }}>
        <span className="hint" style={{ alignSelf: 'center' }}>Insert:</span>
        {TY_VARS.map((v) => <button key={v} type="button" className="btn btn--ghost btn--sm mono" onClick={() => set({ message: `${value.message}${value.message && !value.message.endsWith(' ') ? ' ' : ''}${v}` })}>{v}</button>)}
      </div>
      <ImageField id="ty-bg" label="Background image (optional)" hint="Shown behind the thank-you. Empty uses the donation page's background." value={value.backgroundImage} onChange={(bg) => set({ backgroundImage: bg })} />
      <Field id="ty-a" label="Accent colour (optional)"><input id="ty-a" className="input mono" value={value.accent} placeholder="#1FA37A" onChange={(e) => set({ accent: e.target.value })} /></Field>
    </>
  );
}

/** The global default thank-you editor (its own dock tab). */
function ThankYouCard({ masjidName, currency }: { masjidName: string; currency: string }) {
  const [value, setValue] = useState<ThankYou | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { getThankYou().then(setValue).catch(() => setError('Couldn’t load the thank-you message.')); }, []);
  if (!value) return <section className="glass panel"><span className="spinner" aria-label="Loading" /></section>;
  const save = async () => {
    setBusy(true); setError('');
    try { setValue(await saveThankYou(value)); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };
  return (
    <section className="glass panel">
      <div className="card-head">
        <HeartHandshake size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Thank-you message</h2>
          <p className="muted">Shown right after a donation. Use {'{name}'}, {'{amount}'}, {'{campaign}'} and {'{masjid}'} to personalise it — a campaign can override this on its own editor.</p>
        </div>
      </div>
      <div className="cprev-head"><span className="hint">Live preview</span></div>
      <ThankYouPreview value={value} masjidName={masjidName} currency={currency} />
      <ThankYouFields value={value} onChange={setValue} />
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn--primary" onClick={save} disabled={busy}>{busy ? <span className="spinner" /> : <CheckCircle2 size={16} />} {saved ? 'Saved' : 'Save thank-you'}</button>
    </section>
  );
}

/** A small preview of the emailed receipt (sample values filled in; body newlines kept). */
/** A light, Stripe-style preview of the emailed receipt (sample values; the amount/date/method/
 *  fund render in a details table SEPARATE from the paragraph, with the masjid logo + contact). */
function EmailReceiptPreview({ value, masjid, currency }: { value: EmailReceipt; masjid: MasjidProfile; currency: string }) {
  const vars = { name: 'Yusuf', amount: money(50, currency || 'USD'), campaign: 'General Fund', masjid: masjid.name || 'Your Masjid' };
  const accent = tyAccent(value.accent) || '#1FA37A';
  const logo = safeImg(masjid.logo);
  const rowSty = { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid #eef1f3', fontSize: '12px' } as const;
  const contact = [masjid.email, masjid.phone].filter((s) => s && s.trim()).join(' · ');
  return (
    <>
      <div className="cprev-head"><span className="hint">Email preview</span></div>
      <div style={{ background: '#f4f6f9', borderRadius: '12px', padding: '16px' }}>
        <div style={{ maxWidth: '380px', margin: '0 auto', background: '#ffffff', border: '1px solid #e6eaed', borderRadius: '12px', padding: '20px 18px', color: '#16242b' }}>
          <div style={{ textAlign: 'center', marginBottom: '10px' }}>
            {logo ? <img src={logo} alt="" style={{ maxHeight: '48px', maxWidth: '160px' }} /> : <div style={{ fontSize: '16px', fontWeight: 700 }}>{masjid.name || 'Your Masjid'}</div>}
            <div style={{ marginTop: '8px', fontSize: '10px', letterSpacing: '.06em', textTransform: 'uppercase', color: '#9aa7af' }}>Receipt · 0065A17F</div>
          </div>
          <div style={{ color: accent, fontSize: '15px', fontWeight: 700, textAlign: 'center', marginBottom: '6px' }}>{fillVars(value.heading || 'JazākAllāhu khayran, {name}!', vars)}</div>
          <div style={{ color: '#42535c', fontSize: '12px', lineHeight: 1.5, textAlign: 'center', whiteSpace: 'pre-wrap', marginBottom: '10px' }}>{fillVars(value.body || 'Thank you for your donation.', vars)}</div>
          <div>
            <div style={rowSty}><span style={{ color: '#7a8892' }}>Amount paid</span><b>{money(50, currency || 'USD')}</b></div>
            <div style={rowSty}><span style={{ color: '#7a8892' }}>Date paid</span><span>Jul 15, 2026, 6:03 PM</span></div>
            <div style={rowSty}><span style={{ color: '#7a8892' }}>Payment method</span><span>Visa •••• 4242</span></div>
            <div style={rowSty}><span style={{ color: '#7a8892' }}>Fund</span><span>General Fund</span></div>
          </div>
          {contact && (
            <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #eef1f3', textAlign: 'center', fontSize: '11px', color: '#7a8892' }}>
              Questions? Contact {masjid.name || 'us'} — {contact}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Email receipt — SETUP (Settings tab, next to Notifications): the on/off toggle + provider
 *  status + a "send me a test" that reaches the ADMIN via the alert channel. The receipt DESIGN
 *  (subject/heading/note/preview) lives on the Thank-you tab (EmailDesignCard). */
function EmailSetupCard() {
  const [value, setValue] = useState<EmailReceipt | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  useEffect(() => { getEmailReceipt().then(setValue).catch(() => setError('Couldn’t load the email settings.')); }, []);
  if (!value) return <section className="glass panel"><span className="spinner" aria-label="Loading" /></section>;

  const toggle = async (enabled: boolean) => {
    setSaving(true); setError(''); setValue({ ...value, enabled });
    try { setValue(await saveEmailReceipt({ enabled })); }
    catch (e) { setError(msg(e)); setValue({ ...value, enabled: !enabled }); }
    finally { setSaving(false); }
  };
  // "Send me a test" reaches the ADMIN (you) via the Fabric alert channel — the platform sends it
  // to your OWN OpenMasjidOS email/webhook; this app never sees your address.
  const test = async () => {
    setTesting(true); setTestMsg('');
    try {
      const r = await sendTestAlert();
      setTestMsg(
        r.delivered
          ? `Sent ✓ — check your OpenMasjidOS admin email${r.webhook ? ' (and webhook)' : ''}. Donor receipts use this same email provider.`
          : r.reason === 'disabled_by_admin'
            ? 'This is turned off in OpenMasjidOS → Settings → Alerts (both channels off for “Test message”). Turn email on there to receive it.'
            : r.reason === 'no-fabric'
              ? 'Run this app under OpenMasjidOS to reach your admin inbox.'
              : 'Couldn’t send — make sure OpenMasjidOS is reachable, then try again.',
      );
    } catch (e) { setTestMsg(msg(e)); } finally { setTesting(false); }
  };

  const statusNote = (): string => {
    if (!value.embedded) return 'Email receipts send through OpenMasjidOS. Run this app under OpenMasjidOS and set up an email provider (Settings → Email) to use them.';
    switch (value.emailStatus) {
      case 'ok': return 'Connected to your OpenMasjidOS email ✓ — receipts send from your Settings → Email address.';
      case 'not_configured': return 'No email provider is set up in OpenMasjidOS yet — set one up in Settings → Email there.';
      case 'rate_limited': return 'Email is set up, but sending is rate-limited right now.';
      case 'error': return 'The last receipt send hit a problem — check your provider in OpenMasjidOS → Settings → Email.';
      default: return 'Receipts are emailed to your donors through your OpenMasjidOS email provider.';
    }
  };

  return (
    <section className="glass panel">
      <div className="card-head">
        <Mail size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Email receipts</h2>
          <p className="muted">Email donors a receipt through your OpenMasjidOS email provider. Design what it says on the <b>Thank-you</b> tab.</p>
        </div>
      </div>
      <p className="hint">{statusNote()}</p>
      <label className="check-row"><input type="checkbox" checked={value.enabled} disabled={saving} onChange={(e) => toggle(e.target.checked)} /><span>Email a receipt to donors who leave an email address</span></label>
      {error && <p className="form-error">{error}</p>}
      {value.embedded && (
        <>
          <button className="btn btn--ghost" style={{ marginBlockStart: '0.5rem' }} type="button" onClick={test} disabled={testing}>{testing ? <span className="spinner" /> : <Send size={15} />} Send me a test</button>
          <p className="hint" style={{ marginBlockStart: '0.4rem' }}>The test goes to <b>you</b> (your OpenMasjidOS admin email/webhook), not a donor — it confirms OpenMasjidOS can reach you through the same email provider your receipts use.</p>
          {testMsg && <p className="hint">{testMsg}</p>}
        </>
      )}
    </section>
  );
}

/** Email receipt — DESIGN (Thank-you tab, below the on-page thank-you): the editable content +
 *  preview. Turn receipts on / test them in Settings → Email receipts. */
function EmailDesignCard({ masjid, currency }: { masjid: MasjidProfile; currency: string }) {
  const [value, setValue] = useState<EmailReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { getEmailReceipt().then(setValue).catch(() => setError('Couldn’t load the email receipt design.')); }, []);
  if (!value) return <section className="glass panel"><span className="spinner" aria-label="Loading" /></section>;

  const set = (patch: EmailReceiptPatch) => setValue({ ...value, ...patch });
  const save = async () => {
    setBusy(true); setError('');
    try {
      setValue(await saveEmailReceipt({ subject: value.subject, heading: value.heading, body: value.body, accent: value.accent }));
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };

  return (
    <section className="glass panel">
      <div className="card-head">
        <Mail size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Email receipt design</h2>
          <p className="muted">The receipt emailed to donors — a proper receipt with your masjid logo, then the amount, date, payment method and fund (all filled in automatically). You just write the thank-you note. Variables: {'{name}'}, {'{masjid}'}.</p>
        </div>
      </div>
      {!value.enabled && <p className="hint">Email receipts are currently <b>off</b> — turn them on (and test them) in Settings → Email receipts. You can still design it here.</p>}
      <EmailReceiptPreview value={value} masjid={masjid} currency={currency} />
      <Field id="er-s" label="Subject"><input id="er-s" className="input" value={value.subject} placeholder="Your donation receipt — {masjid}" onChange={(e) => set({ subject: e.target.value })} /></Field>
      <Field id="er-h" label="Heading"><input id="er-h" className="input" value={value.heading} placeholder="JazākAllāhu khayran, {name}!" onChange={(e) => set({ heading: e.target.value })} /></Field>
      <Field id="er-b" label="Thank-you note"><textarea id="er-b" className="input" rows={3} value={value.body} onChange={(e) => set({ body: e.target.value })} /></Field>
      <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap', margin: '-0.2rem 0 0.6rem' }}>
        <span className="hint" style={{ alignSelf: 'center' }}>Insert:</span>
        {['{name}', '{masjid}'].map((v) => <button key={v} type="button" className="btn btn--ghost btn--sm mono" onClick={() => set({ body: `${value.body}${value.body && !value.body.endsWith(' ') ? ' ' : ''}${v}` })}>{v}</button>)}
      </div>
      <p className="hint" style={{ marginBlockStart: 0 }}>The masjid logo + contact details come from Settings → Your masjid. The amount, date, payment method and fund are added automatically as a receipt.</p>
      <Field id="er-a" label="Accent colour (optional)"><input id="er-a" className="input mono" value={value.accent} placeholder="#1FA37A" onChange={(e) => set({ accent: e.target.value })} /></Field>
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn--primary" style={{ marginBlockStart: '0.4rem' }} onClick={save} disabled={busy}>{busy ? <span className="spinner" /> : <CheckCircle2 size={16} />} {saved ? 'Saved' : 'Save design'}</button>
    </section>
  );
}

/** The global large-donation-alternative editor (its own dock tab). Above the threshold,
 *  the donor sees this message + QR before the card; they can still pay by card. */
function LargeDonationCard({ currency }: { currency: string }) {
  const [value, setValue] = useState<LargeDonation | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { getLargeDonation().then(setValue).catch(() => setError('Couldn’t load these settings.')); }, []);
  if (!value) return <section className="glass panel"><span className="spinner" aria-label="Loading" /></section>;
  const set = (patch: Partial<LargeDonation>) => setValue({ ...value, ...patch });
  const save = async () => {
    setBusy(true); setError('');
    try { setValue(await saveLargeDonation(value)); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };
  return (
    <section className="glass panel">
      <div className="card-head">
        <HandCoins size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Large-donation alternative</h2>
          <p className="muted">Card fees are highest on big gifts. Above the amount you set, the donor is gently shown a cheaper way to give (like a bank transfer or a Zelle QR code) before the card — they can still choose to pay by card.</p>
        </div>
      </div>
      <Field id="lg-t" label={`Show it at or above (${currency})`}>
        <input id="lg-t" className="input" type="number" min="0" step="0.01" value={value.threshold || ''} placeholder="e.g. 250" onChange={(e) => set({ threshold: Number(e.target.value) || 0 })} />
        <span className="hint">Leave blank (or 0) to never show it.</span>
      </Field>
      <Field id="lg-m" label="What to show the donor"><textarea id="lg-m" className="input" rows={3} value={value.message} placeholder="e.g. For a gift this size, a bank transfer avoids card fees — details below." onChange={(e) => set({ message: e.target.value })} /></Field>
      <ImageField id="lg-qr" label="QR code / image (optional)" hint="A Zelle/bank QR code or any image to show on the large-donation screen." value={value.qrImage} onChange={(v) => set({ qrImage: v })} />
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn--primary" onClick={save} disabled={busy}>{busy ? <span className="spinner" /> : <CheckCircle2 size={16} />} {saved ? 'Saved' : 'Save'}</button>
    </section>
  );
}

/** This device's address (scheme + host + any tunnel base path), or '' when rendered
 *  without a window. Including BASE keeps share links correct when the app is reached on
 *  the LAN under a path prefix (e.g. https://box:8443/donations) with no public URL set. */
function originBase(): string {
  return typeof location !== 'undefined' ? location.origin + BASE : '';
}

/** The host shown as the link prefix (e.g. "give.masjid.org"). Falls back gracefully
 *  when rendered without a window. */
function linkHost(): string {
  return typeof location !== 'undefined' ? location.host : 'your-masjid';
}

/** Accept only safe image URLs for a CSS url() / <img>, else ''. Mirrors the donor page.
 *  A same-origin uploaded image is prefixed with the tunnel base path so previews load
 *  whether the admin is on the LAN or behind the OpenMasjidOS tunnel. */
function safeImg(v: string): string {
  const s = (v ?? '').trim();
  if (/^\/uploads\/[\w.-]+$/.test(s)) return asset(s); // same-origin uploaded image
  return /^(https?:\/\/|data:image\/)/i.test(s) && !/["\\\s]/.test(s) ? s : '';
}

/** An image input that accepts a URL OR an uploaded file (stored on the data volume). */
function ImageField({ id, label, hint, value, onChange }: {
  id: string; label: string; hint?: string; value: string; onChange: (v: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!f) return;
    setBusy(true); setErr('');
    try { onChange(await uploadImage(f)); } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  };
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <div className="img-field">
        {safeImg(value) && <img className="img-preview" src={safeImg(value)} alt="" />}
        <input id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://  — or upload a file" />
        <button type="button" className="btn btn--ghost btn--sm img-upload" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? <span className="spinner" /> : <Upload size={14} />} Upload
        </button>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={onFile} />
      </div>
      {err ? <span className="form-error" style={{ margin: 0 }}>{err}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

interface PreviewData {
  title: string; description: string; coverImage: string; backgroundImage: string; logo: string;
  presetAmounts: number[]; allowCustom: boolean; goalAmount: number; raised: number;
}

/** A faithful mini of the public donation page. `full` is the live editor preview;
 *  `thumb` is the small swatch shown beside each campaign in the list. */
function CampaignPreview({ data, currency, masjidName, masjidLogo, variant }: {
  data: PreviewData; currency: string; masjidName?: string; masjidLogo?: string; variant: 'full' | 'thumb';
}) {
  const bg = safeImg(data.backgroundImage);
  const bgStyle = bg ? { backgroundImage: `url("${bg}")` } : undefined;
  // Campaign's own logo wins; otherwise the masjid logo.
  const logo = safeImg(data.logo || masjidLogo || '');
  // Match the preview's theme to its background so the card text reads (as the donor sees it).
  const readable = useReadableTheme(bg || undefined, 'dark');
  if (variant === 'thumb') {
    return (
      <div className="cprev-thumb" aria-hidden="true">
        <div className={`cprev-bg${bg ? '' : ' cprev-bg--default'}`} style={bgStyle} />
        <span className="cprev-thumb-ico">{logo ? <img className="cprev-thumb-logo" src={logo} alt="" /> : <HandCoins size={15} />}</span>
      </div>
    );
  }
  const fmt = (n: number) => money(n, currency);
  const presets = (data.presetAmounts.length ? data.presetAmounts : [10, 25, 50, 100]).slice(0, 4);
  const cover = safeImg(data.coverImage);
  const pct = data.goalAmount > 0 ? Math.min(100, Math.round((data.raised / data.goalAmount) * 100)) : 0;
  return (
    <div className="cprev" data-theme={readable} aria-label="Live preview of your donation page">
      <div className={`cprev-bg${bg ? '' : ' cprev-bg--default'}`} style={bgStyle} />
      <div className="cprev-card glass-raised">
        {cover && <img className="cprev-cover" src={cover} alt="" />}
        {logo ? <img className="cprev-logo" src={logo} alt="" /> : <div className="cprev-emblem" aria-hidden="true"><HandCoins size={18} /></div>}
        <div className="cprev-title">{data.title || 'Your appeal'}</div>
        {masjidName && <div className="cprev-sub">{masjidName}</div>}
        {data.description && <p className="cprev-desc">{data.description}</p>}
        {data.goalAmount > 0 && <div className="cprev-goal-bar"><div className="cprev-goal-fill" style={{ width: `${pct}%` }} /></div>}
        <div className="cprev-amounts">
          {presets.map((p, i) => <span key={i} className={`cprev-amt${i === 0 ? ' is-active' : ''}`}>{fmt(p)}</span>)}
          {data.allowCustom && <span className="cprev-amt">Other</span>}
        </div>
        <div className="cprev-cta">Donate{presets[0] ? ` ${fmt(presets[0])}` : ''}</div>
      </div>
    </div>
  );
}

/** The shareable link with a QR code. The URL already reflects the public Cloudflare
 *  domain when public access is on (else this device's address). */
function ShareLink({ url, isPublic }: { url: string; isPublic: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  return (
    <div className="share glass-inset">
      <div className="share-qr"><QRCodeSVG value={url} size={104} bgColor="#ffffff" fgColor="#0b1220" level="M" marginSize={2} /></div>
      <div className="share-main">
        <span className="share-label"><QrCode size={13} /> Share this link</span>
        <a className="share-url mono" href={url} target="_blank" rel="noreferrer noopener">{url.replace(/^https?:\/\//, '')}</a>
        <span className="hint">{isPublic ? 'Public link via your Cloudflare domain — scan or share it anywhere.' : 'On your masjid’s network. Turn on public access (Payments tab) for a link that works anywhere.'}</span>
        <div><button className="btn btn--ghost btn--sm" type="button" onClick={copy}>{copied ? <CheckCircle2 size={14} /> : <Copy size={14} />} Copy link</button></div>
      </div>
    </div>
  );
}

/** Client-side mirror of the server slugify, for the live preview placeholder. */
function slugifyClient(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Friendly availability line under the link field. */
function SlugHint({ info, hasInput }: { info: { slug: string; available: boolean; reserved: boolean } | null; hasInput: boolean }) {
  if (!hasInput) return <span className="hint">Leave blank to use the title. Letters, numbers and dashes only.</span>;
  if (!info) return <span className="hint">Checking…</span>;
  if (info.reserved) return <span className="form-error" role="status" style={{ margin: 0 }}>“{info.slug}” is reserved — please choose another.</span>;
  if (!info.available) return <span className="form-error" role="status" style={{ margin: 0 }}>/{info.slug} is already used by another campaign.</span>;
  return <span className="hint" style={{ color: 'var(--color-success)' }}>✓ /{info.slug} is available.</span>;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}
