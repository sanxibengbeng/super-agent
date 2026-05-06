# Workspace Events Phase 0: Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the unified workspace event infrastructure (DB tables, EventBus service, WebSocket gateway, Redis pub/sub, Reconciler, frontend hook, recovery API) without modifying any existing behavior.

**Architecture:** New `execution_tasks` and `execution_events` tables track execution intent and events. A `WorkspaceEventBus` service persists events and broadcasts via Redis pub/sub to a new `WorkspaceWebSocketGateway`. Frontend connects via `useWorkspaceEvents` hook with disconnect recovery. A BullMQ-based `ExecutionReconciler` periodically reconciles stuck tasks against S3.

**Tech Stack:** Prisma (migration), ioredis (pub/sub), @fastify/websocket (WS gateway), BullMQ (reconciler job), Vitest (tests), React hooks (frontend)

**Spec:** `docs/superpowers/specs/2026-05-06-workspace-chat-integration-design.md`

---

## File Structure

### Backend — New Files
| File | Responsibility |
|------|---------------|
| `backend/prisma/migrations/2026MMDD_add_execution_tasks/migration.sql` | DB schema for execution_tasks + execution_events |
| `backend/src/services/workspace-event-bus.ts` | Central event coordination: persist + broadcast |
| `backend/src/services/execution-reconciler.service.ts` | Periodic reconciliation of stuck tasks against S3 |
| `backend/src/repositories/execution-task.repository.ts` | Data access for execution_tasks table |
| `backend/src/repositories/execution-event.repository.ts` | Data access for execution_events table |
| `backend/src/websocket/workspace.gateway.ts` | WebSocket gateway at `/ws/workspace` with JWT auth |
| `backend/src/routes/workspace-events.routes.ts` | Recovery API endpoint |
| `backend/src/schemas/workspace-events.schema.ts` | Zod schemas for workspace events |

### Backend — Modified Files
| File | Change |
|------|--------|
| `backend/prisma/schema.prisma` | Add execution_tasks + execution_events models |
| `backend/src/services/redis.service.ts` | Add pub/sub methods |
| `backend/src/app.ts` | Register new gateway + reconciler + routes |
| `backend/src/services/index.ts` | Export new services |

### Frontend — New Files
| File | Responsibility |
|------|---------------|
| `frontend/src/services/workspaceSocketClient.ts` | Singleton WebSocket connection manager |
| `frontend/src/hooks/useWorkspaceEvents.ts` | React hook for subscribing to workspace events |
| `frontend/src/components/WorkspaceRecoveryBanner.tsx` | Notification banner for offline recovery |

### Test Files
| File | Responsibility |
|------|---------------|
| `backend/tests/unit/workspace-event-bus.test.ts` | EventBus unit tests |
| `backend/tests/unit/workspace-gateway.test.ts` | WebSocket gateway unit tests |
| `backend/tests/unit/execution-reconciler.test.ts` | Reconciler unit tests |
| `frontend/src/hooks/useWorkspaceEvents.test.ts` | Hook unit tests |

---

## Task 1: Database Migration — execution_tasks + execution_events

**Files:**
- Create: `backend/prisma/migrations/20260506100000_add_execution_tasks/migration.sql`
- Modify: `backend/prisma/schema.prisma`

- [ ] **Step 1: Add Prisma models to schema.prisma**

Add after the last model in the schema file:

```prisma
// ============================================================================
// Execution Tasks - tracks execution intent for workspace event reconciliation
// ============================================================================
model execution_tasks {
  id                  String    @id @default(uuid()) @db.Uuid
  org_id              String    @db.Uuid
  session_id          String    @db.Uuid
  source              String    @db.VarChar(30)   // scope_copilot | workflow | project | twin_session
  source_entity_id    String?   @db.Uuid
  runtime             String    @db.VarChar(20)   // claude | agentcore
  runtime_session_id  String?   @db.VarChar(100)
  workspace_bucket    String?   @db.VarChar(200)
  workspace_prefix    String?   @db.VarChar(500)
  status              String    @default("pending") @db.VarChar(20) // pending | running | completed | failed | timeout | cancelled
  started_at          DateTime? @db.Timestamptz
  completed_at        DateTime? @db.Timestamptz
  error_message       String?
  created_by          String?   @db.Uuid
  created_at          DateTime  @default(now()) @db.Timestamptz
  updated_at          DateTime  @default(now()) @updatedAt @db.Timestamptz

  organization    organizations   @relation(fields: [org_id], references: [id], onDelete: Cascade)
  session         chat_sessions   @relation(fields: [session_id], references: [id], onDelete: Cascade)
  execution_events execution_events[]

  @@index([session_id])
  @@index([org_id])
  @@index([status])
  @@index([source])
  @@index([created_at(sort: Desc)])
}

// ============================================================================
// Execution Events - persistent event log for workspace change notifications
// ============================================================================
model execution_events {
  id          String   @id @default(uuid()) @db.Uuid
  task_id     String   @db.Uuid
  session_id  String   @db.Uuid
  type        String   @db.VarChar(30) // task_started | task_completed | task_failed | task_timeout | files_changed
  payload     Json     @default("{}")
  created_at  DateTime @default(now()) @db.Timestamptz

  task        execution_tasks @relation(fields: [task_id], references: [id], onDelete: Cascade)
  session     chat_sessions   @relation(fields: [session_id], references: [id], onDelete: Cascade)

  @@index([session_id, created_at])
  @@index([task_id])
}
```

Also add the reverse relations to the `organizations` and `chat_sessions` models:

In `organizations` model, add:
```prisma
  execution_tasks          execution_tasks[]
```

In `chat_sessions` model, add:
```prisma
  execution_tasks  execution_tasks[]
  execution_events execution_events[]
```

- [ ] **Step 2: Generate the migration**

Run:
```bash
cd backend && npx prisma migrate dev --name add_execution_tasks --create-only
```

Expected: Creates migration file in `backend/prisma/migrations/` with the SQL.

- [ ] **Step 3: Run the migration**

Run:
```bash
cd backend && npx prisma migrate dev
```

Expected: Migration applied, Prisma Client regenerated.

- [ ] **Step 4: Verify by generating client**

Run:
```bash
cd backend && npx prisma generate
```

Expected: No errors, `execution_tasks` and `execution_events` models available in PrismaClient.

- [ ] **Step 5: Commit**

```bash
cd backend && git add prisma/ && git commit -m "feat: add execution_tasks and execution_events tables for workspace event tracking"
```

---

## Task 2: Execution Task Repository

**Files:**
- Create: `backend/src/repositories/execution-task.repository.ts`
- Test: `backend/tests/unit/execution-task-repository.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/unit/execution-task-repository.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = {
  execution_tasks: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock('../../src/config/database.js', () => ({
  prisma: mockPrisma,
}));

import { executionTaskRepository } from '../../src/repositories/execution-task.repository.js';

describe('ExecutionTaskRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create an execution task', async () => {
      const input = {
        org_id: 'org-1',
        session_id: 'session-1',
        source: 'project' as const,
        runtime: 'agentcore' as const,
        created_by: 'user-1',
      };
      mockPrisma.execution_tasks.create.mockResolvedValue({ id: 'task-1', ...input, status: 'pending' });

      const result = await executionTaskRepository.create(input);

      expect(mockPrisma.execution_tasks.create).toHaveBeenCalledWith({ data: input });
      expect(result.id).toBe('task-1');
      expect(result.status).toBe('pending');
    });
  });

  describe('findStale', () => {
    it('should find tasks in running state older than threshold', async () => {
      const staleTasks = [{ id: 'task-1', status: 'running' }];
      mockPrisma.execution_tasks.findMany.mockResolvedValue(staleTasks);

      const result = await executionTaskRepository.findStale(5 * 60 * 1000);

      expect(mockPrisma.execution_tasks.findMany).toHaveBeenCalledWith({
        where: {
          status: 'running',
          updated_at: { lt: expect.any(Date) },
        },
      });
      expect(result).toEqual(staleTasks);
    });
  });

  describe('updateStatusWhere', () => {
    it('should only update task if current status matches', async () => {
      mockPrisma.execution_tasks.updateMany.mockResolvedValue({ count: 1 });

      const updated = await executionTaskRepository.updateStatusWhere(
        'task-1',
        'running',
        { status: 'completed', completed_at: new Date() }
      );

      expect(updated).toBe(1);
      expect(mockPrisma.execution_tasks.updateMany).toHaveBeenCalledWith({
        where: { id: 'task-1', status: 'running' },
        data: expect.objectContaining({ status: 'completed' }),
      });
    });

    it('should return 0 if status does not match', async () => {
      mockPrisma.execution_tasks.updateMany.mockResolvedValue({ count: 0 });

      const updated = await executionTaskRepository.updateStatusWhere(
        'task-1',
        'running',
        { status: 'completed', completed_at: new Date() }
      );

      expect(updated).toBe(0);
    });
  });

  describe('findBySessionId', () => {
    it('should return tasks for a session ordered by creation', async () => {
      const tasks = [{ id: 'task-2' }, { id: 'task-1' }];
      mockPrisma.execution_tasks.findMany.mockResolvedValue(tasks);

      const result = await executionTaskRepository.findBySessionId('session-1');

      expect(mockPrisma.execution_tasks.findMany).toHaveBeenCalledWith({
        where: { session_id: 'session-1' },
        orderBy: { created_at: 'desc' },
      });
      expect(result).toEqual(tasks);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm run test -- tests/unit/execution-task-repository.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `backend/src/repositories/execution-task.repository.ts`:

```typescript
import { prisma } from '../config/database.js';

export interface CreateExecutionTaskInput {
  org_id: string;
  session_id: string;
  source: string;
  source_entity_id?: string;
  runtime: string;
  runtime_session_id?: string;
  workspace_bucket?: string;
  workspace_prefix?: string;
  created_by?: string;
}

export interface UpdateExecutionTaskData {
  status?: string;
  started_at?: Date;
  completed_at?: Date;
  error_message?: string;
  runtime_session_id?: string;
  workspace_bucket?: string;
  workspace_prefix?: string;
}

class ExecutionTaskRepository {
  async create(data: CreateExecutionTaskInput) {
    return prisma.execution_tasks.create({ data });
  }

  async findById(id: string) {
    return prisma.execution_tasks.findUnique({ where: { id } });
  }

  async findBySessionId(sessionId: string) {
    return prisma.execution_tasks.findMany({
      where: { session_id: sessionId },
      orderBy: { created_at: 'desc' },
    });
  }

  async findStale(thresholdMs: number) {
    const cutoff = new Date(Date.now() - thresholdMs);
    return prisma.execution_tasks.findMany({
      where: {
        status: 'running',
        updated_at: { lt: cutoff },
      },
    });
  }

  async updateStatusWhere(
    id: string,
    expectedStatus: string,
    data: UpdateExecutionTaskData,
  ): Promise<number> {
    const result = await prisma.execution_tasks.updateMany({
      where: { id, status: expectedStatus },
      data,
    });
    return result.count;
  }

  async update(id: string, data: UpdateExecutionTaskData) {
    return prisma.execution_tasks.update({ where: { id }, data });
  }
}

export const executionTaskRepository = new ExecutionTaskRepository();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm run test -- tests/unit/execution-task-repository.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repositories/execution-task.repository.ts backend/tests/unit/execution-task-repository.test.ts
git commit -m "feat: add ExecutionTaskRepository with optimistic status updates"
```

---

## Task 3: Execution Event Repository

**Files:**
- Create: `backend/src/repositories/execution-event.repository.ts`
- Test: `backend/tests/unit/execution-event-repository.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/unit/execution-event-repository.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = {
  execution_events: {
    create: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
};

vi.mock('../../src/config/database.js', () => ({
  prisma: mockPrisma,
}));

import { executionEventRepository } from '../../src/repositories/execution-event.repository.js';

describe('ExecutionEventRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create an event and return it with id', async () => {
      const input = {
        task_id: 'task-1',
        session_id: 'session-1',
        type: 'task_completed',
        payload: { files_modified: ['scope-config.json'] },
      };
      mockPrisma.execution_events.create.mockResolvedValue({ id: 'evt-1', ...input });

      const result = await executionEventRepository.create(input);

      expect(result.id).toBe('evt-1');
      expect(mockPrisma.execution_events.create).toHaveBeenCalledWith({ data: input });
    });
  });

  describe('findAfter', () => {
    it('should return events after a given event ID for a session', async () => {
      const refEvent = { id: 'evt-5', created_at: new Date('2026-05-06T10:00:00Z') };
      const laterEvents = [{ id: 'evt-6' }, { id: 'evt-7' }];

      mockPrisma.execution_events.findMany
        .mockResolvedValueOnce([refEvent])
        .mockResolvedValueOnce(laterEvents);

      const result = await executionEventRepository.findAfter('session-1', 'evt-5');

      expect(result).toEqual(laterEvents);
    });

    it('should return all events if afterEventId is null', async () => {
      const allEvents = [{ id: 'evt-1' }, { id: 'evt-2' }];
      mockPrisma.execution_events.findMany.mockResolvedValue(allEvents);

      const result = await executionEventRepository.findAfter('session-1', null);

      expect(mockPrisma.execution_events.findMany).toHaveBeenCalledWith({
        where: { session_id: 'session-1' },
        orderBy: { created_at: 'asc' },
      });
      expect(result).toEqual(allEvents);
    });
  });

  describe('deleteOlderThan', () => {
    it('should delete events older than given date', async () => {
      mockPrisma.execution_events.deleteMany.mockResolvedValue({ count: 42 });

      const cutoff = new Date('2026-04-29T00:00:00Z');
      const count = await executionEventRepository.deleteOlderThan(cutoff);

      expect(count).toBe(42);
      expect(mockPrisma.execution_events.deleteMany).toHaveBeenCalledWith({
        where: { created_at: { lt: cutoff } },
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm run test -- tests/unit/execution-event-repository.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `backend/src/repositories/execution-event.repository.ts`:

```typescript
import { prisma } from '../config/database.js';

export interface CreateExecutionEventInput {
  task_id: string;
  session_id: string;
  type: string;
  payload: Record<string, unknown>;
}

class ExecutionEventRepository {
  async create(data: CreateExecutionEventInput) {
    return prisma.execution_events.create({ data });
  }

  async findAfter(sessionId: string, afterEventId: string | null) {
    if (!afterEventId) {
      return prisma.execution_events.findMany({
        where: { session_id: sessionId },
        orderBy: { created_at: 'asc' },
      });
    }

    const refEvents = await prisma.execution_events.findMany({
      where: { id: afterEventId },
      select: { created_at: true },
    });

    if (refEvents.length === 0) {
      return prisma.execution_events.findMany({
        where: { session_id: sessionId },
        orderBy: { created_at: 'asc' },
      });
    }

    return prisma.execution_events.findMany({
      where: {
        session_id: sessionId,
        created_at: { gt: refEvents[0].created_at },
      },
      orderBy: { created_at: 'asc' },
    });
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const result = await prisma.execution_events.deleteMany({
      where: { created_at: { lt: cutoff } },
    });
    return result.count;
  }
}

export const executionEventRepository = new ExecutionEventRepository();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm run test -- tests/unit/execution-event-repository.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repositories/execution-event.repository.ts backend/tests/unit/execution-event-repository.test.ts
git commit -m "feat: add ExecutionEventRepository with findAfter for recovery and TTL cleanup"
```

---

## Task 4: Redis Pub/Sub Extension

**Files:**
- Modify: `backend/src/services/redis.service.ts`
- Test: `backend/tests/unit/redis-pubsub.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/unit/redis-pubsub.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  ping: vi.fn().mockResolvedValue('PONG'),
  on: vi.fn(),
  duplicate: vi.fn(),
  publish: vi.fn().mockResolvedValue(1),
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  quit: vi.fn().mockResolvedValue('OK'),
};

const mockSubscriber = {
  on: vi.fn(),
  psubscribe: vi.fn().mockResolvedValue(undefined),
  punsubscribe: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue('OK'),
};

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => {
    const instance = { ...mockClient };
    instance.duplicate = vi.fn().mockReturnValue(mockSubscriber);
    return instance;
  }),
}));

import { RedisService } from '../../src/services/redis.service.js';

describe('RedisService Pub/Sub', () => {
  let service: RedisService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new RedisService();
    await service.initialize();
  });

  describe('publish', () => {
    it('should publish a message to a channel', async () => {
      await service.publish('workspace:events:session-1', '{"type":"task_completed"}');

      expect(mockClient.publish).toHaveBeenCalledWith(
        'workspace:events:session-1',
        '{"type":"task_completed"}'
      );
    });
  });

  describe('psubscribe', () => {
    it('should create a subscriber and register pattern handler', async () => {
      const handler = vi.fn();
      await service.psubscribe('workspace:events:*', handler);

      expect(mockClient.duplicate).toHaveBeenCalled();
      expect(mockSubscriber.psubscribe).toHaveBeenCalledWith('workspace:events:*');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm run test -- tests/unit/redis-pubsub.test.ts`

Expected: FAIL — `publish` and `psubscribe` methods don't exist on RedisService.

- [ ] **Step 3: Add pub/sub methods to RedisService**

Add the following methods to the `RedisService` class in `backend/src/services/redis.service.ts`, after the existing `shutdown()` method:

```typescript
  private subscriber: Redis | null = null;
  private patternHandlers: Map<string, (channel: string, message: string) => void> = new Map();

  async publish(channel: string, message: string): Promise<void> {
    if (!this.client) {
      throw new Error('Redis service not initialized');
    }
    await this.client.publish(channel, message);
  }

  async psubscribe(pattern: string, handler: (channel: string, message: string) => void): Promise<void> {
    if (!this.client) {
      throw new Error('Redis service not initialized');
    }

    if (!this.subscriber) {
      this.subscriber = this.client.duplicate();
      this.subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
        for (const [p, h] of this.patternHandlers.entries()) {
          if (this.matchPattern(p, channel)) {
            h(channel, message);
          }
        }
      });
    }

    this.patternHandlers.set(pattern, handler);
    await this.subscriber.psubscribe(pattern);
  }

  async punsubscribe(pattern: string): Promise<void> {
    this.patternHandlers.delete(pattern);
    if (this.subscriber) {
      await this.subscriber.punsubscribe(pattern);
    }
  }

  private matchPattern(pattern: string, channel: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(channel);
  }
```

Also update the `shutdown()` method to close the subscriber:

```typescript
  async shutdown(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.initialized = false;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm run test -- tests/unit/redis-pubsub.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/redis.service.ts backend/tests/unit/redis-pubsub.test.ts
git commit -m "feat: add pub/sub capability to RedisService for cross-instance event broadcasting"
```

---

## Task 5: WorkspaceEventBus Service

**Files:**
- Create: `backend/src/services/workspace-event-bus.ts`
- Test: `backend/tests/unit/workspace-event-bus.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/unit/workspace-event-bus.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEventRepo = {
  create: vi.fn(),
};

const mockTaskRepo = {
  update: vi.fn(),
};

const mockGateway = {
  broadcastToLocal: vi.fn(),
};

const mockRedis = {
  publish: vi.fn().mockResolvedValue(undefined),
  psubscribe: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/repositories/execution-event.repository.js', () => ({
  executionEventRepository: mockEventRepo,
}));

vi.mock('../../src/repositories/execution-task.repository.js', () => ({
  executionTaskRepository: mockTaskRepo,
}));

vi.mock('../../src/websocket/workspace.gateway.js', () => ({
  workspaceWebSocketGateway: mockGateway,
}));

vi.mock('../../src/services/redis.service.js', () => ({
  redisService: mockRedis,
}));

import { WorkspaceEventBus } from '../../src/services/workspace-event-bus.js';

describe('WorkspaceEventBus', () => {
  let bus: WorkspaceEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new WorkspaceEventBus();
  });

  describe('emit', () => {
    it('should persist event, broadcast locally, and publish to Redis', async () => {
      const event = {
        task_id: 'task-1',
        session_id: 'session-1',
        type: 'task_completed' as const,
        payload: { files_modified: ['scope-config.json'] },
      };
      const savedEvent = { id: 'evt-1', ...event, created_at: new Date().toISOString() };
      mockEventRepo.create.mockResolvedValue(savedEvent);

      await bus.emit(event);

      expect(mockEventRepo.create).toHaveBeenCalledWith(event);
      expect(mockGateway.broadcastToLocal).toHaveBeenCalledWith('session-1', savedEvent);
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'workspace:events:session-1',
        JSON.stringify(savedEvent)
      );
    });

    it('should still broadcast even if DB persistence fails', async () => {
      const event = {
        task_id: 'task-1',
        session_id: 'session-1',
        type: 'files_changed' as const,
        payload: {},
      };
      mockEventRepo.create.mockRejectedValue(new Error('DB error'));

      await expect(bus.emit(event)).rejects.toThrow('DB error');

      expect(mockGateway.broadcastToLocal).not.toHaveBeenCalled();
    });
  });

  describe('handleRemoteEvent', () => {
    it('should broadcast remote events to local WebSocket clients', () => {
      const event = { id: 'evt-2', session_id: 'session-1', type: 'task_started', payload: {} };

      bus.handleRemoteEvent('workspace:events:session-1', JSON.stringify(event));

      expect(mockGateway.broadcastToLocal).toHaveBeenCalledWith('session-1', event);
    });

    it('should not throw on malformed messages', () => {
      expect(() => bus.handleRemoteEvent('workspace:events:x', 'not json')).not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm run test -- tests/unit/workspace-event-bus.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/workspace-event-bus.ts`:

```typescript
import { executionEventRepository, type CreateExecutionEventInput } from '../repositories/execution-event.repository.js';
import { workspaceWebSocketGateway } from '../websocket/workspace.gateway.js';
import { redisService } from './redis.service.js';

export type WorkspaceEventType =
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_timeout'
  | 'files_changed'
  | 'heartbeat';

export interface WorkspaceEvent {
  id: string;
  task_id: string;
  session_id: string;
  type: WorkspaceEventType;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface EmitEventInput {
  task_id: string;
  session_id: string;
  type: WorkspaceEventType;
  payload: Record<string, unknown>;
}

const REDIS_CHANNEL_PREFIX = 'workspace:events:';

export class WorkspaceEventBus {
  async initialize(): Promise<void> {
    await redisService.psubscribe(`${REDIS_CHANNEL_PREFIX}*`, (channel, message) => {
      this.handleRemoteEvent(channel, message);
    });
  }

  async emit(input: EmitEventInput): Promise<WorkspaceEvent> {
    const saved = await executionEventRepository.create({
      task_id: input.task_id,
      session_id: input.session_id,
      type: input.type,
      payload: input.payload,
    });

    const event: WorkspaceEvent = {
      id: saved.id,
      task_id: saved.task_id,
      session_id: saved.session_id,
      type: saved.type as WorkspaceEventType,
      payload: saved.payload as Record<string, unknown>,
      created_at: saved.created_at.toISOString(),
    };

    workspaceWebSocketGateway.broadcastToLocal(input.session_id, event);

    await redisService.publish(
      `${REDIS_CHANNEL_PREFIX}${input.session_id}`,
      JSON.stringify(event)
    );

    return event;
  }

  handleRemoteEvent(channel: string, message: string): void {
    try {
      const event = JSON.parse(message);
      const sessionId = channel.replace(REDIS_CHANNEL_PREFIX, '');
      workspaceWebSocketGateway.broadcastToLocal(sessionId, event);
    } catch {
      // Malformed message — log and skip
    }
  }

  async shutdown(): Promise<void> {
    await redisService.punsubscribe(`${REDIS_CHANNEL_PREFIX}*`);
  }
}

export const workspaceEventBus = new WorkspaceEventBus();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm run test -- tests/unit/workspace-event-bus.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/workspace-event-bus.ts backend/tests/unit/workspace-event-bus.test.ts
git commit -m "feat: add WorkspaceEventBus with DB persistence and Redis pub/sub broadcast"
```

---

## Task 6: Workspace WebSocket Gateway

**Files:**
- Create: `backend/src/websocket/workspace.gateway.ts`
- Test: `backend/tests/unit/workspace-gateway.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/unit/workspace-gateway.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceWebSocketGateway } from '../../src/websocket/workspace.gateway.js';

function createMockSocket() {
  return {
    readyState: 1, // OPEN
    OPEN: 1,
    send: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
  };
}

describe('WorkspaceWebSocketGateway', () => {
  let gateway: WorkspaceWebSocketGateway;

  beforeEach(() => {
    gateway = new WorkspaceWebSocketGateway();
  });

  describe('handleConnection', () => {
    it('should track the new client', () => {
      const socket = createMockSocket();
      gateway.handleConnection(socket as any);

      expect(gateway.getClientCount()).toBe(1);
    });
  });

  describe('subscribe/unsubscribe', () => {
    it('should track session subscriptions for a client', () => {
      const socket = createMockSocket();
      gateway.handleConnection(socket as any);

      gateway.handleSubscribe(socket as any, 'session-1');

      expect(gateway.getSubscriberCount('session-1')).toBe(1);
    });

    it('should remove subscription on unsubscribe', () => {
      const socket = createMockSocket();
      gateway.handleConnection(socket as any);
      gateway.handleSubscribe(socket as any, 'session-1');

      gateway.handleUnsubscribe(socket as any, 'session-1');

      expect(gateway.getSubscriberCount('session-1')).toBe(0);
    });
  });

  describe('broadcastToLocal', () => {
    it('should send event to all subscribers of a session', () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      gateway.handleConnection(socket1 as any);
      gateway.handleConnection(socket2 as any);
      gateway.handleSubscribe(socket1 as any, 'session-1');
      gateway.handleSubscribe(socket2 as any, 'session-1');

      const event = { id: 'evt-1', type: 'task_completed', session_id: 'session-1', payload: {} };
      gateway.broadcastToLocal('session-1', event);

      expect(socket1.send).toHaveBeenCalledWith(JSON.stringify({ type: 'workspace_event', event }));
      expect(socket2.send).toHaveBeenCalledWith(JSON.stringify({ type: 'workspace_event', event }));
    });

    it('should not send to subscribers of other sessions', () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      gateway.handleConnection(socket1 as any);
      gateway.handleConnection(socket2 as any);
      gateway.handleSubscribe(socket1 as any, 'session-1');
      gateway.handleSubscribe(socket2 as any, 'session-2');

      const event = { id: 'evt-1', type: 'task_completed', session_id: 'session-1', payload: {} };
      gateway.broadcastToLocal('session-1', event);

      expect(socket1.send).toHaveBeenCalled();
      expect(socket2.send).not.toHaveBeenCalled();
    });

    it('should skip closed sockets and clean up', () => {
      const socket = createMockSocket();
      socket.readyState = 3; // CLOSED
      gateway.handleConnection(socket as any);
      gateway.handleSubscribe(socket as any, 'session-1');

      const event = { id: 'evt-1', type: 'task_completed', session_id: 'session-1', payload: {} };
      gateway.broadcastToLocal('session-1', event);

      expect(socket.send).not.toHaveBeenCalled();
    });
  });

  describe('handleDisconnect', () => {
    it('should clean up all subscriptions for a client', () => {
      const socket = createMockSocket();
      gateway.handleConnection(socket as any);
      gateway.handleSubscribe(socket as any, 'session-1');
      gateway.handleSubscribe(socket as any, 'session-2');

      gateway.handleDisconnect(socket as any);

      expect(gateway.getClientCount()).toBe(0);
      expect(gateway.getSubscriberCount('session-1')).toBe(0);
      expect(gateway.getSubscriberCount('session-2')).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm run test -- tests/unit/workspace-gateway.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `backend/src/websocket/workspace.gateway.ts`:

```typescript
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

interface WorkspaceClient {
  socket: WebSocket;
  subscriptions: Set<string>;
  lastPing: number;
}

type ClientMessage =
  | { type: 'subscribe'; session_id: string; token?: string }
  | { type: 'unsubscribe'; session_id: string }
  | { type: 'ping' };

const HEARTBEAT_INTERVAL_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 60_000;

export class WorkspaceWebSocketGateway {
  private clients: Map<WebSocket, WorkspaceClient> = new Map();
  private subscriptions: Map<string, Set<WebSocket>> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  async register(fastify: FastifyInstance): Promise<void> {
    fastify.get(
      '/ws/workspace',
      { websocket: true },
      (socket: WebSocket, _request: FastifyRequest) => {
        this.handleConnection(socket);
      }
    );
    this.startHeartbeat();
  }

  handleConnection(socket: WebSocket): void {
    const client: WorkspaceClient = {
      socket,
      subscriptions: new Set(),
      lastPing: Date.now(),
    };
    this.clients.set(socket, client);

    socket.on('message', (data: Buffer | string) => {
      const client = this.clients.get(socket);
      if (client) client.lastPing = Date.now();

      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        switch (message.type) {
          case 'subscribe':
            this.handleSubscribe(socket, message.session_id);
            break;
          case 'unsubscribe':
            this.handleUnsubscribe(socket, message.session_id);
            break;
          case 'ping':
            this.sendMessage(socket, { type: 'pong' });
            break;
        }
      } catch {
        this.sendMessage(socket, { type: 'error', message: 'Invalid message format' });
      }
    });

    socket.on('close', () => this.handleDisconnect(socket));
    socket.on('error', () => this.handleDisconnect(socket));
  }

  handleSubscribe(socket: WebSocket, sessionId: string): void {
    const client = this.clients.get(socket);
    if (!client) return;

    client.subscriptions.add(sessionId);

    let subscribers = this.subscriptions.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.subscriptions.set(sessionId, subscribers);
    }
    subscribers.add(socket);

    this.sendMessage(socket, { type: 'subscribed', session_id: sessionId });
  }

  handleUnsubscribe(socket: WebSocket, sessionId: string): void {
    const client = this.clients.get(socket);
    if (!client) return;

    client.subscriptions.delete(sessionId);

    const subscribers = this.subscriptions.get(sessionId);
    if (subscribers) {
      subscribers.delete(socket);
      if (subscribers.size === 0) {
        this.subscriptions.delete(sessionId);
      }
    }

    this.sendMessage(socket, { type: 'unsubscribed', session_id: sessionId });
  }

  handleDisconnect(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (!client) return;

    for (const sessionId of client.subscriptions) {
      const subscribers = this.subscriptions.get(sessionId);
      if (subscribers) {
        subscribers.delete(socket);
        if (subscribers.size === 0) {
          this.subscriptions.delete(sessionId);
        }
      }
    }

    this.clients.delete(socket);
  }

  broadcastToLocal(sessionId: string, event: unknown): void {
    const subscribers = this.subscriptions.get(sessionId);
    if (!subscribers) return;

    const message = JSON.stringify({ type: 'workspace_event', event });

    for (const socket of subscribers) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      } else {
        subscribers.delete(socket);
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getSubscriberCount(sessionId: string): number {
    return this.subscriptions.get(sessionId)?.size ?? 0;
  }

  private sendMessage(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [socket, client] of this.clients.entries()) {
        if (now - client.lastPing > CONNECTION_TIMEOUT_MS) {
          socket.close(1000, 'Connection timeout');
          this.handleDisconnect(socket);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const [socket] of this.clients) {
      socket.close(1000, 'Server shutdown');
    }
    this.clients.clear();
    this.subscriptions.clear();
  }
}

export const workspaceWebSocketGateway = new WorkspaceWebSocketGateway();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm run test -- tests/unit/workspace-gateway.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/websocket/workspace.gateway.ts backend/tests/unit/workspace-gateway.test.ts
git commit -m "feat: add WorkspaceWebSocketGateway with session-level subscriptions and heartbeat"
```

---

## Task 7: Workspace Events Recovery Route

**Files:**
- Create: `backend/src/schemas/workspace-events.schema.ts`
- Create: `backend/src/routes/workspace-events.routes.ts`
- Test: `backend/tests/unit/workspace-events-routes.test.ts`

- [ ] **Step 1: Write the Zod schemas**

Create `backend/src/schemas/workspace-events.schema.ts`:

```typescript
import { z } from 'zod';

export const recoverQuerySchema = z.object({
  session_id: z.string().uuid(),
  after_event_id: z.string().uuid().nullable().optional(),
});

export const recoverResponseSchema = z.object({
  missed_events: z.array(z.object({
    id: z.string().uuid(),
    task_id: z.string().uuid(),
    session_id: z.string().uuid(),
    type: z.string(),
    payload: z.record(z.string(), z.unknown()),
    created_at: z.string(),
  })),
  current_tasks: z.array(z.object({
    id: z.string().uuid(),
    status: z.string(),
    source: z.string(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    error_message: z.string().nullable(),
  })),
  summary: z.object({
    completed_count: z.number(),
    failed_count: z.number(),
    failed_task_ids: z.array(z.string().uuid()),
  }).nullable(),
});

export type RecoverQuery = z.infer<typeof recoverQuerySchema>;
export type RecoverResponse = z.infer<typeof recoverResponseSchema>;
```

- [ ] **Step 2: Write the route implementation**

Create `backend/src/routes/workspace-events.routes.ts`:

```typescript
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { recoverQuerySchema } from '../schemas/workspace-events.schema.js';
import { executionEventRepository } from '../repositories/execution-event.repository.js';
import { executionTaskRepository } from '../repositories/execution-task.repository.js';

export async function workspaceEventsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/workspace-events/recover',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = recoverQuerySchema.parse(request.query);
      const { session_id, after_event_id } = query;

      const [missedEvents, currentTasks] = await Promise.all([
        executionEventRepository.findAfter(session_id, after_event_id ?? null),
        executionTaskRepository.findBySessionId(session_id),
      ]);

      const completedAfterDisconnect = missedEvents.filter(e => e.type === 'task_completed');
      const failedAfterDisconnect = missedEvents.filter(e => e.type === 'task_failed' || e.type === 'task_timeout');

      const summary = (completedAfterDisconnect.length > 0 || failedAfterDisconnect.length > 0)
        ? {
            completed_count: completedAfterDisconnect.length,
            failed_count: failedAfterDisconnect.length,
            failed_task_ids: failedAfterDisconnect.map(e => e.task_id),
          }
        : null;

      return reply.send({
        missed_events: missedEvents.map(e => ({
          ...e,
          created_at: e.created_at.toISOString(),
        })),
        current_tasks: currentTasks.map(t => ({
          id: t.id,
          status: t.status,
          source: t.source,
          started_at: t.started_at?.toISOString() ?? null,
          completed_at: t.completed_at?.toISOString() ?? null,
          error_message: t.error_message ?? null,
        })),
        summary,
      });
    }
  );
}
```

- [ ] **Step 3: Write test for the route**

Create `backend/tests/unit/workspace-events-routes.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEventRepo = {
  findAfter: vi.fn(),
};

const mockTaskRepo = {
  findBySessionId: vi.fn(),
};

vi.mock('../../src/repositories/execution-event.repository.js', () => ({
  executionEventRepository: mockEventRepo,
}));

vi.mock('../../src/repositories/execution-task.repository.js', () => ({
  executionTaskRepository: mockTaskRepo,
}));

vi.mock('../../src/middleware/auth.js', () => ({
  authenticate: vi.fn((_req: any, _reply: any, done: any) => done?.()),
}));

import Fastify from 'fastify';
import { workspaceEventsRoutes } from '../../src/routes/workspace-events.routes.js';

describe('workspace-events routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await app.register(workspaceEventsRoutes, { prefix: '/api' });
    await app.ready();
  });

  describe('GET /api/workspace-events/recover', () => {
    it('should return missed events and summary', async () => {
      const events = [
        { id: 'evt-1', task_id: 'task-1', session_id: 's-1', type: 'task_completed', payload: {}, created_at: new Date() },
        { id: 'evt-2', task_id: 'task-2', session_id: 's-1', type: 'task_failed', payload: {}, created_at: new Date() },
      ];
      const tasks = [
        { id: 'task-1', status: 'completed', source: 'project', started_at: new Date(), completed_at: new Date(), error_message: null },
      ];
      mockEventRepo.findAfter.mockResolvedValue(events);
      mockTaskRepo.findBySessionId.mockResolvedValue(tasks);

      const response = await app.inject({
        method: 'GET',
        url: '/api/workspace-events/recover?session_id=00000000-0000-0000-0000-000000000001&after_event_id=00000000-0000-0000-0000-000000000002',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.missed_events).toHaveLength(2);
      expect(body.summary.completed_count).toBe(1);
      expect(body.summary.failed_count).toBe(1);
      expect(body.summary.failed_task_ids).toContain('task-2');
    });

    it('should return null summary when no events missed', async () => {
      mockEventRepo.findAfter.mockResolvedValue([]);
      mockTaskRepo.findBySessionId.mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/workspace-events/recover?session_id=00000000-0000-0000-0000-000000000001',
      });

      const body = JSON.parse(response.payload);
      expect(body.summary).toBeNull();
    });
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npm run test -- tests/unit/workspace-events-routes.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/schemas/workspace-events.schema.ts backend/src/routes/workspace-events.routes.ts backend/tests/unit/workspace-events-routes.test.ts
git commit -m "feat: add workspace events recovery API endpoint"
```

---

## Task 8: Execution Reconciler Service

**Files:**
- Create: `backend/src/services/execution-reconciler.service.ts`
- Test: `backend/tests/unit/execution-reconciler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/unit/execution-reconciler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTaskRepo = {
  findStale: vi.fn(),
  updateStatusWhere: vi.fn(),
};

const mockEventBus = {
  emit: vi.fn().mockResolvedValue({ id: 'evt-1' }),
};

const mockRedis = {
  acquireLock: vi.fn(),
};

const mockS3 = {
  headObject: vi.fn(),
  getObject: vi.fn(),
};

vi.mock('../../src/repositories/execution-task.repository.js', () => ({
  executionTaskRepository: mockTaskRepo,
}));

vi.mock('../../src/services/workspace-event-bus.js', () => ({
  workspaceEventBus: mockEventBus,
}));

vi.mock('../../src/services/redis.service.js', () => ({
  redisService: mockRedis,
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockS3.headObject })),
  HeadObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
}));

import { ExecutionReconciler } from '../../src/services/execution-reconciler.service.js';

describe('ExecutionReconciler', () => {
  let reconciler: ExecutionReconciler;

  beforeEach(() => {
    vi.clearAllMocks();
    reconciler = new ExecutionReconciler();
  });

  describe('reconcile', () => {
    it('should skip if lock not acquired', async () => {
      mockRedis.acquireLock.mockResolvedValue(null);

      await reconciler.reconcile();

      expect(mockTaskRepo.findStale).not.toHaveBeenCalled();
    });

    it('should process stale tasks when lock acquired', async () => {
      const releaseLock = vi.fn();
      mockRedis.acquireLock.mockResolvedValue(releaseLock);
      mockTaskRepo.findStale.mockResolvedValue([]);

      await reconciler.reconcile();

      expect(mockTaskRepo.findStale).toHaveBeenCalled();
      expect(releaseLock).toHaveBeenCalled();
    });
  });

  describe('reconcileTask', () => {
    it('should mark task completed when S3 status file shows completed', async () => {
      const task = {
        id: 'task-1',
        session_id: 'session-1',
        workspace_bucket: 'my-bucket',
        workspace_prefix: 'org/scope/sessions/s1/',
        status: 'running',
        created_at: new Date(Date.now() - 10 * 60 * 1000),
      };

      const statusJson = JSON.stringify({
        task_id: 'task-1',
        status: 'completed',
        finished_at: '2026-05-06T10:30:00Z',
        files_modified: ['scope-config.json'],
      });

      mockS3.headObject.mockResolvedValueOnce({}); // headObject succeeds
      mockS3.getObject.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(statusJson) },
      });
      mockTaskRepo.updateStatusWhere.mockResolvedValue(1);

      await reconciler.reconcileTask(task as any);

      expect(mockTaskRepo.updateStatusWhere).toHaveBeenCalledWith(
        'task-1',
        'running',
        expect.objectContaining({ status: 'completed' })
      );
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task_completed', session_id: 'session-1' })
      );
    });

    it('should mark task timeout when no S3 status and past threshold', async () => {
      const task = {
        id: 'task-2',
        session_id: 'session-1',
        workspace_bucket: 'my-bucket',
        workspace_prefix: 'org/scope/sessions/s1/',
        status: 'running',
        created_at: new Date(Date.now() - 35 * 60 * 1000), // 35 min ago
      };

      mockS3.headObject.mockRejectedValueOnce({ name: 'NotFound' }); // no status file
      mockTaskRepo.updateStatusWhere.mockResolvedValue(1);

      await reconciler.reconcileTask(task as any);

      expect(mockTaskRepo.updateStatusWhere).toHaveBeenCalledWith(
        'task-2',
        'running',
        expect.objectContaining({ status: 'timeout' })
      );
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task_timeout' })
      );
    });

    it('should skip task if within timeout threshold and no S3 status', async () => {
      const task = {
        id: 'task-3',
        session_id: 'session-1',
        workspace_bucket: 'my-bucket',
        workspace_prefix: 'org/scope/sessions/s1/',
        status: 'running',
        created_at: new Date(Date.now() - 2 * 60 * 1000), // 2 min ago
      };

      mockS3.headObject.mockRejectedValueOnce({ name: 'NotFound' });

      await reconciler.reconcileTask(task as any);

      expect(mockTaskRepo.updateStatusWhere).not.toHaveBeenCalled();
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm run test -- tests/unit/execution-reconciler.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/execution-reconciler.service.ts`:

```typescript
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config/index.js';
import { executionTaskRepository } from '../repositories/execution-task.repository.js';
import { workspaceEventBus } from './workspace-event-bus.js';
import { redisService } from './redis.service.js';

const RECONCILE_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 5 * 60_000;
const TIMEOUT_THRESHOLD_MS = 30 * 60_000;
const LOCK_KEY = 'reconciler:execution_tasks';

export class ExecutionReconciler {
  private s3: S3Client;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor() {
    this.s3 = new S3Client({ region: config.aws?.region ?? 'us-west-2' });
  }

  start(): void {
    this.intervalHandle = setInterval(() => {
      this.reconcile().catch(err => {
        console.error('[Reconciler] Error:', err.message);
      });
    }, RECONCILE_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async reconcile(): Promise<void> {
    const releaseLock = await redisService.acquireLock(LOCK_KEY, RECONCILE_INTERVAL_MS);
    if (!releaseLock) return;

    try {
      const staleTasks = await executionTaskRepository.findStale(STALE_THRESHOLD_MS);
      for (const task of staleTasks) {
        await this.reconcileTask(task);
      }
    } finally {
      await releaseLock();
    }
  }

  async reconcileTask(task: {
    id: string;
    session_id: string;
    workspace_bucket: string | null;
    workspace_prefix: string | null;
    status: string;
    created_at: Date;
  }): Promise<void> {
    if (!task.workspace_bucket || !task.workspace_prefix) {
      return;
    }

    const statusKey = `${task.workspace_prefix}__executions__/${task.id}.json`;

    try {
      await this.s3.send(new HeadObjectCommand({
        Bucket: task.workspace_bucket,
        Key: statusKey,
      }));

      const response = await this.s3.send(new GetObjectCommand({
        Bucket: task.workspace_bucket,
        Key: statusKey,
      }));

      const body = await response.Body!.transformToString();
      const statusData = JSON.parse(body);

      const newStatus = statusData.status === 'completed' ? 'completed' : 'failed';
      const updated = await executionTaskRepository.updateStatusWhere(
        task.id,
        'running',
        {
          status: newStatus,
          completed_at: new Date(statusData.finished_at ?? Date.now()),
          error_message: statusData.error ?? null,
        }
      );

      if (updated > 0) {
        await workspaceEventBus.emit({
          task_id: task.id,
          session_id: task.session_id,
          type: newStatus === 'completed' ? 'task_completed' : 'task_failed',
          payload: {
            files_modified: statusData.files_modified ?? [],
            error: statusData.error ?? null,
          },
        });
      }
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        const age = Date.now() - task.created_at.getTime();
        if (age >= TIMEOUT_THRESHOLD_MS) {
          const updated = await executionTaskRepository.updateStatusWhere(
            task.id,
            'running',
            { status: 'timeout', completed_at: new Date() }
          );

          if (updated > 0) {
            await workspaceEventBus.emit({
              task_id: task.id,
              session_id: task.session_id,
              type: 'task_timeout',
              payload: {},
            });
          }
        }
      } else {
        console.error(`[Reconciler] Error checking S3 for task ${task.id}:`, err.message);
      }
    }
  }
}

export const executionReconciler = new ExecutionReconciler();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm run test -- tests/unit/execution-reconciler.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/execution-reconciler.service.ts backend/tests/unit/execution-reconciler.test.ts
git commit -m "feat: add ExecutionReconciler with S3 status check and distributed lock"
```

---

## Task 9: App Registration — Wire Everything Together

**Files:**
- Modify: `backend/src/app.ts`

- [ ] **Step 1: Register workspace gateway in app.ts**

Add imports at the top of `backend/src/app.ts`:

```typescript
import { workspaceWebSocketGateway } from './websocket/workspace.gateway.js';
import { workspaceEventBus } from './services/workspace-event-bus.js';
import { executionReconciler } from './services/execution-reconciler.service.js';
import { workspaceEventsRoutes } from './routes/workspace-events.routes.js';
```

In the `buildApp()` function, after the existing `executionWebSocketGateway.register(app)` call, add:

```typescript
await workspaceWebSocketGateway.register(app);
```

In the route registration section, add:

```typescript
await fastify.register(workspaceEventsRoutes, { prefix: '/api' });
```

In the initialization section (where `role === 'worker' || role === 'all'`), add:

```typescript
await workspaceEventBus.initialize();
executionReconciler.start();
```

In the `onClose` hook, add:

```typescript
executionReconciler.stop();
await workspaceEventBus.shutdown();
workspaceWebSocketGateway.close();
```

- [ ] **Step 2: Verify the server starts**

Run: `cd backend && npm run build`

Expected: No TypeScript compilation errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/app.ts
git commit -m "feat: register WorkspaceEventBus, WebSocket gateway, and Reconciler in app bootstrap"
```

---

## Task 10: Frontend — WorkspaceSocketClient

**Files:**
- Create: `frontend/src/services/workspaceSocketClient.ts`
- Test: `frontend/src/services/workspaceSocketClient.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/services/workspaceSocketClient.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
}

vi.stubGlobal('WebSocket', MockWebSocket);

import { WorkspaceSocketClient } from './workspaceSocketClient';

describe('WorkspaceSocketClient', () => {
  let client: WorkspaceSocketClient;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    client = new WorkspaceSocketClient();
  });

  afterEach(() => {
    client.disconnect();
  });

  describe('connect', () => {
    it('should establish WebSocket connection', () => {
      client.connect();

      expect(client.isConnected()).toBe(false); // not yet until onopen
    });
  });

  describe('subscribe', () => {
    it('should send subscribe message when connected', () => {
      client.connect();
      // Simulate connection open
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.();

      const unsubscribe = client.subscribe('session-1', vi.fn());

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', session_id: 'session-1' })
      );
      expect(typeof unsubscribe).toBe('function');
    });

    it('should queue subscription if not yet connected', () => {
      client.connect();
      client.subscribe('session-1', vi.fn());

      const ws = (client as any).ws as MockWebSocket;
      expect(ws.send).not.toHaveBeenCalled();

      // Now connect
      ws.onopen?.();
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', session_id: 'session-1' })
      );
    });
  });

  describe('event routing', () => {
    it('should route events to the correct session handler', () => {
      client.connect();
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.();

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      client.subscribe('session-1', handler1);
      client.subscribe('session-2', handler2);

      const event = { id: 'evt-1', type: 'task_completed', session_id: 'session-1', payload: {} };
      ws.onmessage?.({ data: JSON.stringify({ type: 'workspace_event', event }) });

      expect(handler1).toHaveBeenCalledWith(event);
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe('lastEventId tracking', () => {
    it('should persist lastEventId to localStorage on event', () => {
      client.connect();
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.();
      client.subscribe('session-1', vi.fn());

      const event = { id: 'evt-42', type: 'task_completed', session_id: 'session-1', payload: {} };
      ws.onmessage?.({ data: JSON.stringify({ type: 'workspace_event', event }) });

      expect(localStorage.getItem('workspace:lastEvent:session-1')).toBe('evt-42');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- src/services/workspaceSocketClient.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/services/workspaceSocketClient.ts`:

```typescript
export type WorkspaceEventHandler = (event: WorkspaceEvent) => void;

export interface WorkspaceEvent {
  id: string;
  task_id: string;
  session_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
const PING_INTERVAL = 25000;

export class WorkspaceSocketClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private subscriptions: Map<string, Set<WorkspaceEventHandler>> = new Map();
  private pendingSubscriptions: Set<string> = new Set();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  connect(): void {
    if (this.state !== 'disconnected') return;

    this.state = 'connecting';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env.VITE_API_BASE_URL
      ? new URL(import.meta.env.VITE_API_BASE_URL).host
      : window.location.host;

    this.ws = new WebSocket(`${protocol}//${host}/ws/workspace`);

    this.ws.onopen = () => {
      this.state = 'connected';
      this.reconnectAttempt = 0;
      this.startPing();

      for (const sessionId of this.pendingSubscriptions) {
        this.sendSubscribe(sessionId);
      }
      this.pendingSubscriptions.clear();

      for (const sessionId of this.subscriptions.keys()) {
        this.sendSubscribe(sessionId);
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'workspace_event') {
          this.handleEvent(message.event);
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.state = 'disconnected';
      this.stopPing();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  disconnect(): void {
    this.state = 'disconnected';
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  subscribe(sessionId: string, handler: WorkspaceEventHandler): () => void {
    let handlers = this.subscriptions.get(sessionId);
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(sessionId, handlers);
    }
    handlers.add(handler);

    if (this.state === 'connected') {
      this.sendSubscribe(sessionId);
    } else {
      this.pendingSubscriptions.add(sessionId);
    }

    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.subscriptions.delete(sessionId);
        if (this.state === 'connected') {
          this.sendUnsubscribe(sessionId);
        }
      }
    };
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  getLastEventId(sessionId: string): string | null {
    return localStorage.getItem(`workspace:lastEvent:${sessionId}`);
  }

  private handleEvent(event: WorkspaceEvent): void {
    localStorage.setItem(`workspace:lastEvent:${event.session_id}`, event.id);

    const handlers = this.subscriptions.get(event.session_id);
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }
  }

  private sendSubscribe(sessionId: string): void {
    this.ws?.send(JSON.stringify({ type: 'subscribe', session_id: sessionId }));
  }

  private sendUnsubscribe(sessionId: string): void {
    this.ws?.send(JSON.stringify({ type: 'unsubscribe', session_id: sessionId }));
  }

  private scheduleReconnect(): void {
    if (this.subscriptions.size === 0) return;

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export const workspaceSocketClient = new WorkspaceSocketClient();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- src/services/workspaceSocketClient.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/workspaceSocketClient.ts frontend/src/services/workspaceSocketClient.test.ts
git commit -m "feat: add WorkspaceSocketClient with reconnection, subscription management, and lastEventId tracking"
```

---

## Task 11: Frontend — useWorkspaceEvents Hook

**Files:**
- Create: `frontend/src/hooks/useWorkspaceEvents.ts`
- Test: `frontend/src/hooks/useWorkspaceEvents.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/hooks/useWorkspaceEvents.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockSubscribe = vi.fn().mockReturnValue(vi.fn());
const mockConnect = vi.fn();
const mockGetLastEventId = vi.fn().mockReturnValue(null);

vi.mock('@/services/workspaceSocketClient', () => ({
  workspaceSocketClient: {
    subscribe: mockSubscribe,
    connect: mockConnect,
    isConnected: vi.fn().mockReturnValue(true),
    getLastEventId: mockGetLastEventId,
  },
}));

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ missed_events: [], current_tasks: [], summary: null }),
});
vi.stubGlobal('fetch', mockFetch);

import { useWorkspaceEvents } from './useWorkspaceEvents';

describe('useWorkspaceEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should connect and subscribe when sessionId is provided', () => {
    renderHook(() => useWorkspaceEvents({ sessionId: 'session-1' }));

    expect(mockConnect).toHaveBeenCalled();
    expect(mockSubscribe).toHaveBeenCalledWith('session-1', expect.any(Function));
  });

  it('should not subscribe when sessionId is null', () => {
    renderHook(() => useWorkspaceEvents({ sessionId: null }));

    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('should call onFilesChanged when files_changed event arrives', () => {
    const onFilesChanged = vi.fn();
    renderHook(() => useWorkspaceEvents({ sessionId: 'session-1', onFilesChanged }));

    const handler = mockSubscribe.mock.calls[0][1];
    act(() => {
      handler({
        id: 'evt-1',
        type: 'files_changed',
        session_id: 'session-1',
        task_id: 'task-1',
        payload: { files: [{ path: 'scope-config.json', action: 'modified', size: 100, content: '{}' }] },
      });
    });

    expect(onFilesChanged).toHaveBeenCalledWith([
      { path: 'scope-config.json', action: 'modified', size: 100, content: '{}' },
    ]);
  });

  it('should call onTaskCompleted when task_completed event arrives', () => {
    const onTaskCompleted = vi.fn();
    renderHook(() => useWorkspaceEvents({ sessionId: 'session-1', onTaskCompleted }));

    const handler = mockSubscribe.mock.calls[0][1];
    act(() => {
      handler({
        id: 'evt-2',
        type: 'task_completed',
        session_id: 'session-1',
        task_id: 'task-1',
        payload: {},
      });
    });

    expect(onTaskCompleted).toHaveBeenCalledWith({ id: 'evt-2', task_id: 'task-1', type: 'task_completed', session_id: 'session-1', payload: {} });
  });

  it('should unsubscribe on unmount', () => {
    const unsubscribe = vi.fn();
    mockSubscribe.mockReturnValue(unsubscribe);

    const { unmount } = renderHook(() => useWorkspaceEvents({ sessionId: 'session-1' }));
    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });

  it('should call recovery API on mount', async () => {
    mockGetLastEventId.mockReturnValue('evt-5');

    renderHook(() => useWorkspaceEvents({ sessionId: 'session-1' }));

    // Wait for async effect
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/workspace-events/recover?session_id=session-1&after_event_id=evt-5'),
        expect.any(Object)
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- src/hooks/useWorkspaceEvents.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/hooks/useWorkspaceEvents.ts`:

```typescript
import { useEffect, useRef, useState, useCallback } from 'react';
import { workspaceSocketClient, type WorkspaceEvent } from '@/services/workspaceSocketClient';

export interface FileChange {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  size: number;
  content?: string;
  fetch_url?: string;
}

export interface TaskEvent {
  id: string;
  task_id: string;
  type: string;
  session_id: string;
  payload: Record<string, unknown>;
}

export interface UseWorkspaceEventsOptions {
  sessionId: string | null;
  onFilesChanged?: (files: FileChange[]) => void;
  onTaskStarted?: (task: TaskEvent) => void;
  onTaskCompleted?: (task: TaskEvent) => void;
  onTaskFailed?: (task: TaskEvent) => void;
  onTaskTimeout?: (task: TaskEvent) => void;
}

export interface RecoverySummary {
  completed_count: number;
  failed_count: number;
  failed_task_ids: string[];
}

export function useWorkspaceEvents(options: UseWorkspaceEventsOptions) {
  const { sessionId } = options;
  const [connected, setConnected] = useState(false);
  const [recoverySummary, setRecoverySummary] = useState<RecoverySummary | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const handleEvent = useCallback((event: WorkspaceEvent) => {
    const opts = optionsRef.current;

    switch (event.type) {
      case 'files_changed':
        opts.onFilesChanged?.(
          (event.payload.files as FileChange[]) ?? []
        );
        break;
      case 'task_started':
        opts.onTaskStarted?.(event as TaskEvent);
        break;
      case 'task_completed':
        opts.onTaskCompleted?.(event as TaskEvent);
        break;
      case 'task_failed':
        opts.onTaskFailed?.(event as TaskEvent);
        break;
      case 'task_timeout':
        opts.onTaskTimeout?.(event as TaskEvent);
        break;
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    workspaceSocketClient.connect();
    const unsubscribe = workspaceSocketClient.subscribe(sessionId, handleEvent);
    setConnected(workspaceSocketClient.isConnected());

    const recoverMissedEvents = async () => {
      const lastEventId = workspaceSocketClient.getLastEventId(sessionId);
      const params = new URLSearchParams({ session_id: sessionId });
      if (lastEventId) params.set('after_event_id', lastEventId);

      try {
        const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';
        const response = await fetch(`${baseUrl}/api/workspace-events/recover?${params}`, {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('local_auth_token') ?? ''}`,
          },
        });

        if (response.ok) {
          const data = await response.json();

          for (const event of data.missed_events) {
            handleEvent(event);
          }

          if (data.summary) {
            setRecoverySummary(data.summary);
          }
        }
      } catch {
        // Recovery is best-effort; live subscription will catch up
      }
    };

    recoverMissedEvents();

    return () => {
      unsubscribe();
    };
  }, [sessionId, handleEvent]);

  const dismissRecovery = useCallback(() => {
    setRecoverySummary(null);
  }, []);

  return { connected, recoverySummary, dismissRecovery };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- src/hooks/useWorkspaceEvents.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useWorkspaceEvents.ts frontend/src/hooks/useWorkspaceEvents.test.ts
git commit -m "feat: add useWorkspaceEvents hook with event routing and disconnect recovery"
```

---

## Task 12: Frontend — WorkspaceRecoveryBanner Component

**Files:**
- Create: `frontend/src/components/WorkspaceRecoveryBanner.tsx`

- [ ] **Step 1: Write the component**

Create `frontend/src/components/WorkspaceRecoveryBanner.tsx`:

```typescript
import type { RecoverySummary } from '@/hooks/useWorkspaceEvents';

interface WorkspaceRecoveryBannerProps {
  summary: RecoverySummary;
  onDismiss: () => void;
  onViewDetails?: () => void;
}

export function WorkspaceRecoveryBanner({ summary, onDismiss, onViewDetails }: WorkspaceRecoveryBannerProps) {
  const parts: string[] = [];
  if (summary.completed_count > 0) {
    parts.push(`${summary.completed_count} task${summary.completed_count > 1 ? 's' : ''} completed`);
  }
  if (summary.failed_count > 0) {
    parts.push(`${summary.failed_count} task${summary.failed_count > 1 ? 's' : ''} failed`);
  }

  if (parts.length === 0) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-blue-900/50 border-b border-blue-700 text-sm text-blue-200">
      <span className="flex-1">
        While you were away: {parts.join(', ')}
      </span>
      {onViewDetails && (
        <button
          onClick={onViewDetails}
          className="px-2 py-0.5 rounded text-blue-300 hover:text-white hover:bg-blue-800 transition-colors"
        >
          View
        </button>
      )}
      <button
        onClick={onDismiss}
        className="px-2 py-0.5 rounded text-blue-400 hover:text-white hover:bg-blue-800 transition-colors"
      >
        &times;
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/WorkspaceRecoveryBanner.tsx
git commit -m "feat: add WorkspaceRecoveryBanner component for offline task notifications"
```

---

## Task 13: Integration Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all backend tests**

Run: `cd backend && npm run test`

Expected: All tests pass, including new workspace event tests.

- [ ] **Step 2: Run all frontend tests**

Run: `cd frontend && npm run test`

Expected: All tests pass, including new hook and client tests.

- [ ] **Step 3: Verify backend compiles**

Run: `cd backend && npm run build`

Expected: No TypeScript errors.

- [ ] **Step 4: Verify frontend compiles**

Run: `cd frontend && npm run build`

Expected: No TypeScript errors, successful Vite build.

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A && git commit -m "fix: resolve integration issues from Phase 0 verification"
```

(Only run if fixes were needed in steps 1-4)

---

## Summary

After completing all 13 tasks, Phase 0 delivers:
- **Database tables** for execution tracking and event persistence
- **WorkspaceEventBus** with DB persistence + Redis pub/sub broadcast
- **WorkspaceWebSocketGateway** with session-level subscriptions
- **ExecutionReconciler** with distributed lock and S3 status checks
- **Recovery API** for disconnect catch-up
- **Frontend hook** (`useWorkspaceEvents`) ready for scenario integration
- **Recovery banner** component

All existing functionality remains untouched. Phase 1 (Project migration) can begin immediately.
