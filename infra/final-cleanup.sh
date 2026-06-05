#!/bin/bash
set -e
REGION=ap-southeast-1

echo "Deleting ROLLBACK_COMPLETE stack..."
aws cloudformation delete-stack --stack-name SuperAgent-dev --region $REGION
aws cloudformation wait stack-delete-complete --stack-name SuperAgent-dev --region $REGION
echo "Stack deleted."

# Clean up remaining orphans
echo "Cleaning up remaining orphaned resources..."
aws ecr delete-repository --repository-name super-agent-backend-dev --region $REGION --force 2>&1 || true
aws ecr delete-repository --repository-name super-agent-agentcore-dev --region $REGION --force 2>&1 || true
aws s3 rb s3://super-agent-workspace-dev-873543029686 --force 2>&1 || true
aws s3 rb s3://super-agent-assets-dev-873543029686 --force 2>&1 || true
aws s3 rb s3://super-agent-frontend-dev-873543029686 --force 2>&1 || true

# Delete log groups from previous deploys
aws logs delete-log-group --log-group-name /super-agent/dev/ecs --region $REGION 2>&1 || true

# Check for flow log log groups (CDK creates them with generated names)
FLOW_LOG_GROUPS=$(aws logs describe-log-groups --region $REGION --log-group-name-prefix SuperAgent-dev --query 'logGroups[].logGroupName' --output text)
for lg in $FLOW_LOG_GROUPS; do
  echo "Deleting log group: $lg"
  aws logs delete-log-group --log-group-name "$lg" --region $REGION 2>&1 || true
done

echo "Ready for redeploy."
