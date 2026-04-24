#!/bin/bash
# =============================================================================
# AgentCore 部署配置 — 部署前修改此文件
# =============================================================================

# ---- 必须修改 ----
export DEPLOY_REGION="ap-southeast-1"            # AgentCore 部署 region
export EKS_POD_ROLE_NAME=""                      # 已有的 EKS backend pod IAM Role 名称
                                                 # 用于追加 AgentCore invoke 权限

# ---- 可选修改 ----
export STACK_NAME="super-agent"                  # 资源命名前缀
export S3_BUCKET_NAME=""                         # 留空则自动生成: ${STACK_NAME}-workspace-${ACCOUNT_ID}

# ---- 自动计算 ----
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
[ -z "$S3_BUCKET_NAME" ] && export S3_BUCKET_NAME="${STACK_NAME}-workspace-${ACCOUNT_ID}"
export ECR_REPO="${STACK_NAME}-agentcore"
export ECR_URI="${ACCOUNT_ID}.dkr.ecr.${DEPLOY_REGION}.amazonaws.com/${ECR_REPO}"
export AC_ROLE="${STACK_NAME}-agentcore-role"

# ---- State file ----
export STATE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.deploy-state"

save_state() {
  local key="$1" val="$2"
  [ -f "$STATE_FILE" ] && { grep -v "^${key}=" "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null || true; mv "${STATE_FILE}.tmp" "$STATE_FILE"; }
  echo "${key}=${val}" >> "$STATE_FILE"
  echo "  [saved] ${key}=${val}"
}

load_state() {
  [ -f "$STATE_FILE" ] && grep "^${1}=" "$STATE_FILE" | tail -1 | cut -d'=' -f2-
}

info() { echo -e "\033[1;34m>>> $*\033[0m"; }
ok()   { echo -e "\033[1;32m✓ $*\033[0m"; }
warn() { echo -e "\033[1;33m⚠ $*\033[0m"; }
fail() { echo -e "\033[1;31m✗ $*\033[0m"; exit 1; }

validate_aws() {
  aws sts get-caller-identity --region "$DEPLOY_REGION" > /dev/null 2>&1 \
    || fail "AWS CLI 未配置，先运行 aws configure"
  ok "Account: $ACCOUNT_ID | Region: $DEPLOY_REGION"
}
