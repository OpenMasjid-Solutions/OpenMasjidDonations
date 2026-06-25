// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The login-protected admin area: first-run setup, then manage Stripe accounts,
 *  campaigns (donation pages), and the donations log. Stripe SECRET keys are sent to
 *  the server and never returned to the browser. */
import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Bell, CalendarDays, CheckCircle2, Coins, Copy, CreditCard, Download, ExternalLink, Eye, EyeOff, Globe, HandCoins,
  KeyRound, Landmark, LayoutDashboard, Link2, LogIn, LogOut, Megaphone, Pencil, Plus, QrCode, ReceiptText, RefreshCw,
  Settings as SettingsIcon, ShieldCheck, Sparkles, TrendingUp, Trash2, Upload, Wallet, X,
} from 'lucide-react';
import {
  checkSlug, completeOnboarding, createAccount, createCampaign, deleteAccount, deleteCampaign, getDonations,
  getMetrics, getSession, getSettings, getTunnel, listCampaigns, login, logout, money, saveMasjid, saveTunnel,
  sendTestNotification, setupAdmin, testAccount, updateAccount, updateCampaign, uploadImage,
  type AccountInput, type AppInfo, type Campaign, type CampaignInput, type Donation, type DonationsResult,
  type MasjidProfile, type Metrics, type Session, type Settings, type StripeAccount, type TunnelStatus, type VerifyResult,
} from './api';
import { useReadableTheme } from './prefs';

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
  if (session?.sso.enabled) return <SsoPrompt />;
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

const SsoPrompt = () => (
  <AuthCard title="Sign in through OpenMasjidOS">
    <p className="auth-sub muted">This app uses your OpenMasjidOS login. Open it from your dashboard — press <b>Open</b> on the Donations app — and you’ll be signed in automatically.</p>
  </AuthCard>
);

// ── Console ─────────────────────────────────────────────────────────────────
function AdminConsole({ info, session, onSignedOut }: { info: AppInfo | null; session: Session; onSignedOut: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reload = () => getSettings().then(setSettings).catch(() => setSettings(null)).finally(() => setLoaded(true));
  useEffect(() => void reload(), []);

  if (!loaded) return <Centered><span className="spinner" aria-label="Loading" /></Centered>;
  if (!settings) return <Centered><p className="muted">Couldn’t load your settings. Please refresh.</p></Centered>;
  if (!settings.onboarded) return <Onboarding settings={settings} onReload={reload} />;
  return <AdminHome info={info} session={session} settings={settings} onReload={reload} onSignedOut={onSignedOut} />;
}

function Onboarding({ settings, onReload }: { settings: Settings; onReload: () => void }) {
  const [finishing, setFinishing] = useState(false);
  const finish = async () => { setFinishing(true); try { await completeOnboarding(); onReload(); } catch { setFinishing(false); } };
  return (
    <main className="admin">
      <div className="page-head">
        <h1 className="page-title">Let’s set up your donations</h1>
        <p className="page-sub">Your masjid details and a Stripe account — then create your first appeal.</p>
      </div>
      <MasjidCard masjid={settings.masjid} onSaved={onReload} />
      <StripeAccountsCard accounts={settings.stripeAccounts} onChanged={onReload} />
      <section className="glass panel">
        <div className="row-between">
          <p className="muted" style={{ margin: 0 }}>
            {!settings.masjid.name.trim() ? 'Add and save your masjid name to finish.'
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
type AdminTab = 'overview' | 'campaigns' | 'donations' | 'payments' | 'settings';
const ADMIN_TABS: { id: AdminTab; label: string; Icon: typeof Megaphone }[] = [
  { id: 'overview', label: 'Overview', Icon: LayoutDashboard },
  { id: 'campaigns', label: 'Campaigns', Icon: Megaphone },
  { id: 'donations', label: 'Donations', Icon: ReceiptText },
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
    payments: { title: 'Payments', sub: 'Your Stripe accounts and optional public access.' },
    settings: { title: 'Settings', sub: 'Masjid details, notifications and your account.' },
  };

  return (
    <>
      <main className={`admin${tab === 'donations' ? ' admin--wide' : ''}`}>
        <div className="page-head">
          <h1 className="page-title">{meta[tab].title}</h1>
          <p className="page-sub">{meta[tab].sub}</p>
        </div>

        {tab === 'overview' && <MetricsDashboard />}
        {tab === 'campaigns' && <CampaignsCard accounts={settings.stripeAccounts} currency={settings.masjid.currency} masjidName={settings.masjid.name} masjidLogo={settings.masjid.logo} />}
        {tab === 'donations' && <DonationsCard />}
        {tab === 'payments' && (
          <>
            <StripeAccountsCard accounts={settings.stripeAccounts} onChanged={onReload} />
            <PublicAccessCard />
          </>
        )}
        {tab === 'settings' && (
          <>
            <MasjidCard masjid={settings.masjid} onSaved={onReload} />
            <Notifications embedded={embedded} />
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
    { icon: <Coins size={17} />, label: 'Total raised', value: fmt(m.totalRaised), accent: true },
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

function StripeAccountsCard({ accounts, onChanged }: { accounts: StripeAccount[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState('');
  const [webhookBase, setWebhookBase] = useState('');
  useEffect(() => {
    getTunnel()
      .then((t) => setWebhookBase(t.enabled && t.publicHostname ? `https://${t.publicHostname}` : originBase()))
      .catch(() => setWebhookBase(originBase()));
  }, []);
  return (
    <section className="glass panel">
      <div className="card-head">
        <Wallet size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Payments (Stripe accounts)</h2>
          <p className="muted">Add one or more Stripe accounts — e.g. a separate account for Zakat. Secret keys stay on this device.</p>
        </div>
      </div>
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
function CampaignsCard({ accounts, currency, masjidName, masjidLogo }: { accounts: StripeAccount[]; currency: string; masjidName: string; masjidLogo: string }) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [editId, setEditId] = useState('');
  // The base for shareable links: the Cloudflare public address when public access is
  // on, otherwise this device's address. Drives the link text + QR codes below.
  const [shareBase, setShareBase] = useState('');
  const reload = () => listCampaigns().then(setCampaigns).catch(() => setCampaigns([]));
  useEffect(() => void reload(), []);
  useEffect(() => {
    getTunnel()
      .then((t) => setShareBase(t.enabled && t.publicHostname ? `https://${t.publicHostname}` : originBase()))
      .catch(() => setShareBase(originBase()));
  }, []);

  const noAccount = accounts.length === 0;
  return (
    <section className="glass panel">
      <div className="card-head">
        <Megaphone size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Campaigns</h2>
          <p className="muted">Each appeal gets its own link you choose — e.g. <span className="mono">/zakat</span>. Point different appeals at different Stripe accounts.</p>
        </div>
      </div>
      {noAccount && <p className="hint">Add a Stripe account below first, then create a campaign.</p>}
      <div className="list">
        {(campaigns ?? []).map((c) => (
          <div key={c.id}>
            <div className="list-row">
              <CampaignPreview variant="thumb" currency={c.currency} data={c} masjidLogo={masjidLogo} />
              <div className="list-row__main">
                <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
                  <span className="list-row__title">{c.title}</span>
                  {c.active ? <span className="status-pill status-pill--ok">Live</span> : <span className="status-pill">Hidden</span>}
                </div>
                <CampaignLink url={c.url} base={shareBase} />
                <p className="list-row__sub">{money(c.raised, c.currency)} raised{c.goalAmount ? ` of ${money(c.goalAmount, c.currency)}` : ''}</p>
              </div>
              <button className="icon-btn" title="Edit" onClick={() => setEditId(editId === c.id ? '' : c.id)}><Pencil size={15} /></button>
            </div>
            {editId === c.id && <CampaignForm campaign={c} accounts={accounts} currency={currency} masjidName={masjidName} masjidLogo={masjidLogo} shareBase={shareBase} onDone={() => { setEditId(''); reload(); }} onCancel={() => setEditId('')} />}
          </div>
        ))}
        {campaigns && campaigns.length === 0 && !creating && <p className="muted" style={{ padding: '0.5rem 0' }}>No campaigns yet.</p>}
      </div>
      {creating ? (
        <CampaignForm accounts={accounts} currency={currency} masjidName={masjidName} masjidLogo={masjidLogo} shareBase={shareBase} onDone={() => { setCreating(false); reload(); }} onCancel={() => setCreating(false)} />
      ) : (
        <button className="btn btn--primary btn--sm" disabled={noAccount} onClick={() => setCreating(true)}><Plus size={15} /> New campaign</button>
      )}
    </section>
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

function CampaignForm({ campaign, accounts, currency, masjidName, masjidLogo, shareBase, onDone, onCancel }: {
  campaign?: Campaign; accounts: StripeAccount[]; currency: string; masjidName: string; masjidLogo: string; shareBase: string; onDone: () => void; onCancel?: () => void;
}) {
  const editing = !!campaign;
  const [title, setTitle] = useState(campaign?.title ?? '');
  const [slug, setSlug] = useState(campaign?.slug ?? '');
  const [slugInfo, setSlugInfo] = useState<{ slug: string; available: boolean; reserved: boolean } | null>(null);
  const [description, setDescription] = useState(campaign?.description ?? '');
  const [coverImage, setCoverImage] = useState(campaign?.coverImage ?? '');
  const [backgroundImage, setBackgroundImage] = useState(campaign?.backgroundImage ?? '');
  const [presets, setPresets] = useState((campaign?.presetAmounts ?? [10, 25, 50, 100]).join(', '));
  const [allowCustom, setAllowCustom] = useState(campaign?.allowCustom ?? true);
  const [minAmount, setMinAmount] = useState(String(campaign?.minAmount ?? 1));
  const [stripeAccountId, setStripeAccountId] = useState(campaign?.stripeAccountId ?? accounts[0]?.id ?? '');
  const [coverFees, setCoverFees] = useState(campaign?.coverFees ?? false);
  const [allowMonthly, setAllowMonthly] = useState(campaign?.allowMonthly ?? false);
  const [goalAmount, setGoalAmount] = useState(String(campaign?.goalAmount ?? 0));
  const [active, setActive] = useState(campaign?.active ?? true);
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
      slug: slug.trim() || undefined,
      description: description.trim(),
      coverImage: coverImage.trim(),
      backgroundImage: backgroundImage.trim(),
      presetAmounts: presets.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
      allowCustom,
      minAmount: Number(minAmount) || 0,
      stripeAccountId,
      coverFees,
      allowMonthly,
      goalAmount: Number(goalAmount) || 0,
      active,
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
    title, description, coverImage, backgroundImage,
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
      <Field id="cp" label={`Suggested amounts (${currency}, comma-separated)`}><input id="cp" className="input" value={presets} onChange={(e) => setPresets(e.target.value)} placeholder="10, 25, 50, 100" /></Field>
      <div className="grid2">
        <Field id="cmin" label={`Minimum custom amount (${currency})`}><input id="cmin" className="input" type="number" min="0" step="0.01" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} /></Field>
        <Field id="cgoal" label={`Goal (${currency}, 0 = none)`}><input id="cgoal" className="input" type="number" min="0" step="0.01" value={goalAmount} onChange={(e) => setGoalAmount(e.target.value)} /></Field>
      </div>
      <Field id="cacct" label="Stripe account (where money goes)">
        <select id="cacct" className="input" value={stripeAccountId} onChange={(e) => setStripeAccountId(e.target.value)}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}{a.configured ? '' : ' (needs keys)'}</option>)}
        </select>
      </Field>
      <label className="check-row"><input type="checkbox" checked={allowCustom} onChange={(e) => setAllowCustom(e.target.checked)} /><span>Allow donors to enter their own amount</span></label>
      <label className="check-row"><input type="checkbox" checked={coverFees} onChange={(e) => setCoverFees(e.target.checked)} /><span>Offer donors the option to cover card fees</span></label>
      <label className="check-row"><input type="checkbox" checked={allowMonthly} onChange={(e) => setAllowMonthly(e.target.checked)} /><span>Offer a monthly (recurring) option</span></label>
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
/** "Mastercard - 5319" or '—'. */
function cardLabel(d: Donation): string {
  if (!d.cardBrand && !d.cardLast4) return '';
  const brand = d.cardBrand ? d.cardBrand.charAt(0).toUpperCase() + d.cardBrand.slice(1) : 'Card';
  return d.cardLast4 ? `${brand} - ${d.cardLast4}` : brand;
}
/** Identify a donor across transactions: prefer email, fall back to name. */
function donorKey(d: Donation): string {
  return (d.donorEmail || '').trim().toLowerCase() || (d.donorName || '').trim().toLowerCase();
}

function DonationsCard() {
  const [data, setData] = useState<DonationsResult | null>(null);
  const [sel, setSel] = useState<Donation | null>(null);
  useEffect(() => { getDonations().then(setData).catch(() => setData(null)); }, []);
  return (
    <section className="don-page">
      <div className="card-head">
        <ReceiptText size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title-inline">Donations</h2>
            {data && data.donations.length > 0 && <a className="btn btn--ghost btn--sm" href="/api/admin/donations.csv"><Download size={14} /> Export CSV</a>}
          </div>
          {data && <p className="muted">{money(data.stats.totalRaised, data.stats.currency)} raised · {data.stats.count} donation{data.stats.count === 1 ? '' : 's'}</p>}
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
                  <td>{money(d.amount, d.currency)}</td>
                  <td><span className="don-type">Stripe<span className="faint"> · {d.recurring ? 'Monthly' : 'One-time'} · Web</span></span></td>
                  <td>{cardLabel(d) || <span className="faint">—</span>}</td>
                  <td><span className={`don-status don-status--${d.status}`}>{d.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sel && data && <DonationDetail donation={sel} all={data.donations} onClose={() => setSel(null)} onPick={setSel} />}
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

/** Full details for one transaction + every other donation from the same donor. */
function DonationDetail({ donation, all, onClose, onPick }: {
  donation: Donation; all: Donation[]; onClose: () => void; onPick: (d: Donation) => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden'; // lock background scroll while the window is open
    return () => { window.removeEventListener('keydown', h); html.style.overflow = prev; };
  }, [onClose]);

  const k = donorKey(donation);
  const related = k ? all.filter((x) => donorKey(x) === k) : [donation];
  const others = related.filter((x) => x.id !== donation.id);
  const succeeded = related.filter((x) => x.status === 'succeeded');
  const lifetime = succeeded.reduce((s, x) => s + x.amount, 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal glass-raised win" role="dialog" aria-modal="true" aria-label={`Transaction ${donation.ref}`} onClick={(e) => e.stopPropagation()}>
        <div className="tl-bar">
          <button className="tl tl--red" onClick={onClose} aria-label="Close" title="Close"><X size={9} strokeWidth={3.5} /></button>
        </div>
        <div className="modal-head">
          <div>
            <h3 className="modal-title">Transaction {donation.ref}</h3>
            <p className="muted" style={{ fontSize: '0.85rem' }}>{fmtDateTime(donation.createdAt)}</p>
          </div>
        </div>

        <div className="detail-grid">
          <DetailRow label="Amount" value={money(donation.amount, donation.currency)} />
          <DetailRow label="Status" value={<span className={`don-status don-status--${donation.status}`}>{donation.status}</span>} />
          <DetailRow label="Campaign" value={donation.campaignTitle} />
          <DetailRow label="Type" value={`Stripe · ${donation.recurring ? 'Monthly' : 'One-time'} · Web`} />
          <DetailRow label="Card" value={cardLabel(donation) || '—'} />
          <DetailRow label="Covered fees" value={donation.coverFees ? 'Yes' : 'No'} />
          <DetailRow label="Donor" value={donation.donorName || '—'} />
          <DetailRow label="Contact" value={donation.donorEmail || '—'} />
          <DetailRow label="Payment reference" value={donation.paymentIntentId || '—'} mono />
        </div>

        <div className="detail-section">
          <h4 className="metric-h">From this donor</h4>
          {!k ? (
            <p className="muted">No name or email was given, so we can’t link other donations.</p>
          ) : (
            <>
              <p className="hint">{related.length} donation{related.length === 1 ? '' : 's'} · {money(lifetime, donation.currency)} given in total.</p>
              {others.length > 0 && (
                <div className="don-scroll">
                  <table className="don-table">
                    <thead><tr><th>ID &amp; Date</th><th>Campaign</th><th>Amount</th><th>Status</th></tr></thead>
                    <tbody>
                      {others.map((o) => (
                        <tr key={o.id}>
                          <td><button className="don-id" onClick={() => onPick(o)}>{o.ref}</button><div className="don-date">{fmtDateTime(o.createdAt)}</div></td>
                          <td>{o.campaignTitle}</td>
                          <td>{money(o.amount, o.currency)}</td>
                          <td><span className={`don-status don-status--${o.status}`}>{o.status}</span></td>
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

/** This device's address (scheme + host), or '' when rendered without a window. */
function originBase(): string {
  return typeof location !== 'undefined' ? location.origin : '';
}

/** The host shown as the link prefix (e.g. "give.masjid.org"). Falls back gracefully
 *  when rendered without a window. */
function linkHost(): string {
  return typeof location !== 'undefined' ? location.host : 'your-masjid';
}

/** Accept only safe image URLs for a CSS url() / <img>, else ''. Mirrors the donor page. */
function safeImg(v: string): string {
  const s = (v ?? '').trim();
  if (/^\/uploads\/[\w.-]+$/.test(s)) return s; // same-origin uploaded image
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
  title: string; description: string; coverImage: string; backgroundImage: string;
  presetAmounts: number[]; allowCustom: boolean; goalAmount: number; raised: number;
}

/** A faithful mini of the public donation page. `full` is the live editor preview;
 *  `thumb` is the small swatch shown beside each campaign in the list. */
function CampaignPreview({ data, currency, masjidName, masjidLogo, variant }: {
  data: PreviewData; currency: string; masjidName?: string; masjidLogo?: string; variant: 'full' | 'thumb';
}) {
  const bg = safeImg(data.backgroundImage);
  const bgStyle = bg ? { backgroundImage: `url("${bg}")` } : undefined;
  const logo = safeImg(masjidLogo || '');
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
