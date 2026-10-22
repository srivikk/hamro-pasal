# syntax=docker/dockerfile:1.7
#
# Phase 7 (2026-10-22): the Express API (HTTP + Socket.io). Build from the repository root:
#   docker build -f apps/api/Dockerfile -t hamro-pasal-api .
#
# Stages: `build` installs only the API's workspace graph, compiles it with Turbo and writes a
# production-only copy of the API and its workspace packages (`pnpm deploy`); `runtime` is a slim
# Debian image (glibc, for the sharp and Kafka native binaries) running as the unprivileged `node`
# user under tini. No PM2: the orchestrator (ECS / Cloud Run) restarts a crashed container and
# scales by containers, and one Node process per container keeps signals and logs simple.
#
# The same image runs the one-off deploy steps:
#   node dist/check-env.js                                   validate the environment, exit 1 if not
#   node node_modules/@hamro-pasal/db/dist/bin/migrate.js    apply pending migrations (advisory lock)

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
    pnpm install --frozen-lockfile --filter "@hamro-pasal/api..." --filter "hamro-pasal"
RUN pnpm turbo run build --filter "@hamro-pasal/api..."
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @hamro-pasal/api deploy --prod --legacy --config.node-linker=isolated /out

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install --yes --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    API_PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.API_PORT ?? 4000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
