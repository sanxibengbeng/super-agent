#!/bin/bash
# =============================================================================
# Step 1: 创建 ECR 仓库 (AgentCore 镜像)
# =============================================================================
set -euo pipefail
source "$(dirname "$0")/00-config.sh"
validate_aws

info "Creating ECR: $ECR_REPO ($DEPLOY_REGION)"

if aws ecr describe-repositories --repository-names "$ECR_REPO" \
  --region "$DEPLOY_REGION" > /dev/null 2>&1; then
  warn "ECR '$ECR_REPO' already exists, skipping."
else
  aws ecr create-repository \
    --repository-name "$ECR_REPO" \
    --region "$DEPLOY_REGION" \
    --image-scanning-configuration scanOnPush=true \
    --image-tag-mutability MUTABLE
fi

save_state "ECR_URI" "$ECR_URI"
ok "ECR: $ECR_URI"
