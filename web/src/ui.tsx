// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Small shared UI pieces used by both the public site and the admin area. */
import { useEffect, useRef, useState } from 'react';
import { HandCoins, LogOut, Moon, Settings, Sun, User } from 'lucide-react';
import { prefsStore, resolveTheme, usePrefs } from './prefs';
import { getSession, logout, type AppInfo, type Session } from './api';
import { withBase } from './base';

/** Ambient background. A custom wallpaper image (inherited from the dashboard or set
 *  in the app) fully replaces the preset gradient; otherwise we show the preset scene
 *  (gradient + aurora + geometric pattern, driven by data-wallpaper). */
export function Scene() {
  const prefs = usePrefs();
  const v = prefs.wallpaperImage.trim();
  // Accept only http(s)/data:image URLs with no characters that could break out of
  // url("…"). The value can come from the attacker-craftable #omos fragment, and this
  // is the whole backdrop, so sanitise before use (mirrors Display).
  const safe = /^(https?:\/\/|data:image\/)/i.test(v) && !/["\\\s]/.test(v) ? v : '';
  if (safe) return <div className="scene-img" aria-hidden="true" style={{ backgroundImage: `url("${safe}")` }} />;
  return <div className="scene" aria-hidden="true" />;
}

/** Brand mark; links home so you can leave the admin area. */
export function Brand() {
  return (
    <a className="brand" href="/" aria-label="OpenMasjid Donations — home">
      <HandCoins size={22} aria-hidden="true" />
      <b>OpenMasjid&nbsp;Donations</b>
    </a>
  );
}

/** Light/dark toggle. Choosing a theme manually stops following OpenMasjidOS. */
export function ThemeToggle() {
  const prefs = usePrefs();
  const current = resolveTheme(prefs.theme);
  const toggle = () => prefsStore.patch({ theme: current === 'dark' ? 'light' : 'dark', followOmos: false });
  return (
    <button
      className="icon-btn"
      onClick={toggle}
      aria-label={current === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={current === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {current === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
    </button>
  );
}

/** Top-right account menu (theme, settings, sign out, version) — mirrors the profile
 *  menu in the OpenMasjidOS dashboard and OpenMasjidDisplay. */
export function ProfileMenu({ info }: { info: AppInfo | null }) {
  const prefs = usePrefs();
  const current = resolveTheme(prefs.theme);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    getSession().then(setSession).catch(() => setSession(null));
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggleTheme = () => prefsStore.patch({ theme: current === 'dark' ? 'light' : 'dark', followOmos: false });
  const signOut = async () => { try { await logout(); } catch { /* ignore */ } window.location.href = withBase('/') || '/'; };
  // Under SSO the platform owns the session, so a local sign-out wouldn't stick.
  const canSignOut = !!session?.authed && !session?.sso.enabled;

  return (
    <div className="profile" ref={ref}>
      <button className="profile-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
        <User size={18} />
      </button>
      {open && (
        <div className="profile-menu glass-raised" role="menu">
          <button className="menu-item" role="menuitem" onClick={toggleTheme}>
            {current === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            <span>{current === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
          <a className="menu-item" role="menuitem" href={withBase('/admin#settings')}><Settings size={17} /><span>Settings</span></a>
          {canSignOut && (
            <button className="menu-item" role="menuitem" onClick={signOut}><LogOut size={17} /><span>Sign out</span></button>
          )}
          <div className="menu-foot">OpenMasjid Donations v{info?.version ?? __APP_VERSION__}</div>
        </div>
      )}
    </div>
  );
}

/** Live clock for the top bar, mirroring the OpenMasjidOS dashboard. */
export function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(iv);
  }, []);
  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const date = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <div className="topclock" aria-label={`${time}, ${date}`}>
      <span className="topclock-time">{time}</span>
      <span className="topclock-date">{date}</span>
    </div>
  );
}
