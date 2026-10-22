# Deploying Hamro Pasal (Phase 7, 2026-10-22)

Three images, built from the repository root by CI (`.github/workflows/production.yml`):

| Image                | Dockerfile               | Runs                                  | Port | Health                               |
| -------------------- | ------------------------ | ------------------------------------- | ---- | ------------------------------------ |
| `hamro-pasal-api`    | `apps/api/Dockerfile`    | `node dist/server.js` (HTTP + socket) | 4000 | `GET /health`                        |
| `hamro-pasal-worker` | `apps/worker/Dockerfile` | `node dist/main.js`                   | none | the process (exits on a fatal error) |
| `hamro-pasal-admin`  | `apps/admin/Dockerfile`  | nginx (unprivileged) serving the SPA  | 8080 | `GET /healthz`                       |

All run as non-root users (`node`, uid 101 for nginx) under an init (tini / nginx). There is no
PM2: the orchestrator replaces a container whose process exits and scales by containers.

## The order of a deploy (zero downtime)

```
CI green ─▶ images pushed ─▶ [1] check-env ─▶ [2] migrate ─▶ [3] roll out api, worker, admin
                              (new API image,   (new API image,  (new tasks pass health checks,
                               one-off task)     one-off task)    then old ones drain)
```

1. **Environment check**: `node dist/check-env.js` in the new API image, with the production task
   definition's environment and secrets. It runs the same schema the API and worker run at boot
   (`packages/shared-types/src/env/server-env.ts`) and exits 1 with the problems by key. A bad
   secret stops the deploy here, while the old containers keep serving.
2. **Migrations**: `node node_modules/@hamro-pasal/db/dist/bin/migrate.js`, from the same image.
   It takes a PostgreSQL advisory lock first, so concurrent runs queue and each migration applies
   once (`packages/db/test/migrator.int.test.ts`). Exit != 0 stops the deploy.
3. **Rollout**: ECS starts new tasks, waits for the load balancer health check, then drains the old
   ones (`minimumHealthyPercent=100`, circuit breaker with rollback).

`infra/deploy/deploy-ecs.sh` does exactly this on AWS ECS Fargate (SPEC infrastructure §3). On any
other platform keep the same order: the migration step must finish successfully before a new
container receives traffic.

## Why migrations must be expand-only

Between steps 2 and 3, and during step 3, **old code runs against the new schema**. So a migration
may only add: tables, nullable columns or columns with a default, indexes, enum values, CHECKs the
existing data already satisfies. CI enforces this (`node infra/ci/check-migrations.mjs`): it refuses
`DROP TABLE`, `DROP COLUMN`, `DROP TYPE`, renames, column type changes, `SET NOT NULL` on an existing
column and `ADD COLUMN … NOT NULL` without a default.

Removing or renaming something takes two releases:

1. **Expand** release: add the new shape; the code writes both and reads the new one.
2. **Contract** release, once no running code uses the old shape: a migration whose file contains a
   line `-- deploy: contract` (with the reason), which the guard then lets through.

Drizzle runs each migration file in one transaction, so `CREATE INDEX CONCURRENTLY` is not
available; an index on a large table locks its writes while it builds. Schedule such migrations
for a quiet hour.

## Rolling back

Images are tagged with the commit (`<sha12>`). Roll back by deploying the previous tag: the schema
stays (expand-only migrations are compatible with the previous code). Migrations are never
reversed automatically.

## Configuration the pipeline needs

GitHub (Settings → Secrets and variables → Actions):

- variables: `AWS_REGION`, `ECR_REGISTRY`, `ECS_CLUSTER`, `ECS_API_SERVICE`, `ECS_WORKER_SERVICE`,
  `ECS_ADMIN_SERVICE`, `ECS_SUBNETS`, `ECS_SECURITY_GROUPS`
- secret: `AWS_DEPLOY_ROLE_ARN` (an IAM role trusted for this repository through GitHub OIDC,
  allowed to push to ECR, register task definitions, run tasks, update the three services and pass
  their task / execution roles)
- environment `production` with required reviewers: the deploy job waits for an approval.

The ECS task definitions hold the runtime environment (from Secrets Manager / SSM); see the
production rules at the top of `.env.example`. The worker image builds with Chromium for the IRD
PAN check by default (`--build-arg WITH_CHROMIUM=false` when that check stays `DISABLED`).

## Trying the images locally

```sh
docker build -f apps/api/Dockerfile -t hamro-pasal-api .
docker run --rm -e DATABASE_URL=postgresql://…@host.docker.internal:5432/hamro_pasal \
  hamro-pasal-api node node_modules/@hamro-pasal/db/dist/bin/migrate.js
docker run --rm --env-file <a .env without quotes or comments> -p 4100:4000 hamro-pasal-api
```

`docker run --env-file` does not strip quotes or `# comments` the way Node's `.env` loader does:
convert the file first (`node -e "…util.parseEnv…"`), or the boot check will (rightly) refuse it.
