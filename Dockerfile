# Debian-slim base — sharp's prebuilt binary (`@img/sharp-linux-x64`)
# installs cleanly on glibc-based images. Alpine (musl) was hitting binary
# loading issues during Cloud Build even with libc6-compat + vips installed.
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# OpenSSL is needed by Prisma; libvips ships its own runtime via sharp's
# prebuilt binary, so we don't need a system vips package on Debian.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy lockfile + manifest first to maximise layer caching
COPY package*.json ./

# `--include=optional` is defensive — npm sometimes skips optionalDependencies
# in CI environments, and sharp's platform binary lives there.
RUN npm ci --include=optional

# Prisma client
COPY prisma ./prisma/
RUN npx prisma generate

# Build NestJS
COPY . .
RUN npm run build

# ── Production image ───────────────────────────────────────────────
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --include=optional

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package*.json ./

RUN npx prisma generate

RUN mkdir -p uploads

CMD [ "node", "dist/main.js" ]
