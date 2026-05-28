# Infrastructure (CDK) — CLAUDE.md

> AWS CDK v2 TypeScript app deploying the full Super Agent stack.

## Commands

```bash
npx cdk synth                  # Synthesize CloudFormation template
npx cdk diff                   # Show pending infrastructure changes
npx cdk deploy --all           # Deploy all stacks
npx cdk destroy --all          # Tear down all stacks
npm run build                  # TypeScript compile
```

## Architecture

```
infra/
├── bin/app.ts                 # CDK app entry point
├── lib/
│   ├── super-agent-stack.ts   # Main stack — composes all constructs
│   └── constructs/
│       ├── vpc.ts             # 3-tier VPC + security groups
│       ├── data-layer.ts      # Aurora PostgreSQL 16 + ElastiCache Redis 7
│       ├── secrets.ts         # Secrets Manager (DB + app secrets)
│       ├── agentcore.ts       # Bedrock AgentCore runtime + S3 Files filesystem
│       ├── ecs-cluster.ts     # ECS Fargate cluster (api, worker, gateway services) + ALB
│       └── cdn.ts             # CloudFront + WAF → internal ALB + S3 frontend
└── cdk.json                   # CDK context and configuration
```

## Construct Details

### VPC (`vpc.ts`)
- 3-tier: public (NAT/ALB), private (ECS tasks), isolated (DB/Redis)
- Security groups: ALB, ECS, DB, Redis — exports all for cross-construct wiring

### Data Layer (`data-layer.ts`)
- Aurora PostgreSQL 16 provisioned (t4g.medium writer + 1 t4g.medium reader)
- ElastiCache Redis 7.1 (replication group, auth token via Secrets Manager)
- Exports: `dbCluster`, `dbSecret`, `redisEndpoint`, `redisPort`, `redisAuthSecret`

### Secrets (`secrets.ts`)
- Creates an app-level secret (JWT, API keys) in Secrets Manager
- Props: `dbSecretArn` for cross-referencing

### AgentCore (`agentcore.ts`)
- Bedrock AgentCore `CfnAgentRuntime` resource
- S3 Files `CfnFileSystem` for workspace mounts
- IAM roles for AgentCore ↔ S3 access
- Exports: `runtime`, `fileSystem`

### ECS Cluster (`ecs-cluster.ts`)
- Fargate services: api, worker, gateway (separate task definitions)
- Internal ALB with health checks
- Service discovery, auto-scaling policies
- Props: VPC, security groups, secrets, Redis/DB endpoints, S3 bucket names, AgentCore ARNs

### CDN (`cdn.ts`)
- CloudFront distribution with VPC origin → internal ALB
- S3 origin for frontend static assets
- WAF web ACL (rate limiting, common rule sets)
- Props: `alb`, `frontendBucket`

## S3 Buckets (created in main stack)

| Bucket | Naming | Purpose |
|--------|--------|---------|
| Workspace | `super-agent-workspace-{account}` | Agent workspaces, S3 Files mount |
| Assets | `super-agent-assets-{account}` | Avatars, skills, uploads |
| Frontend | `super-agent-frontend-{account}` | Built SPA (CloudFront origin) |

## ECR Repositories

- `super-agent-backend` — ECS Fargate task image
- `super-agent-agentcore` — AgentCore microVM image (ARM64 only)

## Outputs

The stack exports: CloudFront domain, ALB DNS, DB endpoint, DB secret ARN, Redis endpoint, workspace bucket, assets bucket, AgentCore runtime ARN, S3 Files filesystem ID, ECR repo URIs, app secret ARN, frontend bucket.

## CDK Context (`cdk.json`)

App entry: `npx ts-node --prefer-ts-exts bin/app.ts`

Context variables (passed via `-c key=value`):
- `stackName` — Stack name (default: SuperAgent)
- `enableCdn` — "true" to deploy CloudFront + S3 frontend
- `domainName` — Custom domain (required when enableCdn=true)
- `hostedZoneId` — Route53 zone (required when enableCdn=true)
- `authMode` — "cognito" | "local" (default: local)

## Deployment Scripts (`scripts/`)

- `deploy.sh` — Reads stack outputs, builds + deploys backend/frontend, runs migrations
- `deploy-full.sh` — Full CDK deploy + code deploy + AgentCore setup (ECR build, runtime creation)
- Flags: `--skip-frontend`, `--skip-backend`, `--env-file`, `--cognito-password`

## Gotchas

- All constructs use `RemovalPolicy.RETAIN` for data resources (S3, RDS, ECR).
- AgentCore images MUST be `linux/arm64`. Use `DOCKER_BUILDKIT=0` to avoid attestation manifests.
- VPC origin for CloudFront requires the ALB to be internal (no public access except via CDN).
- Aurora PostgreSQL 16 is provisioned (t4g.medium), not Serverless v2 — no scale-to-zero.
- Redis auth token is stored in Secrets Manager; ElastiCache requires `transit_encryption_enabled`.
- WAF WebACL must be in `us-east-1` for CloudFront scope — handled by CDK cross-region if stack is elsewhere.
- VPC has 2 NAT Gateways (one per AZ) — costs ~$65/mo each.
