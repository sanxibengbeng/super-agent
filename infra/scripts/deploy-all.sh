#!/bin/bash
# Full deployment: infra → backend → frontend → migrate → health check

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

SKIP_INFRA=false
SKIP_BACKEND=false
SKIP_FRONTEND=false
SKIP_MIGRATE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)           ENV_NAME="$2"; STACK_NAME="SuperAgent-${ENV_NAME}"; shift 2 ;;
    --region)        REGION="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=true; shift ;;
    --skip-infra)    SKIP_INFRA=true; shift ;;
    --skip-backend)  SKIP_BACKEND=true; shift ;;
    --skip-frontend) SKIP_FRONTEND=true; shift ;;
    --skip-migrate)  SKIP_MIGRATE=true; shift ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

banner "Full Deploy"

COMMON_ARGS="--env $ENV_NAME --region $REGION"
[[ "$DRY_RUN" == "true" ]] && COMMON_ARGS="$COMMON_ARGS --dry-run"

# Step 1: Infrastructure
if [[ "$SKIP_INFRA" == "false" ]]; then
  log "═══ Step 1/4: Infrastructure ═══"
  "$SCRIPT_DIR/deploy-infra.sh" $COMMON_ARGS
else
  info "Step 1/4: Infrastructure — SKIPPED"
fi
echo ""

# Step 2: Backend
if [[ "$SKIP_BACKEND" == "false" ]]; then
  log "═══ Step 2/4: Backend ═══"
  "$SCRIPT_DIR/deploy-backend.sh" $COMMON_ARGS
else
  info "Step 2/4: Backend — SKIPPED"
fi
echo ""

# Step 3: Frontend
if [[ "$SKIP_FRONTEND" == "false" ]]; then
  log "═══ Step 3/4: Frontend ═══"
  "$SCRIPT_DIR/deploy-frontend.sh" $COMMON_ARGS
else
  info "Step 3/4: Frontend — SKIPPED"
fi
echo ""

# Step 4: Migration
if [[ "$SKIP_MIGRATE" == "false" ]]; then
  log "═══ Step 4/4: Migration ═══"
  "$SCRIPT_DIR/deploy-migrate.sh" $COMMON_ARGS
else
  info "Step 4/4: Migration — SKIPPED"
fi
echo ""

# Health check
CF_DOMAIN=$(get_stack_output "CloudFrontDomain")
if [[ -n "$CF_DOMAIN" ]]; then
  log "═══ Health Check ═══"
  health_check "https://${CF_DOMAIN}/health" 5 10 || true
fi

log "Full deploy complete."
