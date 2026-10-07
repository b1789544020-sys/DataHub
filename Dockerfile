# DataHub Dockerfile
# Multi-stage build for a smaller image
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

# Create non-root user
RUN addgroup -S datahub && adduser -S datahub -G datahub

# Copy deps
COPY --from=deps /app/node_modules ./node_modules
# Copy source
COPY package.json ./
COPY src ./src
COPY public ./public

# Create persistent data directory for SQLite + uploads
RUN mkdir -p /app/data/storage && chown -R datahub:datahub /app
VOLUME ["/app/data"]
USER datahub

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "src/app.js"]