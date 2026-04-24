#!/bin/bash
# =============================================================================
# Step 4: 构建并推送 AgentCore 镜像 (ARM64)
# Usage:
#   ./04-build-agentcore.sh           # tag = latest
#   ./04-build-agentcore.sh v1.0.0    # tag = v1.0.0 + latest
# =============================================================================
set -euo pipefail
source "$(dirname "$0")/00-config.sh"
validate_aws

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
TAG="${1:-latest}"

info "ECR login ($DEPLOY_REGION)"
aws ecr get-login-password --region "$DEPLOY_REGION" \
  | docker login --username AWS --password-stdin \
    "${ACCOUNT_ID}.dkr.ecr.${DEPLOY_REGION}.amazonaws.com"

info "Building AgentCore (ARM64, BuildKit OFF)"
cd "$REPO_ROOT/agentcore"

# DOCKER_BUILDKIT=0: BuildKit 会加 unknown/unknown manifest，导致 AgentCore microVM 启动失败
DOCKER_BUILDKIT=0 docker build \
  --platform linux/arm64 \
  -t "${ECR_URI}:${TAG}" \
  -t "${ECR_URI}:latest" \
  .

info "Pushing ${ECR_URI}:${TAG}"
docker push "${ECR_URI}:${TAG}"
docker push "${ECR_URI}:latest"

save_state "AGENTCORE_IMAGE" "${ECR_URI}:${TAG}"
ok "Image: ${ECR_URI}:${TAG}"
echo ""
echo "下一步: 在 Bedrock Console 创建 AgentCore Runtime"
echo "  Image URI:      ${ECR_URI}:${TAG}"
echo "  Execution Role: $(load_state AC_ROLE_ARN)"
