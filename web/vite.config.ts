// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

// The site + admin are served by the Node server, which also exposes /api. In dev
// (`npm run dev`) we proxy /api and /healthz to the server on :8080 so the same
// fetches work locally and in production.
export default defineConfig({
  plugins: [react()],
  // Relative asset base: the built index.html references assets as ./assets/… so they
  // resolve against the runtime `<base href>` the server injects. This makes one build
  // work at the root (LAN) AND under any OpenMasjidOS tunnel path (e.g. /donate) without
  // baking the path in. Dynamic import() chunks resolve via import.meta.url, so they
  // follow the prefix too. Do NOT change to an absolute base — that breaks behind the tunnel.
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/uploads': 'http://localhost:8080',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
