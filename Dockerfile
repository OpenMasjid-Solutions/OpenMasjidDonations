# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions

# syntax=docker/dockerfile:1
#
# OpenMasjid Donations — multi-stage, multi-arch (amd64 + arm64).
# The JS build stages run on the native BUILD platform (fast, arch-independent
# output); only the runtime stage runs as the TARGET arch, where `npm ci` pulls
# the correct prebuilt native binaries (e.g. better-sqlite3) for that architecture.

# ---- Build the web app (donor site + admin) → static files -----------------
FROM --platform=$BUILDPLATFORM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- cloudflared (for the optional Cloudflare Tunnel public-access feature) -
# Taken from the official multi-arch image, pinned by version. No --platform
# override, so it's pulled for the TARGET arch (arm64 build → arm64 binary).
FROM cloudflare/cloudflared:2026.6.1 AS cloudflared

# ---- Compile the server (TypeScript → dist) --------------------------------
FROM --platform=$BUILDPLATFORM node:22-slim AS server
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# ---- Runtime (target architecture) -----------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="OpenMasjid Donations" \
      org.opencontainers.image.description="A self-hosted Stripe donation website for your masjid, on your own network." \
      org.opencontainers.image.source="https://github.com/OpenMasjid-Solutions/OpenMasjidDonations" \
      org.opencontainers.image.licenses="AGPL-3.0"

# ca-certificates: outbound HTTPS to api.stripe.com. tini: reap children + forward
# signals cleanly so the container stops fast and tidily.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Production deps only — this resolves any per-arch prebuilt native binary
# (e.g. better-sqlite3) for the target architecture.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=server /server/dist ./dist
COPY --from=web /web/dist ./public

# The Cloudflare Tunnel daemon. The app launches + supervises it ONLY when the admin
# saves a tunnel token (optional public access without port-forwarding). It makes
# outbound connections only — no inbound ports, no extra privileges.
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

ENV PORT=8080 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public
EXPOSE 8080
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
