#!/bin/bash
set -euo pipefail

# =============================================================================
# Deploy Super Agent Platform to EC2 (code-only redeploy via SSM tunnel)
#
# Usage: ./deploy.sh <SSH_KEY_PATH> [STACK_NAME] [REGION]
#
# This script:
# 1. Reads instance ID from stack outputs
# 2. Opens an SSM port-forward tunnel (localhost:2222 -> EC2:22)
# 3. Builds the frontend locally
# 4. Syncs the project to EC2 via the tunnel
# 5. Installs dependencies, builds backend, runs Prisma migrations, restarts
#
# Prerequisites:
#   - AWS CLI v2 with Session Manager plugin installed
# =============================================================================

SSH_KEY="${1:?Usage: ./deploy.sh <SSH_KEY_PATH> [STACK_NAME] [REGION]}"
STACK_NAME="${2:-SuperAgentV2Stack}"
REGION="${3:-us-west-2}"
SSH_USER="ubuntu"
LOCAL_SSH_PORT=2222
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== Reading stack outputs ==="
OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs" \
  --output json)

get_output() {
  echo "$OUTPUTS" | python3 -c "
import sys, json
outputs = json.load(sys.stdin)
for o in outputs:
    if o['OutputKey'] == '$1':
        print(o['OutputValue'])
        break
"
}

INSTANCE_ID=$(get_output "InstanceId")
PUBLIC_IP=$(get_output "PublicIP")
echo "  InstanceId: $INSTANCE_ID"
echo "  PublicIP:   $PUBLIC_IP"

SSH_VIA_SSM="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $LOCAL_SSH_PORT $SSH_USER@localhost"
RSYNC_SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $LOCAL_SSH_PORT"

# =========================================================================
# Start SSM tunnel
# =========================================================================
echo "=== Starting SSM port-forward tunnel ==="
lsof -ti:$LOCAL_SSH_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true

aws ssm start-session \
  --target "$INSTANCE_ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "portNumber=22,localPortNumber=$LOCAL_SSH_PORT" \
  --region "$REGION" &
SSM_PID=$!

cleanup() {
  echo "=== Cleaning up SSM tunnel ==="
  kill $SSM_PID 2>/dev/null || true
  wait $SSM_PID 2>/dev/null || true
}
trap cleanup EXIT

echo "  Waiting for tunnel..."
sleep 5
for i in $(seq 1 10); do
  if $SSH_VIA_SSM "echo ok" 2>/dev/null; then
    echo "  Tunnel ready."
    break
  fi
  [ "$i" -eq 10 ] && { echo "ERROR: tunnel failed"; exit 1; }
  sleep 3
done

# =========================================================================
# Build frontend
# =========================================================================
echo "=== Building frontend ==="
cd "$PROJECT_ROOT/super-agent-platform"
npm ci
npx vite build

# =========================================================================
# Sync via SSM tunnel
# =========================================================================
echo "=== Syncing backend to EC2 ==="
cd "$PROJECT_ROOT"
rsync -avz --delete \
  -e "$RSYNC_SSH" \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='dist' \
  super-agent-backend/ \
  "$SSH_USER@localhost:/opt/super-agent/super-agent-backend/"

echo "=== Syncing frontend build to EC2 ==="
$SSH_VIA_SSM "mkdir -p /opt/super-agent/super-agent-platform/dist"
rsync -avz --delete \
  -e "$RSYNC_SSH" \
  super-agent-platform/dist/ \
  "$SSH_USER@localhost:/opt/super-agent/super-agent-platform/dist/"

# =========================================================================
# Install, build, migrate, restart
# =========================================================================
echo "=== Installing dependencies, building, migrating DB, and restarting ==="
$SSH_VIA_SSM << 'REMOTE_SCRIPT'
set -euo pipefail

cd /opt/super-agent/super-agent-backend
ln -sf /opt/super-agent/.env .env

npm ci --production=false
npx prisma generate
npx tsc --noUnusedLocals false --noUnusedParameters false --strict false --noImplicitAny false --strictNullChecks false 2>&1 || true
if [ ! -f dist/index.js ]; then
  echo "ERROR: dist/index.js not found after build"
  exit 1
fi

npx prisma migrate deploy

sudo systemctl restart super-agent-backend
sudo systemctl enable super-agent-backend

echo "=== Deployment complete ==="
sudo systemctl status super-agent-backend --no-pager || true
REMOTE_SCRIPT

echo ""
echo "=== Deployed successfully ==="
echo "App URL: https://$PUBLIC_IP"
echo "Health:  https://$PUBLIC_IP/api/health"
echo "SSM:     aws ssm start-session --target $INSTANCE_ID --region $REGION"
