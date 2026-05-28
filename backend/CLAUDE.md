# Backend — CLAUDE.md

> Fastify 5 + TypeScript + Prisma monolith serving API, workers, and IM gateways.

## Commands

```bash
npm run dev                    # tsx watch (port 3000)
npm run build                  # tsc → dist/
npm run start                  # node dist/index.js
npm run lint                   # ESLint
npm run lint:fix               # ESLint auto-fix
npm run format                 # Prettier write
npm run format:check           # Prettier CI check
npm run test                   # vitest run
npm run test -- path/to/file   # Single file
npm run test:watch             # Watch mode
npm run test:coverage          # Coverage report
npm run prisma:generate        # Regenerate Prisma Client
npm run prisma:migrate         # Create/apply dev migration
npm run prisma:migrate:prod    # Apply migrations (production)
```

## Architecture

```
src/
├── index.ts              # Entry: starts Fastify, resets stale sessions, seeds copilots
├── app.ts                # Builds Fastify instance (CORS, Swagger, routes, WS, queues)
├── routes/*.routes.ts    # HTTP handlers — validate with Zod, call services
├── schemas/*.schema.ts   # Zod request/response shapes
├── services/*.service.ts # Business logic, external integrations
├── repositories/*.ts     # Data access (Prisma queries, BaseRepository)
├── middleware/           # auth, errorHandler, requestLogger, scopeAccess
├── config/               # Zod-validated env schema, database, queue
├── websocket/            # execution + workspace WS gateways
├── setup/                # Event bridge, queue initialization, schedulers
└── utils/                # SSE helpers, claude-config, json-repair, workflow-graph
```

## Request Flow

```
Route → Zod schema validation → authenticate() hook → Service → Repository → Prisma/DB
                                 ↳ requireModifyAccess() for writes
                                 ↳ requireScopeAccess() for scope-scoped routes
```

## Key Patterns

### Route Registration
Routes export an `async function(app: FastifyInstance)` and are registered in `routes/index.ts`. Each route applies `authenticate` as a preHandler hook.

### Repository Layer
All repos extend `BaseRepository<T>` which provides `findAll`, `findById`, `create`, `update`, `delete`, `findAllPaginated`, `findFirst`, `count`, `exists` with org-scoped filtering built in.

### Config
`config/index.ts` uses a Zod schema to parse and validate ALL env vars at startup. Access via `import { config } from './config/index.js'`.

### Error Handling
```typescript
import { AppError } from '../middleware/errorHandler.js';
throw AppError.notFound('Resource not found');
throw AppError.forbidden('No access');
throw AppError.validation('Bad input', zodErrors);
```

### Streaming (SSE)
Chat responses stream via SSE using `utils/sse.ts` helpers (`formatSSEEvent`). The reply is a raw Node stream — don't call `reply.send()`.

### Agent Runtimes
Factory pattern in `services/agent-runtime-factory.ts`:
- `agent-runtime-claude.ts` — Claude Agent SDK (primary)
- `agent-runtime-agentcore.ts` — AWS Bedrock AgentCore (container isolation)
- `agent-runtime-openclaw.ts` — OpenClaw adapter

Selected by `AGENT_RUNTIME` env var.

### Process Roles
`PROCESS_ROLE` env var controls what runs in the process:
- `all` — full monolith (default)
- `api` — HTTP routes only
- `worker` — BullMQ processors, schedulers
- `gateway` — IM long-lived connections

### Workspace Manager
`services/workspace-manager.ts` provisions scope workspaces at `/tmp/workspaces/{orgId}/{scopeId}/workspace/`. Creates CLAUDE.md, loads skills, clones plugins, writes MCP settings.

## Database

Schema: `prisma/schema.prisma` (67 models)

After changing the schema:
```bash
npm run prisma:migrate    # Creates migration + regenerates client
```

Multi-tenancy: all queries filter by `organization_id`. Scope-level resources additionally filter by `business_scope_id`.

## WebSocket

Two gateways registered in `app.ts` via `@fastify/websocket`:
- `websocket/execution.gateway.ts` — workflow execution progress events
- `websocket/workspace.gateway.ts` — workspace file change events

Client protocol: JSON messages (`subscribe`, `unsubscribe`, `ping`). Server pushes events via an event bridge (`setup/event-websocket-bridge.ts`).

## Testing

Vitest with no special setup. Tests live in:
- `tests/property/*.property.test.ts` — property-based (fast-check)
- `tests/integration/*.integration.test.ts` — integration tests
- Inline `*.test.ts` near source files

Mock Prisma/services with `vi.mock()`.

## Gotchas

- `.js` extensions in imports are required (ESM output). Write `from './foo.js'` even though the source is `.ts`.
- Body limit is 50MB (for base64 document uploads).
- `backend.log` file is written by custom console.log tee in `app.ts` — don't rely on it in production.
- Startup resets any `chat_sessions` stuck in `generating` status.
- Swagger UI available at `/docs` in dev mode.
