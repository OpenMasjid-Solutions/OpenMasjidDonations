// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Runtime base path. When OpenMasjidOS exposes this app behind its Cloudflare tunnel it
 * serves us under an admin-chosen path prefix (e.g. "/donate") and forwards that full
 * prefix to us. The server injects the prefix into the page as `window.__OMOS_BASE__`
 * (and a matching `<base href>`), so the client can build API/nav/asset URLs that keep
 * the prefix. Empty string when served at the root (direct LAN access, or remote access
 * off) — then everything behaves exactly as before. Read once per page load.
 */
declare global {
  interface Window {
    __OMOS_BASE__?: string;
  }
}

function read(): string {
  const raw = (typeof window !== 'undefined' && window.__OMOS_BASE__) || '';
  const t = raw.trim().replace(/\/+$/, '');
  if (!t) return '';
  return t.startsWith('/') ? t : '/' + t;
}

/** The base path, e.g. "/donate" or "" (no trailing slash). */
export const BASE = read();

/** Prefix an absolute in-app path (e.g. "/api/x", "/admin") with the base path. */
export const withBase = (p: string): string => (BASE && p.startsWith('/') ? BASE + p : p);

/** Prefix a same-origin uploaded-image path ("/uploads/…") with the base path; leaves
 *  external http(s)/data URLs untouched so they render unchanged behind the tunnel. */
export const asset = (p: string): string => (BASE && /^\/uploads\//.test(p) ? BASE + p : p);

/** Strip the base path off a `location.pathname` for client-side route matching, so the
 *  router sees "/zakat" whether the page was opened on the LAN or under "/donate". */
export const stripBase = (pathname: string): string => {
  if (BASE && (pathname === BASE || pathname.startsWith(BASE + '/'))) return pathname.slice(BASE.length) || '/';
  return pathname;
};
