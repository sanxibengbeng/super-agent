#!/bin/bash
set -euo pipefail

# =============================================================================
# Super Agent Platform - EC2 Bootstrap Script (Ubuntu 22.04 ARM64)
# Installs: Node.js 22, PostgreSQL client, Redis 7, Nginx, Certbot, Claude Code CLI
# Database: RDS PostgreSQL (managed, not installed locally)
# =============================================================================

export DEBIAN_FRONTEND=noninteractive

echo ">>> Updating system packages..."
apt-get update -y
apt-get upgrade -y

# =============================================================================
# Node.js 22 (via NodeSource)
# =============================================================================
echo ">>> Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g npm@latest

# =============================================================================
# PostgreSQL client only (for psql CLI — DB is Aurora)
# =============================================================================
echo ">>> Installing PostgreSQL client..."
sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
apt-get update -y
apt-get install -y postgresql-client-16

# =============================================================================
# AWS CLI (for fetching secrets)
# =============================================================================
echo ">>> Installing AWS CLI..."
apt-get install -y unzip jq
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/aws /tmp/awscliv2.zip

# =============================================================================
# CloudWatch Agent (for streaming application logs)
# =============================================================================
echo ">>> Installing CloudWatch Agent..."
curl -fsSL "https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb" -o /tmp/amazon-cloudwatch-agent.deb
dpkg -i /tmp/amazon-cloudwatch-agent.deb
rm -f /tmp/amazon-cloudwatch-agent.deb

# CloudWatch Agent config
mkdir -p /opt/aws/amazon-cloudwatch-agent/etc
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CW_CONFIG'
{
  "agent": {
    "run_as_user": "root",
    "region": "us-west-2"
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/opt/super-agent/logs/backend.log",
            "log_group_name": "/super-agent/backend",
            "log_stream_name": "{instance_id}/backend",
            "retention_in_days": 30
          },
          {
            "file_path": "/opt/super-agent/logs/backend-error.log",
            "log_group_name": "/super-agent/backend-errors",
            "log_stream_name": "{instance_id}/backend-errors",
            "retention_in_days": 30
          },
          {
            "file_path": "/var/log/nginx/access.log",
            "log_group_name": "/super-agent/nginx-access",
            "log_stream_name": "{instance_id}/nginx-access",
            "retention_in_days": 14
          },
          {
            "file_path": "/var/log/nginx/error.log",
            "log_group_name": "/super-agent/nginx-errors",
            "log_stream_name": "{instance_id}/nginx-errors",
            "retention_in_days": 14
          }
        ]
      }
    }
  }
}
CW_CONFIG

# Start CloudWatch Agent
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s

systemctl enable amazon-cloudwatch-agent

# =============================================================================
# Redis 7 (from official Redis repo for 7.x)
# =============================================================================
echo ">>> Installing Redis 7..."
curl -fsSL https://packages.redis.io/gpg | gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" > /etc/apt/sources.list.d/redis.list
apt-get update -y
apt-get install -y redis-server

# Configure Redis with password
sed -i 's/^# requirepass .*/requirepass super-agent-redis-password/' /etc/redis/redis.conf
sed -i 's/^requirepass .*/requirepass super-agent-redis-password/' /etc/redis/redis.conf
systemctl restart redis-server
systemctl enable redis-server

# =============================================================================
# Nginx (reverse proxy)
# =============================================================================
echo ">>> Installing Nginx..."
apt-get install -y nginx certbot python3-certbot-nginx

# Generate self-signed SSL cert (for HTTPS with IP — replace with real cert later)
mkdir -p /etc/nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/selfsigned.key \
  -out /etc/nginx/ssl/selfsigned.crt \
  -subj "/CN=super-agent"

# =============================================================================
# Claude Code CLI (for Claude Agent SDK)
# =============================================================================
echo ">>> Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code || true

# =============================================================================
# Application directory
# =============================================================================
echo ">>> Setting up application directory..."
mkdir -p /opt/super-agent
mkdir -p /opt/super-agent/workspaces
mkdir -p /opt/super-agent/logs
chown -R ubuntu:ubuntu /opt/super-agent

# =============================================================================
# Nginx configuration
# =============================================================================
cat > /etc/nginx/sites-available/super-agent << 'NGINX_CONF'
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

    # Frontend static files
    root /opt/super-agent/super-agent-platform/dist;
    index index.html;

    # API proxy
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

    # WebSocket proxy
    location /ws/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX_CONF

ln -sf /etc/nginx/sites-available/super-agent /etc/nginx/sites-enabled/super-agent
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
systemctl enable nginx

# =============================================================================
# Systemd service for the backend
# =============================================================================
cat > /etc/systemd/system/super-agent-backend.service << 'SERVICE'
[Unit]
Description=Super Agent Backend
After=network.target redis-server.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/super-agent/super-agent-backend
EnvironmentFile=/opt/super-agent/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
StandardOutput=append:/opt/super-agent/logs/backend.log
StandardError=append:/opt/super-agent/logs/backend-error.log

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload

# =============================================================================
# Helper script: fetch RDS credentials from Secrets Manager and build DATABASE_URL
# =============================================================================
cat > /opt/super-agent/fetch-db-url.sh << 'FETCHSCRIPT'
#!/bin/bash
# Fetches RDS credentials from Secrets Manager and prints the DATABASE_URL.
# Output includes ?sslmode=no-verify for the pg Node.js driver (RDS requires SSL).
# Usage: ./fetch-db-url.sh <SECRET_ARN>

SECRET_ARN="${1:?Usage: fetch-db-url.sh <SECRET_ARN>}"
REGION="${AWS_REGION:-us-west-2}"

SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ARN" \
  --region "$REGION" \
  --query SecretString \
  --output text)

DB_USER=$(echo "$SECRET_JSON" | jq -r '.username')
DB_PASS=$(echo "$SECRET_JSON" | jq -r '.password')
DB_HOST=$(echo "$SECRET_JSON" | jq -r '.host')
DB_PORT=$(echo "$SECRET_JSON" | jq -r '.port')
DB_NAME=$(echo "$SECRET_JSON" | jq -r '.dbname // "super_agent"')

# URL-encode the password (handles special chars)
ENCODED_PASS=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$DB_PASS', safe=''))")

echo "postgresql://${DB_USER}:${ENCODED_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=no-verify"
FETCHSCRIPT

chmod +x /opt/super-agent/fetch-db-url.sh
chown ubuntu:ubuntu /opt/super-agent/fetch-db-url.sh

# =============================================================================
# Placeholder .env (to be filled after deployment)
# =============================================================================
cat > /opt/super-agent/.env << 'ENVFILE'
# Server
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info

# Database (RDS PostgreSQL — run fetch-db-url.sh to get this)
DATABASE_URL=CHANGE_ME

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=super-agent-redis-password

# Cognito (fill these in)
COGNITO_USER_POOL_ID=CHANGE_ME
COGNITO_CLIENT_ID=CHANGE_ME
COGNITO_REGION=us-west-2
COGNITO_DOMAIN=CHANGE_ME

# AWS (uses EC2 instance role — no keys needed)
AWS_REGION=us-west-2

# S3
S3_BUCKET_NAME=super-agent-avatars-CHANGE_ME
S3_AVATARS_BUCKET=super-agent-avatars-CHANGE_ME
S3_PRESIGNED_URL_EXPIRES=3600
ENABLE_AVATAR_GENERATION=true

# CORS (set to your domain after DNS setup)
CORS_ORIGIN=*

# Claude Agent SDK
CLAUDE_CODE_USE_BEDROCK=1
CLAUDE_MODEL=claude-haiku-4-5-20251001
AGENT_WORKSPACE_BASE_DIR=/opt/super-agent/workspaces

# Langfuse (optional)
# LANGFUSE_SECRET_KEY=
# LANGFUSE_PUBLIC_KEY=
# LANGFUSE_BASE_URL=
ENVFILE

chown ubuntu:ubuntu /opt/super-agent/.env
chmod 600 /opt/super-agent/.env

echo ">>> Bootstrap complete."
echo ">>> Next: SSH in, run ./fetch-db-url.sh <SECRET_ARN> to get DATABASE_URL, update .env, then run deploy."
