// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Small shared UI pieces used by both the public site and the admin area. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LogOut, Moon, Settings, Sparkles, Sun, User, X } from 'lucide-react';
import { prefsStore, resolveTheme, usePrefs } from './prefs';
import { getSession, logout, type AppInfo, type Session } from './api';
import type { Release } from './changelog';
import { markReleaseSeen, useUnreadRelease } from './whatsnew';
import { withBase } from './base';
import brandMark from './assets/brand-mark.svg';

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
 *  menu in the OpenMasjidOS dashboard and OpenMasjidDisplay.
 *
 *  `admin` says we're on an admin route. It gates the unread-notes dot: this menu is also in the
 *  top bar of the public home page, and a donor has no use for news about the panel. */
export function ProfileMenu({ info, admin }: { info: AppInfo | null; admin?: boolean }) {
  const prefs = usePrefs();
  const current = resolveTheme(prefs.theme);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [whatsNew, setWhatsNew] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = useUnreadRelease(info?.version);

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
  // The dot, though, has to be decided BEFORE the menu is opened (that's the point of it), and the
  // session is only fetched on open. So: the admin route, unless we've since learned they're signed
  // out — which stops a dot pointing at a menu that has no "What's new" item in it.
  const showDot = unread && !!admin && session?.authed !== false;

  return (
    <div className="profile" ref={ref}>
      <button
        className="profile-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={showDot ? 'Account menu — new release notes' : 'Account menu'}
      >
        <User size={18} />
        {showDot && <span className="profile-dot" aria-hidden="true" />}
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
              {unread && <span className="menu-dot" aria-hidden="true" />}
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

/** Inline `**bold**` and `` `code` `` in a release note, as React nodes.
 *
 *  Deliberately NOT a Markdown library: this renders text we write ourselves, in two constructs,
 *  and everything becomes React nodes — there is no dangerouslySetInnerHTML anywhere, so no wording
 *  in a note can inject markup. Ported from OpenMasjid Kiosk's release-notes renderer so a masjid
 *  reads the same shape of note in both apps. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={k++}>{m[1]}</strong>);
    else out.push(<code key={k++}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** "2026-08-04" → "4 August 2026", in the reader's own locale.
 *
 *  Built from the parts as LOCAL midnight, never `new Date(iso)`: a bare ISO date is UTC by spec, so
 *  parsing it directly renders as the day before for every masjid west of Greenwich. */
function releaseDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** The release notes, as a window over the page — same furniture as OpenMasjid Kiosk's "What's
 *  new": traffic-light chrome, the running version named in the subtitle, and the releases
 *  scrolling inside a fixed frame rather than the dialog itself growing.
 *
 *  The notes are loaded on DEMAND: they'd otherwise ride in the main bundle (this menu is in the
 *  shared shell) and slow the donation page for every visitor to carry text only an admin reads.
 *  They ship with the app rather than being fetched from the internet, because a masjid box is
 *  usually LAN-only. */
function WhatsNew({ version, onClose }: { version: string; onClose: () => void }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [failed, setFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    import('./changelog')
      .then((m) => { if (live) setReleases(m.RELEASES); })
      .catch(() => { if (live) setFailed(true); });
    // Opening them is reading them, as far as the dot is concerned.
    markReleaseSeen(version);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => { live = false; document.removeEventListener('keydown', onKey); };
  }, [onClose, version]);

  // Through a portal, for the same reason Kiosk's is: this dialog is a child of the account menu,
  // and the top bar around it is its own stacking context (position: sticky + z-index: 30) — so the
  // scrim's z-index only ever competed with the top bar's siblings, and the bottom dock (z-index
  // 40) painted straight over the window.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal glass-raised whatsnew" role="dialog" aria-modal="true" aria-label="What’s new" onClick={(e) => e.stopPropagation()}>
        <div className="tl-bar">
          <button ref={closeRef} className="tl tl--red" onClick={onClose} aria-label="Close" title="Close"><X size={9} strokeWidth={3.5} /></button>
          <span className="tl tl--amber" aria-hidden="true" />
        </div>
        <div className="modal-head">
          <div className="card-head__main">
            <h3 className="section-title-inline">What’s new</h3>
            <p className="muted">
              Release notes for OpenMasjid Donations{version ? `, up to the v${version} you’re running` : ''}.
            </p>
          </div>
        </div>
        <div className="modal-body">
          {failed && <p className="form-error">We couldn’t load the release notes just now.</p>}
          {!releases && !failed && <p className="muted">Loading…</p>}
          {releases?.map((r) => (
            <section className="wn-release" key={r.version}>
              <h4 className="wn-version">
                {r.version}
                {r.version === version && <span className="status-pill status-pill--ok">You’re on this</span>}
                <span className="faint wn-date">{releaseDate(r.date)}</span>
              </h4>
              <ul className="wn-list">
                {r.notes.map((n, i) => <li key={i}>{inline(n)}</li>)}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
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
