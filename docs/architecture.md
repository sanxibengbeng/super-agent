# Super Agent — Production Architecture

> Updated: 2026-06-04 | Based on `infra/` CDK constructs (current branch)

## Architecture Diagram (Mermaid)

```mermaid
graph TB
    %% Styling
    classDef edge fill:#dae8fc,stroke:#6c8ebf,stroke-width:2px
    classDef vpc fill:none,stroke:#8C4FFF,stroke-width:2px
    classDef public fill:#F2F6E8,stroke:#7AA116
    classDef private fill:#E6F6F7,stroke:#00A4A6
    classDef isolated fill:#F2F3F4,stroke:#879196
    classDef ai fill:#fff2cc,stroke:#d6b656,stroke-width:2px
    classDef storage fill:#d5e8d4,stroke:#82b366,stroke-width:2px
    classDef db fill:#e8d5f5,stroke:#9673a6

    %% Users
    Users((Internet Users))

    %% Edge Layer
    subgraph Edge["AWS Edge (Global)"]
        CF[CloudFront Distribution<br/>HTTP/2+3, TLS 1.2+]
        WAF[WAF v2<br/>Rate 1000/5m • CRS • SQLi<br/>BadInputs • IP Reputation]
        S3FE[S3 Frontend Bucket<br/>React SPA • OAC SigV4]
    end

    %% VPC
    subgraph VPC["VPC 10.0.0.0/16 (2 AZ) — Flow Logs Enabled"]
        subgraph Public["Public Subnets (10.0.0.0/24, 10.0.1.0/24)"]
            NAT1[NAT GW AZ-1]
            NAT2[NAT GW AZ-2]
        end

        subgraph Private["Private Subnets (10.0.2.0/24, 10.0.3.0/24)"]
            ALB[Internal ALB<br/>SG: VPC CIDR:80 only<br/>idle: 3600s]

            subgraph ECS["ECS Fargate Cluster — Circuit Breaker + Container Insights"]
                API[API Service<br/>0.5 vCPU / 1 GB<br/>2→6 tasks]
                Worker[Worker Service<br/>1 vCPU / 2 GB<br/>1→4 tasks]
                Gateway[Gateway Service<br/>0.25 vCPU / 512 MB<br/>2→4 tasks]
            end
        end

        subgraph Isolated["Isolated Subnets (10.0.4.0/24, 10.0.5.0/24) — No Internet"]
            Aurora[(Aurora PostgreSQL 16<br/>Writer + Reader t4g.medium<br/>Multi-AZ • Encrypted<br/>Performance Insights)]
            Redis[(ElastiCache Redis 7.1<br/>Multi-AZ Replication<br/>TLS Required • AUTH Token)]
            Secrets[Secrets Manager<br/>DB + App + Redis]
        end

        subgraph VPCE["VPC Endpoints"]
            S3EP[S3 Gateway]
            ECRAP[ECR API + Docker]
            CWEP[CloudWatch Logs]
            SMEP[Secrets Manager]
            STSEP[STS]
            BREP[Bedrock Runtime]
        end
    end

    %% Amazon Bedrock (AI Model Provider)
    subgraph Bedrock["Amazon Bedrock (Model Provider)"]
        Models[Foundation Models<br/>• Claude Sonnet 4.6 primary<br/>• Claude Opus 4.6<br/>• Claude Haiku 4.5]
        BedrockAPI[InvokeModel API<br/>InvokeModelWithResponseStream<br/>Cross-region inference profiles]
    end

    %% Bedrock AgentCore
    subgraph AgentCore["Bedrock AgentCore (AWS-Managed)"]
        Runtime[AgentCore Runtime<br/>microVM Isolation]
        Container[Container Image<br/>• Claude Agent SDK<br/>• Claude Code CLI<br/>• ARM64 only]
        Mounts[Filesystem Mounts<br/>• /mnt/session<br/>• /mnt/ws S3 Files]
    end

    %% S3 Storage
    subgraph S3["S3 Storage (Gateway Endpoint)"]
        WS[Workspace Bucket<br/>Versioned • SSL enforced<br/>IA 30d • Expire 90d]
        Assets[Assets Bucket<br/>Versioned • SSL enforced<br/>Avatars, skills, uploads]
        S3Files[S3 Files FileSystem<br/>POSIX mount for AgentCore<br/>Per-scope Access Points]
    end

    %% ECR + CloudWatch
    ECR[ECR Repositories<br/>backend + agentcore ARM64]
    CW[CloudWatch<br/>Logs 90d • Alarms<br/>CPU, 5xx, Unhealthy]

    %% Connections
    Users -->|HTTPS 443| CF
    CF -->|"default /* (OAC)"| S3FE
    WAF -.->|protects| CF
    CF -->|"VPC Origin /api/* /v1/* /ws/*<br/>Private ENI → port 80"| ALB

    ALB -->|"/api/* /health /v1/*"| API
    ALB -->|"/ws/*"| Gateway

    API -->|5432 TLS| Aurora
    Worker -->|5432 TLS| Aurora
    Gateway -->|6379 TLS required| Redis
    API -->|6379 TLS required| Redis
    Worker -->|6379 TLS required| Redis

    %% Model invocation paths
    API ==>|"InvokeModelWithResponseStream<br/>(Bedrock VPC Endpoint)"| BedrockAPI
    Worker ==>|"InvokeModel<br/>(Bedrock VPC Endpoint)"| BedrockAPI
    Worker -->|"InvokeAgentRuntime<br/>CreateSession"| Runtime
    Runtime --> Container
    Container --> Mounts
    Container ==>|"InvokeModel<br/>(Bedrock API)"| BedrockAPI
    BedrockAPI --> Models

    %% Storage paths
    Worker -->|"Read/Write (S3 GW EP)"| WS
    API -->|"Read/Write (S3 GW EP)"| WS
    API -->|"Read/Write"| Assets
    Mounts -->|"/mnt/ws mount"| S3Files
    S3Files -.->|"backed by"| WS

    %% Class assignments
    class Edge edge
    class VPC vpc
    class Public public
    class Private private
    class Isolated isolated
    class Bedrock,AgentCore ai
    class S3 storage
    class Aurora,Redis db
```

## Component Summary

### Network (VPC)

| Layer | CIDR | Purpose |
|-------|------|---------|
| Public | 10.0.0.0/24, 10.0.1.0/24 | NAT Gateways (2x, HA) |
| Private | 10.0.2.0/24, 10.0.3.0/24 | ECS Fargate + Internal ALB |
| Isolated | 10.0.4.0/24, 10.0.5.0/24 | Aurora PostgreSQL + Redis (no internet) |

**VPC Endpoints (7):** S3 Gateway, ECR API, ECR Docker, CloudWatch Logs, Secrets Manager, STS, **Bedrock Runtime**

### Compute (ECS Fargate)

| Service | CPU/Mem | Scale | Role |
|---------|---------|-------|------|
| API | 0.5 vCPU / 1 GB | 2→6 | HTTP API, chat streaming |
| Worker | 1 vCPU / 2 GB | 1→4 | BullMQ jobs, workflow execution, AgentCore orchestration |
| Gateway | 0.25 vCPU / 512 MB | 2→4 | WebSocket, IM long-lived connections |

### AI / Model Layer

| Component | Purpose | Access Pattern |
|-----------|---------|---------------|
| **Amazon Bedrock** | Foundation model provider | VPC Endpoint (private) |
| Claude Sonnet 4.6 | Primary model (chat + workflows) | `InvokeModelWithResponseStream` |
| Claude Opus 4.6 | Complex reasoning tasks | `InvokeModel` |
| Claude Haiku 4.5 | Fast/cheap tasks | `InvokeModel` |
| Cross-region profiles | Global model routing | `us.anthropic.*` prefix |
| **Bedrock AgentCore** | Isolated agent execution runtime | `InvokeAgentRuntime` from Worker |

### Model Invocation Paths

```
Path A: Direct (Chat Streaming)
  ECS API/Worker → Bedrock Runtime VPC Endpoint → Claude Models → Stream back

Path B: AgentCore (Autonomous Workflows)
  ECS Worker → AgentCore Runtime → microVM Container
    → Claude Agent SDK → Bedrock API → Claude Models
    → Read/Write workspace on S3 Files mount (/mnt/ws)
```

Both paths use:
- `CLAUDE_CODE_USE_BEDROCK=1` environment variable
- Cross-region inference profiles for availability
- IAM least-privilege with `SourceAccount` condition

### Data Layer

| Service | Config | Access |
|---------|--------|--------|
| Aurora PostgreSQL 16 | Writer + Reader (t4g.medium), Multi-AZ, encrypted, Performance Insights | ECS→5432 only |
| ElastiCache Redis 7.1 | Replication group, Multi-AZ, TLS required, AUTH token | ECS→6379 only |
| Secrets Manager | DB creds, App secret (JWT), Redis AUTH | VPC Endpoint |

### Storage (S3)

| Bucket | Purpose | Features |
|--------|---------|----------|
| Workspace | Agent workspaces, S3 Files backing store | Versioned, lifecycle (IA 30d, expire 90d) |
| Assets | Avatars, skills, uploads | Versioned, enforceSSL |
| Frontend | React SPA (CloudFront origin) | OAC SigV4, enforceSSL |
| S3 Files FileSystem | POSIX filesystem for AgentCore | Per-scope access points |

### Edge / CDN

| Component | Config |
|-----------|--------|
| CloudFront | HTTP/2+3, TLS 1.2+, VPC Origin → internal ALB |
| WAF v2 | Rate limit 1000/5m, CRS, SQLi, BadInputs, IP Reputation |
| S3 Frontend | BucketDeployment with cache control (immutable assets, no-cache index.html) |

### Security Posture

- **Network:** No 0.0.0.0/0 ingress, VPC Origin (private path), 7 VPC Endpoints, Flow Logs
- **IAM:** Least-privilege S3 actions, SourceAccount conditions, no wildcard policies
- **Encryption:** TLS 1.2+ everywhere, Redis TLS required, S3 enforceSSL, RDS encrypted at rest
- **WAF:** Rate limiting, AWS managed rule sets (CRS, SQLi, BadInputs, IP Reputation)
- **Reliability:** Circuit breaker + rollback, graceful shutdown 120s, Multi-AZ all layers
- **Observability:** Container Insights, CloudWatch Logs (90d), Alarms (CPU, 5xx, unhealthy hosts)
