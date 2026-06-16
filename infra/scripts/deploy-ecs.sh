#!/bin/bash
set -euo pipefail

# =============================================================================
# Super Agent — ECS Fargate Deploy Script
#
# Builds backend Docker image, pushes to ECR, deploys CDK infrastructure,
# builds frontend, syncs to S3, and forces ECS service update.
#
# Prerequisites:
#   - AWS CLI v2 configured with account 873543029686 access
#   - Docker running
#   - Node.js 22+
#   - CDK bootstrapped in target region
#
# Usage:
#   ./deploy-ecs.sh                    # Full deploy (infra + backend + frontend)
#   ./deploy-ecs.sh --skip-infra       # Code deploy only (backend + frontend)
#   ./deploy-ecs.sh --skip-frontend    # Infra + backend only
#   ./deploy-ecs.sh --skip-backend     # Infra + frontend only
#   ./deploy-ecs.sh --backend-only     # Backend image build + push + ECS restart
#   ./deploy-ecs.sh --frontend-only    # Frontend build + S3 sync + CF invalidation
#
# Options:
#   --env <name>            Environment name (default: prod)
#   --region <region>       AWS region (default: us-east-1)
#   --skip-infra            Skip CDK deploy
#   --skip-backend          Skip backend build/push
#   --skip-frontend         Skip frontend build/deploy
#   --backend-only          Only deploy backend
#   --frontend-only         Only deploy frontend
#   --otel-endpoint <url>   Grafana Cloud OTLP endpoint
#   --dry-run               Show what would be done without executing
#
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Defaults
ENV_NAME="prod"
REGION="us-east-1"
SKIP_INFRA=false
SKIP_BACKEND=false
SKIP_FRONTEND=false
BACKEND_ONLY=false
FRONTEND_ONLY=false
OTEL_ENDPOINT=""
DRY_RUN=false

# Parse options
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)              ENV_NAME="$2"; shift 2 ;;
    --region)           REGION="$2"; shift 2 ;;
    --skip-infra)       SKIP_INFRA=true; shift ;;
    --skip-backend)     SKIP_BACKEND=true; shift ;;
    --skip-frontend)    SKIP_FRONTEND=true; shift ;;
    --backend-only)     BACKEND_ONLY=true; SKIP_INFRA=true; SKIP_FRONTEND=true; shift ;;
    --frontend-only)    FRONTEND_ONLY=true; SKIP_INFRA=true; SKIP_BACKEND=true; shift ;;
    --otel-endpoint)    OTEL_ENDPOINT="$2"; shift 2 ;;
    --dry-run)          DRY_RUN=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

STACK_NAME="SuperAgent-${ENV_NAME}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
BACKEND_REPO="super-agent-backend-${ENV_NAME}"
BACKEND_IMAGE="${ECR_REGISTRY}/${BACKEND_REPO}:latest"

echo "============================================="
echo "  Super Agent ECS Deploy"
echo "============================================="
echo "  Environment:  $ENV_NAME"
echo "  Stack:        $STACK_NAME"
echo "  Region:       $REGION"
echo "  Account:      $ACCOUNT"
echo "  ECR Image:    $BACKEND_IMAGE"
echo "  Skip Infra:   $SKIP_INFRA"
echo "  Skip Backend: $SKIP_BACKEND"
echo "  Skip Frontend:$SKIP_FRONTEND"
echo "============================================="
echo ""

if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] Would execute the steps above. Exiting."
  exit 0
fi

# =========================================================================
# Step 1: CDK Infrastructure Deploy
# =========================================================================
if [ "$SKIP_INFRA" = false ]; then
  echo "=== [1/4] CDK Infrastructure Deploy ==="

  cd "$PROJECT_ROOT/infra"
  npm run build 2>/dev/null || true

  CDK_ARGS="-c env=${ENV_NAME}"
  [ -n "$OTEL_ENDPOINT" ] && CDK_ARGS="$CDK_ARGS -c otelEndpoint=$OTEL_ENDPOINT"

  echo "  Running: npx cdk deploy --all $CDK_ARGS --require-approval broadening"
  npx cdk deploy --all $CDK_ARGS --require-approval broadening

  echo "  CDK deploy complete."
  echo ""
fi

# =========================================================================
# Step 2: Backend Docker Build + Push to ECR
# =========================================================================
if [ "$SKIP_BACKEND" = false ]; then
  echo "=== [2/4] Backend Docker Build + ECR Push ==="

  cd "$PROJECT_ROOT/backend"

  # ECR login
  echo "  Logging into ECR..."
  aws ecr get-login-password --region "$REGION" | \
    docker login --username AWS --password-stdin "$ECR_REGISTRY"

  # Build production image
  echo "  Building backend Docker image..."
  docker build \
    --platform linux/amd64 \
    -t "$BACKEND_IMAGE" \
    -f Dockerfile \
    .

  # Push
  echo "  Pushing to ECR: $BACKEND_IMAGE"
  docker push "$BACKEND_IMAGE"

  echo "  Backend image pushed."
  echo ""

  # Force ECS service update to pick up new image
  echo "  Forcing ECS service update..."
  CLUSTER_NAME="super-agent-${ENV_NAME}"

  aws ecs update-service \
    --cluster "$CLUSTER_NAME" \
    --service "${STACK_NAME}-ApiService" \
    --force-new-deployment \
    --region "$REGION" \
    --no-cli-pager 2>/dev/null || \
  aws ecs list-services --cluster "$CLUSTER_NAME" --region "$REGION" --query "serviceArns" --output text | \
    tr '\t' '\n' | while read -r svc; do
      echo "  Updating: $svc"
      aws ecs update-service --cluster "$CLUSTER_NAME" --service "$svc" --force-new-deployment --region "$REGION" --no-cli-pager 2>/dev/null || true
    done

  echo "  ECS services updating (rolling deployment)."
  echo ""
fi

# =========================================================================
# Step 3: Frontend Build + S3 Deploy + CloudFront Invalidation
# =========================================================================
if [ "$SKIP_FRONTEND" = false ]; then
  echo "=== [3/4] Frontend Build + S3 Deploy ==="

  cd "$PROJECT_ROOT/frontend"

  # Read stack outputs for frontend bucket and CF distribution
  FRONTEND_BUCKET=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" \
    --output text 2>/dev/null || echo "")

  CF_DOMAIN=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" \
    --output text 2>/dev/null || echo "")

  if [ -z "$FRONTEND_BUCKET" ]; then
    echo "  WARNING: Could not find FrontendBucketName in stack outputs. Skipping."
  else
    # Generate production env
    cat > .env.production << VITE_EOF
VITE_API_BASE_URL=
VITE_AUTH_MODE=local
VITE_EOF

    echo "  Installing dependencies..."
    npm ci

    echo "  Building frontend..."
    npx vite build

    echo "  Syncing to S3: $FRONTEND_BUCKET"
    # Static assets (long cache)
    aws s3 sync dist/ "s3://$FRONTEND_BUCKET/" \
      --delete \
      --exclude "index.html" \
      --cache-control "public,max-age=31536000,immutable" \
      --region "$REGION"

    # index.html (no cache)
    aws s3 cp dist/index.html "s3://$FRONTEND_BUCKET/index.html" \
      --cache-control "no-cache,no-store,must-revalidate" \
      --region "$REGION"

    # CloudFront invalidation
    if [ -n "$CF_DOMAIN" ]; then
      CF_DIST_ID=$(aws cloudfront list-distributions \
        --query "DistributionList.Items[?DomainName=='${CF_DOMAIN}'].Id" \
        --output text 2>/dev/null || echo "")

      if [ -n "$CF_DIST_ID" ]; then
        echo "  Invalidating CloudFront: $CF_DIST_ID"
        aws cloudfront create-invalidation \
          --distribution-id "$CF_DIST_ID" \
          --paths "/index.html" "/*" \
          --no-cli-pager 2>/dev/null || true
      fi
    fi

    echo "  Frontend deployed."
  fi
  echo ""
fi

# =========================================================================
# Step 4: Run Migrations (via ECS Exec or one-off task)
# =========================================================================
echo "=== [4/4] Post-Deploy Verification ==="

# Check ECS service status
CLUSTER_NAME="super-agent-${ENV_NAME}"
echo "  ECS Cluster: $CLUSTER_NAME"

SERVICES=$(aws ecs list-services --cluster "$CLUSTER_NAME" --region "$REGION" \
  --query "serviceArns" --output text 2>/dev/null || echo "")

if [ -n "$SERVICES" ]; then
  echo "$SERVICES" | tr '\t' '\n' | while read -r svc; do
    SVC_NAME=$(basename "$svc")
    STATUS=$(aws ecs describe-services --cluster "$CLUSTER_NAME" --services "$svc" --region "$REGION" \
      --query "services[0].{desired: desiredCount, running: runningCount, status: status}" \
      --output text 2>/dev/null || echo "unknown")
    echo "    $SVC_NAME: $STATUS"
  done
else
  echo "  No ECS services found (desiredCount may be 0)."
fi

# Health check via CloudFront
CF_DOMAIN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" \
  --output text 2>/dev/null || echo "")

if [ -n "$CF_DOMAIN" ]; then
  echo ""
  echo "  Health check: https://$CF_DOMAIN/health"
  HEALTH=$(curl -sf "https://$CF_DOMAIN/health" 2>/dev/null || echo "FAILED")
  echo "  Response: $HEALTH"
fi

# =========================================================================
# Done
# =========================================================================
echo ""
echo "============================================="
echo "  Deployment complete!"
echo "============================================="
echo "  Stack:      $STACK_NAME"
echo "  Region:     $REGION"
[ -n "$CF_DOMAIN" ] && echo "  URL:        https://$CF_DOMAIN"
echo "  ECR Image:  $BACKEND_IMAGE"
echo "============================================="
