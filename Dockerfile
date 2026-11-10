# UNVERIFIED: Docker is not available in the authoring sandbox. Build and run on the VPS (see DEPLOYMENT.md).
# Targets: `api` (API + dashboard static files) and `worker` (WhatsApp worker with Chromium).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM deps AS web
COPY tsconfig*.json ./
COPY scripts ./scripts
COPY src ./src
RUN node scripts/build-web.mjs

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=8080 DATABASE_PATH=/data/guardian.db BACKUP_DIR=/data/backups
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY --from=web /app/dist/web ./dist/web
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/api/main.ts"]

FROM node:22-bookworm-slim AS worker
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-noto-color-emoji ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production CHROMIUM_PATH=/usr/bin/chromium DATABASE_PATH=/data/guardian.db WA_SESSION_DIR=/data/wa-session \
    WORKER_HEALTH_HOST=0.0.0.0 WORKER_HEALTH_PORT=8081 PUPPETEER_SKIP_DOWNLOAD=true
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data /app
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/worker/main.ts"]
