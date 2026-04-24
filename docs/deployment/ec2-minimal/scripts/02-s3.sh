#!/bin/bash
# =============================================================================
# Step 2: 创建 S3 Bucket (AgentCore workspace 文件同步)
# =============================================================================
set -euo pipefail
source "$(dirname "$0")/00-config.sh"
validate_aws

info "Creating S3: $S3_BUCKET_NAME ($DEPLOY_REGION)"

if aws s3api head-bucket --bucket "$S3_BUCKET_NAME" --region "$DEPLOY_REGION" 2>/dev/null; then
  warn "Bucket '$S3_BUCKET_NAME' already exists, skipping."
else
  aws s3api create-bucket \
    --bucket "$S3_BUCKET_NAME" \
    --region "$DEPLOY_REGION" \
    --create-bucket-configuration LocationConstraint="$DEPLOY_REGION"

  aws s3api put-public-access-block \
    --bucket "$S3_BUCKET_NAME" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

save_state "S3_BUCKET" "$S3_BUCKET_NAME"
ok "S3: $S3_BUCKET_NAME"
