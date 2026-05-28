#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# deploy.sh — Deploy infrastructure, roll out ECS services, run migrations
#
# Usage:
#   ENV=dev ./scripts/deploy.sh                      # Full deploy to dev
#   ENV=prod ./scripts/deploy.sh                     # Full deploy to prod
#   ENV=dev SKIP_INFRA=1 ./scripts/deploy.sh         # ECS rollout only
#   ENV=staging SKIP_MIGRATION=1 ./scripts/deploy.sh # No DB migration
#
# Environment variables:
#   ENV               — Target environment (default: dev) — drives stack/cluster names
#   AWS_ACCOUNT_ID    — AWS account (auto-detected if not set)
#   AWS_REGION        — AWS region (default: us-east-1)
#   SKIP_INFRA        — 1 to skip CDK deploy (default: 0)
#   SKIP_ECS_DEPLOY   — 1 to skip ECS force-new-deployment (default: 0)
#   SKIP_MIGRATION    — 1 to skip DB migration (default: 0)
#   SKIP_SMOKE_TEST   — 1 to skip health check (default: 0)
#   WAIT_TIMEOUT      — ECS stabilization timeout in seconds (default: 600)
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Environment
ENV="${ENV:-dev}"
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")}"
SKIP_INFRA="${SKIP_INFRA:-0}"
SKIP_ECS_DEPLOY="${SKIP_ECS_DEPLOY:-0}"
SKIP_MIGRATION="${SKIP_MIGRATION:-0}"
SKIP_SMOKE_TEST="${SKIP_SMOKE_TEST:-0}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-600}"

# Derived names (match CDK resource naming convention)
STACK_NAME="SuperAgent-${ENV}"
ECS_CLUSTER="super-agent-${ENV}"
DEPLOY_LOG="$PROJECT_ROOT/scripts/deployments.log"
OUTPUTS_FILE="$PROJECT_ROOT/scripts/.cdk-outputs-${ENV}.json"

log() { echo "[$(date '+%H:%M:%S')] [$ENV] $*"; }
err() { echo "[$(date '+%H:%M:%S')] [$ENV] ERROR: $*" >&2; }

if [[ -z "$AWS_ACCOUNT_ID" ]]; then
  err "AWS_ACCOUNT_ID not set and auto-detection failed."
  exit 1
fi

GIT_SHA="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
DEPLOYER="$(whoami)@$(hostname -s)"

log "Deploy started: ENV=$ENV, STACK=$STACK_NAME, CLUSTER=$ECS_CLUSTER"

###############################################################################
# Step 1: CDK Deploy (Infrastructure + Frontend S3 upload)
###############################################################################
if [[ "$SKIP_INFRA" != "1" ]]; then
  log "Step 1/5: Deploying CDK stack '$STACK_NAME'..."
  cd "$PROJECT_ROOT/infra"
  npx cdk deploy "$STACK_NAME" \
    -c env="$ENV" \
    --require-approval never \
    --outputs-file "$OUTPUTS_FILE" \
    --ci
  log "CDK deploy complete."
else
  log "Step 1/5: SKIPPED (SKIP_INFRA=1)"
fi

###############################################################################
# Step 2: Read stack outputs
###############################################################################
log "Step 2/5: Reading stack outputs..."

get_output() {
  local key="$1"
  if [[ -f "$OUTPUTS_FILE" ]]; then
    jq -r ".[\"$STACK_NAME\"][\"$key\"] // empty" "$OUTPUTS_FILE"
  else
    aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" \
      --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" \
      --output text --region "$AWS_REGION" 2>/dev/null || echo ""
  fi
}

CF_DOMAIN="$(get_output "CloudFrontDomain")"
ALB_DNS="$(get_output "AlbDnsName")"

log "  CloudFront: ${CF_DOMAIN:-<not found>}"
log "  ALB:        ${ALB_DNS:-<not found>}"

###############################################################################
# Step 3: ECS Force New Deployment
###############################################################################
if [[ "$SKIP_ECS_DEPLOY" != "1" ]]; then
  log "Step 3/5: Rolling out ECS services in cluster '$ECS_CLUSTER'..."

  SERVICES=$(aws ecs list-services --cluster "$ECS_CLUSTER" --region "$AWS_REGION" \
    --query "serviceArns[*]" --output text 2>/dev/null || echo "")

  if [[ -z "$SERVICES" ]]; then
    err "No ECS services found in cluster '$ECS_CLUSTER'. Is the cluster deployed?"
    exit 1
  fi

  for SERVICE_ARN in $SERVICES; do
    SERVICE_NAME=$(echo "$SERVICE_ARN" | awk -F'/' '{print $NF}')
    log "  Deploying: $SERVICE_NAME"
    aws ecs update-service \
      --cluster "$ECS_CLUSTER" \
      --service "$SERVICE_NAME" \
      --force-new-deployment \
      --region "$AWS_REGION" \
      --no-cli-pager > /dev/null
  done

  log "  Waiting for services to stabilize (timeout: ${WAIT_TIMEOUT}s)..."
  aws ecs wait services-stable \
    --cluster "$ECS_CLUSTER" \
    --services $SERVICES \
    --region "$AWS_REGION" \
    2>/dev/null && log "  All services stable." || {
      err "ECS services did not stabilize within timeout."
      exit 1
    }
else
  log "Step 3/5: SKIPPED (SKIP_ECS_DEPLOY=1)"
fi

###############################################################################
# Step 4: Database Migration
###############################################################################
if [[ "$SKIP_MIGRATION" != "1" ]]; then
  log "Step 4/5: Running database migration..."

  API_SERVICE_NAME=""
  for SERVICE_ARN in $(aws ecs list-services --cluster "$ECS_CLUSTER" --region "$AWS_REGION" \
    --query "serviceArns[*]" --output text 2>/dev/null); do
    SVC=$(echo "$SERVICE_ARN" | awk -F'/' '{print $NF}')
    if echo "$SVC" | grep -qi "api"; then
      API_SERVICE_NAME="$SVC"
      break
    fi
  done

  if [[ -z "$API_SERVICE_NAME" ]]; then
    API_SERVICE_NAME=$(aws ecs list-services --cluster "$ECS_CLUSTER" --region "$AWS_REGION" \
      --query "serviceArns[0]" --output text 2>/dev/null | awk -F'/' '{print $NF}')
  fi

  TASK_ARN=$(aws ecs list-tasks --cluster "$ECS_CLUSTER" \
    --service-name "$API_SERVICE_NAME" \
    --desired-status RUNNING \
    --region "$AWS_REGION" \
    --query "taskArns[0]" --output text 2>/dev/null)

  if [[ -z "$TASK_ARN" || "$TASK_ARN" == "None" ]]; then
    err "No running tasks found for migration. Run manually:"
    err "  aws ecs execute-command --cluster $ECS_CLUSTER --task <task-id> --container ApiContainer --interactive --command 'npx prisma migrate deploy'"
    exit 1
  fi

  log "  Executing migration on task: $(echo "$TASK_ARN" | awk -F'/' '{print $NF}')"
  aws ecs execute-command \
    --cluster "$ECS_CLUSTER" \
    --task "$TASK_ARN" \
    --container "ApiContainer" \
    --interactive \
    --command "npx prisma migrate deploy" \
    --region "$AWS_REGION"

  log "  Migration complete."
else
  log "Step 4/5: SKIPPED (SKIP_MIGRATION=1)"
fi

###############################################################################
# Step 5: Smoke Test
###############################################################################
if [[ "$SKIP_SMOKE_TEST" != "1" ]]; then
  log "Step 5/5: Running smoke tests..."

  HEALTH_URL=""
  if [[ -n "$CF_DOMAIN" ]]; then
    HEALTH_URL="https://$CF_DOMAIN/health"
  elif [[ -n "$ALB_DNS" ]]; then
    HEALTH_URL="http://$ALB_DNS/health"
  fi

  if [[ -z "$HEALTH_URL" ]]; then
    err "Cannot determine health endpoint. Skipping smoke test."
  else
    log "  Health check: $HEALTH_URL"

    for i in 1 2 3 4 5; do
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")
      if [[ "$HTTP_CODE" == "200" ]]; then
        log "  Health check PASSED (HTTP 200)"
        break
      fi
      if [[ "$i" == "5" ]]; then
        err "Health check FAILED after 5 attempts (last: HTTP $HTTP_CODE)"
        # Record failed deploy
        echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') | $ENV | $STACK_NAME | $GIT_SHA | FAILED | $DEPLOYER" >> "$DEPLOY_LOG"
        exit 1
      fi
      log "  Attempt $i: HTTP $HTTP_CODE — retrying in 10s..."
      sleep 10
    done

    FRONTEND_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://$CF_DOMAIN/" 2>/dev/null || echo "000")
    if [[ "$FRONTEND_CODE" == "200" ]]; then
      log "  Frontend check PASSED (HTTP 200)"
    else
      err "  Frontend check WARNING: HTTP $FRONTEND_CODE"
    fi
  fi
else
  log "Step 5/5: SKIPPED (SKIP_SMOKE_TEST=1)"
fi

###############################################################################
# Step 6: Record deployment
###############################################################################
mkdir -p "$(dirname "$DEPLOY_LOG")"
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') | $ENV | $STACK_NAME | $GIT_SHA | SUCCESS | $DEPLOYER" >> "$DEPLOY_LOG"

log "========================================"
log "Deployment complete"
log "  Environment: $ENV"
log "  Stack:       $STACK_NAME"
log "  Cluster:     $ECS_CLUSTER"
log "  Commit:      $GIT_SHA"
log "  CloudFront:  ${CF_DOMAIN:-N/A}"
log "  URL:         https://${CF_DOMAIN:-<pending>}"
log ""
log "  Infra:       $([ "$SKIP_INFRA" != "1" ] && echo "DEPLOYED" || echo "SKIPPED")"
log "  ECS:         $([ "$SKIP_ECS_DEPLOY" != "1" ] && echo "ROLLED OUT" || echo "SKIPPED")"
log "  Migration:   $([ "$SKIP_MIGRATION" != "1" ] && echo "APPLIED" || echo "SKIPPED")"
log "  Smoke test:  $([ "$SKIP_SMOKE_TEST" != "1" ] && echo "PASSED" || echo "SKIPPED")"
log "========================================"
log "Deploy log: $DEPLOY_LOG"
