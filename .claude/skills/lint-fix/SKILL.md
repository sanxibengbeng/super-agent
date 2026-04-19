---
name: lint-fix
description: Code quality checks and auto-fix for Super Agent - ESLint, TypeScript type checking, Prettier formatting. Use this skill whenever the user mentions: lint, eslint, fix lint, lint errors, type check, tsc, typescript errors, format, prettier, code quality, fix errors, lint:fix, check types, type errors, formatting, code style, or any variation of linting/formatting operations. Also use when user encounters lint errors, type errors, or wants to ensure code quality before committing.
---

# Lint Fix - Code Quality Operations

## Purpose

Run ESLint, TypeScript type checking, and code formatting for Super Agent's monorepo. Ensure code quality and consistency across backend and frontend.

## Tool Configuration

| Tool | Backend Config | Frontend Config |
|------|---------------|-----------------|
| ESLint | `backend/eslint.config.js` | `frontend/eslint.config.js` |
| TypeScript | `backend/tsconfig.json` | `frontend/tsconfig.json` |
| Prettier | (via ESLint) | (via ESLint) |

## Common Operations

### Check Lint Errors (No Fix)

```bash
# Backend
cd backend && npm run lint

# Frontend
cd frontend && npm run lint

# Both
cd backend && npm run lint && cd ../frontend && npm run lint
```

### Auto-Fix Lint Errors

```bash
# Backend
cd backend && npm run lint:fix

# Frontend
cd frontend && npm run lint:fix

# Both
cd backend && npm run lint:fix && cd ../frontend && npm run lint:fix
```

### TypeScript Type Check

```bash
# Backend
cd backend && npx tsc --noEmit

# Frontend
cd frontend && npx tsc --noEmit

# Both (parallel)
cd backend && npx tsc --noEmit & cd frontend && npx tsc --noEmit & wait
```

### Check Specific File

```bash
# Lint single file
cd backend && npx eslint src/services/agent.service.ts

# Type check and see errors for file
cd backend && npx tsc --noEmit 2>&1 | grep "agent.service.ts"
```

### Fix Specific File

```bash
cd backend && npx eslint --fix src/services/agent.service.ts
```

## Common ESLint Rules

### Backend (Fastify + TypeScript)

| Rule | Description |
|------|-------------|
| `@typescript-eslint/no-unused-vars` | No unused variables |
| `@typescript-eslint/no-explicit-any` | Avoid `any` type |
| `@typescript-eslint/explicit-function-return-type` | Explicit return types |
| `no-console` | No console.log (use logger) |

### Frontend (React + TypeScript)

| Rule | Description |
|------|-------------|
| `react-hooks/rules-of-hooks` | Hook rules |
| `react-hooks/exhaustive-deps` | useEffect dependencies |
| `@typescript-eslint/no-unused-vars` | No unused variables |
| `react/jsx-key` | Keys in lists |

## Fixing Common Errors

### Unused Variables

```typescript
// Error: 'foo' is declared but never used
const foo = 'bar';

// Fix 1: Remove it
// Fix 2: Prefix with underscore if intentional
const _foo = 'bar';
```

### Missing Return Type

```typescript
// Error: Missing return type on function
function getData() {
  return { id: 1 };
}

// Fix: Add explicit return type
function getData(): { id: number } {
  return { id: 1 };
}
```

### React Hook Dependencies

```typescript
// Error: React Hook useEffect has missing dependency: 'userId'
useEffect(() => {
  fetchUser(userId);
}, []);

// Fix: Add dependency
useEffect(() => {
  fetchUser(userId);
}, [userId]);
```

### Explicit Any

```typescript
// Error: Unexpected any
function process(data: any) {}

// Fix: Use proper type
function process(data: unknown) {}
// or
function process(data: Record<string, unknown>) {}
```

### Console Statements

```typescript
// Error: Unexpected console statement
console.log('debug');

// Fix: Use logger or remove
import { logger } from '@/config/logger';
logger.info('debug');
```

## Pre-Commit Workflow

Run this sequence before committing:

```bash
# 1. Type check
cd backend && npx tsc --noEmit && cd ../frontend && npx tsc --noEmit

# 2. Lint and auto-fix
cd backend && npm run lint:fix && cd ../frontend && npm run lint:fix

# 3. Verify no remaining errors
cd backend && npm run lint && cd ../frontend && npm run lint
```

## Suppressing Rules (Use Sparingly)

### Disable for Line

```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data: any = response.body;
```

### Disable for File

```typescript
/* eslint-disable no-console */
// ... file contents
```

### Disable in Config

Only for project-wide exceptions in `eslint.config.js`.

## Troubleshooting

### "Parsing error: Cannot find module"

```bash
# Regenerate TypeScript config
cd backend && npx tsc --init
# or reinstall deps
npm install
```

### ESLint Cache Issues

```bash
# Clear ESLint cache
cd backend && npx eslint --cache-location .eslintcache --cache false src/
```

### Type Errors After Prisma Schema Change

```bash
cd backend && npm run prisma:generate
```

### Too Many Errors to Fix

```bash
# Fix one rule at a time
cd backend && npx eslint --fix --rule '@typescript-eslint/no-unused-vars: error' src/
```

## Quick Reference

| Action | Command |
|--------|---------|
| Lint backend | `cd backend && npm run lint` |
| Lint frontend | `cd frontend && npm run lint` |
| Fix backend | `cd backend && npm run lint:fix` |
| Fix frontend | `cd frontend && npm run lint:fix` |
| Type check backend | `cd backend && npx tsc --noEmit` |
| Type check frontend | `cd frontend && npx tsc --noEmit` |
| Lint single file | `npx eslint path/to/file.ts` |
| Fix single file | `npx eslint --fix path/to/file.ts` |
