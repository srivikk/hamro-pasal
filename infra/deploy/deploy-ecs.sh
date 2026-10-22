#!/usr/bin/env bash
# Phase 7 (2026-10-22): zero-downtime deploy to AWS ECS (Fargate), SPEC infrastructure §3.
#
# Order, each step gating the next (see infra/deploy/README.md):
#   1. Register new task-definition revisions that point at the new images (nothing runs yet).
#   2. One-off task from the NEW API image: `node dist/check-env.js` — the environment the new code
#      will boot with is valid. Exit != 0 stops the deploy; the old containers keep serving.
#   3. One-off task from the NEW API image: the migration runner (advisory-locked, expand-only
#      migrations, CI-checked). Exit != 0 stops the deploy; the old containers keep serving.
#   4. Roll the services (api, worker, admin) to the new revisions. ECS starts new tasks, waits for
#      the load balancer's health check (/health, /healthz), then drains the old ones
#      (minimumHealthyPercent 100). Then `aws ecs wait services-stable`.
#
# Required environment:
#   AWS_REGION, ECS_CLUSTER
#   API_IMAGE, WORKER_IMAGE, ADMIN_IMAGE          full image references (registry/repo:tag)
#   API_SERVICE, WORKER_SERVICE, ADMIN_SERVICE    ECS service names
#   ECS_SUBNETS, ECS_SECURITY_GROUPS              comma-separated, for the one-off tasks
# Optional: API_CONTAINER (default "api"), WORKER_CONTAINER ("worker"), ADMIN_CONTAINER ("admin"),
#   ECS_ASSIGN_PUBLIC_IP (DISABLED), MIGRATION_LOCK_TIMEOUT_MS (600000)
#
# The services' task definitions hold the secrets (from Secrets Manager / SSM); this script only
# swaps the image. Requires: aws (v2), jq.
set -euo pipefail

: "${AWS_REGION:?}" "${ECS_CLUSTER:?}"
: "${API_IMAGE:?}" "${WORKER_IMAGE:?}" "${ADMIN_IMAGE:?}"
: "${API_SERVICE:?}" "${WORKER_SERVICE:?}" "${ADMIN_SERVICE:?}"
: "${ECS_SUBNETS:?}" "${ECS_SECURITY_GROUPS:?}"
API_CONTAINER="${API_CONTAINER:-api}"
WORKER_CONTAINER="${WORKER_CONTAINER:-worker}"
ADMIN_CONTAINER="${ADMIN_CONTAINER:-admin}"
ASSIGN_PUBLIC_IP="${ECS_ASSIGN_PUBLIC_IP:-DISABLED}"
LOCK_TIMEOUT_MS="${MIGRATION_LOCK_TIMEOUT_MS:-600000}"

log() { printf '[deploy] %s\n' "$*"; }

# Registers a copy of the service's current task definition with one container's image replaced,
# and prints the new revision's ARN.
new_revision() {
  local service="$1" container="$2" image="$3" current definition
  current=$(aws ecs describe-services --region "$AWS_REGION" --cluster "$ECS_CLUSTER" \
    --services "$service" --query 'services[0].taskDefinition' --output text)
  definition=$(aws ecs describe-task-definition --region "$AWS_REGION" --task-definition "$current" \
    --query taskDefinition --output json)
  echo "$definition" \
    | jq --arg c "$container" --arg i "$image" '
        .containerDefinitions |= map(if .name == $c then .image = $i else . end)
        | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
              .registeredAt, .registeredBy, .deregisteredAt)' \
    > /tmp/hamro-pasal-taskdef.json
  aws ecs register-task-definition --region "$AWS_REGION" \
    --cli-input-json file:///tmp/hamro-pasal-taskdef.json \
    --query 'taskDefinition.taskDefinitionArn' --output text
}

# Runs a one-off task from a task definition with the API container's command replaced, waits
# for it to stop, and fails unless it exited 0.
run_once() {
  local definition="$1" label="$2"; shift 2
  local command overrides task code
  command=$(printf '%s\n' "$@" | jq -R . | jq -s .)
  overrides=$(jq -n --arg c "$API_CONTAINER" --argjson cmd "$command" \
    --arg t "$LOCK_TIMEOUT_MS" \
    '{containerOverrides: [{name: $c, command: $cmd,
      environment: [{name: "MIGRATION_LOCK_TIMEOUT_MS", value: $t}]}]}')
  task=$(aws ecs run-task --region "$AWS_REGION" --cluster "$ECS_CLUSTER" \
    --launch-type FARGATE --task-definition "$definition" --count 1 \
    --network-configuration "awsvpcConfiguration={subnets=[${ECS_SUBNETS}],securityGroups=[${ECS_SECURITY_GROUPS}],assignPublicIp=${ASSIGN_PUBLIC_IP}}" \
    --overrides "$overrides" --started-by "deploy-${label}" \
    --query 'tasks[0].taskArn' --output text)
  log "${label}: task ${task##*/} started"
  aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$ECS_CLUSTER" --tasks "$task"
  code=$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$ECS_CLUSTER" --tasks "$task" \
    --query "tasks[0].containers[?name=='${API_CONTAINER}'].exitCode | [0]" --output text)
  if [ "$code" != "0" ]; then
    log "${label}: FAILED (exit ${code}); nothing was rolled out. See the task's logs."
    exit 1
  fi
  log "${label}: ok"
}

log "registering task definitions"
API_DEF=$(new_revision "$API_SERVICE" "$API_CONTAINER" "$API_IMAGE")
WORKER_DEF=$(new_revision "$WORKER_SERVICE" "$WORKER_CONTAINER" "$WORKER_IMAGE")
ADMIN_DEF=$(new_revision "$ADMIN_SERVICE" "$ADMIN_CONTAINER" "$ADMIN_IMAGE")

run_once "$API_DEF" check-env node dist/check-env.js
run_once "$API_DEF" migrate node node_modules/@hamro-pasal/db/dist/bin/migrate.js

log "rolling out"
for pair in "$API_SERVICE=$API_DEF" "$WORKER_SERVICE=$WORKER_DEF" "$ADMIN_SERVICE=$ADMIN_DEF"; do
  aws ecs update-service --region "$AWS_REGION" --cluster "$ECS_CLUSTER" \
    --service "${pair%%=*}" --task-definition "${pair#*=}" \
    --deployment-configuration 'minimumHealthyPercent=100,maximumPercent=200,deploymentCircuitBreaker={enable=true,rollback=true}' \
    --query 'service.serviceName' --output text >/dev/null
done
aws ecs wait services-stable --region "$AWS_REGION" --cluster "$ECS_CLUSTER" \
  --services "$API_SERVICE" "$WORKER_SERVICE" "$ADMIN_SERVICE"
log "done: ${API_IMAGE##*/}, ${WORKER_IMAGE##*/}, ${ADMIN_IMAGE##*/} are live"
