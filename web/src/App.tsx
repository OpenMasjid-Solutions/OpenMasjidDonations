// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { lazy, Suspense, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ShieldCheck } from 'lucide-react';
import { getAppInfo, type AppInfo } from './api';
import { useOmosAppearanceSync, usePrefs, useReadableTheme } from './prefs';
import { Scene, Brand, Clock, ProfileMenu } from './ui';
import { withBase, stripBase } from './base';

// Code-split the two heavy areas so the initial shell stays tiny and fast: the donor
// page (which pulls in Stripe.js) and the admin panel each load only when visited.
const AdminApp = lazy(() => import('./admin').then((m) => ({ default: m.AdminApp })));
const DonatePage = lazy(() => import('./donate').then((m) => ({ default: m.DonatePage })));
// Its own chunk, deliberately not part of donate.tsx: that module pulls in Stripe.js, and a donor
// stopping their payments has no card to enter.
const PlanStopPage = lazy(() => import('./plan').then((m) => ({ default: m.PlanStopPage })));

/** Top-level paths the app owns — never treated as a campaign slug. Kept in sync with
 *  RESERVED_SLUGS on the server. */
const RESERVED = new Set(['admin', 'api', 'healthz', 'assets', 'static', 'public', 'favicon.ico', 'robots.txt']);

/** The token out of a monthly donor's "stop these payments" link, /stop/<token>, or null.
 *
 *  Two segments, which is why 'stop' is NOT in RESERVED (nor in the server's RESERVED_SLUGS):
 *  `parseCampaignPath` only ever matches a SINGLE segment, so this can never be mistaken for a
 *  campaign and a campaign can never shadow it. Reserving the word would buy only the bare /stop and
 *  would pay for it by having the server silently rename any existing campaign slugged 'stop' on its
 *  next boot (store.ts migrateCampaignSlugs), breaking a link a masjid may already have printed. */
export function parseStopPath(pathname: string): string | null {
  const m = pathname.replace(/\/+$/, '').match(/^\/stop\/([0-9a-fA-F]{32})$/);
  return m ? m[1].toLowerCase() : null;
}
/** True for a bare /stop (or /stop/ with something that isn't a token) — the link was truncated by a
 *  mail client, which is common enough to deserve its own words rather than the public home page. */
export function isTruncatedStopPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, '');
  return (p === '/stop' || p.startsWith('/stop/')) && parseStopPath(p) === null;
}

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

  // Embeddable widget: the server serves /w/<slug> with window.__OMOS_WIDGET__ set, so a
  // masjid can iframe a single campaign into their own site. It renders like a campaign page.
  const widgetSlug = typeof window !== 'undefined' ? window.__OMOS_WIDGET__?.slug : undefined;

  // Strip any tunnel base path (e.g. /donate) so route matching is identical on the LAN
  // and behind the OpenMasjidOS tunnel.
  const path = stripBase((typeof location !== 'undefined' ? location.pathname : '/').replace(/\/+$/, '') || '/');
  const isAdmin = !widgetSlug && (path === '/admin' || path.startsWith('/admin/'));
  const stopToken = widgetSlug || isAdmin ? null : parseStopPath(path);
  const stopTruncated = !widgetSlug && !isAdmin && !stopToken && isTruncatedStopPath(path);
  const campaign = widgetSlug ? { slug: widgetSlug } : isAdmin || stopToken || stopTruncated ? null : parseCampaignPath(path);
  // First boot: until setup is done there's nothing for donors at the root, so send
  // the admin straight to setup. Never redirect a campaign/widget link — and never a donor's stop
  // link either: that replace() would destroy the token, and it is the one copy they have.
  const goToSetup = !!info && !info.onboarded && !isAdmin && !campaign && !stopToken && !stopTruncated;

  useEffect(() => {
    if (goToSetup) window.location.replace(withBase('/admin'));
  }, [goToSetup]);

  // On-scene text color follows the WALLPAPER, not the light/dark toggle. With no custom image
  // the scene is the theme's own gradient — light in light mode since v0.43.0 — and the CSS picks
  // the ink from the theme. A custom image overrides that in BOTH directions, which is why this
  // sets "dark" as well as "light": a DARK image under a LIGHT theme would otherwise get the
  // theme's dark ink written straight onto it. The donate page manages its own scene.
  const prefs = usePrefs();
  const sceneTone = useReadableTheme(!campaign ? prefs.wallpaperImage.trim() || undefined : undefined, 'dark');
  useEffect(() => {
    if (campaign) return;
    const html = document.documentElement;
    // Only when there IS an image to measure. Without one, remove the attribute entirely so the
    // theme's own rule applies rather than a stale measurement of a wallpaper that has gone.
    if (prefs.wallpaperImage.trim()) html.setAttribute('data-scene', sceneTone === 'light' ? 'light' : 'dark');
    else html.removeAttribute('data-scene');
  }, [sceneTone, campaign]);

  // A monthly donor's stop page: its own full-screen experience like the donation page, with no
  // admin chrome and no Stripe.js. Checked BEFORE the campaign branch so a two-segment /stop/<token>
  // is never handed to the campaign resolver.
  if (stopToken)
    return (
      <Suspense fallback={<div className="shell"><Scene /><LoadFallback /></div>}>
        <PlanStopPage token={stopToken} />
      </Suspense>
    );

  // A stop link that arrived cut short (mail clients do wrap and truncate long URLs). Say so, rather
  // than showing a stranger the app's home page and leaving them to guess.
  if (stopTruncated)
    return (
      <div className="shell">
        <Scene />
        <main className="donate-wrap">
          <section className="glass-raised donate-card">
            <div className="donate-emblem" aria-hidden="true"><ShieldCheck size={30} /></div>
            <h1 className="donate-title">This link looks incomplete</h1>
            <p className="donate-desc">
              It may have been cut short by your email program. Try opening it again from the email itself, or copying the whole
              address into your browser.
            </p>
            <p className="donate-desc muted">
              If that doesn’t work, contact the masjid — they can stop a monthly donation for you in a moment.
            </p>
          </section>
        </main>
      </div>
    );

  // A campaign donation page — and the embeddable widget — are their own full-screen
  // experience (own Scene, no admin chrome). The widget is the same page in an iframe.
  if (campaign)
    return (
      <Suspense fallback={<div className="shell"><Scene /><LoadFallback /></div>}>
        <DonatePage slug={campaign.slug} token={'token' in campaign ? campaign.token : undefined} widget={!!widgetSlug} />
      </Suspense>
    );

  return (
    <div className="shell">
      <Scene />
      <header className="topbar">
        <Brand />
        <div className="spacer" />
        <Clock />
        <ProfileMenu info={info} admin={isAdmin} />
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
          <a href={withBase('/admin')}>Admin</a>
        </p>
      </motion.section>
    </main>
  );
}
