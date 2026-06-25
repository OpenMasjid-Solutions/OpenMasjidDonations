// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { lazy, Suspense, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ShieldCheck } from 'lucide-react';
import { getAppInfo, type AppInfo } from './api';
import { resolveTheme, useOmosAppearanceSync, usePrefs, useReadableTheme } from './prefs';
import { Scene, Brand, Clock, ProfileMenu } from './ui';

// Code-split the two heavy areas so the initial shell stays tiny and fast: the donor
// page (which pulls in Stripe.js) and the admin panel each load only when visited.
const AdminApp = lazy(() => import('./admin').then((m) => ({ default: m.AdminApp })));
const DonatePage = lazy(() => import('./donate').then((m) => ({ default: m.DonatePage })));

/** Top-level paths the app owns — never treated as a campaign slug. Kept in sync with
 *  RESERVED_SLUGS on the server. */
const RESERVED = new Set(['admin', 'api', 'healthz', 'assets', 'static', 'public', 'favicon.ico', 'robots.txt']);

/** Resolve a campaign from the URL. New links are a clean single segment (/zakat);
 *  legacy /c/<slug>-<token> links still resolve (the token is passed through to the
 *  server's back-compat resolver). */
export function parseCampaignPath(pathname: string): { slug: string; token?: string } | null {
  const path = pathname.replace(/\/+$/, '');
  const legacy = path.match(/^\/c\/(.+)-([0-9a-f]{6,})$/i);
  if (legacy) return { slug: legacy[1].toLowerCase(), token: legacy[2] };
  const m = path.match(/^\/([a-z0-9][a-z0-9-]*)$/i);
  if (m && !RESERVED.has(m[1].toLowerCase())) return { slug: m[1].toLowerCase() };
  return null;
}

const LoadFallback = () => (
  <main className="auth-wrap">
    <span className="spinner" aria-label="Loading" />
  </main>
);

export function App() {
  const reduce = useReducedMotion();
  const [info, setInfo] = useState<AppInfo | null>(null);

  // Bootstrap: learn our version + whether we're embedded under OpenMasjidOS.
  useEffect(() => {
    let live = true;
    getAppInfo()
      .then((i) => live && setInfo(i))
      .catch(() => {
        /* shell still renders standalone */
      });
    return () => {
      live = false;
    };
  }, []);

  // Inherit the dashboard's live theme + wallpaper + accent while embedded (polled
  // via our same-origin relay so it isn't mixed-content-blocked on our HTTPS page).
  useOmosAppearanceSync(info?.embedded);

  const path = typeof location !== 'undefined' ? location.pathname.replace(/\/+$/, '') : '/';
  const isAdmin = path === '/admin' || path.startsWith('/admin/');
  const campaign = isAdmin ? null : parseCampaignPath(path);
  // First boot: until setup is done there's nothing for donors at the root, so send
  // the admin straight to setup. Never redirect a campaign link.
  const goToSetup = !!info && !info.onboarded && !isAdmin && !campaign;

  useEffect(() => {
    if (goToSetup) window.location.replace('/admin');
  }, [goToSetup]);

  // Adapt the shell's theme to a custom (inherited) dashboard wallpaper image so text
  // stays readable over it. With no custom image this just tracks the chosen theme.
  // The donation page is excluded — it manages its own theme against its own background.
  const prefs = usePrefs();
  const shellTheme = useReadableTheme(!campaign ? prefs.wallpaperImage.trim() || undefined : undefined, resolveTheme(prefs.theme));
  useEffect(() => {
    if (!campaign) document.documentElement.setAttribute('data-theme', shellTheme);
  }, [shellTheme, campaign]);

  // A campaign donation page is its own full-screen experience (own Scene + chrome).
  if (campaign)
    return (
      <Suspense fallback={<div className="shell"><Scene /><LoadFallback /></div>}>
        <DonatePage slug={campaign.slug} token={campaign.token} />
      </Suspense>
    );

  return (
    <div className="shell">
      <Scene />
      <header className="topbar">
        <Brand />
        <div className="spacer" />
        <Clock />
        <ProfileMenu info={info} />
      </header>
      {goToSetup ? (
        <main className="auth-wrap"><span className="spinner" aria-label="Opening setup" /></main>
      ) : isAdmin ? (
        <Suspense fallback={<LoadFallback />}><AdminApp info={info} /></Suspense>
      ) : (
        <PublicHome info={info} reduce={!!reduce} />
      )}
    </div>
  );
}

function PublicHome({ info, reduce }: { info: AppInfo | null; reduce: boolean }) {
  const rise = reduce ? {} : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 } };
  return (
    <main className="hero">
      <motion.section className="glass-raised hero-card" {...rise} transition={{ duration: reduce ? 0 : 0.5, ease: 'easeOut' }}>
        <div className="hero-emblem" aria-hidden="true">
          <ShieldCheck size={32} />
        </div>
        <h1 className="hero-title">Donations</h1>
        <p className="hero-lead">
          This masjid's donation pages are managed here. Open a specific appeal's link to give, or sign in to
          manage appeals and payments.
        </p>
        <div className="hero-note">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>Self-hosted and private. Card details go straight to Stripe — never through this app.</span>
        </div>
        <p className="hero-foot muted">
          {info?.embedded ? 'Connected to OpenMasjidOS' : 'Running standalone'}
          {' · '}v{info?.version ?? __APP_VERSION__}
          {' · '}
          <a href="/admin">Admin</a>
        </p>
      </motion.section>
    </main>
  );
}
