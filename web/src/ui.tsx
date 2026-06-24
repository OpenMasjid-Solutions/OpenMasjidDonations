/** Small shared UI pieces used by both the public site and the admin area. */
import { HandCoins, Moon, Sun } from 'lucide-react';
import { prefsStore, resolveTheme, usePrefs } from './prefs';

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
