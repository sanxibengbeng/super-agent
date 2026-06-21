# CI/CD Pipeline Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic deploy script with a three-layer architecture: CDK-managed AgentCore image builder (CodeBuild + Custom Resource), AGENT_RUNTIME env var in ECS, and independent deployment scripts.

**Architecture:** CDK Custom Resource triggers CodeBuild on agentcore source change (S3 Asset hash detection). ECS services receive `AGENT_RUNTIME` env var to switch between Claude SDK and AgentCore runtime. Five independent bash scripts replace the single `deploy-ecs.sh`.

**Tech Stack:** AWS CDK v2, CodeBuild (ARM_CONTAINER), Custom Resources (cr.Provider), S3 Assets, ECS Fargate, CloudFront, Bash

---

### Task 1: Create AgentCore Image Builder Construct

**Files:**
- Create: `infra/lib/constructs/agentcore-image-builder.ts`

- [ ] **Step 1: Create the construct file with CodeBuild project**

```typescript
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

export interface AgentCoreImageBuilderProps {
  agentcoreRepo: ecr.IRepository;
  sourceDirectory: string;
  region: string;
  account: string;
}

export class AgentCoreImageBuilderConstruct extends Construct {
  public readonly project: codebuild.Project;
  public readonly buildTrigger: cdk.CustomResource;

  constructor(scope: Construct, id: string, props: AgentCoreImageBuilderProps) {
    super(scope, id);

    const ecrUri = `${props.account}.dkr.ecr.${props.region}.amazonaws.com/${props.agentcoreRepo.repositoryName}`;

    // Package agentcore source as S3 Asset (hash-based change detection)
    const sourceAsset = new s3_assets.Asset(this, 'Source', {
      path: path.resolve(props.sourceDirectory),
      exclude: ['node_modules', 'dist', '.git', '*.log'],
    });

    // CodeBuild project — ARM64 native, privileged for Docker
    this.project = new codebuild.Project(this, 'Project', {
      projectName: 'super-agent-agentcore-builder',
      description: 'Builds AgentCore ARM64 container image and pushes to ECR',
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.LARGE,
        privileged: true,
      },
      timeout: cdk.Duration.minutes(15),
      source: codebuild.Source.s3({
        bucket: sourceAsset.bucket,
        path: sourceAsset.s3ObjectKey,
      }),
      environmentVariables: {
        ECR_URI: { value: ecrUri },
        AWS_ACCOUNT_ID: { value: props.account },
        AWS_DEFAULT_REGION: { value: props.region },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo "Logging into ECR..."',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
            ],
          },
          build: {
            commands: [
              'echo "Building AgentCore image (ARM64, BuildKit disabled)..."',
              'DOCKER_BUILDKIT=0 docker build --platform linux/arm64 -t $ECR_URI:latest -t $ECR_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION .',
            ],
          },
          post_build: {
            commands: [
              'echo "Pushing to ECR..."',
              'docker push $ECR_URI:latest',
              'docker push $ECR_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION',
              'echo "Build complete: $ECR_URI:latest"',
            ],
          },
        },
      }),
    });

    // Grant CodeBuild permission to push to ECR
    props.agentcoreRepo.grantPullPush(this.project);

    // Grant CodeBuild permission to read source from S3 Asset bucket
    sourceAsset.grantRead(this.project);

    // Custom Resource Lambda — starts CodeBuild and polls until complete
    const triggerFunction = new lambda.Function(this, 'TriggerFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(15),
      code: lambda.Code.fromInline(`
const { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand } = require('@aws-sdk/client-codebuild');

const client = new CodeBuildClient();

async function waitForBuild(buildId) {
  while (true) {
    const resp = await client.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const build = resp.builds[0];
    const status = build.buildStatus;
    if (status === 'SUCCEEDED') return;
    if (status === 'FAILED' || status === 'FAULT' || status === 'STOPPED' || status === 'TIMED_OUT') {
      throw new Error('CodeBuild failed: ' + status + ' — ' + (build.phases?.find(p => p.phaseStatus === 'FAILED')?.contexts?.[0]?.message || 'unknown'));
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event));
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId || 'deleted' };
  }
  const projectName = event.ResourceProperties.ProjectName;
  const sourceHash = event.ResourceProperties.SourceHash;
  console.log('Starting build for project:', projectName, 'hash:', sourceHash);
  const startResp = await client.send(new StartBuildCommand({ projectName }));
  const buildId = startResp.build.id;
  console.log('Build started:', buildId);
  await waitForBuild(buildId);
  console.log('Build succeeded:', buildId);
  return { PhysicalResourceId: buildId, Data: { BuildId: buildId } };
};
`),
    });

    // Grant Lambda permission to start and monitor CodeBuild
    triggerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
        resources: [this.project.projectArn],
      })
    );

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: triggerFunction,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Custom Resource — sourceHash in properties ensures re-trigger on source change
    this.buildTrigger = new cdk.CustomResource(this, 'BuildTrigger', {
      serviceToken: provider.serviceToken,
      properties: {
        ProjectName: this.project.projectName,
        SourceHash: sourceAsset.assetHash,
      },
    });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run from `infra/`:
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add infra/lib/constructs/agentcore-image-builder.ts
git commit -m "feat(infra): add AgentCore image builder construct with CodeBuild + Custom Resource"
```

---

### Task 2: Wire Image Builder into Main Stack

**Files:**
- Modify: `infra/lib/super-agent-stack.ts:1-11` (imports)
- Modify: `infra/lib/super-agent-stack.ts:100-111` (AgentCore section)

- [ ] **Step 1: Add import for the new construct**

Add after line 10 (`import { CdnConstruct } from './constructs/cdn';`):

```typescript
import { AgentCoreImageBuilderConstruct } from './constructs/agentcore-image-builder';
```

- [ ] **Step 2: Wire ImageBuilder before AgentCore Runtime creation**

Replace lines 100–111 (the AgentCore section) with:

```typescript
    // =========================================================================
    // AgentCore Runtime + S3 Files (only in regions where S3 Files is available)
    // =========================================================================
    const enableAgentCore = props.enableAgentCore !== false;
    let agentCore: AgentCoreConstruct | undefined;
    if (enableAgentCore) {
      // Build AgentCore image via CodeBuild (auto-triggered on source change)
      const imageBuilder = new AgentCoreImageBuilderConstruct(this, 'AgentCoreBuilder', {
        agentcoreRepo,
        sourceDirectory: '../agentcore',
        region: this.region,
        account: this.account,
      });

      agentCore = new AgentCoreConstruct(this, 'AgentCore', {
        workspaceBucket,
        containerUri: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${agentcoreRepo.repositoryName}:latest`,
        region: this.region,
        account: this.account,
      });

      // Guarantee: image exists in ECR before Runtime creation
      agentCore.runtime.node.addDependency(imageBuilder.buildTrigger);
    }
```

- [ ] **Step 3: Verify TypeScript compiles and CDK synth succeeds**

Run from `infra/`:
```bash
npx tsc --noEmit && npx cdk synth --quiet
```
Expected: no errors, CloudFormation template generated

- [ ] **Step 4: Commit**

```bash
git add infra/lib/super-agent-stack.ts
git commit -m "feat(infra): wire AgentCore image builder into main stack with dependency chain"
```

---

### Task 3: Add AGENT_RUNTIME Environment Variable to ECS

**Files:**
- Modify: `infra/lib/constructs/ecs-cluster.ts:12-31` (props interface)
- Modify: `infra/lib/constructs/ecs-cluster.ts:94-111` (sharedEnvironment)

- [ ] **Step 1: Add `agentRuntime` prop to EcsClusterConstructProps**

Add after `otelEndpoint?: string;` (line 31 in the interface):

```typescript
  agentRuntime?: string;
```

- [ ] **Step 2: Add AGENT_RUNTIME to sharedEnvironment**

Add to the `sharedEnvironment` object (after `OTEL_METRICS_EXPORT_INTERVAL` line):

```typescript
      AGENT_RUNTIME: props.agentRuntime || 'claude',
```

- [ ] **Step 3: Pass agentRuntime from main stack**

In `infra/lib/super-agent-stack.ts`, modify the EcsClusterConstruct instantiation (around line 116) to add the new prop. Add after `otelEndpoint: props.otelEndpoint,`:

```typescript
      agentRuntime: enableAgentCore ? 'agentcore' : 'claude',
```

- [ ] **Step 4: Verify TypeScript compiles and CDK synth succeeds**

Run from `infra/`:
```bash
npx tsc --noEmit && npx cdk synth --quiet
```
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add infra/lib/constructs/ecs-cluster.ts infra/lib/super-agent-stack.ts
git commit -m "feat(infra): add AGENT_RUNTIME env var to ECS services (agentcore/claude switch)"
```

---

### Task 4: Create Shared Library Script

**Files:**
- Create: `infra/scripts/lib/common.sh`

- [ ] **Step 1: Create lib directory and common.sh**

```bash
#!/bin/bash
# Shared utilities for deployment scripts

set -euo pipefail

# ---- Colors ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ---- Defaults ----
ENV_NAME="${ENV_NAME:-prod}"
REGION="${REGION:-us-east-1}"
STACK_NAME="SuperAgent-${ENV_NAME}"
DRY_RUN="${DRY_RUN:-false}"

# ---- Logging ----
log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] WARN:${NC} $*"; }
err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ERROR:${NC} $*" >&2; }
info() { echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $*"; }

# ---- AWS helpers ----
detect_account() {
  aws sts get-caller-identity --query Account --output text 2>/dev/null || {
    err "Failed to detect AWS account. Check credentials."
    exit 1
  }
}

get_stack_output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text 2>/dev/null || echo ""
}

# ---- Health check ----
health_check() {
  local url="$1"
  local max_attempts="${2:-5}"
  local wait_seconds="${3:-10}"

  for i in $(seq 1 "$max_attempts"); do
    local code
    code=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
    if [[ "$code" == "200" ]]; then
      log "Health check PASSED: $url (HTTP 200)"
      return 0
    fi
    if [[ "$i" -lt "$max_attempts" ]]; then
      warn "Attempt $i/$max_attempts: HTTP $code — retrying in ${wait_seconds}s..."
      sleep "$wait_seconds"
    fi
  done
  err "Health check FAILED after $max_attempts attempts: $url"
  return 1
}

# ---- Option parsing helper ----
parse_common_opts() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env)     ENV_NAME="$2"; STACK_NAME="SuperAgent-${ENV_NAME}"; shift 2 ;;
      --region)  REGION="$2"; shift 2 ;;
      --dry-run) DRY_RUN=true; shift ;;
      *)         return 0 ;;
    esac
  done
}

# ---- Banner ----
banner() {
  local script_name="$1"
  local account
  account=$(detect_account)
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Super Agent — ${script_name}${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════${NC}"
  echo "  Environment:  $ENV_NAME"
  echo "  Stack:        $STACK_NAME"
  echo "  Region:       $REGION"
  echo "  Account:      $account"
  echo -e "${CYAN}═══════════════════════════════════════════${NC}"
  echo ""
}
```

- [ ] **Step 2: Commit**

```bash
mkdir -p infra/scripts/lib
git add infra/scripts/lib/common.sh
git commit -m "feat(infra): add shared deployment script library (common.sh)"
```

---

### Task 5: Create deploy-infra.sh

**Files:**
- Create: `infra/scripts/deploy-infra.sh`

- [ ] **Step 1: Create deploy-infra.sh**

```bash
#!/bin/bash
# Deploy infrastructure via CDK (with mandatory diff + confirmation)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# Parse options (common first, then script-specific)
EXTRA_CONTEXT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env|--region|--dry-run) parse_common_opts "$1" "$2"; shift $([[ "$1" == "--dry-run" ]] && echo 1 || echo 2) ;;
    --context) EXTRA_CONTEXT="$EXTRA_CONTEXT -c $2"; shift 2 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

banner "Infrastructure Deploy"

PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT/infra"

CDK_ARGS="-c env=${ENV_NAME}${EXTRA_CONTEXT}"

# Step 1: CDK Diff (mandatory)
log "Running cdk diff..."
echo ""
npx cdk diff $CDK_ARGS 2>&1 || true
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  info "[DRY RUN] Would deploy with: npx cdk deploy --all $CDK_ARGS"
  exit 0
fi

# Step 2: Interactive confirmation
echo -e "${YELLOW}The above changes will be applied to ${STACK_NAME} in ${REGION}.${NC}"
read -rp "Proceed with deploy? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  log "Aborted by user."
  exit 0
fi

# Step 3: Deploy
log "Deploying: npx cdk deploy --all $CDK_ARGS --require-approval never"
npx cdk deploy --all $CDK_ARGS --require-approval never

log "Infrastructure deploy complete."
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x infra/scripts/deploy-infra.sh
git add infra/scripts/deploy-infra.sh
git commit -m "feat(infra): add deploy-infra.sh with mandatory diff + confirmation"
```

---

### Task 6: Create deploy-backend.sh

**Files:**
- Create: `infra/scripts/deploy-backend.sh`

- [ ] **Step 1: Create deploy-backend.sh**

```bash
#!/bin/bash
# Build backend Docker image, push to ECR, and roll out ECS services

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env|--region|--dry-run) parse_common_opts "$1" "$2"; shift $([[ "$1" == "--dry-run" ]] && echo 1 || echo 2) ;;
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
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x infra/scripts/deploy-backend.sh
git add infra/scripts/deploy-backend.sh
git commit -m "feat(infra): add deploy-backend.sh (ECR push + ECS rolling update)"
```

---

### Task 7: Create deploy-frontend.sh

**Files:**
- Create: `infra/scripts/deploy-frontend.sh`

- [ ] **Step 1: Create deploy-frontend.sh**

```bash
#!/bin/bash
# Build frontend and deploy to S3 + invalidate CloudFront

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env|--region|--dry-run) parse_common_opts "$1" "$2"; shift $([[ "$1" == "--dry-run" ]] && echo 1 || echo 2) ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

banner "Frontend Deploy"

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

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
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x infra/scripts/deploy-frontend.sh
git add infra/scripts/deploy-frontend.sh
git commit -m "feat(infra): add deploy-frontend.sh (Vite build + S3 sync + CF invalidation)"
```

---

### Task 8: Create deploy-migrate.sh

**Files:**
- Create: `infra/scripts/deploy-migrate.sh`

- [ ] **Step 1: Create deploy-migrate.sh**

```bash
#!/bin/bash
# Run database migrations via ECS Exec on a running API task

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env|--region|--dry-run) parse_common_opts "$1" "$2"; shift $([[ "$1" == "--dry-run" ]] && echo 1 || echo 2) ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

banner "Database Migration"

CLUSTER_NAME="super-agent-${ENV_NAME}"

# Find a running API task
log "Finding running API task in cluster: ${CLUSTER_NAME}"

SERVICES=$(aws ecs list-services --cluster "$CLUSTER_NAME" --region "$REGION" \
  --query "serviceArns[*]" --output text 2>/dev/null || echo "")

API_SERVICE=""
for SERVICE_ARN in $SERVICES; do
  SVC_NAME=$(echo "$SERVICE_ARN" | awk -F'/' '{print $NF}')
  if echo "$SVC_NAME" | grep -qi "api"; then
    API_SERVICE="$SVC_NAME"
    break
  fi
done

if [[ -z "$API_SERVICE" ]]; then
  err "No API service found in cluster. Cannot run migration."
  exit 1
fi

TASK_ARN=$(aws ecs list-tasks \
  --cluster "$CLUSTER_NAME" \
  --service-name "$API_SERVICE" \
  --desired-status RUNNING \
  --region "$REGION" \
  --query "taskArns[0]" --output text 2>/dev/null)

if [[ -z "$TASK_ARN" || "$TASK_ARN" == "None" ]]; then
  err "No running tasks found for service: $API_SERVICE"
  err "Ensure ECS services have desiredCount > 0."
  exit 1
fi

TASK_ID=$(echo "$TASK_ARN" | awk -F'/' '{print $NF}')
log "Target task: $TASK_ID (service: $API_SERVICE)"

if [[ "$DRY_RUN" == "true" ]]; then
  info "[DRY RUN] Would execute: npx prisma migrate deploy"
  info "[DRY RUN] On task: $TASK_ID"
  exit 0
fi

log "Running: npx prisma migrate deploy"
aws ecs execute-command \
  --cluster "$CLUSTER_NAME" \
  --task "$TASK_ARN" \
  --container "ApiContainer" \
  --interactive \
  --command "npx prisma migrate deploy" \
  --region "$REGION"

log "Migration complete."
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x infra/scripts/deploy-migrate.sh
git add infra/scripts/deploy-migrate.sh
git commit -m "feat(infra): add deploy-migrate.sh (ECS Exec Prisma migration)"
```

---

### Task 9: Create deploy-all.sh

**Files:**
- Create: `infra/scripts/deploy-all.sh`

- [ ] **Step 1: Create deploy-all.sh**

```bash
#!/bin/bash
# Full deployment: infra → backend → frontend → migrate → health check

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

SKIP_INFRA=false
SKIP_BACKEND=false
SKIP_FRONTEND=false
SKIP_MIGRATE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env|--region|--dry-run) parse_common_opts "$1" "$2"; shift $([[ "$1" == "--dry-run" ]] && echo 1 || echo 2) ;;
    --skip-infra)    SKIP_INFRA=true; shift ;;
    --skip-backend)  SKIP_BACKEND=true; shift ;;
    --skip-frontend) SKIP_FRONTEND=true; shift ;;
    --skip-migrate)  SKIP_MIGRATE=true; shift ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

banner "Full Deploy"

COMMON_ARGS="--env $ENV_NAME --region $REGION"
[[ "$DRY_RUN" == "true" ]] && COMMON_ARGS="$COMMON_ARGS --dry-run"

# Step 1: Infrastructure
if [[ "$SKIP_INFRA" == "false" ]]; then
  log "═══ Step 1/4: Infrastructure ═══"
  "$SCRIPT_DIR/deploy-infra.sh" $COMMON_ARGS
else
  info "Step 1/4: Infrastructure — SKIPPED"
fi
echo ""

# Step 2: Backend
if [[ "$SKIP_BACKEND" == "false" ]]; then
  log "═══ Step 2/4: Backend ═══"
  "$SCRIPT_DIR/deploy-backend.sh" $COMMON_ARGS
else
  info "Step 2/4: Backend — SKIPPED"
fi
echo ""

# Step 3: Frontend
if [[ "$SKIP_FRONTEND" == "false" ]]; then
  log "═══ Step 3/4: Frontend ═══"
  "$SCRIPT_DIR/deploy-frontend.sh" $COMMON_ARGS
else
  info "Step 3/4: Frontend — SKIPPED"
fi
echo ""

# Step 4: Migration
if [[ "$SKIP_MIGRATE" == "false" ]]; then
  log "═══ Step 4/4: Migration ═══"
  "$SCRIPT_DIR/deploy-migrate.sh" $COMMON_ARGS
else
  info "Step 4/4: Migration — SKIPPED"
fi
echo ""

# Health check
CF_DOMAIN=$(get_stack_output "CloudFrontDomain")
if [[ -n "$CF_DOMAIN" ]]; then
  log "═══ Health Check ═══"
  health_check "https://${CF_DOMAIN}/health" 5 10 || true
fi

log "Full deploy complete."
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x infra/scripts/deploy-all.sh
git add infra/scripts/deploy-all.sh
git commit -m "feat(infra): add deploy-all.sh orchestrator (infra → backend → frontend → migrate)"
```

---

### Task 10: Delete Legacy Scripts

**Files:**
- Delete: `infra/scripts/deploy-ecs.sh`
- Delete: `infra/scripts/deploy-full.sh`
- Delete: `infra/scripts/deploy.sh`
- Delete: `scripts/deploy.sh`
- Delete: `scripts/build.sh`

- [ ] **Step 1: Remove legacy scripts**

```bash
rm infra/scripts/deploy-ecs.sh
rm infra/scripts/deploy-full.sh
rm infra/scripts/deploy.sh
rm scripts/deploy.sh
rm scripts/build.sh
```

- [ ] **Step 2: Check for remaining references to deleted scripts**

Run from project root:
```bash
grep -r "deploy-ecs\|deploy-full\|scripts/deploy\|scripts/build" --include="*.md" --include="*.sh" --include="*.yml" --include="*.yaml" .
```
Expected: only the spec file (`docs/superpowers/specs/`) and this plan. If `infra/CLAUDE.md` references them, that will be updated in Task 11.

- [ ] **Step 3: Commit**

```bash
git add -u infra/scripts/deploy-ecs.sh infra/scripts/deploy-full.sh infra/scripts/deploy.sh scripts/deploy.sh scripts/build.sh
git commit -m "chore(infra): remove legacy deployment scripts (replaced by layered deploy-*.sh)"
```

---

### Task 11: Update infra/CLAUDE.md

**Files:**
- Modify: `infra/CLAUDE.md` (Deployment Scripts section)

- [ ] **Step 1: Replace the Deployment Scripts section**

Find and replace the "Deployment Scripts" section in `infra/CLAUDE.md` with:

```markdown
## Deployment Scripts (`scripts/`)

### Layered Scripts (production)

| Script | Purpose | Key flags |
|--------|---------|-----------|
| `lib/common.sh` | Shared utilities (logging, AWS helpers, health check) | — |
| `deploy-infra.sh` | CDK diff → confirm → deploy | `--env`, `--region`, `--dry-run`, `--context` |
| `deploy-backend.sh` | Docker build → ECR push → ECS rolling deploy | `--env`, `--region`, `--dry-run` |
| `deploy-frontend.sh` | Vite build → S3 sync → CloudFront invalidation | `--env`, `--region`, `--dry-run` |
| `deploy-migrate.sh` | ECS Exec → `npx prisma migrate deploy` | `--env`, `--region`, `--dry-run` |
| `deploy-all.sh` | Orchestrator: infra → backend → frontend → migrate → health | `--skip-infra`, `--skip-backend`, `--skip-frontend`, `--skip-migrate` |

```bash
# Typical usage
./scripts/deploy-infra.sh --env prod              # Infra only (shows diff, asks y/N)
./scripts/deploy-backend.sh --env prod            # Backend code deploy
./scripts/deploy-frontend.sh --env prod           # Frontend code deploy
./scripts/deploy-all.sh --env prod --skip-infra   # App-only full deploy
```

### Legacy (retained for reference)
- `setup-github-secrets.sh` — GitHub Actions secrets setup
- `setup-litellm.sh` — LiteLLM proxy setup
- `user-data.sh` — EC2 user-data (unused since ECS migration)
```

- [ ] **Step 2: Commit**

```bash
git add infra/CLAUDE.md
git commit -m "docs(infra): update CLAUDE.md with new layered deployment scripts"
```

---

### Task 12: Verify Full CDK Synth

**Files:** None (verification only)

- [ ] **Step 1: Run CDK synth end-to-end**

Run from `infra/`:
```bash
npx cdk synth -c env=prod --quiet 2>&1 | tail -5
```
Expected: no errors, template generated

- [ ] **Step 2: Run CDK diff (dry-run validation against live stack)**

Run from `infra/`:
```bash
npx cdk diff -c env=prod 2>&1 | head -50
```
Expected: shows new resources (CodeBuild project, Lambda function, Custom Resource, IAM roles) and modified ECS task definitions (AGENT_RUNTIME env var added)

- [ ] **Step 3: Verify all new scripts are executable**

```bash
ls -la infra/scripts/deploy-*.sh infra/scripts/lib/common.sh
```
Expected: all have `x` permission bit set

- [ ] **Step 4: Final commit (if any fixups needed)**

Only if prior steps revealed issues that were fixed.
