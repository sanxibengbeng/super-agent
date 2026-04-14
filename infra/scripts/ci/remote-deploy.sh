#!/bin/bash
set -euo pipefail
# Backend deploy script — runs on EC2 via CI/CD pipeline.
# Expects /opt/super-agent/.env and /opt/super-agent/backend/ to be ready.

cd /opt/super-agent/backend
ln -sf /opt/super-agent/.env .env

echo "npm ci..."
npm ci --production=false

echo "prisma generate..."
npx prisma generate

echo "DB grants..."
# Ensure psql is available
if ! command -v psql &>/dev/null; then
  echo "psql not found, installing postgresql-client..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq postgresql-client || true
fi
# Extract DATABASE_URL safely (avoid sourcing .env which can fail with special chars)
DATABASE_URL=$(grep '^DATABASE_URL=' /opt/super-agent/.env | head -1 | cut -d= -f2-)
if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL not found in /opt/super-agent/.env"
  exit 1
fi
PSQL_URL=$(echo "$DATABASE_URL" | sed 's/?.*//')
PSQL_URL="${PSQL_URL}?sslmode=require"
psql "$PSQL_URL" -c "GRANT ALL PRIVILEGES ON DATABASE super_agent TO superagent;"
psql "$PSQL_URL" -c "GRANT ALL ON SCHEMA public TO superagent;"
psql "$PSQL_URL" -c "ALTER SCHEMA public OWNER TO superagent;"
psql "$PSQL_URL" -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO superagent;"
psql "$PSQL_URL" -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO superagent;"
psql "$PSQL_URL" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO superagent;"
psql "$PSQL_URL" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO superagent;"

echo "prisma migrate deploy..."
npx prisma migrate deploy

echo "Seeding..."
AGENT_COUNT=$(psql "$PSQL_URL" -t -A -c "SELECT count(*) FROM agents;" 2>/dev/null || echo "0")
if [ "$AGENT_COUNT" -gt "0" ] 2>/dev/null; then
  echo "(Seed skipped: $AGENT_COUNT agents exist)"
else
  npx tsx prisma/seed.ts 2>/dev/null || echo "(Seed failed or already seeded)"
fi

echo "Restarting backend..."
sudo systemctl restart backend
sudo systemctl enable backend
sleep 3
sudo systemctl status backend --no-pager || true
