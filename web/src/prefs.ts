// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Per-browser presentation preferences (theme + wallpaper), persisted in
 * localStorage and applied live. This is NOT masjid config — it mirrors how
 * OpenMasjidOS treats appearance, so the site can follow the viewer's OS
 * light/dark setting and, when running under OpenMasjidOS, inherit the
 * dashboard's theme + wallpaper via the OpenMasjidOS Fabric (the appearance half
 * of the platform↔app layer). See docs/ARCHITECTURE.md.
 *
 * The `#omos=…` fragment is attacker-craftable presentation input — we only ever
 * read theme/wallpaper from it, never anything security-relevant.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { withBase } from './base';

export interface Prefs {
  theme: 'system' | 'dark' | 'light';
  wallpaper: string;
  /** Optional custom wallpaper image URL — overrides the preset when set. */
  wallpaperImage: string;
  /** Accent color id — matches the dashboard's accent when embedded. */
  accent: string;
  /** Mirror OpenMasjidOS's theme + wallpaper (on by default under the platform). */
  followOmos: boolean;
}

const KEY = 'omdon-prefs';
// `accent: ''` means "nobody has handed us one", NOT cyan — and the difference is load-bearing,
// because `applyAccent` writes INLINE custom properties on <html>, which beat every [data-theme]
// block. Defaulting to a named accent would make the light theme's own designed primary and button
// colours unreachable on every standalone install, including a masjid that never opens
// OpenMasjidOS. Copied from OpenMasjidDisplay, which learned it the same way.
const DEFAULTS: Prefs = { theme: 'system', wallpaper: 'aurora', wallpaperImage: '', accent: '', followOmos: true };

/**
 * Accent palette — the five colours OpenMasjidOS hands an app, each with the INK that goes on it.
 *
 * Ported from OpenMasjidDisplay's `omosAccents.ts` (CLAUDE.md §2: follow Display's real code),
 * and the two extra fields are the whole point. This app shipped with `primary`/`hover`/`subtle`
 * only, and `applyAccent` therefore repainted every filled button without repainting its text:
 *
 *   light theme, white ink on the raw accent — gold 1.67:1, cyan 1.81:1, teal 1.86:1,
 *   sky 2.14:1, violet 2.72:1. AA wants 4.5:1. That is the Donate button.
 *
 * • `onPrimary` is the ink for the FILL. Never assume white: these are bright fills chosen to
 *   carry dark ink, and light theme makes it worse rather than better, because the stylesheet's
 *   own primary there is a deep blue whose ink genuinely IS white.
 * • `textLight` is the same accent as a LETTERFORM on the light theme — a link, the brand, an
 *   active nav label. A fill and a letterform are not the same problem: as text on a white card
 *   the raw accents measure 1.67:1 to 2.72:1. Each of these is its accent walked toward a dark
 *   neutral until it clears AA on both the light card (#FFFFFF) and the light page (#F0F9FF),
 *   keeping the hue — so a gold masjid still looks gold. The dark theme needs no equivalent:
 *   there the raw accents run 6.9:1 to 11.3:1 on the page, so fill and text really are one colour.
 *
 * Kept as a flat literal on purpose: `server/src/accents.test.ts` reads this file as TEXT and
 * measures every pairing, so the table here cannot drift from the platform's spec unnoticed.
 */
export interface Accent {
  /** The FILL: buttons, active chips. Reaches CSS as `--color-btn`. */
  primary: string;
  /** The hover fill. */
  hover: string;
  /** The ink that goes ON `primary`. Never assume white. */
  onPrimary: string;
  /** The same accent as TEXT on the LIGHT theme. See above. */
  textLight: string;
}

export const ACCENTS: Record<string, Accent> = {
  cyan: { primary: '#22D3EE', hover: '#67E8F9', onPrimary: '#00131C', textLight: '#177A8F' },
  teal: { primary: '#2DD4BF', hover: '#5EEAD4', onPrimary: '#00201B', textLight: '#1E7F79' },
  sky: { primary: '#38BDF8', hover: '#7DD3FC', onPrimary: '#001B2E', textLight: '#2679A2' },
  violet: { primary: '#A78BFA', hover: '#C4B5FD', onPrimary: '#190B3D', textLight: '#7564B4' },
  gold: { primary: '#FBBF24', hover: '#FCD34D', onPrimary: '#2B1B00', textLight: '#886C22' },
};

/** What the dashboard ships with, and what an unrecognised value falls back to. */
export const DEFAULT_ACCENT = 'cyan';

/**
 * Looked up through a Map, never `ACCENTS[id]`.
 *
 * The accent arrives from the attacker-craftable `#omos` fragment as well as from the platform, so
 * the id is untrusted input against an object literal: `ACCENTS['toString']` returns a FUNCTION —
 * truthy, so a `?? DEFAULT` fallback never fires, and reading `.primary` off it gives `undefined`.
 * Display hit exactly that and it reached localStorage, so the bad value came back on every reload.
 */
const BY_ID = new Map(Object.entries(ACCENTS));

export function accentFor(id: string | undefined): Accent {
  return BY_ID.get(String(id ?? '')) ?? BY_ID.get(DEFAULT_ACCENT)!;
}
/** `#rrggbb` as an `rgba(...)` at `alpha`, for the accent's own tint. */
function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Paint the dashboard's accent over the stylesheet's.
 *
 * THE FILL AND ITS INK MOVE TOGETHER, or neither moves. That is the whole fix here: this used to
 * set `--color-btn` and leave `--color-on-primary` alone, which in light theme left white ink on a
 * bright accent — 1.67:1 on gold, on the Donate button. Setting a fill without its ink is not a
 * smaller version of setting both; it is worse than setting neither.
 *
 * The split that matters is FILL versus TEXT, which is why this is not four `setProperty` calls:
 *
 *  • `--color-btn` / `--color-btn-hover` take the RAW accent. They are only ever backgrounds, and
 *    `--color-on-primary` is the ink measured against them.
 *  • `--color-primary` is the accent as a LETTERFORM — links, the brand, the active dock item —
 *    and on a light page the raw accent is unreadable. There it takes `textLight`.
 *
 * Because that choice depends on the theme, it has to run again whenever the theme changes,
 * including when the OS flips under a `system` preference at dusk. `applyTheme` calls it.
 */
export function applyAccent(id: string): void {
  const root = document.documentElement.style;
  if (!id) {
    // Nothing handed over: take the inline overrides back OFF so the stylesheet's own theme
    // colours apply again. Removing rather than re-setting, so turning "follow OpenMasjidOS" off
    // restores the app rather than freezing it on the last accent it happened to see.
    for (const prop of ['--color-btn', '--color-btn-hover', '--color-on-primary', '--color-primary', '--color-primary-hover', '--color-primary-subtle']) {
      root.removeProperty(prop);
    }
    return;
  }
  const a = accentFor(id);
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  root.setProperty('--color-btn', a.primary);
  root.setProperty('--color-btn-hover', a.hover);
  root.setProperty('--color-on-primary', a.onPrimary);
  root.setProperty('--color-primary', light ? a.textLight : a.primary);
  root.setProperty('--color-primary-hover', light ? a.textLight : a.hover);
  // The tint behind accent-coloured text (active dock item, badges). Always the RAW accent: it is
  // a wash of the masjid's colour, and at 10-12% it is the page underneath that carries contrast.
  root.setProperty('--color-primary-subtle', tint(a.primary, light ? 0.1 : 0.12));
}

export const WALLPAPERS: Record<string, { label: string; preview: string }> = {
  aurora: { label: 'Aurora', preview: 'radial-gradient(circle at 30% 25%, #22D3EE, #0A1828 70%)' },
  ocean: { label: 'Ocean', preview: 'linear-gradient(150deg, #38BDF8, #2563EB 55%, #0a1838 100%)' },
  twilight: { label: 'Twilight', preview: 'linear-gradient(150deg, #C084FC, #7C3AED 55%, #0a0618 100%)' },
  berry: { label: 'Berry', preview: 'linear-gradient(150deg, #F472B6, #A21CAF 55%, #1a0518 100%)' },
  sunset: { label: 'Sunset', preview: 'linear-gradient(150deg, #FBBF24, #FB7185 55%, #1a0d08 100%)' },
  ember: { label: 'Ember', preview: 'linear-gradient(150deg, #FB923C, #DC2626 55%, #190806 100%)' },
  forest: { label: 'Forest', preview: 'linear-gradient(150deg, #4ADE80, #15803D 55%, #04140e 100%)' },
  night: { label: 'Night', preview: 'linear-gradient(150deg, #60A5FA, #1E3A8A 55%, #02060f 100%)' },
  graphite: { label: 'Graphite', preview: 'linear-gradient(150deg, #64748B, #334155 55%, #0b0f17 100%)' },
};

export function resolveTheme(theme: Prefs['theme']): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

export function applyTheme(theme: Prefs['theme']): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme));
  // The accent's TEXT form depends on which page it is sitting on, so it is re-resolved here and
  // not only when the accent itself changes — otherwise a masjid whose dashboard is on `system`
  // gets a dark-theme accent on a light page the moment their laptop switches at dusk.
  applyAccent(accentOf());
}

/** The accent currently in force. Read lazily so `applyTheme` can be called before the store is
 *  hydrated — it is, on the very first paint, when `state` is still in its temporal dead zone. */
function accentOf(): string {
  try {
    return state.accent;
  } catch {
    return '';
  }
}

/**
 * Re-resolve the accent against whatever `data-theme` now says.
 *
 * For pages that pin their OWN theme rather than going through `applyTheme` — the donation page
 * chooses light or dark from the campaign's background image, and the donor's plan page is always
 * dark. They call `setAttribute('data-theme', …)` directly, so without this the accent keeps the
 * form it was given at hydrate: a masjid on `light` whose campaign has a dark photo would get the
 * light theme's dark-olive `textLight` painted on a dark card, at about 3:1.
 */
export function refreshAccent(): void {
  applyAccent(accentOf());
}

export function applyWallpaper(id: string): void {
  document.documentElement.setAttribute('data-wallpaper', WALLPAPERS[id] ? id : 'aurora');
}

const THEME_VALUES = ['system', 'dark', 'light'] as const;
function normTheme(v: unknown): Prefs['theme'] {
  return (THEME_VALUES as readonly string[]).includes(String(v)) ? (v as Prefs['theme']) : 'system';
}

/** Appearance handed over by OpenMasjidOS — we use theme + wallpaper only. */
interface OmosAppearance {
  theme?: string;
  wallpaper?: string;
  wallpaperImage?: string;
  accent?: string;
}

function appearancePatch(p: OmosAppearance): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  if (p.theme != null) out.theme = normTheme(p.theme);
  if (typeof p.wallpaper === 'string') out.wallpaper = p.wallpaper;
  if (typeof p.accent === 'string') out.accent = p.accent;
  // wallpaperImage comes from the attacker-craftable #omos fragment (and the public
  // appearance endpoint). Stored as-is; the Scene sanitises it before rendering it
  // into a CSS url(...) (accept only http(s)/data:image, reject quotes/backslash/space).
  if (typeof p.wallpaperImage === 'string') out.wallpaperImage = p.wallpaperImage;
  return out;
}

/** Read the `#omos=…` appearance fragment OpenMasjidOS adds when it opens us
 *  (base64url JSON). Applied once, then the hash is cleared. */
function readOmosFragment(): OmosAppearance | null {
  const m = location.hash.match(/omos=([^&]+)/);
  if (!m) return null;
  try {
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const p = JSON.parse(new TextDecoder().decode(bytes)) as OmosAppearance;
    history.replaceState(null, '', location.pathname + location.search);
    return p;
  } catch {
    return null;
  }
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

let state: Prefs = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode — just won't persist */
  }
}

export const prefsStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  patch(part: Partial<Prefs>) {
    state = { ...state, ...part };
    persist();
    if (part.theme !== undefined) applyTheme(state.theme);
    if (part.wallpaper !== undefined) applyWallpaper(state.wallpaper);
    if (part.accent !== undefined) applyAccent(state.accent);
    for (const l of listeners) l();
  },
  /** Apply persisted prefs on first load, inherit any OpenMasjidOS hand-off, and
   *  follow OS theme changes live. */
  hydrate() {
    const omos = readOmosFragment();
    if (omos) {
      // Opened from OpenMasjidOS → adopt its look and (re)enable following.
      state = { ...state, ...appearancePatch(omos), followOmos: true };
      persist();
    }
    applyTheme(state.theme);
    applyWallpaper(state.wallpaper);
    applyAccent(state.accent);
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (state.theme === 'system') applyTheme('system');
    });
  },
};

export function usePrefs(): Prefs {
  return useSyncExternalStore(prefsStore.subscribe, prefsStore.get, prefsStore.get);
}

/** One-shot pull of OpenMasjidOS's current appearance, via our OWN same-origin relay
 *  (GET /api/public/appearance) — our page is HTTPS but the platform's appearance
 *  endpoint is HTTP, so a direct cross-origin fetch would be mixed-content blocked.
 *  The server fetches the platform side. Only theme + wallpaper + accent are applied. */
export async function fetchOmosAppearance(): Promise<void> {
  try {
    const res = await fetch(withBase('/api/public/appearance'), { credentials: 'omit' });
    if (!res.ok) return;
    if (!prefsStore.get().followOmos) return;
    prefsStore.patch(appearancePatch((await res.json()) as OmosAppearance));
  } catch {
    /* platform offline — keep the current look (the #omos fragment already themed us) */
  }
}

// ── Background-aware readability ──────────────────────────────────────────────
// Sample a background image's average luminance so text on top of it stays readable
// (dark text on light images, light text on dark). Works for same-origin / CORS-enabled
// images and data: URLs; if the canvas is tainted (host sent no CORS header) we can't
// read the pixels, so we fall back to the caller's default theme.
const lumCache = new Map<string, 'light' | 'dark'>();

function sampleLuminance(url: string): Promise<'light' | 'dark' | null> {
  const cached = lumCache.get(url);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const n = 16;
        const canvas = document.createElement('canvas');
        canvas.width = n;
        canvas.height = n;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, n, n);
        const { data } = ctx.getImageData(0, 0, n, n);
        let sum = 0;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          count++;
        }
        const avg = count ? sum / count : 0; // 0..255
        const res: 'light' | 'dark' = avg > 140 ? 'light' : 'dark';
        lumCache.set(url, res);
        resolve(res);
      } catch {
        resolve(null); // tainted canvas — image host sent no CORS header
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** The theme ('light'|'dark') that reads best over a background image. Returns
 *  `fallback` when there's no image or it can't be sampled (cross-origin). */
export function useReadableTheme(imageUrl: string | undefined, fallback: 'light' | 'dark'): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(fallback);
  useEffect(() => {
    if (!imageUrl) {
      setTheme(fallback);
      return;
    }
    let live = true;
    void sampleLuminance(imageUrl).then((r) => {
      if (live) setTheme(r ?? fallback);
    });
    return () => {
      live = false;
    };
  }, [imageUrl, fallback]);
  return theme;
}

/** While embedded under OpenMasjidOS and "follow" is on, keep theme + wallpaper +
 *  accent in sync with the dashboard (poll periodically and whenever the page regains
 *  focus). The one-shot #omos fragment is the primary hand-off; this is live sync. */
export function useOmosAppearanceSync(embedded: boolean | undefined): void {
  const { followOmos } = usePrefs();
  useEffect(() => {
    if (!embedded || !followOmos) return;
    void fetchOmosAppearance();
    const iv = window.setInterval(() => void fetchOmosAppearance(), 45_000);
    const onFocus = () => void fetchOmosAppearance();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('focus', onFocus);
    };
  }, [embedded, followOmos]);
}
