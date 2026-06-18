#!/bin/bash
# Run database migrations via ECS Exec on a running API task

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)     ENV_NAME="$2"; STACK_NAME="SuperAgent-${ENV_NAME}"; shift 2 ;;
    --region)  REGION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

banner "Database Migration"

CLUSTER_NAME="super-agent-${ENV_NAME}"

# Find a running API task
log "Finding running API task in cluster: ${CLUSTER_NAME}"

SERVICES=$(aws ecs list-services --cluster "$CLUSTER_NAME" --region "$REGION" \
  --query "serviceArns[*]" --output text 2>/dev/null || echo "")

API_SERVICE=""
for SERVICE_ARN in $SERVICES; do
  SVC_NAME=$(echo "$SERVICE_ARN" | awk -F'/' '{print $NF}')
  if echo "$SVC_NAME" | grep -qi "api"; then
    API_SERVICE="$SVC_NAME"
    break
  fi
done

if [[ -z "$API_SERVICE" ]]; then
  err "No API service found in cluster. Cannot run migration."
  exit 1
fi

TASK_ARN=$(aws ecs list-tasks \
  --cluster "$CLUSTER_NAME" \
  --service-name "$API_SERVICE" \
  --desired-status RUNNING \
  --region "$REGION" \
  --query "taskArns[0]" --output text 2>/dev/null)

if [[ -z "$TASK_ARN" || "$TASK_ARN" == "None" ]]; then
  err "No running tasks found for service: $API_SERVICE"
  err "Ensure ECS services have desiredCount > 0."
  exit 1
fi

TASK_ID=$(echo "$TASK_ARN" | awk -F'/' '{print $NF}')
log "Target task: $TASK_ID (service: $API_SERVICE)"

if [[ "$DRY_RUN" == "true" ]]; then
  info "[DRY RUN] Would execute: npx prisma migrate deploy"
  info "[DRY RUN] On task: $TASK_ID"
  exit 0
fi

log "Running: npx prisma migrate deploy"
aws ecs execute-command \
  --cluster "$CLUSTER_NAME" \
  --task "$TASK_ARN" \
  --container "ApiContainer" \
  --interactive \
  --command "npx prisma migrate deploy" \
  --region "$REGION"

log "Migration complete."
