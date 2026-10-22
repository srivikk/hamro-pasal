# syntax=docker/dockerfile:1.7
#
# Phase 7 (2026-10-22): the worker (outbox relay, Kafka consumers, BullMQ timers and crons, the
# IRD PAN check). Build from the repository root:
#   docker build -f apps/worker/Dockerfile -t hamro-pasal-worker .
#   docker build -f apps/worker/Dockerfile --build-arg WITH_CHROMIUM=false -t hamro-pasal-worker .
#
# Same layout as apps/api/Dockerfile (see there). WITH_CHROMIUM (default true) installs the
# headless Chromium shell that IRD_VERIFICATION_PROVIDER=PLAYWRIGHT launches (`headless: true`),
# with its system libraries: about 1.4 GB in all instead of about 0.5 GB. Build with false when
# the IRD check stays DISABLED.
# Task 8: the worker answers GET /health on WORKER_HEALTH_PORT (4001): 200 once every consumer and
# queue is running, 503 while it shuts down. The HEALTHCHECK below (the same command serves as the
# ECS container health check) reads it; the orchestrator replaces a container that fails it.

ARG NODE_VERSION=24.18.1

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    HUSKY=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@hamro-pasal/worker..." --filter "hamro-pasal"
RUN pnpm turbo run build --filter "@hamro-pasal/worker..."
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @hamro-pasal/worker deploy --prod --legacy --config.node-linker=isolated /out

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG WITH_CHROMIUM=true
RUN apt-get update \
 && apt-get install --yes --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    WORKER_HEALTH_HOST=0.0.0.0 \
    WORKER_HEALTH_PORT=4001
WORKDIR /app
COPY --from=build --chown=node:node /out ./
RUN if [ "$WITH_CHROMIUM" = "true" ]; then \
      node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
      && chown -R node:node /ms-playwright \
      && rm -rf /var/lib/apt/lists/*; \
    fi
USER node
EXPOSE 4001
# start-period: the worker connects to PostgreSQL, Kafka and Redis before it starts answering.
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.WORKER_HEALTH_PORT ?? 4001) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
