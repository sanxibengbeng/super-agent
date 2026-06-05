#!/bin/bash
set -e
REGION=ap-southeast-1

echo "Force deleting the stack..."
aws cloudformation delete-stack --stack-name SuperAgent-dev --region $REGION \
  --deletion-mode FORCE_DELETE_STACK

echo "Waiting for deletion to complete..."
aws cloudformation wait stack-delete-complete --stack-name SuperAgent-dev --region $REGION 2>&1 || true

STATUS=$(aws cloudformation describe-stacks --stack-name SuperAgent-dev --region $REGION --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "DELETED")
echo "Final status: $STATUS"
