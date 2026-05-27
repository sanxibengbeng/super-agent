# AgentCore CDK + S3 Files + ECS Fargate Production Deployment

**Date:** 2026-05-27
**Branch:** `feature/agentcore-cdk-s3files`
**Status:** Design approved

---

## Goals

1. Manage AgentCore Runtime via CDK (`CfnRuntime`) — fresh resource, no migration
2. Replace manual workspace sync with S3 Files Access Point mount (`/mnt/ws`)
3. Replace `__claude_home__/` S3 sync with Session Storage mount (`/mnt/session`)
4. Migrate backend from EC2 to ECS Fargate, split by PROCESS_ROLE (api/worker/gateway)
5. Follow AWS Well-Architected (Security + Reliability pillars): private subnets, encryption, multi-AZ, least privilege
6. Expose private ALB via CloudFront VPC Origin — no public-facing load balancer
7. AgentCore remains PUBLIC mode (AWS-managed microVM isolation)

## Non-Goals

- Historical data migration (old workspace S3 content left as-is)
- Migrating existing AgentCore Runtime (create new, retire old manually)
- Multi-region deployment
- Cost optimization pillar (favor security/reliability first)

---

## Architecture Overview

```
Internet
    │
CloudFront (CDN + WAF)
    │ VPC Origin
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ VPC 10.0.0.0/16                                                      │
│                                                                       │
│  ┌── Public Subnets (2 AZ) ────────────────────────────────────────┐│
│  │  NAT Gateway (AZ-a)         NAT Gateway (AZ-b)                  ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                       │
│  ┌── Private Subnets (2 AZ) ──────────────────────────────────────┐│
│  │  ALB (internal)                                                  ││
│  │  ECS Fargate Cluster                                             ││
│  │    ├── api service (PROCESS_ROLE=api)                            ││
│  │    ├── worker service (PROCESS_ROLE=worker)                      ││
│  │    └── gateway service (PROCESS_ROLE=gateway)                    ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                       │
│  ┌── Isolated Subnets (2 AZ) ─────────────────────────────────────┐│
│  │  RDS Aurora PostgreSQL 16 (Multi-AZ)                             ││
│  │  ElastiCache Redis 7.1 (Multi-AZ)                                ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                       │
│  VPC Endpoints: S3 (Gateway), ECR, CloudWatch Logs, SecretsManager  │
└─────────────────────────────────────────────────────────────────────┘

External (AWS-managed):
┌─────────────────────────────────────────────────────────────────────┐
│ AgentCore Runtime (PUBLIC mode)                                       │
│  ├── Container: ECR image (arm64)                                    │
│  ├── /mnt/session — Session Storage (per-session, ~/.claude state)  │
│  ├── /mnt/ws — S3 Files Access Point (per-scope workspace)          │
│  └── Claude Agent SDK execution inside microVM                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. VPC & Networking

| Resource | Config |
|----------|--------|
| VPC CIDR | 10.0.0.0/16 |
| Public Subnets | 2 AZ, /24 each, NAT Gateways |
| Private Subnets | 2 AZ, /24 each, ECS + ALB |
| Isolated Subnets | 2 AZ, /24 each, RDS + Redis |
| NAT Gateways | 2 (one per AZ, high availability) |
| VPC Endpoints | S3 (Gateway), ECR API + DKR, CloudWatch Logs, Secrets Manager |

**Why isolated subnets for data:** No NAT egress, databases cannot reach internet even if misconfigured. Least privilege by network topology.

### 2. ECS Fargate Cluster

Single cluster, three services sharing one ECR image differentiated by `PROCESS_ROLE` env var.

#### Service: api

| Setting | Value |
|---------|-------|
| PROCESS_ROLE | `api` |
| CPU / Memory | 0.5 vCPU / 1 GB |
| Desired / Min / Max | 2 / 2 / 6 |
| Auto-scaling | CPU target tracking 70% |
| Health check | `GET /health` |
| ALB routing | `/api/*`, `/health`, `/v1/*` |

#### Service: worker

| Setting | Value |
|---------|-------|
| PROCESS_ROLE | `worker` |
| CPU / Memory | 1 vCPU / 2 GB |
| Desired / Min / Max | 2 / 1 / 4 |
| Auto-scaling | Custom metric (BullMQ queue depth) |
| Health check | Internal (ECS container health) |
| ALB routing | None (no inbound HTTP) |

Responsibilities: AgentCore orchestration, BullMQ job processing, cron/scheduler, stream relay.

#### Service: gateway

| Setting | Value |
|---------|-------|
| PROCESS_ROLE | `gateway` |
| CPU / Memory | 0.25 vCPU / 0.5 GB |
| Desired / Min / Max | 2 / 2 / 4 |
| Auto-scaling | Connection count |
| Health check | `GET /health` |
| ALB routing | `/ws/*` (WebSocket, sticky sessions, idle timeout 3600s) |

#### Shared ECS Configuration

- **Image:** Single ECR repo, tagged per deploy
- **Secrets:** Injected from Secrets Manager (DB password, JWT secret, API keys)
- **Logging:** CloudWatch Logs via awslogs driver
- **Service Connect:** Internal service discovery for worker ↔ gateway communication (optional)

### 3. ALB (Internal)

| Setting | Value |
|---------|-------|
| Scheme | Internal (no public IP) |
| Subnets | Private subnets |
| Listeners | HTTPS:443 (ACM certificate) |
| Target Groups | api (path: /api/*, /health, /v1/*), gateway (path: /ws/*) |
| WebSocket | Idle timeout 3600s on gateway target group |
| Health | Each TG checks /health |

Exposed only via CloudFront VPC Origin — no internet-facing security group rules.

### 4. CloudFront + VPC Origin

| Setting | Value |
|---------|-------|
| Origin | VPC Origin → internal ALB |
| Behaviors | `/*` → ALB origin |
| Cache Policy | CachingDisabled (API traffic) |
| Origin Request Policy | AllViewerExceptHostHeader |
| WebSocket | Supported through CloudFront |
| WAF | AWS WAF v2 (rate limiting, geo blocking) |
| SSL | ACM certificate, TLS 1.2+ |

### 5. AgentCore Runtime (CfnRuntime)

| Setting | Value |
|---------|-------|
| Name | `super-agent-runtime` |
| Network | PUBLIC |
| Container | ECR arm64 image |
| Idle Timeout | 900s (15 min) |
| Max Lifetime | 28800s (8 hours) |
| Filesystem: sessionStorage | mountPath: `/mnt/session` |
| Filesystem: s3FilesAccessPoint | Passed per-session at invoke time |
| Environment | `WORKSPACE_DIR=/mnt/ws`, `HOME=/mnt/session` |

**Per-session S3 Files mount:** The runtime's default `filesystemConfigurations` includes only `sessionStorage`. The `s3FilesAccessPoint` is specified dynamically at invoke time via the session API, allowing per-scope isolation.

### 6. S3 Files (Per-Scope Access Points)

```
S3 Bucket (workspace)
    │
    ▼
CfnFileSystem (one per stack)
├── bucket: workspace-bucket-name
├── roleArn: s3files-filesystem-role
└── synchronizationConfiguration: { autoExportPolicy: AUTOMATIC, autoImportPolicy: AUTOMATIC }
    │
    ▼
Access Points (created dynamically by worker)
├── Scope A: rootDirectory = /orgId-A/scopeId-A/
├── Scope B: rootDirectory = /orgId-B/scopeId-B/
└── ...
```

**Lifecycle:**
1. First invoke for a scope → worker calls S3 Files `CreateAccessPoint`
2. ARN stored in `business_scopes.workspace_access_point_arn`
3. Subsequent invokes use cached ARN
4. Scope deletion → worker calls `DeleteAccessPoint`

**Why per-scope:** Multi-tenant hard isolation. A container for scope A physically cannot see scope B's files via the filesystem mount. Defense-in-depth beyond IAM policies.

### 7. IAM Roles

#### ECS Task Execution Role (shared)

```
ecr:GetAuthorizationToken
ecr:BatchGetImage, GetDownloadUrlForLayer
logs:CreateLogStream, PutLogEvents
secretsmanager:GetSecretValue  (resource: specific secret ARNs)
```

#### api-task-role

```
s3:PutObject, GetObject, DeleteObject  (resource: workspace-bucket/*)
cognito-idp:AdminGetUser, etc.         (resource: user pool ARN)
```

#### worker-task-role

```
bedrock-agentcore:InvokeAgentRuntime          (resource: runtime ARN)
bedrock-agentcore:CreateAgentRuntimeSession   (resource: runtime ARN)
bedrock-agentcore:GetAgentRuntimeSession      (resource: runtime ARN)
bedrock-agentcore:DeleteAgentRuntimeSession   (resource: runtime ARN)
s3files:CreateAccessPoint                     (resource: filesystem ARN)
s3files:DescribeAccessPoint                   (resource: filesystem ARN/*)
s3files:DeleteAccessPoint                     (resource: filesystem ARN/*)
s3:*                                          (resource: workspace-bucket/*)
secretsmanager:GetSecretValue                 (resource: specific secret ARNs)
```

#### gateway-task-role

```
(no AWS API permissions — Redis connection only)
```

#### agentcore-exec-role

```
bedrock:InvokeModel, InvokeModelWithResponseStream  (resource: claude model ARNs)
s3:GetObject, PutObject                              (resource: workspace-bucket/*)
logs:CreateLogGroup, CreateLogStream, PutLogEvents
```

#### s3files-filesystem-role

```
s3:GetObject, PutObject, DeleteObject, ListBucket  (resource: workspace-bucket)
```

### 8. Data Layer

#### RDS Aurora PostgreSQL

| Setting | Value |
|---------|-------|
| Engine | PostgreSQL 16 (Aurora-compatible) |
| Instance | db.t4g.medium (upgradable) |
| Multi-AZ | Yes (Aurora automatic) |
| Subnet | Isolated subnets |
| Encryption | KMS (aws/rds) |
| Backup | 7 days retention, PITR |
| Security Group | Inbound 5432 from ECS SG only |

#### ElastiCache Redis

| Setting | Value |
|---------|-------|
| Engine | Redis 7.1 |
| Node | cache.t4g.small |
| Multi-AZ | Yes (automatic failover) |
| Subnet | Isolated subnets |
| Encryption | In-transit + at-rest |
| Security Group | Inbound 6379 from ECS SG only |

### 9. S3 Buckets

| Bucket | Purpose | Encryption | Access |
|--------|---------|------------|--------|
| workspace | Scope workspaces + S3 Files backend | SSE-S3 | ECS + AgentCore + S3 Files role |
| assets | Avatars, skill packages, uploads | SSE-S3 | ECS (presigned URLs) |

Both buckets: versioning enabled, lifecycle rules for old versions (30d transition to IA, 90d expiry).

---

## Backend Code Changes

### Files to Delete

| File | Reason |
|------|--------|
| `agentcore/src/workspace-sync.ts` | Replaced by S3 Files mount |
| Related sync calls in `agentcore/src/index.ts` | No restore/sync steps needed |

### Files to Simplify

| File | Change |
|------|--------|
| `backend/src/services/agent-runtime-agentcore.ts` | Remove `uploadWorkspaceIfNeeded()`, `syncBackFromS3()`, `configVersion` tracking. Invoke only needs session creation + stream relay. |

### Files to Create

| File | Purpose |
|------|--------|
| `backend/src/services/s3files.service.ts` | Manage Access Point lifecycle (create/get/delete per scope) |
| DB migration | Add `workspace_access_point_arn` to `business_scopes` |

### Container Image Changes

| Change | Detail |
|--------|--------|
| Entrypoint | Remove S3 restore step, directly start Claude Agent SDK |
| Workspace dir | Read from `WORKSPACE_DIR` env var (=/mnt/ws) |
| Claude home | Use `/mnt/session/.claude` |
| Dependencies | Remove `@aws-sdk/client-s3` (no longer needed in container) |

---

## Security Considerations (WA Security Pillar)

1. **Network isolation:** Data layer in isolated subnets (no internet egress), ECS in private subnets behind NAT
2. **Least privilege IAM:** 5 separate roles, each with only needed permissions scoped to specific resources
3. **Encryption:** All data encrypted at rest (KMS) and in transit (TLS)
4. **Multi-tenant isolation:** Per-scope S3 Files Access Points provide filesystem-level isolation
5. **No public endpoints:** ALB is internal, exposed only via CloudFront VPC Origin
6. **Secrets management:** All credentials in Secrets Manager, injected at task start
7. **WAF:** CloudFront fronted by AWS WAF for rate limiting and basic protection

## Reliability Considerations (WA Reliability Pillar)

1. **Multi-AZ:** All components (NAT, ECS, RDS, Redis) span 2 AZs
2. **Auto-scaling:** Each ECS service scales independently based on relevant metrics
3. **Health checks:** ALB + ECS container health checks with automatic replacement
4. **Aurora auto-failover:** Automatic promotion of read replica on primary failure
5. **Redis automatic failover:** ElastiCache Multi-AZ with auto-failover
6. **Session resilience:** AgentCore Session Storage persists across microVM restarts

---

## Migration Notes

- This is a **new stack deployment**, not an in-place upgrade
- Old EC2 + manually-created AgentCore Runtime will be retired separately
- No data migration required (user confirmed)
- DNS cutover via CloudFront distribution domain → Route53 record update
- Rollback: point DNS back to old EC2 deployment
