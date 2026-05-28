#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# build.sh — Build frontend, backend Docker image, and push to ECR
#
# Usage:
#   ENV=dev ./scripts/build.sh              # Build for dev environment
#   ENV=prod ./scripts/build.sh             # Build for prod environment
#   ENV=staging BUILD_AGENTCORE=1 ./scripts/build.sh
#
# Environment variables:
#   ENV               — Target environment (default: dev) — drives ECR repo names
#   AWS_ACCOUNT_ID    — AWS account (auto-detected if not set)
#   AWS_REGION        — AWS region (default: us-east-1)
#   IMAGE_TAG         — Docker tag (default: git SHA short)
#   BUILD_FRONTEND    — 1/0 (default: 1)
#   BUILD_BACKEND     — 1/0 (default: 1)
#   BUILD_AGENTCORE   — 1/0 (default: 0)
#   PUSH              — 1/0 push to ECR (default: 1)
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Environment
ENV="${ENV:-dev}"
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$PROJECT_ROOT" rev-parse --short HEAD)}"
BUILD_FRONTEND="${BUILD_FRONTEND:-1}"
BUILD_BACKEND="${BUILD_BACKEND:-1}"
BUILD_AGENTCORE="${BUILD_AGENTCORE:-0}"
PUSH="${PUSH:-1}"

# Derived names (match CDK resource naming)
BACKEND_REPO="super-agent-backend-${ENV}"
AGENTCORE_REPO="super-agent-agentcore-${ENV}"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

log() { echo "[$(date '+%H:%M:%S')] [$ENV] $*"; }
err() { echo "[$(date '+%H:%M:%S')] [$ENV] ERROR: $*" >&2; }

if [[ -z "$AWS_ACCOUNT_ID" ]]; then
  err "AWS_ACCOUNT_ID not set and auto-detection failed. Configure AWS credentials."
  exit 1
fi

log "Build started: ENV=$ENV, TAG=$IMAGE_TAG"

###############################################################################
# ECR Login
###############################################################################
if [[ "$PUSH" == "1" ]]; then
  log "Logging into ECR: $ECR_REGISTRY"
  aws ecr get-login-password --region "$AWS_REGION" | \
    docker login --username AWS --password-stdin "$ECR_REGISTRY"
fi

###############################################################################
# Frontend Build
###############################################################################
if [[ "$BUILD_FRONTEND" == "1" ]]; then
  log "Building frontend..."
  cd "$PROJECT_ROOT/frontend"
  npm ci --prefer-offline
  npm run build
  log "Frontend build complete: frontend/dist/ ($(du -sh dist | cut -f1))"
fi

###############################################################################
# Backend Docker Image
###############################################################################
if [[ "$BUILD_BACKEND" == "1" ]]; then
  log "Building backend image: $BACKEND_REPO:$IMAGE_TAG"
  cd "$PROJECT_ROOT/backend"

  docker build \
    --platform linux/amd64 \
    -t "$ECR_REGISTRY/$BACKEND_REPO:$IMAGE_TAG" \
    -t "$ECR_REGISTRY/$BACKEND_REPO:latest" \
    -f Dockerfile .

  if [[ "$PUSH" == "1" ]]; then
    log "Pushing backend image..."
    docker push "$ECR_REGISTRY/$BACKEND_REPO:$IMAGE_TAG"
    docker push "$ECR_REGISTRY/$BACKEND_REPO:latest"
    log "Backend image pushed: $ECR_REGISTRY/$BACKEND_REPO:$IMAGE_TAG"
  fi
fi

###############################################################################
# AgentCore Docker Image (ARM64)
###############################################################################
if [[ "$BUILD_AGENTCORE" == "1" ]]; then
  log "Building agentcore image (ARM64): $AGENTCORE_REPO:$IMAGE_TAG"
  cd "$PROJECT_ROOT/agentcore"

  DOCKER_BUILDKIT=0 docker build \
    --platform linux/arm64 \
    -t "$ECR_REGISTRY/$AGENTCORE_REPO:$IMAGE_TAG" \
    -t "$ECR_REGISTRY/$AGENTCORE_REPO:latest" \
    -f Dockerfile .

  if [[ "$PUSH" == "1" ]]; then
    log "Pushing agentcore image..."
    docker push "$ECR_REGISTRY/$AGENTCORE_REPO:$IMAGE_TAG"
    docker push "$ECR_REGISTRY/$AGENTCORE_REPO:latest"
    log "AgentCore image pushed: $ECR_REGISTRY/$AGENTCORE_REPO:$IMAGE_TAG"
  fi
fi

###############################################################################
# Summary
###############################################################################
log "========================================"
log "Build complete"
log "  Environment: $ENV"
log "  Tag:         $IMAGE_TAG"
log "  Frontend:    $([ "$BUILD_FRONTEND" == "1" ] && echo "BUILT" || echo "SKIPPED")"
log "  Backend:     $([ "$BUILD_BACKEND" == "1" ] && echo "$BACKEND_REPO:$IMAGE_TAG" || echo "SKIPPED")"
log "  AgentCore:   $([ "$BUILD_AGENTCORE" == "1" ] && echo "$AGENTCORE_REPO:$IMAGE_TAG" || echo "SKIPPED")"
log "  Pushed:      $([ "$PUSH" == "1" ] && echo "YES" || echo "NO")"
log "========================================"
