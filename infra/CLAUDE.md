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
- `enableCdn` — Deploy CloudFront + S3 frontend (default: true; set "false" to disable)
- `domainName` — Custom domain (required when enableCdn=true)
- `hostedZoneId` — Route53 zone (required when enableCdn=true)
- `authMode` — "cognito" | "local" (default: local)
- `otelEndpoint` — Grafana Cloud OTLP endpoint URL (enables distributed tracing)

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

## Observability (Distributed Tracing)

Full-chain distributed tracing via OpenTelemetry SDK → Grafana Cloud (Tempo + Mimir).

### Architecture

```
ECS Fargate (api/worker/gateway)
  └── OTel Node.js SDK (auto-instruments HTTP, Fastify, pg, ioredis, AWS SDK)
       ├── Traces → OTLP/proto → Grafana Cloud Tempo
       └── Metrics → OTLP/proto → Grafana Cloud Mimir
```

AgentCore containers (no network access) piggyback span data on SSE events; the backend rehydrates them into OTel spans.

### Production Setup

**Step 1: Set Grafana Cloud OTLP endpoint via CDK context**

```bash
npx cdk deploy --all -c otelEndpoint=https://otlp-gateway-prod-ap-southeast-1.grafana.net/otlp
```

**Step 2: Store Grafana Cloud API key in Secrets Manager**

The `OTEL_EXPORTER_OTLP_HEADERS` secret is part of `super-agent/app-config`. Update it in the AWS Console or CLI:

```bash
aws secretsmanager put-secret-value \
  --secret-id super-agent/app-config \
  --secret-string '{
    "JWT_SECRET": "<existing>",
    "ANTHROPIC_API_KEY": "<existing>",
    "LANGFUSE_SECRET_KEY": "<existing>",
    "LANGFUSE_PUBLIC_KEY": "<existing>",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic <base64(instanceId:apiKey)>"
  }'
```

To get the base64 value for Grafana Cloud:
```bash
echo -n "<instance-id>:<api-key>" | base64
```

**Step 3: Verify traces appear**

After deploying, make a request and check Grafana Cloud → Explore → Tempo. Search by service name: `super-agent-api`, `super-agent-worker`, `super-agent-gateway`.

### Environment Variables (ECS)

| Variable | Source | Per-Service |
|----------|--------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Plain-text env (CDK context) | Shared |
| `OTEL_EXPORTER_OTLP_HEADERS` | Secrets Manager (`super-agent/app-config`) | Shared |
| `OTEL_SERVICE_NAME` | Plain-text env | `super-agent-api` / `super-agent-worker` / `super-agent-gateway` |
| `OTEL_TRACES_SAMPLER` | Plain-text env | `parentbased_traceidratio` (all) |
| `OTEL_TRACES_SAMPLER_ARG` | Plain-text env | `0.1` (10% sampling in production) |
| `OTEL_METRICS_EXPORT_INTERVAL` | Plain-text env | `60000` ms (all) |

### Disabling Tracing

Set `otelEndpoint` to empty string or omit it from CDK context. When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, the OTel SDK is a complete no-op with zero performance overhead.

### Local Development

```bash
docker compose --profile tracing up    # Starts Jaeger at localhost:16686
```

Traces are sent to the local Jaeger container. No Grafana Cloud credentials needed for local dev.

### Cost (Grafana Cloud Free Tier)

- 50 GB traces/month
- 10,000 metrics series
- 50 GB logs/month (if Loki added later)

At 10% sampling rate with typical traffic, this is well within free tier.

## Gotchas

- All constructs use `RemovalPolicy.RETAIN` for data resources (S3, RDS, ECR).
- AgentCore images MUST be `linux/arm64`. Use `DOCKER_BUILDKIT=0` to avoid attestation manifests.
- VPC origin for CloudFront requires the ALB to be internal (no public access except via CDN).
- Aurora PostgreSQL 16 is provisioned (t4g.medium), not Serverless v2 — no scale-to-zero.
- Redis auth token is stored in Secrets Manager; ElastiCache requires `transit_encryption_enabled`.
- WAF WebACL must be in `us-east-1` for CloudFront scope — handled by CDK cross-region if stack is elsewhere.
- VPC has 2 NAT Gateways (one per AZ) — costs ~$65/mo each.
- `OTEL_EXPORTER_OTLP_HEADERS` contains Grafana Cloud API key — always stored in Secrets Manager, never in plain-text env vars.
