# syntax=docker/dockerfile:1.7
#
# Phase 7 (2026-10-22): the Super Admin web dashboard (and Vendor Portal). Build from the
# repository root:
#   docker build -f apps/admin/Dockerfile -t hamro-pasal-admin .
#
# `build` compiles the Vite app; `runtime` is nginx's unprivileged image (uid 101, port 8080,
# no Node at all) serving the static files with nginx/default.conf.template. Run with
# API_UPSTREAM=http://<api host>:4000 when this server forwards /api itself (see the template).

ARG NODE_VERSION=24.18.1

FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    HUSKY=0
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@hamro-pasal/admin..." --filter "hamro-pasal"
RUN pnpm turbo run build --filter "@hamro-pasal/admin..."

FROM nginxinc/nginx-unprivileged:1.27.5-alpine AS runtime
ENV API_UPSTREAM=http://api:4000 \
    NGINX_ENVSUBST_FILTER=^API_UPSTREAM$
COPY apps/admin/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
