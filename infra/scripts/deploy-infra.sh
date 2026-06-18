#!/bin/bash
# Deploy infrastructure via CDK (with mandatory diff + confirmation)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# Parse options
EXTRA_CONTEXT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)     ENV_NAME="$2"; STACK_NAME="SuperAgent-${ENV_NAME}"; shift 2 ;;
    --region)  REGION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --context) EXTRA_CONTEXT="$EXTRA_CONTEXT -c $2"; shift 2 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

banner "Infrastructure Deploy"

PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT/infra"

CDK_ARGS="-c env=${ENV_NAME}${EXTRA_CONTEXT}"

# Step 1: CDK Diff (mandatory)
log "Running cdk diff..."
echo ""
npx cdk diff $CDK_ARGS 2>&1 || true
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  info "[DRY RUN] Would deploy with: npx cdk deploy --all $CDK_ARGS"
  exit 0
fi

# Step 2: Interactive confirmation
echo -e "${YELLOW}The above changes will be applied to ${STACK_NAME} in ${REGION}.${NC}"
read -rp "Proceed with deploy? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  log "Aborted by user."
  exit 0
fi

# Step 3: Deploy
log "Deploying: npx cdk deploy --all $CDK_ARGS --require-approval never"
npx cdk deploy --all $CDK_ARGS --require-approval never

log "Infrastructure deploy complete."
