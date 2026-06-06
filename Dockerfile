# Use Node.js 20 Alpine as base image for a smaller footprint
FROM node:20-alpine AS builder

# Create app directory
WORKDIR /app

# Install OpenSSL for Prisma + libc6-compat which sharp's prebuilt binary
# needs on Alpine (musl libc). `vips-dev` is only required if sharp falls
# back to source build — we keep `vips` (runtime) so the prebuilt binary
# can dlopen it if needed.
RUN apk add --no-cache openssl libc6-compat vips

# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# Install app dependencies. `--include=optional` forces npm to install the
# platform-specific sharp binary (e.g. @img/sharp-linuxmusl-x64) — without
# this flag, npm sometimes silently skips optional deps in CI environments
# and sharp throws at require() time.
RUN npm ci --include=optional

# Copy Prisma schema and generate client before building
COPY prisma ./prisma/
RUN npx prisma generate

# Bundle app source
COPY . .

# Build the NestJS application
RUN npm run build

# --- Second Stage: Production Image ---
FROM node:20-alpine

WORKDIR /app

# Same Alpine deps the builder uses — sharp's binary needs libc6-compat
# + libvips at runtime.
RUN apk add --no-cache openssl libc6-compat vips

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --include=optional

# Copy built files from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package*.json ./

# Generate Prisma client for Alpine
RUN npx prisma generate

# Create uploads directory (if needed for local storage fallback)
RUN mkdir -p uploads

# Command to run the application
CMD [ "node", "dist/main.js" ]
