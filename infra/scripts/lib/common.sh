#!/bin/bash
# Shared utilities for deployment scripts

set -euo pipefail

# ---- Colors ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ---- Defaults ----
ENV_NAME="${ENV_NAME:-prod}"
REGION="${REGION:-us-east-1}"
STACK_NAME="SuperAgent-${ENV_NAME}"
DRY_RUN="${DRY_RUN:-false}"

# ---- Logging ----
log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] WARN:${NC} $*"; }
err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ERROR:${NC} $*" >&2; }
info() { echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $*"; }

# ---- AWS helpers ----
detect_account() {
  aws sts get-caller-identity --query Account --output text 2>/dev/null || {
    err "Failed to detect AWS account. Check credentials."
    exit 1
  }
}

get_stack_output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text 2>/dev/null || echo ""
}

# ---- Health check ----
health_check() {
  local url="$1"
  local max_attempts="${2:-5}"
  local wait_seconds="${3:-10}"

  for i in $(seq 1 "$max_attempts"); do
    local code
    code=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
    if [[ "$code" == "200" ]]; then
      log "Health check PASSED: $url (HTTP 200)"
      return 0
    fi
    if [[ "$i" -lt "$max_attempts" ]]; then
      warn "Attempt $i/$max_attempts: HTTP $code — retrying in ${wait_seconds}s..."
      sleep "$wait_seconds"
    fi
  done
  err "Health check FAILED after $max_attempts attempts: $url"
  return 1
}

# ---- Option parsing helper ----
parse_common_opts() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env)     ENV_NAME="$2"; STACK_NAME="SuperAgent-${ENV_NAME}"; shift 2 ;;
      --region)  REGION="$2"; shift 2 ;;
      --dry-run) DRY_RUN=true; shift ;;
      *)         return 0 ;;
    esac
  done
}

# ---- Banner ----
banner() {
  local script_name="$1"
  local account
  account=$(detect_account)
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Super Agent — ${script_name}${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════${NC}"
  echo "  Environment:  $ENV_NAME"
  echo "  Stack:        $STACK_NAME"
  echo "  Region:       $REGION"
  echo "  Account:      $account"
  echo -e "${CYAN}═══════════════════════════════════════════${NC}"
  echo ""
}
