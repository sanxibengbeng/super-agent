#!/usr/bin/env bash
set -euo pipefail

# AgentCore Docker image build & push script
#
# DOCKER_BUILDKIT=0 is required: BuildKit adds attestation manifests
# (unknown/unknown arch entries) that cause AgentCore microVM startup
# failures. Disabling BuildKit produces a clean single-arch manifest.
#
# This host is ARM (aarch64) — images are built natively for linux/arm64
# which is what AgentCore requires. Never cross-compile to amd64.

AWS_ACCOUNT_ID="873543029686"
AWS_REGION="us-east-1"
ECR_REPO="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/superagenteks-agentcore"
IMAGE_TAG="${1:-latest}"
IMAGE_URI="${ECR_REPO}:${IMAGE_TAG}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> ECR login"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin \
    "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "==> Building ${IMAGE_URI} (arm64, BuildKit disabled)"
DOCKER_BUILDKIT=0 docker build \
  --platform linux/arm64 \
  -t "$IMAGE_URI" \
  .

echo "==> Pushing ${IMAGE_URI}"
docker push "$IMAGE_URI"

# Also tag as latest if a custom tag was provided
if [[ "$IMAGE_TAG" != "latest" ]]; then
  echo "==> Tagging ${IMAGE_TAG} as latest"
  docker tag "$IMAGE_URI" "${ECR_REPO}:latest"
  docker push "${ECR_REPO}:latest"
fi

echo "==> Done. Image pushed: ${IMAGE_URI}"
echo ""
echo "To force AgentCore runtimes to pick up the new image, update them:"
echo "  Dev:  aws bedrock-agent-runtime update-agent-runtime --agent-runtime-arn arn:aws:bedrock-agentcore:us-east-1:${AWS_ACCOUNT_ID}:runtime/SuperAgent_Dev_Runtime-3jV461BYtB"
echo "  Prod: aws bedrock-agent-runtime update-agent-runtime --agent-runtime-arn arn:aws:bedrock-agentcore:us-east-1:${AWS_ACCOUNT_ID}:runtime/SuperAgentEks_Runtime-3xzeklD05D"
