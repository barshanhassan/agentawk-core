# Use Node.js 20 Alpine as base image for a smaller footprint
FROM node:20-alpine AS builder

# Create app directory
WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# Install app dependencies
RUN npm ci

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

# Install OpenSSL (required by Prisma at runtime)
RUN apk add --no-cache openssl

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm ci --only=production

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
