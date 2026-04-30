# Apps S3 Storage Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move published app bundle storage from the backend container's local filesystem (`/tmp/workspaces/_published_apps/`) to S3, so apps survive container rebuilds and work correctly when code runs inside AgentCore.

**Architecture:** The `publish-from-workspace` endpoint currently copies files from the session workspace to a local `_published_apps/{appId}/` directory. The static serving endpoint reads from that directory. We replace both with S3 operations: `PutObject` for publish, `GetObject` for serve. The S3 key prefix is `_published_apps/{appId}/`. We reuse the existing `AGENTCORE_WORKSPACE_S3_BUCKET` bucket. All existing auth, HTML path-rewriting, and SPA fallback logic stays in the route handler — only the storage backend changes. The `bundle_path` DB column transitions from an absolute filesystem path to an S3 key prefix.

**Tech Stack:** `@aws-sdk/client-s3` (already a dependency), Fastify, Prisma

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/src/services/app-storage.ts` | **Create** | S3 storage service: `uploadDir`, `getObject`, `deletePrefix`, `listPrefix` |
| `backend/src/routes/apps.routes.ts` | **Modify** | Replace all `fs.cp`/`fs.createReadStream`/`fs.rm` calls with `appStorage.*` calls |
| `backend/src/services/__tests__/app-storage.test.ts` | **Create** | Unit tests for app-storage service |
| `backend/src/routes/__tests__/apps-s3.test.ts` | **Create** | Integration tests for S3-backed publish and serve |

---

### Task 1: Create `app-storage.ts` — S3 storage service

**Files:**
- Create: `backend/src/services/app-storage.ts`
- Test: `backend/src/services/__tests__/app-storage.test.ts`

- [ ] **Step 1: Write the failing test for `uploadDir`**

Create `backend/src/services/__tests__/app-storage.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppStorage } from '../app-storage.js';

const mockSend = vi.fn().mockResolvedValue({});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'PutObject' })),
  GetObjectCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'GetObject' })),
  DeleteObjectCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'DeleteObject' })),
  ListObjectsV2Command: vi.fn().mockImplementation((input) => ({ ...input, _type: 'ListObjects' })),
}));

// Mock fs for uploadDir
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual };
});

describe('AppStorage', () => {
  let storage: AppStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new AppStorage('test-bucket', 'us-east-1');
  });

  it('should construct S3 key prefix from appId', () => {
    expect(storage.getKeyPrefix('abc-123')).toBe('_published_apps/abc-123/');
  });

  it('getObject returns body and content type', async () => {
    const body = Buffer.from('<html>hello</html>');
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: () => Promise.resolve(body) },
      ContentType: 'text/html',
      ContentLength: body.length,
    });

    const result = await storage.getObject('abc-123', 'index.html');
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe('text/html');
    expect(result!.body).toEqual(body);
  });

  it('getObject returns null for NoSuchKey', async () => {
    const err = new Error('not found');
    (err as any).name = 'NoSuchKey';
    mockSend.mockRejectedValueOnce(err);

    const result = await storage.getObject('abc-123', 'missing.html');
    expect(result).toBeNull();
  });

  it('deletePrefix lists and deletes all objects', async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [
          { Key: '_published_apps/abc-123/index.html' },
          { Key: '_published_apps/abc-123/main.js' },
        ],
        IsTruncated: false,
      })
      .mockResolvedValue({}); // DeleteObject calls

    const count = await storage.deletePrefix('abc-123');
    expect(count).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/__tests__/app-storage.test.ts`
Expected: FAIL — `app-storage.ts` does not exist.

- [ ] **Step 3: Implement `app-storage.ts`**

Create `backend/src/services/app-storage.ts`:

```typescript
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, extname } from 'path';

const S3_PREFIX = '_published_apps';

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.DS_Store']);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json',
};

export interface S3Object {
  body: Uint8Array;
  contentType: string;
  contentLength: number;
}

export class AppStorage {
  private s3: S3Client;
  private bucket: string;

  constructor(bucket: string, region: string, s3Client?: S3Client) {
    this.bucket = bucket;
    this.s3 = s3Client ?? new S3Client({ region });
  }

  getKeyPrefix(appId: string): string {
    return `${S3_PREFIX}/${appId}/`;
  }

  /**
   * Upload a local directory to S3 under _published_apps/{appId}/.
   * Returns the number of files uploaded.
   */
  async uploadDir(appId: string, localDir: string): Promise<number> {
    let count = 0;

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }

        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > 50 * 1024 * 1024) continue; // skip >50MB

          const relPath = relative(localDir, fullPath);
          const key = `${S3_PREFIX}/${appId}/${relPath}`;
          const ext = extname(entry.name).toLowerCase();

          await this.s3.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: await readFile(fullPath),
            ContentType: MIME_TYPES[ext] || 'application/octet-stream',
            ContentLength: fileStat.size,
          }));
          count++;
        } catch {
          // skip individual file failures
        }
      }
    };

    await walk(localDir);
    return count;
  }

  /**
   * Get a single file from S3.
   * Returns null if the key does not exist.
   */
  async getObject(appId: string, filePath: string): Promise<S3Object | null> {
    const key = `${S3_PREFIX}/${appId}/${filePath}`;
    try {
      const response = await this.s3.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));

      const body = await response.Body!.transformToByteArray();
      const ext = extname(filePath).toLowerCase();

      return {
        body,
        contentType: response.ContentType || MIME_TYPES[ext] || 'application/octet-stream',
        contentLength: body.length,
      };
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Delete all objects under _published_apps/{appId}/.
   * Returns the number of deleted objects.
   */
  async deletePrefix(appId: string): Promise<number> {
    const prefix = this.getKeyPrefix(appId);
    let deleted = 0;
    let continuationToken: string | undefined;

    do {
      const result = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      for (const obj of result.Contents ?? []) {
        if (!obj.Key) continue;
        await this.s3.send(new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: obj.Key,
        }));
        deleted++;
      }

      continuationToken = result.NextContinuationToken;
    } while (continuationToken);

    return deleted;
  }

  /**
   * List all keys under _published_apps/{appId}/ (for SPA fallback detection).
   */
  async listFiles(appId: string): Promise<string[]> {
    const prefix = this.getKeyPrefix(appId);
    const files: string[] = [];
    let continuationToken: string | undefined;

    do {
      const result = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      for (const obj of result.Contents ?? []) {
        if (!obj.Key) continue;
        files.push(obj.Key.slice(prefix.length));
      }

      continuationToken = result.NextContinuationToken;
    } while (continuationToken);

    return files;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/services/__tests__/app-storage.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/app-storage.ts backend/src/services/__tests__/app-storage.test.ts
git commit -m "feat(apps): add S3-backed AppStorage service for published app bundles"
```

---

### Task 2: Create and export `appStorage` singleton

**Files:**
- Modify: `backend/src/services/app-storage.ts` (add export at bottom)

- [ ] **Step 1: Add singleton export to `app-storage.ts`**

Append to the bottom of `backend/src/services/app-storage.ts`:

```typescript
import { config } from '../config/index.js';

export const appStorage = new AppStorage(
  config.agentcore.workspaceS3Bucket,
  config.agentcore.workspaceS3Region,
);
```

- [ ] **Step 2: Verify the import resolves**

Run: `cd backend && npx tsc --noEmit --pretty 2>&1 | grep app-storage || echo "OK"`
Expected: No errors mentioning `app-storage`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/app-storage.ts
git commit -m "feat(apps): export appStorage singleton wired to workspace S3 bucket"
```

---

### Task 3: Migrate `publish-from-workspace` endpoint to S3

**Files:**
- Modify: `backend/src/routes/apps.routes.ts:166-434` (the `publish-from-workspace` handler)

This is the core change. We replace:
1. `cp(copySourcePath, targetDir, ...)` → `appStorage.uploadDir(appId, copySourcePath)`
2. `rm(targetDir, ...)` → `appStorage.deletePrefix(existingApp.id)`
3. `bundle_path` DB value: from local path → S3 key prefix (`_published_apps/{appId}/`)

- [ ] **Step 1: Update imports at top of `apps.routes.ts`**

Remove unused fs imports and add `appStorage`:

```typescript
// BEFORE (line 7-8):
import { stat as fsStat, cp, mkdir, readFile, rm } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';

// AFTER:
import { stat as fsStat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { appStorage } from '../services/app-storage.js';
```

Remove `APPS_STORAGE_DIR` constant (line 18):

```typescript
// DELETE this line:
const APPS_STORAGE_DIR = join(config.claude.workspaceBaseDir, '_published_apps');
```

Remove the `config` import if it's no longer needed elsewhere in the file — check first. (It's used by `workspaceManager` which imports it separately, so check if `config` is used directly in this file besides the deleted `APPS_STORAGE_DIR` line.) If not used elsewhere, remove `import { config } from '../config/index.js';`.

- [ ] **Step 2: Replace UPGRADE path (existing app re-publish)**

Replace lines 341-351 (the `rm` + `mkdir` + `cp` block inside the `if (existingApp)` branch):

```typescript
// BEFORE:
const targetDir = existingApp.bundle_path;
try {
  await rm(targetDir, { recursive: true, force: true });
} catch { /* old dir may already be gone */ }
await mkdir(targetDir, { recursive: true });
try {
  await cp(copySourcePath, targetDir, { recursive: true });
} catch {
  return reply.status(500).send({ error: 'Failed to copy app bundle', code: 'COPY_FAILED' });
}

// AFTER:
try {
  await appStorage.deletePrefix(existingApp.id);
  await appStorage.uploadDir(existingApp.id, copySourcePath);
} catch {
  return reply.status(500).send({ error: 'Failed to upload app bundle to S3', code: 'UPLOAD_FAILED' });
}
```

The DB update stays the same — `bundle_path` for existing apps keeps its current value (we'll address historical data below).

Wait — for the UPGRADE path, the existing `bundle_path` is a local path. After migration, new apps will have S3 prefix as `bundle_path`. For the upgrade, we should update `bundle_path` to the S3 key prefix in the DB update:

In the `prisma.published_apps.update()` call (around line 354), add/change `bundle_path`:

```typescript
// In the data object for the update:
data: {
  name,
  description: description || existingApp.description,
  icon: icon || existingApp.icon,
  category: category || existingApp.category,
  entry_point: resolvedEntry,
  bundle_path: appStorage.getKeyPrefix(existingApp.id), // S3 prefix
  version: newVersion,
  published_at: new Date(),
  metadata: { source_folder: folder_path },
},
```

- [ ] **Step 3: Replace NEW publish path**

Replace lines 385-397 (the `mkdir` + `cp` block for new apps):

```typescript
// BEFORE:
await mkdir(APPS_STORAGE_DIR, { recursive: true });
const appId = crypto.randomUUID();
const targetDir = join(APPS_STORAGE_DIR, appId);
try {
  await cp(copySourcePath, targetDir, { recursive: true });
} catch (err) {
  return reply.status(500).send({
    error: 'Failed to copy app bundle',
    code: 'COPY_FAILED',
  });
}

// AFTER:
const appId = crypto.randomUUID();
try {
  await appStorage.uploadDir(appId, copySourcePath);
} catch (err) {
  return reply.status(500).send({
    error: 'Failed to upload app bundle to S3',
    code: 'UPLOAD_FAILED',
  });
}
```

Update the DB create call's `bundle_path`:

```typescript
// BEFORE:
bundle_path: targetDir,

// AFTER:
bundle_path: appStorage.getKeyPrefix(appId),
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/apps.routes.ts
git commit -m "feat(apps): migrate publish-from-workspace to S3 storage"
```

---

### Task 4: Migrate static serving endpoint to S3

**Files:**
- Modify: `backend/src/routes/apps.routes.ts:444-527` (the `GET /:id/static/*` handler)

This replaces `existsSync` + `createReadStream` + `fsStat` with `appStorage.getObject()`.

- [ ] **Step 1: Rewrite the static serving handler**

Replace the entire handler body (inside the `async (request, reply) =>` callback, lines 464-527):

```typescript
async (request, reply) => {
  const appId = request.params.id;
  const requestedPath = request.params['*'] || '';
  const ext = extname(requestedPath).toLowerCase();
  const isHtml = ext === '.html' || ext === '.htm' || !requestedPath;

  if (isHtml) {
    await authenticate(request, reply);
    if (reply.sent) return;
  }

  const where: Record<string, unknown> = { id: appId };
  if (request.user?.orgId) where.org_id = request.user.orgId;
  const app = await prisma.published_apps.findFirst({ where });
  if (!app) return reply.status(404).send({ error: 'App not found' });

  const resolvedPath = requestedPath || app.entry_point;

  // Security: reject path traversal
  if (resolvedPath.includes('..')) {
    return reply.status(403).send({ error: 'Forbidden' });
  }

  const staticPrefix = `/api/apps/${app.id}/static/`;

  const serveHtml = async (htmlKey: string) => {
    const obj = await appStorage.getObject(app.id, htmlKey);
    if (!obj) return reply.status(404).send({ error: 'File not found' });

    let html = Buffer.from(obj.body).toString('utf-8');
    html = html.replace(/(src|href|action)="\/(?!\/)/g, `$1="${staticPrefix}`);
    html = html.replace(/url\("\/(?!\/)/g, `url("${staticPrefix}`);
    return reply
      .type('text/html')
      .header('Content-Length', Buffer.byteLength(html))
      .header('Cache-Control', 'no-cache')
      .send(html);
  };

  const obj = await appStorage.getObject(app.id, resolvedPath);

  if (!obj) {
    // SPA fallback — serve entry point for client-side routing
    if (isHtml || !ext) {
      return serveHtml(app.entry_point);
    }
    return reply.status(404).send({ error: 'File not found' });
  }

  if (isHtml) {
    return serveHtml(resolvedPath);
  }

  // Non-HTML assets
  return reply
    .type(obj.contentType)
    .header('Content-Length', obj.contentLength)
    .header('Cache-Control', 'public, max-age=31536000, immutable')
    .send(Buffer.from(obj.body));
},
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/apps.routes.ts
git commit -m "feat(apps): migrate static file serving to stream from S3"
```

---

### Task 5: Migrate delete endpoints to S3

**Files:**
- Modify: `backend/src/routes/apps.routes.ts:536-625` (single delete + bulk delete handlers)

- [ ] **Step 1: Replace single delete handler cleanup**

Replace lines 560-568 (the `rm` block):

```typescript
// BEFORE:
const bundleDir = join(APPS_STORAGE_DIR, app.id);
try {
  const { rm } = await import('fs/promises');
  await rm(bundleDir, { recursive: true, force: true });
} catch {
  request.log.warn({ appId: app.id, bundleDir }, 'Failed to remove app bundle directory');
}

// AFTER:
try {
  await appStorage.deletePrefix(app.id);
} catch {
  request.log.warn({ appId: app.id }, 'Failed to remove app bundle from S3');
}
```

- [ ] **Step 2: Replace bulk delete handler cleanup**

Replace lines 613-620 (the `rm` loop):

```typescript
// BEFORE:
const { rm } = await import('fs/promises');
for (const appId of validIds) {
  try {
    await rm(join(APPS_STORAGE_DIR, appId), { recursive: true, force: true });
  } catch {
    request.log.warn({ appId }, 'Failed to remove app bundle directory');
  }
}

// AFTER:
for (const id of validIds) {
  try {
    await appStorage.deletePrefix(id);
  } catch {
    request.log.warn({ appId: id }, 'Failed to remove app bundle from S3');
  }
}
```

- [ ] **Step 3: Clean up unused imports**

After all changes, the file should no longer use `cp`, `mkdir`, `rm`, `createReadStream` from `fs`/`fs/promises`. Also `APPS_STORAGE_DIR`, `config`, and `MIME_TYPES` should be gone from this file (MIME is now in `app-storage.ts`).

Check and remove:
- `import { stat as fsStat, cp, mkdir, readFile, rm } from 'fs/promises'` → keep only what's still used. After all tasks, check if `fsStat` and `readFile` are still needed in this file — `readFile` was used by `serveHtml` (now removed), `fsStat` was used by the static handler (now removed). The `existsSync` is still used by the `publish-from-workspace` entry point detection. So:

```typescript
// Final imports at top of file:
import { existsSync } from 'fs';
import { join, extname } from 'path';
```

`stat as fsStat`, `cp`, `mkdir`, `readFile`, `rm`, `createReadStream` — all removed.

Also remove the `MIME_TYPES` constant from this file (it's now in `app-storage.ts`).

Also remove `APPS_STORAGE_DIR`.

Keep `config` import ONLY if it's still used (check — it was only used for `APPS_STORAGE_DIR`). If not needed, remove.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/apps.routes.ts
git commit -m "feat(apps): migrate delete endpoints to S3 cleanup"
```

---

### Task 6: Update `POST /api/apps` (manual register) endpoint

**Files:**
- Modify: `backend/src/routes/apps.routes.ts:120-163`

This rarely-used endpoint accepts a raw `bundle_path` from the caller. After migration, the `bundle_path` should be an S3 key prefix. No file copying happens here — the caller is responsible for the bundle being present. This endpoint just needs to stay consistent. No code changes needed unless we want to validate the S3 prefix format. Skip validation for now — this is a power-user endpoint.

- [ ] **Step 1: No code changes needed — verify the endpoint still works conceptually**

The `POST /api/apps` endpoint stores whatever `bundle_path` is sent. Callers that use this directly (if any) will need to provide S3 prefixes. This is acceptable — document in commit message.

- [ ] **Step 2: Commit (docs-only change, no code)**

No commit needed — no code changed.

---

### Task 7: End-to-end smoke test

**Files:**
- No file changes — manual verification

- [ ] **Step 1: Verify backend compiles and starts**

Run:
```bash
cd backend && npx tsc --noEmit --pretty
```
Expected: No TypeScript errors.

- [ ] **Step 2: Run existing tests to check for regressions**

Run:
```bash
cd backend && npm run test 2>&1 | tail -20
```
Expected: All existing tests pass. No tests should break from these changes since the old code had no tests for apps routes.

- [ ] **Step 3: Run the new app-storage tests**

Run:
```bash
cd backend && npx vitest run src/services/__tests__/app-storage.test.ts
```
Expected: All pass.

- [ ] **Step 4: Final commit with all cleanup**

If any remaining lint/type issues, fix them and commit:

```bash
cd backend && npm run lint:fix
git add -A
git commit -m "chore(apps): final cleanup after S3 storage migration"
```

---

## Summary of Changes

| What | Before | After |
|------|--------|-------|
| Publish storage | `fs.cp()` to `/tmp/workspaces/_published_apps/{appId}/` | `appStorage.uploadDir()` to `s3://{bucket}/_published_apps/{appId}/` |
| Static serving | `fs.createReadStream()` from local path | `appStorage.getObject()` from S3 |
| Delete cleanup | `fs.rm()` on local directory | `appStorage.deletePrefix()` on S3 |
| `bundle_path` in DB | Absolute filesystem path | S3 key prefix (`_published_apps/{appId}/`) |
| S3 bucket | N/A | Reuses `AGENTCORE_WORKSPACE_S3_BUCKET` |
| Auth / path rewriting | In route handler | Unchanged — stays in route handler |
| `detect-apps` endpoint | Scans local filesystem | **Unchanged** — still scans local workspace (workspace sync-back populates these files) |
