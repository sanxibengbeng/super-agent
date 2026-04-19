---
name: test-runner
description: Run and manage tests for Super Agent using Vitest. Use this skill whenever the user mentions: run tests, test, npm test, vitest, test coverage, check tests, test failing, test passing, write test, add test, unit test, integration test, test file, spec file, describe block, it block, expect, mock, or any variation of testing operations. Also use when user encounters test failures, wants to debug tests, check coverage, or run specific test files/patterns.
---

# Test Runner - Super Agent Testing Workflow

## Purpose

Run, debug, and manage tests for Super Agent's monorepo using Vitest. Handle test execution, coverage reporting, and test debugging for both backend and frontend.

## Test Configuration

| Project | Framework | Config | Test Pattern |
|---------|-----------|--------|--------------|
| Backend | Vitest | `backend/vitest.config.ts` | `**/*.test.ts`, `**/*.spec.ts` |
| Frontend | Vitest | `frontend/vitest.config.ts` | `**/*.test.ts`, `**/*.test.tsx` |

## Common Operations

### Run All Tests

```bash
# Backend tests
cd backend && npm run test

# Frontend tests
cd frontend && npm run test

# Run both
cd backend && npm run test && cd ../frontend && npm run test
```

### Run Tests in Watch Mode

```bash
# Backend (dev mode)
cd backend && npm run test -- --watch

# Frontend (dev mode)
cd frontend && npm run test -- --watch
```

### Run Specific Test File

```bash
# By filename
cd backend && npm run test -- src/services/agent.service.test.ts

# By pattern
cd backend && npm run test -- --grep "AgentService"
```

### Run Tests with Coverage

```bash
# Backend coverage
cd backend && npm run test -- --coverage

# Frontend coverage
cd frontend && npm run test -- --coverage
```

### Run Single Test or Describe Block

```bash
# Run tests matching name pattern
cd backend && npm run test -- -t "should create agent"

# Run specific describe block
cd backend && npm run test -- -t "AgentService"
```

## Test File Structure

### Backend Test Example

```typescript
// backend/src/services/agent.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from './agent.service';

describe('AgentService', () => {
  let service: AgentService;

  beforeEach(() => {
    service = new AgentService();
    vi.clearAllMocks();
  });

  describe('createAgent', () => {
    it('should create agent with valid input', async () => {
      const result = await service.createAgent({
        name: 'Test Agent',
        organizationId: 'org-123',
      });
      expect(result).toBeDefined();
      expect(result.name).toBe('Test Agent');
    });

    it('should throw error for invalid input', async () => {
      await expect(service.createAgent({})).rejects.toThrow();
    });
  });
});
```

### Frontend Test Example

```typescript
// frontend/src/components/AgentCard.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentCard } from './AgentCard';

describe('AgentCard', () => {
  it('renders agent name', () => {
    render(<AgentCard agent={{ id: '1', name: 'Test Agent' }} />);
    expect(screen.getByText('Test Agent')).toBeInTheDocument();
  });
});
```

## Mocking Patterns

### Mock External Services

```typescript
import { vi } from 'vitest';

// Mock Prisma client
vi.mock('@/config/database', () => ({
  prisma: {
    agent: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

// Mock AWS services
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(),
  PutObjectCommand: vi.fn(),
}));
```

### Mock Fastify Request/Reply

```typescript
const mockRequest = {
  params: { id: 'agent-123' },
  body: { name: 'Updated Agent' },
  user: { organizationId: 'org-123' },
} as unknown as FastifyRequest;

const mockReply = {
  code: vi.fn().mockReturnThis(),
  send: vi.fn(),
} as unknown as FastifyReply;
```

## Debugging Failed Tests

### Step 1: Identify Failure

```bash
# Run with verbose output
cd backend && npm run test -- --reporter=verbose

# Run failed tests only
cd backend && npm run test -- --failed
```

### Step 2: Isolate Test

```bash
# Run single file
cd backend && npm run test -- src/path/to/failing.test.ts

# Run single test
cd backend && npm run test -- -t "exact test name"
```

### Step 3: Debug Output

```typescript
// Add console.log in test
it('debug test', async () => {
  const result = await service.method();
  console.log('Result:', JSON.stringify(result, null, 2));
  expect(result).toBeDefined();
});
```

## Common Issues

### Tests Timing Out

```typescript
// Increase timeout for slow tests
it('slow operation', async () => {
  // ...
}, 10000); // 10 second timeout
```

### Database Connection Issues

```bash
# Ensure test database exists
cd backend && npx prisma migrate reset --force
```

### Module Resolution Errors

```bash
# Regenerate Prisma client
cd backend && npm run prisma:generate
```

### Stale Mocks

```typescript
beforeEach(() => {
  vi.clearAllMocks(); // Clear mock call history
  vi.resetAllMocks(); // Reset mock implementations
});
```

## Quick Reference

| Action | Command |
|--------|---------|
| Run all backend tests | `cd backend && npm run test` |
| Run all frontend tests | `cd frontend && npm run test` |
| Watch mode | `npm run test -- --watch` |
| Single file | `npm run test -- path/to/file.test.ts` |
| Pattern match | `npm run test -- -t "pattern"` |
| Coverage | `npm run test -- --coverage` |
| Verbose | `npm run test -- --reporter=verbose` |
| Update snapshots | `npm run test -- -u` |
