#!/bin/bash
set -euo pipefail

# =============================================================================
# Super Agent Platform V2 - Post-CDK Deploy Script
#
# Fully dynamic - reads all values from CloudFormation stack outputs.
# Uses SSM port-forwarding for SSH/rsync (port 22 is not open from internet).
#
# Prerequisites:
#   - AWS CLI v2 with Session Manager plugin installed
#     https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html
#   - SSH key for the EC2 instance (used over the SSM tunnel)
#
# Usage:
#   ./post-deploy-v2.sh <SSH_KEY_PATH> <ADMIN_PASSWORD> [STACK_NAME] [REGION]
#
# Example:
#   ./post-deploy-v2.sh ~/Downloads/my-key.pem 'MySecurePass1'
#   ./post-deploy-v2.sh ~/Downloads/my-key.pem 'MySecurePass1' SuperAgentV2Stack us-west-2
# =============================================================================

SSH_KEY="${1:?Usage: ./post-deploy-v2.sh <SSH_KEY_PATH> <ADMIN_PASSWORD> [STACK_NAME] [REGION]}"
ADMIN_PASSWORD="${2:?Usage: ./post-deploy-v2.sh <SSH_KEY_PATH> <ADMIN_PASSWORD> [STACK_NAME] [REGION]}"
STACK_NAME="${3:-SuperAgentV2Stack}"
REGION="${4:-us-west-2}"
SSH_USER="ubuntu"
LOCAL_SSH_PORT=2222
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# =========================================================================
# Read all values from stack outputs (no hardcoded account-specific values)
# =========================================================================
echo "=== Reading stack outputs from $STACK_NAME ==="
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

PUBLIC_IP=$(get_output "PublicIP")
INSTANCE_ID=$(get_output "InstanceId")
COGNITO_USER_POOL_ID=$(get_output "CognitoUserPoolId")
COGNITO_CLIENT_ID=$(get_output "CognitoClientId")
COGNITO_DOMAIN=$(get_output "CognitoDomainUrl")
DB_ENDPOINT=$(get_output "DBEndpoint")
DB_SECRET_ARN=$(get_output "DBSecretArn")
AVATAR_BUCKET=$(get_output "AvatarBucketName")

echo "  PublicIP:           $PUBLIC_IP"
echo "  InstanceId:         $INSTANCE_ID"
echo "  CognitoUserPoolId:  $COGNITO_USER_POOL_ID"
echo "  CognitoClientId:    $COGNITO_CLIENT_ID"
echo "  CognitoDomain:      $COGNITO_DOMAIN"
echo "  DBEndpoint:         $DB_ENDPOINT"
echo "  DBSecretArn:        $DB_SECRET_ARN"
echo "  AvatarBucket:       $AVATAR_BUCKET"

# =========================================================================
# Helper: SSH/rsync commands that go through the SSM tunnel
# =========================================================================
SSH_VIA_SSM="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $LOCAL_SSH_PORT $SSH_USER@localhost"
RSYNC_SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $LOCAL_SSH_PORT"

# =========================================================================
# Step 1: Update Cognito callback URLs with the real IP
# =========================================================================
echo ""
echo "=== Updating Cognito callback URLs ==="
aws cognito-idp update-user-pool-client \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --client-id "$COGNITO_CLIENT_ID" \
  --callback-urls "https://${PUBLIC_IP}/auth/callback" "http://localhost:5173/auth/callback" \
  --logout-urls "https://${PUBLIC_IP}/login" "http://localhost:5173/login" \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client \
  --supported-identity-providers COGNITO \
  --region "$REGION" \
  --no-cli-pager
echo "  Done."

# =========================================================================
# Step 2: Set admin password
# =========================================================================
echo ""
echo "=== Setting admin password in Cognito ==="
ADMIN_EMAIL=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Parameters[?ParameterKey=='AdminEmail'].ParameterValue" \
  --output text 2>/dev/null || echo "admin@example.com")

aws cognito-idp admin-set-user-password \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --password "$ADMIN_PASSWORD" \
  --permanent \
  --region "$REGION" \
  --no-cli-pager
echo "  Done. Login: $ADMIN_EMAIL"

# =========================================================================
# Step 3: Start SSM port-forwarding tunnel (background)
# =========================================================================
echo ""
echo "=== Starting SSM port-forward tunnel (localhost:$LOCAL_SSH_PORT -> EC2:22) ==="

# Wait for SSM agent to be ready
for i in $(seq 1 30); do
  STATUS=$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --region "$REGION" \
    --query "InstanceInformationList[0].PingStatus" \
    --output text 2>/dev/null || echo "None")
  if [ "$STATUS" = "Online" ]; then
    echo "  SSM agent is online."
    break
  fi
  echo "  Attempt $i/30 - SSM agent status: $STATUS, waiting 10s..."
  sleep 10
done

# Kill any existing tunnel on this port
lsof -ti:$LOCAL_SSH_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true

aws ssm start-session \
  --target "$INSTANCE_ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "portNumber=22,localPortNumber=$LOCAL_SSH_PORT" \
  --region "$REGION" &
SSM_PID=$!

echo "  Waiting for tunnel to establish..."
sleep 5

for i in $(seq 1 10); do
  if $SSH_VIA_SSM "echo ok" 2>/dev/null; then
    echo "  SSM tunnel is ready."
    break
  fi
  if [ "$i" -eq 10 ]; then
    echo "  ERROR: Could not establish SSM tunnel after 10 attempts."
    kill $SSM_PID 2>/dev/null || true
    exit 1
  fi
  echo "  Attempt $i/10 - waiting 3s..."
  sleep 3
done

# Ensure we clean up the tunnel on exit
cleanup() {
  echo ""
  echo "=== Cleaning up SSM tunnel (PID $SSM_PID) ==="
  kill $SSM_PID 2>/dev/null || true
  wait $SSM_PID 2>/dev/null || true
}
trap cleanup EXIT

# =========================================================================
# Step 4: Populate .env on EC2
# =========================================================================
echo ""
echo "=== Fetching DATABASE_URL and populating .env on EC2 ==="
$SSH_VIA_SSM << REMOTE_ENV
set -euo pipefail

# fetch-db-url.sh outputs the full URL with ?sslmode=no-verify already included
DATABASE_URL=\$(/opt/super-agent/fetch-db-url.sh "$DB_SECRET_ARN")
echo "  DATABASE_URL fetched."

cat > /opt/super-agent/.env << ENVFILE
# Server
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info

# Database (RDS PostgreSQL)
DATABASE_URL=\${DATABASE_URL}

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=super-agent-redis-password

# Cognito
COGNITO_USER_POOL_ID=${COGNITO_USER_POOL_ID}
COGNITO_CLIENT_ID=${COGNITO_CLIENT_ID}
COGNITO_REGION=${REGION}
COGNITO_DOMAIN=${COGNITO_DOMAIN}

# AWS (uses EC2 instance role)
AWS_REGION=${REGION}

# S3
S3_BUCKET_NAME=${AVATAR_BUCKET}
S3_AVATARS_BUCKET=${AVATAR_BUCKET}
S3_PRESIGNED_URL_EXPIRES=3600
ENABLE_AVATAR_GENERATION=true

# CORS
CORS_ORIGIN=https://${PUBLIC_IP}

# Claude Agent SDK
CLAUDE_CODE_USE_BEDROCK=1
CLAUDE_MODEL=claude-haiku-4-5-20251001
AGENT_WORKSPACE_BASE_DIR=/opt/super-agent/workspaces
ENVFILE

chmod 600 /opt/super-agent/.env
echo "  .env written."
REMOTE_ENV

# =========================================================================
# Step 5: Build frontend with production Cognito config
# =========================================================================
echo ""
echo "=== Building frontend ==="
cd "$PROJECT_ROOT/super-agent-platform"

cat > .env.production << EOF
VITE_API_BASE_URL=
VITE_COGNITO_REGION=${REGION}
VITE_COGNITO_USER_POOL_ID=${COGNITO_USER_POOL_ID}
VITE_COGNITO_CLIENT_ID=${COGNITO_CLIENT_ID}
VITE_COGNITO_DOMAIN=${COGNITO_DOMAIN}
VITE_COGNITO_REDIRECT_URI=https://${PUBLIC_IP}/auth/callback
EOF

npm ci
npx vite build

# =========================================================================
# Step 6: Sync to EC2 (via SSM tunnel)
# =========================================================================
echo ""
echo "=== Syncing backend to EC2 (via SSM tunnel) ==="
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
# Step 7: Install, migrate, seed, restart
# =========================================================================
echo ""
echo "=== Installing deps, running migrations, seeding, and restarting ==="
$SSH_VIA_SSM << 'REMOTE_DEPLOY'
set -euo pipefail

cd /opt/super-agent/super-agent-backend
ln -sf /opt/super-agent/.env .env

echo "  Installing dependencies..."
npm ci --production=false

echo "  Generating Prisma client..."
npx prisma generate

echo "  Building TypeScript (transpile only)..."
npx tsc --noUnusedLocals false --noUnusedParameters false --strict false --noImplicitAny false --strictNullChecks false 2>&1 || true
if [ ! -f dist/index.js ]; then
  echo "  ERROR: dist/index.js not found after build"
  exit 1
fi

echo "  Running database grants..."
source /opt/super-agent/.env

# psql understands sslmode=require but not no-verify; swap for psql usage
PSQL_URL=$(echo "$DATABASE_URL" | sed 's/sslmode=no-verify/sslmode=require/')

# PostgreSQL 16 revoked default CREATE on public schema.
psql "$PSQL_URL" << 'GRANTS_SQL'
GRANT ALL PRIVILEGES ON DATABASE super_agent TO superagent;
GRANT ALL ON SCHEMA public TO superagent;
ALTER SCHEMA public OWNER TO superagent;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO superagent;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO superagent;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO superagent;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO superagent;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO superagent;
GRANTS_SQL
echo "  Database grants applied."

echo "  Running database migrations..."
npx prisma migrate deploy

echo "  Seeding database..."
npx tsx prisma/seed.ts || echo "  (Seed skipped or already seeded)"

echo "  Restarting backend service..."
sudo systemctl restart super-agent-backend
sudo systemctl enable super-agent-backend

echo "  Checking backend status..."
sleep 3
sudo systemctl status super-agent-backend --no-pager || true
REMOTE_DEPLOY

# =========================================================================
# Done
# =========================================================================
echo ""
echo "============================================="
echo "  Deployment complete!"
echo "============================================="
echo ""
echo "  App URL:    https://$PUBLIC_IP"
echo "  Health:     https://$PUBLIC_IP/api/health"
echo "  SSM:        aws ssm start-session --target $INSTANCE_ID --region $REGION"
echo ""
echo "  Cognito login: $ADMIN_EMAIL"
echo "  Cognito domain: https://$COGNITO_DOMAIN"
echo ""
echo "  NOTE: SSH is NOT open from the internet."
echo "  Use SSM Session Manager for shell access."
echo "============================================="
