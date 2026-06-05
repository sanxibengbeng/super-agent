#!/bin/bash
set -e
REGION=ap-southeast-1

echo "Deleting orphaned ECR repos..."
aws ecr delete-repository --repository-name super-agent-backend-dev --region $REGION --force 2>&1 || true
aws ecr delete-repository --repository-name super-agent-agentcore-dev --region $REGION --force 2>&1 || true

echo "Deleting orphaned Secrets Manager secret..."
aws secretsmanager delete-secret --secret-id super-agent/app-config --region $REGION --force-delete-without-recovery 2>&1 || true

echo "Deleting orphaned S3 buckets (if empty)..."
aws s3 rb s3://super-agent-workspace-dev-873543029686 --region $REGION 2>&1 || true
aws s3 rb s3://super-agent-assets-dev-873543029686 --region $REGION 2>&1 || true
aws s3 rb s3://super-agent-frontend-dev-873543029686 --region $REGION 2>&1 || true

echo "Cleanup complete."
