# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
npm run lint                   # ESLint check
npm run lint:fix               # ESLint auto-fix
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
npm run lint                   # ESLint check
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

**Workspace Structure:**
```
/tmp/workspaces/{sessionId}/
├── CLAUDE.md              # Task context and instructions
├── .claude/
│   └── settings.json      # MCP servers, permissions
├── skills/                # Loaded skill definitions
└── plugins/               # Git-cloned plugins
```

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

**Core Resources (Always Created):**
- EC2 (t4g.small, Ubuntu 22.04) with Elastic IP
- RDS PostgreSQL 16.6 (t4g.micro, Aurora-compatible)
- ElastiCache Redis 7.1 (cache.t4g.micro)
- S3 Buckets: avatars, skills, workspaces
- IAM Role with Bedrock, S3, Secrets Manager permissions

**Optional Resources:**
- Cognito User Pool (when `authMode=cognito`)
- CloudFront CDN + Route53 (when `enableCdn=true`)

---

## Database Schema

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

### Backend Configuration (`backend/.env`)

**Server:**
```bash
PORT=3000
HOST=0.0.0.0
NODE_ENV=development|production|test
LOG_LEVEL=info|debug|trace
CORS_ORIGIN=*  # Comma-separated for production
```

**Database & Cache:**
```bash
DATABASE_URL=postgresql://user:pass@host:5432/super_agent
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
```

**Authentication:**
```bash
AUTH_MODE=local|cognito

# Local mode
JWT_SECRET=your-secret-key

# Cognito mode
COGNITO_USER_POOL_ID=
COGNITO_CLIENT_ID=
COGNITO_REGION=us-west-2
COGNITO_DOMAIN=
```

**AWS & Storage:**
```bash
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET_NAME=super-agent-files
SKILLS_S3_BUCKET=super-agent-skills
S3_PRESIGNED_URL_EXPIRES=3600
```

**AI/LLM:**
```bash
ANTHROPIC_API_KEY=           # Direct Anthropic API
CLAUDE_CODE_USE_BEDROCK=1    # Use AWS Bedrock instead
CLAUDE_MODEL=claude-sonnet-4-5-20250929
AGENT_RUNTIME=claude|agentcore|openclaw
AGENT_WORKSPACE_BASE_DIR=/tmp/workspaces
CLAUDE_SESSION_TIMEOUT_MS=1800000
CLAUDE_MAX_CONCURRENT_SESSIONS=10
```

**AgentCore (Container Isolation):**
```bash
AGENTCORE_RUNTIME_ARN=
AGENTCORE_EXECUTION_ROLE_ARN=
AGENTCORE_BACKEND_API_URL=
AGENTCORE_WORKSPACE_S3_BUCKET=
```

**Observability:**
```bash
LANGFUSE_SECRET_KEY=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_BASE_URL=
```

**Process Scaling:**
```bash
PROCESS_ROLE=all|api|worker|gateway
```

### Frontend Configuration (`frontend/.env`)

```bash
VITE_API_BASE_URL=http://localhost:3000
VITE_USE_MOCK=false

# Cognito mode
VITE_COGNITO_USER_POOL_ID=
VITE_COGNITO_CLIENT_ID=
VITE_COGNITO_DOMAIN=
VITE_COGNITO_REGION=
```

---

## API Structure

### Route Prefixes

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
| `/v1/chat/completions` | OpenAI-compatible proxy | API Key |

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

**Skill Structure:**
```
backend/skills/{skill-name}/
└── SKILL.md    # Frontmatter (name, description) + documentation
```

Skills are stored in S3 with metadata in PostgreSQL. Loaded into agent workspace at chat/workflow runtime.

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

### Production (AWS)
```bash
# Deploy infrastructure
cd infra && npx cdk deploy -c stackName=SuperAgent

# Deploy application
./infra/scripts/deploy.sh --stack SuperAgent
```

### CI/CD (GitHub Actions)
- Push to `main` triggers automatic deployment
- Jobs: Build/Test → Infrastructure (CDK) → Deploy Application → Smoke Test
- Artifacts: backend (compiled), frontend/dist
