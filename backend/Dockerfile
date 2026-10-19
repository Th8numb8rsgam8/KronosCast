# --- Stage 1: Build Environment ---
FROM node:20-alpine AS builder
WORKDIR /app

# Copy dependency mappings and install everything
COPY package*.json ./
RUN npm ci

# Copy source code and compile TypeScript to production JavaScript
COPY . .
RUN npx tsc

# --- Stage 2: Final Runtime Environment ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy only production dependencies to keep the image tiny
COPY package*.json ./
RUN npm ci --only=production

# Copy the compiled build assets from Stage 1
COPY --from=builder /app/dist ./dist

# Expose ports internally (Port 80 for public, Port 8443 for mTLS)
EXPOSE 80
EXPOSE 8443

CMD ["node", "dist/server.js"]