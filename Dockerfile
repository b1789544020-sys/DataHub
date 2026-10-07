# DataHub Dockerfile
# Debian-slim (glibc) base so better-sqlite3 can use its prebuilt binary.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

# Create non-root user
RUN groupadd --system datahub && useradd --system --gid datahub datahub

# Copy deps
COPY --from=deps /app/node_modules ./node_modules
# Copy source
COPY package.json ./
COPY src ./src
COPY public ./public

# Create persistent data directory for SQLite + uploads (mounted as a volume)
RUN mkdir -p /app/data && chown -R datahub:datahub /app
ENV STORAGE_DIR=/app/data/storage \
    DB_PATH=/app/data/datahub.db
VOLUME ["/app/data"]
USER datahub

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/app.js"]