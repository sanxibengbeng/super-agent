#!/bin/bash
# Build backend Docker image, push to ECR, and roll out ECS services

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)     ENV_NAME="$2"; STACK_NAME="SuperAgent-${ENV_NAME}"; shift 2 ;;
    --region)  REGION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

banner "Backend Deploy"

PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ACCOUNT=$(detect_account)
ECR_REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
BACKEND_REPO="super-agent-backend-${ENV_NAME}"
IMAGE_TAG=$(git -C "$PROJECT_ROOT" rev-parse --short HEAD)
BACKEND_IMAGE="${ECR_REGISTRY}/${BACKEND_REPO}"

if [[ "$DRY_RUN" == "true" ]]; then
  info "[DRY RUN] Would build and push: ${BACKEND_IMAGE}:${IMAGE_TAG}"
  info "[DRY RUN] Would force-new-deployment on all ECS services"
  exit 0
fi

# Step 1: ECR login
log "Logging into ECR..."
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$ECR_REGISTRY"

# Step 2: Build backend image
log "Building backend image (linux/amd64)..."
cd "$PROJECT_ROOT/backend"
docker build \
  --platform linux/amd64 \
  -t "${BACKEND_IMAGE}:${IMAGE_TAG}" \
  -t "${BACKEND_IMAGE}:latest" \
  -f Dockerfile .

# Step 3: Push to ECR
log "Pushing: ${BACKEND_IMAGE}:${IMAGE_TAG}"
docker push "${BACKEND_IMAGE}:${IMAGE_TAG}"
docker push "${BACKEND_IMAGE}:latest"
log "Image pushed successfully."

# Step 4: Force ECS service rolling update
CLUSTER_NAME="super-agent-${ENV_NAME}"
log "Rolling out ECS services in cluster: ${CLUSTER_NAME}"

SERVICES=$(aws ecs list-services --cluster "$CLUSTER_NAME" --region "$REGION" \
  --query "serviceArns[*]" --output text 2>/dev/null || echo "")

if [[ -z "$SERVICES" ]]; then
  warn "No ECS services found. Cluster may have desiredCount=0."
  exit 0
fi

for SERVICE_ARN in $SERVICES; do
  SERVICE_NAME=$(echo "$SERVICE_ARN" | awk -F'/' '{print $NF}')
  log "  Deploying: $SERVICE_NAME"
  aws ecs update-service \
    --cluster "$CLUSTER_NAME" \
    --service "$SERVICE_NAME" \
    --force-new-deployment \
    --region "$REGION" \
    --no-cli-pager > /dev/null
done

# Step 5: Wait for stability
log "Waiting for services to stabilize..."
aws ecs wait services-stable \
  --cluster "$CLUSTER_NAME" \
  --services $SERVICES \
  --region "$REGION" 2>/dev/null && log "All services stable." || {
    err "Services did not stabilize. Check ECS console."
    exit 1
  }

log "Backend deploy complete. Image: ${BACKEND_IMAGE}:${IMAGE_TAG}"
