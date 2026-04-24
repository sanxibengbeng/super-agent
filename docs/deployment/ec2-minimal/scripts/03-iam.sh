#!/bin/bash
# =============================================================================
# Step 3: 创建 IAM 资源
#   (A) AgentCore Execution Role — AgentCore 容器运行时使用
#   (B) Pod Invoke Policy — 追加到已有 EKS pod role，允许调用 AgentCore
# =============================================================================
set -euo pipefail
source "$(dirname "$0")/00-config.sh"
validate_aws

S3_BUCKET=$(load_state "S3_BUCKET")
[ -z "$S3_BUCKET" ] && S3_BUCKET="$S3_BUCKET_NAME"

# ======================== A. AgentCore Execution Role ========================
info "Creating AgentCore Role: $AC_ROLE"

if aws iam get-role --role-name "$AC_ROLE" > /dev/null 2>&1; then
  warn "Role '$AC_ROLE' exists, updating policy."
else
  # Trust: bedrock-agentcore.amazonaws.com
  cat > /tmp/ac-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF
  aws iam create-role \
    --role-name "$AC_ROLE" \
    --assume-role-policy-document file:///tmp/ac-trust.json
  rm /tmp/ac-trust.json
fi

# AgentCore permissions: Bedrock model + S3 workspace + ECR pull + CloudWatch
cat > /tmp/ac-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockInvoke",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": "*"
    },
    {
      "Sid": "S3Workspace",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${S3_BUCKET}", "arn:aws:s3:::${S3_BUCKET}/*"]
    },
    {
      "Sid": "ECRAuth",
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken"],
      "Resource": "*"
    },
    {
      "Sid": "ECRPull",
      "Effect": "Allow",
      "Action": ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
      "Resource": "arn:aws:ecr:${DEPLOY_REGION}:${ACCOUNT_ID}:repository/${ECR_REPO}"
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:${DEPLOY_REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name "$AC_ROLE" \
  --policy-name "${STACK_NAME}-agentcore-policy" \
  --policy-document file:///tmp/ac-policy.json
rm /tmp/ac-policy.json

AC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${AC_ROLE}"
save_state "AC_ROLE_ARN" "$AC_ROLE_ARN"
ok "AgentCore Role: $AC_ROLE_ARN"

# ======================== B. Pod Invoke Policy ==============================
# Backend pod 需要: 调用 AgentCore + 读写 S3 workspace
INVOKE_POLICY_NAME="${STACK_NAME}-agentcore-invoke"

cat > /tmp/invoke-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeAgentCore",
      "Effect": "Allow",
      "Action": ["bedrock-agentcore:InvokeAgentRuntime"],
      "Resource": "arn:aws:bedrock-agentcore:${DEPLOY_REGION}:${ACCOUNT_ID}:runtime/*"
    },
    {
      "Sid": "S3Workspace",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${S3_BUCKET}", "arn:aws:s3:::${S3_BUCKET}/*"]
    }
  ]
}
EOF

if [ -n "$EKS_POD_ROLE_NAME" ]; then
  info "Attaching invoke policy to EKS pod role: $EKS_POD_ROLE_NAME"
  aws iam put-role-policy \
    --role-name "$EKS_POD_ROLE_NAME" \
    --policy-name "$INVOKE_POLICY_NAME" \
    --policy-document file:///tmp/invoke-policy.json
  ok "Policy '$INVOKE_POLICY_NAME' attached to $EKS_POD_ROLE_NAME"
else
  warn "EKS_POD_ROLE_NAME not set in 00-config.sh"
  echo "  手动附加:"
  echo "  aws iam put-role-policy \\"
  echo "    --role-name YOUR-POD-ROLE \\"
  echo "    --policy-name $INVOKE_POLICY_NAME \\"
  echo "    --policy-document file:///tmp/invoke-policy.json"
  echo ""
  echo "  Policy 已保存到: /tmp/invoke-policy.json"
fi

save_state "INVOKE_POLICY" "$INVOKE_POLICY_NAME"
