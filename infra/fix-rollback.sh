#!/bin/bash
set -e
REGION=ap-southeast-1

echo "Step 1: Attempting regular stack deletion..."
aws cloudformation delete-stack --stack-name SuperAgent-dev --region $REGION

echo "Waiting for deletion (expecting it may fail due to retained resources)..."
aws cloudformation wait stack-delete-complete --stack-name SuperAgent-dev --region $REGION 2>&1 || true

STATUS=$(aws cloudformation describe-stacks --stack-name SuperAgent-dev --region $REGION --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "DELETED")
echo "Stack status: $STATUS"

if [ "$STATUS" = "DELETE_FAILED" ]; then
  echo "Step 2: Retrying with force delete..."
  aws cloudformation delete-stack --stack-name SuperAgent-dev --region $REGION \
    --deletion-mode FORCE_DELETE_STACK

  echo "Waiting for force deletion..."
  aws cloudformation wait stack-delete-complete --stack-name SuperAgent-dev --region $REGION 2>&1 || true

  STATUS=$(aws cloudformation describe-stacks --stack-name SuperAgent-dev --region $REGION --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "DELETED")
  echo "Final stack status: $STATUS"
fi

echo "Done."
