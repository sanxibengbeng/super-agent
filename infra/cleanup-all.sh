#!/bin/bash
REGION=ap-southeast-1

echo "Cleaning up orphaned resources before redeploy..."

# ECR repos
echo "Deleting ECR repos..."
aws ecr delete-repository --repository-name super-agent-backend-dev --region $REGION --force 2>&1 || true
aws ecr delete-repository --repository-name super-agent-agentcore-dev --region $REGION --force 2>&1 || true

# Secrets
echo "Deleting Secrets Manager secret..."
aws secretsmanager delete-secret --secret-id super-agent/app-config --region $REGION --force-delete-without-recovery 2>&1 || true

# S3 Buckets (empty first)
echo "Deleting S3 buckets..."
aws s3 rb s3://super-agent-workspace-dev-873543029686 --region $REGION --force 2>&1 || true
aws s3 rb s3://super-agent-assets-dev-873543029686 --region $REGION --force 2>&1 || true
aws s3 rb s3://super-agent-frontend-dev-873543029686 --region $REGION --force 2>&1 || true

# Redis subnet group
echo "Deleting Redis subnet group..."
aws elasticache delete-cache-subnet-group --cache-subnet-group-name super-agent-redis-subnet-group --region $REGION 2>&1 || true

# DB subnet group
echo "Deleting DB subnet group..."
aws rds delete-db-subnet-group --db-subnet-group-name superagent-dev-datadbclustersubnetsba71ca9b-antg8isg4net --region $REGION 2>&1 || true

echo "Cleanup complete."
