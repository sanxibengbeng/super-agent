#!/bin/bash
# =============================================================================
# 清理: 删除 AgentCore 相关 AWS 资源
# Usage: ./teardown.sh [--yes]
# =============================================================================
set -euo pipefail
source "$(dirname "$0")/00-config.sh"
validate_aws

if [ "${1:-}" != "--yes" ]; then
  echo "Will DELETE:"
  echo "  ECR: $ECR_REPO"
  echo "  S3:  $S3_BUCKET_NAME"
  echo "  IAM: $AC_ROLE"
  [ -n "$EKS_POD_ROLE_NAME" ] && echo "  Policy on: $EKS_POD_ROLE_NAME"
  echo -n "Type 'destroy': "
  read -r c; [ "$c" != "destroy" ] && echo "Aborted." && exit 0
fi

# ECR
info "Deleting ECR: $ECR_REPO"
aws ecr delete-repository --repository-name "$ECR_REPO" --force \
  --region "$DEPLOY_REGION" 2>/dev/null && ok "Done." || warn "Not found."

# S3
info "Deleting S3: $S3_BUCKET_NAME"
aws s3 rm "s3://$S3_BUCKET_NAME" --recursive --region "$DEPLOY_REGION" 2>/dev/null || true
aws s3api delete-bucket --bucket "$S3_BUCKET_NAME" --region "$DEPLOY_REGION" 2>/dev/null \
  && ok "Done." || warn "Not found."

# Pod invoke policy
if [ -n "$EKS_POD_ROLE_NAME" ]; then
  info "Removing invoke policy from $EKS_POD_ROLE_NAME"
  aws iam delete-role-policy --role-name "$EKS_POD_ROLE_NAME" \
    --policy-name "${STACK_NAME}-agentcore-invoke" 2>/dev/null || true
fi

# AgentCore role
info "Deleting IAM: $AC_ROLE"
for p in $(aws iam list-role-policies --role-name "$AC_ROLE" --query 'PolicyNames[*]' --output text 2>/dev/null); do
  aws iam delete-role-policy --role-name "$AC_ROLE" --policy-name "$p"
done
aws iam delete-role --role-name "$AC_ROLE" 2>/dev/null && ok "Done." || warn "Not found."

rm -f "$(dirname "$0")/.deploy-state"
ok "Teardown complete."
