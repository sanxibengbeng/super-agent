#!/bin/bash
# =============================================================================
# Step 5: 验证所有 AgentCore 资源
# =============================================================================
set -euo pipefail
source "$(dirname "$0")/00-config.sh"
validate_aws

echo "========================================="
echo " AgentCore Resources ($DEPLOY_REGION)"
echo "========================================="

PASS=0; FAIL=0
check() {
  local label="$1"; shift
  if "$@" > /dev/null 2>&1; then ok "$label"; ((PASS++)); else echo -e "\033[1;31m✗ $label\033[0m"; ((FAIL++)); fi
}

check "ECR: $ECR_REPO" \
  aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$DEPLOY_REGION"

check "S3: $S3_BUCKET_NAME" \
  aws s3api head-bucket --bucket "$S3_BUCKET_NAME" --region "$DEPLOY_REGION"

check "IAM: $AC_ROLE" \
  aws iam get-role --role-name "$AC_ROLE"

# Check image exists
IMG=$(load_state "AGENTCORE_IMAGE" 2>/dev/null || echo "")
if [ -n "$IMG" ]; then
  ok "Image: $IMG"; ((PASS++))
else
  warn "Image: not built yet (run 04-build-agentcore.sh)"
fi

# Check invoke policy on pod role
if [ -n "$EKS_POD_ROLE_NAME" ]; then
  check "Pod policy on $EKS_POD_ROLE_NAME" \
    aws iam get-role-policy --role-name "$EKS_POD_ROLE_NAME" --policy-name "${STACK_NAME}-agentcore-invoke"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
echo ""

# Backend .env 参考值
echo "========================================="
echo " Backend .env 参考值"
echo "========================================="
echo "AGENT_RUNTIME=agentcore"
echo "AGENTCORE_EXECUTION_ROLE_ARN=$(load_state AC_ROLE_ARN 2>/dev/null || echo 'RUN 03-iam.sh')"
echo "AGENTCORE_WORKSPACE_S3_BUCKET=$(load_state S3_BUCKET 2>/dev/null || echo "$S3_BUCKET_NAME")"
echo "AGENTCORE_RUNTIME_ARN=<从 Bedrock Console 获取>"
echo "AGENTCORE_BACKEND_API_URL=<你的 backend 外部 URL>"
