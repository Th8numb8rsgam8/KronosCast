# ==========================================
# Stage 1: Build / Compile TypeScript
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY package.json package-lock.json ./

# Install ALL dependencies (including devDependencies like typescript and tsx)
RUN npm ci

RUN npm install -g typescript

# Copy source code and TypeScript config
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript code (this generates /dist folder)
RUN npm run build

# ==========================================
# Stage 2: Production Runtime Image
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

# Create a non-root system user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

# Copy dependency manifests and install production-only dependencies
COPY package.json package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy ONLY the compiled output from the builder stage
COPY --chown=nodejs:nodejs --from=builder /app/dist ./dist
USER nodejs

# Point to compiled JavaScript output file
CMD ["node", "dist/server.js"]
