---
name: cdk-infra
description: AWS CDK infrastructure operations for Super Agent - deploy, diff, synth, destroy stacks, manage ECS Fargate services, Aurora PostgreSQL, ElastiCache Redis, CloudFront CDN, AgentCore runtime. Use this skill whenever the user mentions: cdk, deploy, infrastructure, aws, cloudformation, stack, cdk diff, cdk deploy, cdk synth, cdk destroy, infra, provision, ecs, fargate, rds, aurora, elasticache, redis, s3, cloudfront, waf, vpc, agentcore, ecr, or any variation of infrastructure/deployment operations. Also use when user wants to check deployment status, modify infrastructure config, or troubleshoot AWS resource issues.
---

# CDK Infra - AWS Infrastructure Operations

## Purpose

Manage AWS CDK infrastructure for Super Agent. The stack provisions a 3-tier VPC, ECS Fargate cluster (api/worker/gateway), Aurora PostgreSQL, ElastiCache Redis, CloudFront CDN with WAF, Bedrock AgentCore runtime, and S3 storage.

## Stack Overview

**Location**: `infra/`

**Main Stack**: `SuperAgentStack` in `lib/super-agent-stack.ts`

### Constructs (in `lib/constructs/`)

| Construct | File | Resources |
|-----------|------|-----------|
| VPC | `vpc.ts` | 3-tier VPC (public/private/isolated), 2 NAT GWs, VPC endpoints, security groups |
| Data Layer | `data-layer.ts` | Aurora PostgreSQL 16 (t4g.medium writer+reader), ElastiCache Redis 7.1 (multi-AZ) |
| Secrets | `secrets.ts` | Secrets Manager (app config, JWT, API keys) |
| AgentCore | `agentcore.ts` | Bedrock AgentCore runtime, S3 Files filesystem, IAM roles |
| ECS Cluster | `ecs-cluster.ts` | Fargate services (api/worker/gateway), internal ALB, auto-scaling |
| CDN | `cdn.ts` | CloudFront distribution, WAF (rate limit + AWS managed rules), S3 frontend origin |

### S3 Buckets
- `super-agent-workspace-{account}` — Agent workspaces, S3 Files mount
- `super-agent-assets-{account}` — Avatars, skills, uploads
- `super-agent-frontend-{account}` — Built SPA (CloudFront origin)

### ECR Repositories
- `super-agent-backend` — ECS Fargate task image
- `super-agent-agentcore` — AgentCore microVM image (ARM64 only)

## Common Operations

### View Pending Changes (Diff)

```bash
cd infra && npx cdk diff
```

### Deploy All Stacks

```bash
cd infra && npx cdk deploy --all
```

### Deploy with Context Parameters

```bash
cd infra && npx cdk deploy --all \
  -c enableCdn=true \
  -c domainName=app.example.com \
  -c hostedZoneId=Z1234567890
```

### Synthesize CloudFormation Template

```bash
cd infra && npx cdk synth
```

### Destroy All Stacks

```bash
cd infra && npx cdk destroy --all
```

**Warning**: Data resources (S3, RDS, ECR) have `RemovalPolicy.RETAIN` — they survive stack deletion.

### Bootstrap (First Time Only)

```bash
cd infra && npx cdk bootstrap aws://ACCOUNT_ID/REGION
```

## Context Parameters

| Parameter | Values | Default | Description |
|-----------|--------|---------|-------------|
| `stackName` | string | SuperAgent | CloudFormation stack name |
| `enableCdn` | true/false | false | Enable CloudFront + WAF |
| `domainName` | string | - | Custom domain (required if CDN) |
| `hostedZoneId` | string | - | Route53 zone (required if CDN) |
| `authMode` | cognito/local | local | Authentication mode |

## ECS Service Details

| Service | Role | CPU | Memory | Scaling |
|---------|------|-----|--------|---------|
| api | HTTP routes | 512 | 1024 MiB | 2-6 tasks, 70% CPU |
| worker | BullMQ + AgentCore | 1024 | 2048 MiB | 1-4 tasks, 70% CPU |
| gateway | WebSocket/IM | 256 | 512 MiB | 2-4 tasks, 70% CPU |

ALB routing: `/api/*`, `/v1/*`, `/health` → api; `/ws/*` → gateway (sticky sessions)

## Checking Deployment Status

### View Stack Outputs

```bash
aws cloudformation describe-stacks \
  --stack-name SuperAgent \
  --query 'Stacks[0].Outputs' \
  --output table
```

### View ECS Services

```bash
aws ecs list-services --cluster super-agent-cluster --output table
aws ecs describe-services --cluster super-agent-cluster \
  --services super-agent-api super-agent-worker super-agent-gateway \
  --query 'services[].[serviceName,runningCount,desiredCount,status]' \
  --output table
```

### Check CloudFront Distribution

```bash
aws cloudfront list-distributions \
  --query 'DistributionList.Items[].[Id,DomainName,Status]' \
  --output table
```

## Troubleshooting

### ECS Task Failing to Start

```bash
# Check task stopped reason
aws ecs describe-tasks --cluster super-agent-cluster \
  --tasks $(aws ecs list-tasks --cluster super-agent-cluster --service-name super-agent-api --query 'taskArns[0]' --output text) \
  --query 'tasks[].{status:lastStatus,reason:stoppedReason}'

# Check CloudWatch logs
aws logs tail /super-agent/ecs --follow
```

### Database Connection Issues

- ECS tasks run in private subnets; DB is in isolated subnets
- Security group `DbSecurityGroup` must allow port 5432 from `EcsSecurityGroup`
- Check `DATABASE_URL` secret is correctly referenced in task definition

### AgentCore Runtime Issues

- Images MUST be `linux/arm64` — AgentCore microVMs are Graviton-based
- Use `DOCKER_BUILDKIT=0` — BuildKit attestation manifests break microVM startup
- S3 Files mount at `/mnt/ws` — verify filesystem ID matches stack output

## File Structure

```
infra/
├── bin/app.ts                  # CDK app entry point
├── lib/
│   ├── super-agent-stack.ts    # Main stack (S3, ECR, construct composition)
│   └── constructs/             # 6 construct files (vpc, data-layer, secrets, agentcore, ecs-cluster, cdn)
├── scripts/
│   ├── deploy.sh              # Application deployment orchestrator
│   └── deploy-full.sh         # Full infra + app + AgentCore deployment
├── lambda/connectors/         # Lambda handlers for data connectors
├── cdk.json                   # CDK config (context defaults)
├── package.json
└── tsconfig.json
```

## Quick Reference

| Action | Command |
|--------|---------|
| View changes | `cd infra && npx cdk diff` |
| Deploy all | `cd infra && npx cdk deploy --all` |
| Synth template | `cd infra && npx cdk synth` |
| Destroy all | `cd infra && npx cdk destroy --all` |
| Bootstrap | `cd infra && npx cdk bootstrap` |
| List stacks | `cd infra && npx cdk list` |
| Full deploy | `cd infra && ./scripts/deploy-full.sh` |
