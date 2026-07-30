// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Small shared UI pieces used by both the public site and the admin area. */
import { useEffect, useRef, useState } from 'react';
import { LogOut, Moon, Settings, Sparkles, Sun, User, X } from 'lucide-react';
import { prefsStore, resolveTheme, usePrefs } from './prefs';
import { getSession, logout, type AppInfo, type Session } from './api';
import type { Release } from './changelog';
import { withBase } from './base';
import brandMark from './assets/brand-mark.png';

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
      <img className="brand-mark" src={brandMark} width={24} height={24} alt="" aria-hidden="true" />
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
  const [whatsNew, setWhatsNew] = useState(false);
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
  // The release notes are for whoever runs the masjid's site, not for a visitor who happens to
  // open the menu on the public page — so only offer them to a signed-in admin.
  const canSeeNotes = !!session?.authed;

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
          {canSeeNotes && (
            <button className="menu-item" role="menuitem" onClick={() => { setWhatsNew(true); setOpen(false); }}>
              <Sparkles size={17} /><span>What’s new</span>
            </button>
          )}
          {canSignOut && (
            <button className="menu-item" role="menuitem" onClick={signOut}><LogOut size={17} /><span>Sign out</span></button>
          )}
          <div className="menu-foot">OpenMasjid Donations v{info?.version ?? __APP_VERSION__}</div>
        </div>
      )}
      {whatsNew && <WhatsNew version={info?.version ?? __APP_VERSION__} onClose={() => setWhatsNew(false)} />}
    </div>
  );
}

/** The release notes, in a dialog. The notes are loaded on DEMAND: they'd otherwise ride in the
 *  main bundle (this menu is in the shared shell) and slow the donation page for every visitor to
 *  carry text only an admin reads. They ship with the app rather than being fetched from the
 *  internet, because a masjid box is usually LAN-only. */
function WhatsNew({ version, onClose }: { version: string; onClose: () => void }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    import('./changelog')
      .then((m) => { if (live) setReleases(m.RELEASES); })
      .catch(() => { if (live) setFailed(true); });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { live = false; document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal glass-raised whatsnew" role="dialog" aria-modal="true" aria-label="What’s new" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3 className="modal-title">What’s new</h3>
            <p className="muted" style={{ fontSize: '0.85rem' }}>You’re on v{version}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {failed ? (
          <p className="muted">We couldn’t load the release notes just now.</p>
        ) : !releases ? (
          <span className="spinner" aria-label="Loading" />
        ) : (
          <div className="whatsnew-list">
            {releases.map((r) => (
              <section key={r.version}>
                <h4 className="whatsnew-ver">
                  v{r.version}
                  {r.version === version && <span className="badge badge--live">You’re here</span>}
                  <span className="faint whatsnew-date">{r.date}</span>
                </h4>
                <ul className="whatsnew-notes">
                  {r.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
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
