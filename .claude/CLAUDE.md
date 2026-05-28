# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Progressive Disclosure:** Each subdirectory has its own CLAUDE.md with deeper operational context:
> - [`backend/CLAUDE.md`](../backend/CLAUDE.md) — Request flow, service/repository patterns, streaming, testing
> - [`frontend/CLAUDE.md`](../frontend/CLAUDE.md) — Components, state management, path aliases, styling
> - [`infra/CLAUDE.md`](../infra/CLAUDE.md) — CDK constructs, resource details, deployment scripts
> - [`agentcore/CLAUDE.md`](../agentcore/CLAUDE.md) — Container runtime, SDK integration, build process

## Project Overview

Super Agent is an enterprise-grade multi-agent platform for transforming business knowledge into AI Agents. Core workflow: **Business Domain → SOP → Agent → Workflow → Automation**.

Key capabilities:
- Multi-tenant organization isolation
- Business Scope domains with knowledge bases, skills, and toolsets
- AI Agents with customizable personas and skill compositions
- DAG-based workflow automation with visual editor
- MCP (Model Context Protocol) tool integrations
- Multi-channel IM integrations (Slack, Discord, DingTalk, Feishu, Telegram)
- Mini-SaaS app builder and marketplace

---

## Quick Reference

### Backend Commands (from `backend/`)
```bash
npm run dev                    # Start dev server (tsx watch, port 3000)
npm run build                  # TypeScript compile
npm run start                  # Run compiled output (node dist/index.js)
npm run lint                   # ESLint check
npm run lint:fix               # ESLint auto-fix
npm run format                 # Prettier format all src
npm run format:check           # Prettier check (CI)
npm run test                   # Run all tests (vitest)
npm run test -- path/to/file   # Run single test file
npm run test:watch             # Watch mode
npm run test:coverage          # Coverage report
npm run prisma:generate        # Generate Prisma Client
npm run prisma:migrate         # Run migrations (dev)
npm run prisma:migrate:prod    # Run migrations (production)
```

### Frontend Commands (from `frontend/`)
```bash
npm run dev                    # Start dev server (Vite, port 5173)
npm run build                  # Production build (tsc + vite)
npm run preview                # Preview production build locally
npm run lint                   # ESLint check
npm run format                 # Prettier format all src
npm run format:check           # Prettier check (CI)
npm run test                   # Run all tests (vitest)
npm run test -- path/to/file   # Run single test file
npm run test:watch             # Watch mode
npm run test:ui                # Vitest UI
```

### Infrastructure Commands (from `infra/`)
```bash
npx cdk synth                  # Synthesize CloudFormation
npx cdk diff                   # View pending changes
npx cdk deploy --all           # Deploy all stacks
npx cdk destroy --all          # Destroy all stacks
```

---

## Tech Stack

| Layer | Technologies |
|-------|--------------|
| Backend | Fastify 5, TypeScript, Prisma ORM, PostgreSQL, Redis (BullMQ) |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, XY Flow, React Router 7 |
| AI | Amazon Bedrock (Claude), Claude Agent SDK, Langfuse observability |
| Auth | AWS Cognito (OAuth) or Local JWT |
| Storage | AWS S3 (avatars, skills, workspaces) |
| Infrastructure | AWS CDK (EC2, RDS Aurora, ElastiCache, S3, Cognito, CloudFront) |

---

## Architecture

### Backend Layer Structure

```
backend/src/
├── routes/*.routes.ts      # Request handling, Zod validation, auth hooks
├── schemas/*.schema.ts     # Zod request/response schemas
├── services/*.service.ts   # Business logic, external integrations
├── repositories/*.ts       # Data access layer (Prisma queries)
├── middleware/             # Auth, error handling, logging
├── config/                 # Environment configuration
└── websocket/              # Real-time WebSocket gateway
```

**Request Flow:** Route → Schema Validation → Auth Middleware → Service → Repository → Database

### Backend Process Roles

The backend supports different runtime modes via `PROCESS_ROLE` env var:

| Role | Description |
|------|-------------|
| `all` (default) | Full monolith - API + workers + IM gateways |
| `api` | HTTP API only (horizontal scaling) |
| `worker` | BullMQ job processors, schedulers, distillation |
| `gateway` | IM long-lived connections (Slack, Discord, etc.) |

### Agent Runtime System

Multiple agent runtime implementations with factory pattern:

```
services/agent-runtime-factory.ts  # Selects runtime based on config
services/agent-runtime-claude.ts   # Claude Agent SDK (primary)
services/agent-runtime-agentcore.ts # AWS Bedrock AgentCore
services/agent-runtime-openclaw.ts  # OpenClaw adapter
```

### Chat Architecture

`chat.service.ts` orchestrates conversations:
1. Creates/resumes `ChatSession` with agent context
2. Loads skills, MCP servers, knowledge from Business Scope
3. Provisions isolated workspace directory
4. Streams responses via Claude Agent SDK
5. Persists messages to `chat_messages` table
6. Emits events for real-time WebSocket updates
7. Triggers memory distillation for scope learning

**Workspace Structure (Scope-Level Shared):**
```
/tmp/workspaces/{orgId}/{scopeId}/workspace/
├── CLAUDE.md              # Task context and instructions
├── workflow.json           # DAG with executionLayers (workflow runs)
├── .claude/
│   └── settings.json      # MCP servers, permissions
├── skills/                # Loaded skill definitions
└── plugins/               # Git-cloned plugins
```

All sessions within the same scope share a single workspace directory, enabling cross-session artifact visibility.

### Workflow Execution Engine

DAG-based workflow engine in `services/workflow-*.ts`:

| Component | Purpose |
|-----------|---------|
| `workflow-orchestrator.ts` | Node-by-node DAG execution with Kahn's algorithm |
| `workflow-executor-v2.ts` | Single-node execution with Claude |
| `workflow-queue.service.ts` | BullMQ job processing |
| `workflow-workspace.ts` | Isolated execution environments |

**Node Types:** `start`, `end`, `agent`, `action`, `condition`, `document`, `codeArtifact`, `humanApproval`

**Execution Features:**
- Parallel execution via DAG layers (nodes in same layer run concurrently as subagents)
- `workflow.json` written to workspace with `executionLayers` for Task tool dispatch
- Retry logic with exponential backoff (2s, 4s, 8s...)
- Checkpoint/pause/resume for human approval
- Real-time WebSocket progress updates
- Trigger types: manual, webhook, cron, API

### Frontend Architecture

```
frontend/src/
├── App.tsx                # React Router configuration
├── pages/                 # Page components (24+)
├── components/
│   ├── canvas/            # XY Flow workflow editor
│   └── chat/              # Chat message components
├── services/
│   ├── api/               # REST client and service implementations
│   └── ChatContext.tsx    # Chat state management
├── hooks/                 # Custom React hooks
└── types/                 # TypeScript type definitions
```

**State Management:** React Context + Custom Hooks pattern
- `AuthProvider` - Authentication state
- `ChatContext` - Chat session, messages, memory
- `ThemeProvider` - Dark/light mode
- `TranslationProvider` - i18n (en/zh)

**Key Routes:**
| Route | Purpose |
|-------|---------|
| `/` | Dashboard |
| `/chat` | Chat interface |
| `/workflow` | Workflow canvas editor |
| `/agents` | Agent management |
| `/projects/:id` | Kanban project board |
| `/config/*` | Admin settings (MCP, skills, knowledge) |
| `/apps` | Mini-SaaS marketplace |

### Infrastructure (AWS CDK)

Construct-based composition in `infra/lib/constructs/`:

| Construct | File | Purpose |
|-----------|------|---------|
| VPC | `vpc.ts` | 3-tier VPC (public, private, isolated subnets) with security groups |
| Data Layer | `data-layer.ts` | Aurora PostgreSQL 16 + ElastiCache Redis 7 |
| Secrets | `secrets.ts` | Secrets Manager for DB and app secrets |
| AgentCore | `agentcore.ts` | Bedrock AgentCore runtime + S3 Files filesystem |
| ECS Cluster | `ecs-cluster.ts` | Fargate services (api, worker, gateway) behind internal ALB |
| CDN | `cdn.ts` | CloudFront distribution + WAF → ALB origin; S3 frontend bucket |

**S3 Buckets:** `super-agent-workspace-{account}`, `super-agent-assets-{account}`, `super-agent-frontend-{account}`
**ECR Repos:** `super-agent-backend`, `super-agent-agentcore`

> **Maintenance:** When adding S3 buckets or ECR repos in `super-agent-stack.ts`, update this list.

---

## Database Schema

> **Maintenance:** After running `prisma:migrate` or modifying `schema.prisma`, verify the model count and update the tree/tables below if models were added, removed, or relationships changed.

### Multi-Tenancy Model

```
organizations (root tenant)
├── memberships → profiles (user access: owner/admin/member)
├── business_scopes (domain isolation)
│   ├── scope_memberships (scope-level RBAC)
│   ├── agents
│   ├── workflows → workflow_executions → node_executions
│   ├── chat_sessions → chat_messages
│   ├── scope_mcp_servers, scope_plugins
│   ├── scope_memories, scope_briefings
│   └── published_apps
├── skills → skill_marketplace
├── mcp_servers
├── credential_vault → data_connectors
└── user_groups (RBAC for skills/MCP access)
```

### Core Models

| Model | Purpose |
|-------|---------|
| `organizations` | Multi-tenant root, plan_type (free/pro/enterprise) |
| `business_scopes` | Domain container, scope_type (business/digital_twin) |
| `agents` | AI persona with system_prompt, model_config, tools |
| `skills` | Reusable capability packages (S3-stored) |
| `workflows` | DAG definition with nodes[] and connections[] |
| `chat_sessions` | Conversation container, room_mode (single/group) |
| `mcp_servers` | MCP tool definitions with config JSON |

### Key Relationships

- Agent ↔ Skills: Many-to-many via `agent_skills`
- Scope ↔ MCP Servers: Many-to-many via `scope_mcp_servers`
- Scope ↔ Document Groups: Many-to-many via `scope_document_groups`
- Workflow → Webhooks, Schedules (triggers)
- Chat Session → Messages, Room Members (group chat)

---

## Environment Variables

> **Maintenance:** After adding env vars to `backend/src/config/index.ts` or `docker-compose.yml`, update the list below if the var is non-obvious or has side effects.

See `docker-compose.yml` for the full set of env vars used in local development. Key non-obvious ones:

```bash
# Backend - runtime selection
AUTH_MODE=local|cognito              # Auth strategy
AGENT_RUNTIME=claude|agentcore|openclaw  # Which agent backend
PROCESS_ROLE=all|api|worker|gateway  # Process mode for scaling
CLAUDE_CODE_USE_BEDROCK=1            # Use Bedrock instead of direct API

# Backend - AgentCore
AGENTCORE_RUNTIME_ARN=               # Bedrock AgentCore runtime
AGENTCORE_WORKSPACE_S3_BUCKET=       # S3 workspace for AgentCore containers

# Backend - observability
LANGFUSE_SECRET_KEY=                 # Langfuse tracing (optional)
LANGFUSE_PUBLIC_KEY=
LANGFUSE_BASE_URL=

# Frontend
VITE_API_BASE_URL=http://localhost:3000
```

---

## API Structure

### Route Prefixes (non-exhaustive — 41 route files total)

| Prefix | Purpose | Auth |
|--------|---------|------|
| `/health` | Health check | None |
| `/api/auth/*` | Authentication | None |
| `/api/organizations/*` | Org management | JWT |
| `/api/business-scopes/*` | Scope CRUD | JWT |
| `/api/agents/*` | Agent management | JWT |
| `/api/skills/*` | Skills CRUD | JWT |
| `/api/workflows/*` | Workflow CRUD | JWT |
| `/api/chat/*` | Chat sessions/messages | JWT |
| `/api/mcp/*` | MCP server config | JWT |
| `/api/webhooks/*` | Webhook management | JWT |
| `/api/apps/*` | Published apps | JWT |
| `/api/projects/*` | Kanban project boards | JWT |
| `/api/documents/*` | Document management | JWT |
| `/api/tasks/*` | Task audit/execution | JWT |
| `/api/schedules/*` | Cron/trigger schedules | JWT |
| `/api/rag/*` | RAG retrieval | JWT |
| `/api/token-usage/*` | LLM token tracking | JWT |
| `/v1/chat/completions` | OpenAI-compatible proxy | API Key |

> **Maintenance:** When adding a route file, update the count above and add to this table if user-facing.

### Request Validation

All routes use Zod schemas from `backend/src/schemas/`:
```typescript
// Example: chat.schema.ts
const chatStreamRequestSchema = z.object({
  session_id: uuidSchema.optional(),
  business_scope_id: uuidSchema.optional(),
  message: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional(),
});
```

---

## Built-in Skills

Located in `backend/skills/`:

| Skill | Purpose |
|-------|---------|
| `app-builder` | Build full-stack mini-SaaS apps with React + Data API |
| `app-publisher` | Preview and deploy apps to platform marketplace |
| `skill-creator` | Create new reusable skills for agents |

### Seed Copilots

System copilots are auto-provisioned per organization on startup via `seed-copilot.service.ts`. Templates live in `backend/seeds/system-copilots/`:
- `workflow-copilot.json` — Workflow design assistant
- `scope-copilot.json` — Business scope configuration assistant
- `claude-code-agent.json` — General coding agent

**Skill Structure:**
```
backend/skills/{skill-name}/
└── SKILL.md    # Frontmatter (name, description) + documentation
```

Skills are stored in S3 with metadata in PostgreSQL. Loaded into agent workspace at chat/workflow runtime.

---

## Tool & MCP Routing

When a task requires external tooling, use this table to select the correct tool:

| Scenario | Route To | When NOT to use |
|----------|----------|-----------------|
| Query/inspect database schema or data | `mcp:postgres` | Schema changes (use Prisma CLI) |
| Look up AWS service docs, limits, API details | `mcp:aws` | Already documented in `infra/CLAUDE.md` |
| Look up library APIs (npm packages, SDKs) | `mcp:context7` | Standard Node/TS stdlib |
| Fetch a specific URL or API response | `mcp:fetch` | Already have the data locally |
| Multi-step reasoning / complex planning | `mcp:sequential-thinking` | Simple linear tasks |
| GitHub PRs, issues, actions | `mcp:github` | Local git operations (use Bash) |
| Infrastructure changes (CDK constructs) | `skill:cdk-infra` | Reading infra code (just use Read) |
| Database migrations, seeding, Prisma ops | `skill:prisma-ops` | Querying data (use mcp:postgres) |
| Start/stop/check dev servers | `skill:dev-server` | Production deployments |
| Run tests, check coverage | `skill:test-runner` | Manual verification at localhost:8080 |
| Lint and auto-fix code | `skill:lint-fix` | Already running in watch mode |
| Commit, push, create PRs | `skill:smart-commit` | Exploratory/uncommitted work |

**Default path:** If no row matches, use Bash directly or Read the relevant source.

---

## Behavioral Rules

- Always show design proposal before implementing. Wait for user confirmation.
- Do not refactor beyond what the task requires. No speculative abstractions.
- All chat UIs must reuse `components/chat/` and `ChatContext` — never create standalone chat implementations.
- When creating entities by name that may already exist, upsert — do not throw on collision.
- For UI verification, test at `localhost:8080` (Docker Compose) — not raw ports 3000/5173.
- If a command fails twice, report the error and ask — do not keep retrying silently.
- Do not use Playwright MCP for browser testing — use Puppeteer or AgentCore browser use.
- Never assume AWS service versions or features from training data — verify against `infra/` source or docs.

---

## Subdirectory Protocol

When operating in a subdirectory (`backend/`, `frontend/`, `infra/`, `agentcore/`):
1. Check for local `CLAUDE.md` — its patterns override root conventions for that scope
2. Run commands from that directory (not project root) unless explicitly cross-cutting
3. Root **Architecture Principles** and **Behavioral Rules** always apply regardless of subdirectory

---

## Architecture Principles

### Chat Component Reuse (Critical)
All chat-like UIs in the app MUST reuse the shared components from `frontend/src/components/chat/` and `ChatContext.tsx`. This includes: scope copilot, workflow copilot, project twin sessions, and any future conversational UIs. Never create standalone chat implementations — styling, file preview, streaming, and message rendering must all come from the shared base.

### Source-Based Session Types
Chat sessions use a `source` field (VARCHAR(20)) to differentiate business contexts (chat, workflow, project, scope-copilot, etc.). Don't modify existing source values. Add new values for new features. Business logic routes from the source to determine which external entity table to join.

### Upsert Pattern for Copilot-Created Entities
When AI copilots (scope copilot, workflow copilot) create resources like agents or skills, use upsert-by-name within the scope rather than failing on name collision. Users iterate via copilot and expect saves to work repeatedly.

### Workspace File Persistence
Copilot sessions should persist generated artifacts (scope configs, workflow definitions) to workspace files, not just chat output. This enables history tracking, version comparison, and resumption across sessions.

### Scope-Level Shared Workspace
All chat sessions within a scope share a single workspace directory (`{orgId}/{scopeId}/workspace/`). This means file artifacts from one session are visible to all others in the same scope. The `sessionId` parameter in workspace APIs is retained for backward compatibility but is not used in paths.

---

## Coding Standards

### General
- TypeScript strict mode
- English code and comments
- Node.js >= 18

### File Naming
- **Components/Pages:** PascalCase (`AgentCard.tsx`)
- **Services/Utils/Hooks:** camelCase (`chat.service.ts`)
- **Schemas:** `{resource}.schema.ts`
- **Routes:** `{resource}.routes.ts`

### Backend Patterns
- Zod for all API request/response validation
- Repository pattern for data access
- Service layer for business logic
- `AppError` class for domain errors with codes
- Async generators for streaming responses

### Frontend Patterns
- Functional components with Hooks
- Context + Custom Hooks for state management
- Tailwind CSS for styling
- Path aliases: `@/`, `@components/`, `@services/`, `@types/`

### Error Handling
```typescript
// Backend: Use AppError factory methods
throw AppError.notFound('Agent not found');
throw AppError.forbidden('Access denied');
throw AppError.validation('Invalid input', details);

// Response format
{ error: string, code: string, details?: any, requestId: string }
```

---

## Testing

### Backend (Vitest)
```bash
npm run test                   # Run all
npm run test -- agents         # Filter by name
npm run test:coverage          # With coverage
```

### Frontend (Vitest + React Testing Library)
```bash
npm run test                   # Run all
npm run test:ui                # Vitest UI
```

### Test Utilities
- `fast-check` for property-based testing
- `msw` for API mocking in frontend tests
- `jsdom` for DOM simulation

---

## Deployment

### Local Development (Docker Compose)

All services run in Docker containers with hot reload. Local code changes take effect immediately.

**Prerequisites:**
- Docker and Docker Compose
- AWS credentials configured (`~/.aws/credentials`)

**Quick Start:**
```bash
# 1. Build and start all services
docker compose up -d --build

# 2. Run database migrations (first time or after schema changes)
docker exec super-agent-backend npx prisma migrate deploy

# 3. Access the application
open http://localhost:8080
```

**Architecture:**
```
localhost:8080 (Nginx)
├── /api/*  → backend:3000 (Backend container)
├── /ws/*   → backend:3000 (WebSocket)
└── /*      → frontend:5173 (Frontend container)
```

**Hot Reload:**
- Backend: `tsx watch` auto-restarts on `.ts` file changes
- Frontend: Vite HMR updates the browser instantly on save
- Source directories are volume-mounted — no rebuild needed for code changes

**Docker Services:**
| Service | Image | Exposed Port | Purpose |
|---------|-------|--------------|---------|
| postgres | pgvector/pgvector:pg16 | - | Database with vector extension |
| redis | redis:7-alpine | - | Cache and job queues |
| backend | super-agent-backend | - | Fastify API server |
| frontend | super-agent-frontend | - | Vite dev server |
| nginx | nginx:alpine | 8080 | Reverse proxy (only exposed port) |

**Management Commands:**
```bash
# View status
docker compose ps

# View logs
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f nginx

# Stop all services
docker compose down

# Full reset (including database)
docker compose down -v
docker compose up -d --build
docker exec super-agent-backend npx prisma migrate deploy
```

**Configuration Files:**
- `docker-compose.yml` - All services definition
- `docker/nginx.conf` - Nginx reverse proxy config
- `backend/Dockerfile.dev` - Backend dev container
- `frontend/Dockerfile.dev` - Frontend dev container

**Environment Variables:**
All environment variables are defined in `docker-compose.yml` for the containers. AWS credentials are mounted from `~/.aws`.

**AgentCore Integration:**
Local dev uses the shared AgentCore runtime:
- Runtime ARN: `arn:aws:bedrock-agentcore:us-east-1:873543029686:runtime/SuperAgentEks_Runtime-3xzeklD05D`
- Workspace S3: `super-agent-local-dev-workspace`
- ECR: `873543029686.dkr.ecr.us-east-1.amazonaws.com/superagenteks-agentcore`
- **AgentCore requires ARM (linux/arm64) images.** Build natively on ARM hosts — do not cross-compile to amd64.

```bash
# Build and push agentcore image (use the script)
cd agentcore && ./build-and-push.sh

# Or manually — DOCKER_BUILDKIT=0 is critical: BuildKit adds attestation
# manifests (unknown/unknown arch) that break AgentCore microVM startup.
cd agentcore
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 873543029686.dkr.ecr.us-east-1.amazonaws.com
DOCKER_BUILDKIT=0 docker build --platform linux/arm64 -t 873543029686.dkr.ecr.us-east-1.amazonaws.com/superagenteks-agentcore:latest .
docker push 873543029686.dkr.ecr.us-east-1.amazonaws.com/superagenteks-agentcore:latest
```

### Production (AWS ECS Fargate)
```bash
# Deploy all infrastructure (VPC, Aurora, Redis, ECS, CDN)
cd infra && npx cdk deploy --all

# View pending changes before deploying
cd infra && npx cdk diff
```

Architecture: CloudFront → internal ALB → ECS Fargate services (api, worker, gateway). Frontend served from S3 via CloudFront.

### CI/CD (GitHub Actions)
- Push to `main` triggers automatic deployment
- Jobs: Build/Test → Infrastructure (CDK) → Deploy Application → Smoke Test
- Artifacts: backend Docker image → ECR, frontend/dist → S3
