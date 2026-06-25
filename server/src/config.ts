// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Environment configuration. Install settings seed first-run defaults only; all
 *  ongoing configuration will live in the data volume (a later slice). Secrets are
 *  read here but NEVER logged or sent to the browser. */
import fs from 'node:fs';
import path from 'node:path';

function env(name: string, def = ''): string {
  const v = process.env[name];
  return v == null || v === '' ? def : v;
}
function intEnv(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

/** Read this app's version from the package.json shipped next to the runtime
 *  (copied to /app/package.json in the image). Falls back gracefully in dev. */
function readVersion(): string {
  for (const p of [path.join(process.cwd(), 'package.json'), path.join(__dirname, '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* try next */
    }
  }
  return '0.1.0';
}

export const config = {
  port: intEnv('PORT', 8080),
  /** Bind all interfaces so the LAN (and Docker port mapping) can reach us. */
  host: env('HOST', '0.0.0.0'),
  dataDir: env('DATA_DIR', path.resolve(process.cwd(), 'data')),
  publicDir: env('PUBLIC_DIR', path.resolve(__dirname, '..', 'public')),
  version: readVersion(),

  /** The cloudflared binary (bundled in the image). Overridable for local dev. */
  cloudflaredBin: env('CLOUDFLARED_BIN', 'cloudflared'),

  /** OpenMasjidOS Fabric (the platform↔app appearance + SSO layer). Injected by the
   *  platform at install and empty on a standalone install, where the app uses its
   *  own appearance + own login. The wire identifiers (env var names, header,
   *  cookie, endpoints) are the shared Fabric contract and must stay byte-for-byte.
   *  See docs/ARCHITECTURE.md. */
  omosBaseUrl: env('OPENMASJID_BASE_URL', '').replace(/\/+$/, ''),
  omosAppId: env('OPENMASJID_APP_ID', ''),
  /** Per-app secret issued by the platform to `sso: true` apps. SSO is identity-
   *  bound: we must present this on the /api/auth/session check or the platform
   *  fails closed. It is a CREDENTIAL — never log or expose it. */
  omosAppSecret: env('OPENMASJID_APP_SECRET', ''),

  /** First-run seed values. Install settings + any platform-provided MASJID_* vars
   *  seed defaults ONLY; once the admin saves a value in-app it persists to the data
   *  volume and takes precedence (see store.ts). The Stripe SECRET key is read here
   *  but is server-side only and must never reach the browser or the logs. */
  seed: {
    masjid: {
      name: env('MASJID_NAME', ''),
      address: env('MASJID_ADDRESS', ''),
      email: env('MASJID_EMAIL', ''),
      phone: env('MASJID_PHONE', ''),
      website: env('MASJID_WEBSITE', ''),
      logo: env('MASJID_LOGO', ''),
    },
    // CURRENCY install setting wins; else the platform's MASJID_CURRENCY; else USD
    // (the default offered during first-run setup; the admin can change it in-app).
    currency: (env('CURRENCY', '') || env('MASJID_CURRENCY', '') || 'USD').toUpperCase(),
    stripe: {
      publishableKey: env('STRIPE_PUBLISHABLE_KEY', ''),
      secretKey: env('STRIPE_SECRET_KEY', ''),
      webhookSecret: env('STRIPE_WEBHOOK_SECRET', ''),
    },
  },
};

/** True when the app is running embedded under OpenMasjidOS with SSO available. */
export function ssoConfigured(): boolean {
  return !!config.omosBaseUrl && !!config.omosAppSecret;
}

export type Config = typeof config;
