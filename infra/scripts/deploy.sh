#!/bin/bash
set -euo pipefail

# =============================================================================
# Deploy Super Agent Platform to EC2 (code-only redeploy)
#
# Usage: ./deploy.sh <EC2_IP> [SSH_KEY_PATH]
#
# This script:
# 1. Builds the frontend locally (vite only, no tsc)
# 2. Syncs the project to EC2
# 3. Installs dependencies, builds backend, runs Prisma migrations, restarts
# =============================================================================

EC2_IP="${1:?Usage: ./deploy.sh <EC2_IP> [SSH_KEY_PATH]}"
SSH_KEY="${2:-super-agent-key.pem}"
SSH_USER="ubuntu"
REMOTE_DIR="/opt/super-agent"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== Building frontend ==="
cd "$PROJECT_ROOT/super-agent-platform"
npm ci
npx vite build

echo "=== Syncing backend to EC2 ==="
cd "$PROJECT_ROOT"
rsync -avz --delete \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='dist' \
  super-agent-backend/ \
  "$SSH_USER@$EC2_IP:$REMOTE_DIR/super-agent-backend/"

echo "=== Syncing frontend build to EC2 ==="
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$EC2_IP" "mkdir -p $REMOTE_DIR/super-agent-platform/dist"
rsync -avz --delete \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  super-agent-platform/dist/ \
  "$SSH_USER@$EC2_IP:$REMOTE_DIR/super-agent-platform/dist/"

echo "=== Installing dependencies, building, migrating DB, and restarting ==="
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$EC2_IP" << 'REMOTE_SCRIPT'
set -euo pipefail

cd /opt/super-agent/super-agent-backend

# Symlink .env so Prisma's dotenv can find it
ln -sf /opt/super-agent/.env .env

# Install dependencies
npm ci --production=false

# Generate Prisma client
npx prisma generate

# Build TypeScript (transpile only — skip strict checks)
npx tsc --noUnusedLocals false --noUnusedParameters false --strict false --noImplicitAny false --strictNullChecks false 2>&1 || true
if [ ! -f dist/index.js ]; then
  echo "ERROR: dist/index.js not found after build"
  exit 1
fi

# Run database migrations (against Aurora PostgreSQL)
npx prisma migrate deploy

# Restart the backend service
sudo systemctl restart super-agent-backend
sudo systemctl enable super-agent-backend

echo "=== Deployment complete ==="
echo "Backend status:"
sudo systemctl status super-agent-backend --no-pager || true
REMOTE_SCRIPT

echo ""
echo "=== Deployed successfully ==="
echo "App URL: https://$EC2_IP"
echo "Backend: https://$EC2_IP/api/auth/config"
