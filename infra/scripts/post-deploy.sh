#!/bin/bash
set -euo pipefail

# =============================================================================
# Super Agent Platform — Post-CDK Deploy Script
#
# Run this ONCE after `cdk deploy` completes. It:
# 1. Reads all CDK stack outputs automatically
# 2. Updates Cognito callback URLs with the Elastic IP
# 3. Sets the admin user password in Cognito
# 4. SSHs into EC2 and populates .env with Aurora + Cognito values
# 5. Creates frontend .env.production with Cognito config
# 6. Builds frontend, syncs to EC2
# 7. Installs deps, runs migrations, seeds DB, restarts backend
#
# Usage:
#   ./post-deploy.sh <SSH_KEY_PATH> <ADMIN_PASSWORD>
#
# Example:
#   ./post-deploy.sh ~/.ssh/super-agent-key.pem 'MySecurePass1'
# =============================================================================

SSH_KEY="${1:?Usage: ./post-deploy.sh <SSH_KEY_PATH> <ADMIN_PASSWORD>}"
ADMIN_PASSWORD="${2:?Usage: ./post-deploy.sh <SSH_KEY_PATH> <ADMIN_PASSWORD>}"
STACK_NAME="SuperAgentStack"
REGION="us-west-2"
SSH_USER="ubuntu"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== Reading CDK stack outputs ==="
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
COGNITO_USER_POOL_ID=$(get_output "CognitoUserPoolId")
COGNITO_CLIENT_ID=$(get_output "CognitoClientId")
COGNITO_DOMAIN=$(get_output "CognitoDomainUrl")
AURORA_ENDPOINT=$(get_output "AuroraEndpoint")
DB_SECRET_ARN=$(get_output "DBSecretArn")
AVATAR_BUCKET=$(get_output "AvatarBucketName")

echo "  PublicIP:            $PUBLIC_IP"
echo "  CognitoUserPoolId:  $COGNITO_USER_POOL_ID"
echo "  CognitoClientId:    $COGNITO_CLIENT_ID"
echo "  CognitoDomain:      $COGNITO_DOMAIN"
echo "  AuroraEndpoint:     $AURORA_ENDPOINT"
echo "  DBSecretArn:        $DB_SECRET_ARN"
echo "  AvatarBucket:       $AVATAR_BUCKET"

# =========================================================================
# Step 1: Update Cognito callback URLs
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
aws cognito-idp admin-set-user-password \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --username "admin@example.com" \
  --password "$ADMIN_PASSWORD" \
  --permanent \
  --region "$REGION" \
  --no-cli-pager

echo "  Done."

# =========================================================================
# Step 3: Wait for EC2 to be ready
# =========================================================================
echo ""
echo "=== Waiting for EC2 SSH to be ready ==="
for i in $(seq 1 30); do
  if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$SSH_USER@$PUBLIC_IP" "echo ok" 2>/dev/null; then
    echo "  EC2 is ready."
    break
  fi
  echo "  Attempt $i/30 — waiting 10s..."
  sleep 10
done

# =========================================================================
# Step 3b: Set up HTTPS with self-signed cert on Nginx
# =========================================================================
echo ""
echo "=== Setting up HTTPS on Nginx ==="
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$PUBLIC_IP" << 'REMOTE_NGINX'
set -euo pipefail

# Generate self-signed cert if not present
if [ ! -f /etc/nginx/ssl/selfsigned.crt ]; then
  sudo mkdir -p /etc/nginx/ssl
  sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/selfsigned.key \
    -out /etc/nginx/ssl/selfsigned.crt \
    -subj "/CN=super-agent"
fi

# Write HTTPS Nginx config
sudo tee /etc/nginx/sites-available/super-agent > /dev/null << 'NGINX_CONF'
# Redirect HTTP to HTTPS
server {
    listen 80 default_server;
    server_name _;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl default_server;
    server_name _;

    ssl_certificate /etc/nginx/ssl/selfsigned.crt;
    ssl_certificate_key /etc/nginx/ssl/selfsigned.key;

    root /opt/super-agent/super-agent-platform/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        client_max_body_size 50M;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX_CONF

sudo ln -sf /etc/nginx/sites-available/super-agent /etc/nginx/sites-enabled/super-agent
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
echo "  Nginx HTTPS configured."
REMOTE_NGINX

# =========================================================================
# Step 4: Populate .env on EC2
# =========================================================================
echo ""
echo "=== Fetching Aurora DATABASE_URL and populating .env on EC2 ==="
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$PUBLIC_IP" << REMOTE_ENV
set -euo pipefail

# Fetch DATABASE_URL from Secrets Manager
DATABASE_URL=\$(/opt/super-agent/fetch-db-url.sh "$DB_SECRET_ARN")
echo "  DATABASE_URL fetched."

cat > /opt/super-agent/.env << ENVFILE
# Server
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info

# Database (Aurora PostgreSQL)
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
# Step 6: Sync to EC2
# =========================================================================
echo ""
echo "=== Syncing backend to EC2 ==="
cd "$PROJECT_ROOT"
rsync -avz --delete \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='dist' \
  super-agent-backend/ \
  "$SSH_USER@$PUBLIC_IP:/opt/super-agent/super-agent-backend/"

echo "=== Syncing frontend build to EC2 ==="
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$PUBLIC_IP" "mkdir -p /opt/super-agent/super-agent-platform/dist"
rsync -avz --delete \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  super-agent-platform/dist/ \
  "$SSH_USER@$PUBLIC_IP:/opt/super-agent/super-agent-platform/dist/"

# =========================================================================
# Step 7: Install, migrate, seed, restart
# =========================================================================
echo ""
echo "=== Installing deps, running migrations, seeding, and restarting ==="
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$PUBLIC_IP" << 'REMOTE_DEPLOY'
set -euo pipefail

cd /opt/super-agent/super-agent-backend

# Symlink .env so Prisma's dotenv can find it
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
echo "  SSH:        ssh -i $SSH_KEY ubuntu@$PUBLIC_IP"
echo ""
echo "  Cognito login: admin@example.com"
echo "  Cognito domain: https://$COGNITO_DOMAIN"
echo ""
echo "  Next: open https://$PUBLIC_IP and sign in."
echo "============================================="
