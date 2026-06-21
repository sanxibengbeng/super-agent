# CI/CD Pipeline Redesign — Three-Layer Local Deployment

**Date:** 2026-06-18
**Status:** Approved
**Scope:** Production environment (SuperAgent-prod, us-east-1, 873543029686)

## Problem

The previous CI/CD system was a monolithic GitHub Actions workflow that coupled infrastructure changes with application deployments. This caused:

1. Application deploys blocked by unrelated infra failures (e.g., AgentCore S3 Files bugs blocking performance optimizations)
2. No separation of concern — changing one line of CSS triggered full CDK deploy + backend image build
3. AgentCore ARM64 image built on x86 runner (broken — no QEMU configured)
4. No interactive confirmation before destructive infra operations
5. `:latest` tag deployment with no immutable reference for rollback

## Design Principles

1. **Infrastructure and application have separate lifecycles** — infra changes weekly, app changes daily
2. **CDK deploy is the single source of truth for infra state** — including agentcore image building
3. **Local-first deployment** — scripts run from developer machine, CI/CD to be layered on later
4. **Fail-safe by default** — diff before deploy, confirm before proceed, health check after

## Architecture

### Three-Layer Model

```
Layer 1: Infrastructure (CDK)
├── VPC, RDS, Redis, S3, ECR, CloudFront, WAF
├── AgentCore Runtime + S3 Files
├── CodeBuild Project (ARM64 agentcore builder)
└── Custom Resource trigger (auto-builds agentcore image on source change)

Layer 2a: Backend Application
├── Docker build (linux/amd64)
├── ECR push
└── ECS rolling deployment (api + worker + gateway)

Layer 2b: Frontend Application
├── Vite production build
├── S3 sync (immutable cache for assets, no-cache for index.html)
└── CloudFront invalidation

Layer 2c: Database Migration
└── ECS Exec → prisma migrate deploy
```

### CDK Dependency Chain (Layer 1 internal)

```
S3 Asset (agentcore/ source, hash-based)
  → CodeBuild Project (ARM_CONTAINER, privileged)
    → Custom Resource Lambda (start-build + poll until complete)
      → CfnRuntime (containerUri → ECR :latest, guaranteed to exist)
```

Source code hash drives the trigger: unchanged source = no rebuild = no-op.

## Components

### 1. AgentCore Image Builder Construct

**File:** `infra/lib/constructs/agentcore-image-builder.ts`

**Resources created:**
- `codebuild.Project` — ARM64 native (`AMAZON_LINUX_2_STANDARD_3_0`), privileged, 15min timeout
- `s3_assets.Asset` — agentcore source packaged (excludes node_modules/dist)
- `cr.Provider` + Custom Resource Lambda — starts CodeBuild, polls `batchGetBuilds` until SUCCEEDED/FAILED
- IAM Role for CodeBuild — ECR push + S3 source read + CloudWatch Logs

**BuildSpec constraints (from existing repo conventions):**
- `DOCKER_BUILDKIT=0` — BuildKit attestation manifests break AgentCore microVM startup
- `--platform linux/arm64` — AgentCore only supports ARM64
- Native ARM environment — no emulation/cross-compile

**Exports:** `project` (for direct `start-build` if needed), `buildTrigger` (for dependency wiring)

### 2. ECS AGENT_RUNTIME Switch

**File:** `infra/lib/constructs/ecs-cluster.ts`

Add `AGENT_RUNTIME` environment variable to all three ECS task definitions:
- When `enableAgentCore=true` → `AGENT_RUNTIME=agentcore`
- When `enableAgentCore=false` → `AGENT_RUNTIME=claude`

This activates `agent-runtime-factory.ts` → `AgentCoreRuntime` class → Bedrock AgentCore API.

**Rollback:** Set `-c enableAgentCore=false` and redeploy to instantly revert to Claude SDK runtime.

### 3. Deployment Scripts

**Directory:** `infra/scripts/`

| Script | Responsibility |
|--------|---------------|
| `lib/common.sh` | Shared: color output, AWS account detection, stack output reader, health check |
| `deploy-infra.sh` | `cdk diff` → show changes → interactive confirm → `cdk deploy --all` |
| `deploy-backend.sh` | ECR login → docker build amd64 → push → ECS force-new-deployment × 3 services → wait stable |
| `deploy-frontend.sh` | npm ci → vite build → S3 sync → CloudFront invalidation |
| `deploy-migrate.sh` | Find API task → ECS exec `npx prisma migrate deploy` |
| `deploy-all.sh` | Sequential: infra → backend → frontend → migrate → health check |

**Shared options:** `--env prod`, `--region us-east-1`, `--dry-run`

**Safety:** `deploy-infra.sh` always shows `cdk diff` output and requires `y/N` confirmation before proceeding. This codifies the trust boundary requirement.

## Wiring in Main Stack

```typescript
// super-agent-stack.ts
const imageBuilder = new AgentCoreImageBuilderConstruct(this, 'AgentCoreBuilder', {
  agentcoreRepo,
  sourceDirectory: '../agentcore',
  region: this.region,
  account: this.account,
});

// Guarantee: image exists before Runtime creation
agentCore.runtime.node.addDependency(imageBuilder.buildTrigger);

// ECS uses agentcore runtime when enabled
const ecsCluster = new EcsClusterConstruct(this, 'Ecs', {
  ...existingProps,
  agentRuntime: enableAgentCore ? 'agentcore' : 'claude',
});
```

## Files Changed

| Action | Path | Description |
|--------|------|-------------|
| Create | `infra/lib/constructs/agentcore-image-builder.ts` | CodeBuild + Custom Resource construct |
| Modify | `infra/lib/super-agent-stack.ts` | Wire ImageBuilder, add dependency to AgentCore |
| Modify | `infra/lib/constructs/ecs-cluster.ts` | Add AGENT_RUNTIME env var |
| Create | `infra/scripts/lib/common.sh` | Shared utilities |
| Create | `infra/scripts/deploy-infra.sh` | CDK deploy with diff+confirm |
| Create | `infra/scripts/deploy-backend.sh` | Backend image + ECS |
| Create | `infra/scripts/deploy-frontend.sh` | Frontend S3 + CF |
| Create | `infra/scripts/deploy-migrate.sh` | Database migration |
| Create | `infra/scripts/deploy-all.sh` | Orchestrator |
| Delete | `infra/scripts/deploy-ecs.sh` | Replaced by new scripts |
| Delete | `infra/scripts/deploy-full.sh` | EC2 legacy, unused |
| Delete | `infra/scripts/deploy.sh` | EC2 legacy, unused |
| Delete | `scripts/deploy.sh` | Root legacy |
| Delete | `scripts/build.sh` | Root legacy |

## Risk & Rollback

| Risk | Mitigation |
|------|-----------|
| AgentCore Runtime fails after switching AGENT_RUNTIME | Set `enableAgentCore=false`, redeploy — instant revert to Claude SDK |
| CodeBuild ARM build fails during cdk deploy | CloudFormation auto-rollback; ECR stays with previous image; no downtime |
| Custom Resource Lambda timeout (>15min build) | Set Lambda timeout = 15min, CodeBuild timeout = 15min; typical build ~3-5min |
| First deploy: ECR empty + Runtime creation | Dependency chain guarantees image build completes first |

## Future CI/CD Extension

The CodeBuild Project created by CDK is a persistent resource. When GitHub Actions CI/CD is added later:
- Layer 0 (image build): `aws codebuild start-build --project-name super-agent-agentcore-builder`
- Layer 1 (infra): `cdk deploy` in workflow with environment protection
- Layer 2 (app): reuse `deploy-backend.sh` / `deploy-frontend.sh` logic

No new infrastructure needed — just workflow files calling existing resources and scripts.
