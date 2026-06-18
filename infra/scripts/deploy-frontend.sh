#!/bin/bash
# Build frontend and deploy to S3 + invalidate CloudFront

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

banner "Frontend Deploy"

PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Read stack outputs
FRONTEND_BUCKET=$(get_stack_output "FrontendBucketName")
CF_DOMAIN=$(get_stack_output "CloudFrontDomain")

if [[ -z "$FRONTEND_BUCKET" ]]; then
  err "FrontendBucketName not found in stack outputs. Run deploy-infra.sh first."
  exit 1
fi

log "Frontend bucket: $FRONTEND_BUCKET"
log "CloudFront domain: ${CF_DOMAIN:-<none>}"

if [[ "$DRY_RUN" == "true" ]]; then
  info "[DRY RUN] Would build frontend and sync to s3://${FRONTEND_BUCKET}/"
  exit 0
fi

# Step 1: Build
cd "$PROJECT_ROOT/frontend"

cat > .env.production << 'EOF'
VITE_API_BASE_URL=
VITE_AUTH_MODE=local
EOF

log "Installing dependencies..."
npm ci --prefer-offline

log "Building frontend..."
npx vite build

# Step 2: S3 sync
log "Syncing to S3: ${FRONTEND_BUCKET}"

# Static assets — long cache (immutable fingerprinted files)
aws s3 sync dist/ "s3://${FRONTEND_BUCKET}/" \
  --delete \
  --exclude "index.html" \
  --cache-control "public,max-age=31536000,immutable" \
  --region "$REGION"

# index.html — no cache (always fresh)
aws s3 cp dist/index.html "s3://${FRONTEND_BUCKET}/index.html" \
  --cache-control "no-cache,no-store,must-revalidate" \
  --region "$REGION"

# Step 3: CloudFront invalidation
if [[ -n "$CF_DOMAIN" ]]; then
  CF_DIST_ID=$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?DomainName=='${CF_DOMAIN}'].Id" \
    --output text 2>/dev/null || echo "")

  if [[ -n "$CF_DIST_ID" ]]; then
    log "Invalidating CloudFront distribution: $CF_DIST_ID"
    aws cloudfront create-invalidation \
      --distribution-id "$CF_DIST_ID" \
      --paths "/index.html" \
      --no-cli-pager > /dev/null
  fi
fi

log "Frontend deploy complete."
