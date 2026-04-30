/**
 * Published Apps Routes
 * REST API endpoints for the internal mini-SaaS marketplace.
 */

import { FastifyInstance } from 'fastify';
import { stat as fsStat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, extname } from 'path';
import { authenticate } from '../middleware/auth.js';
import { prisma } from '../config/database.js';
import { chatService } from '../services/chat.service.js';
import { workspaceManager } from '../services/workspace-manager.js';
import { streamRegistry } from '../services/stream-registry.js';
import { findAppRoot } from '../services/app-finder.js';
import { appStorage } from '../services/app-storage.js';

export async function appsRoutes(fastify: FastifyInstance): Promise<void> {

  /**
   * GET /api/apps — List published apps
   */
  fastify.get<{ Querystring: { status?: string; category?: string; search?: string; page?: string; limit?: string } }>(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        description: 'List published apps',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            category: { type: 'string' },
            search: { type: 'string' },
            page: { type: 'string' },
            limit: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.orgId;
      const page = Math.max(1, parseInt(request.query.page || '1'));
      const limit = Math.min(50, Math.max(1, parseInt(request.query.limit || '20')));

      const where: Record<string, unknown> = {
        org_id: orgId,
        status: request.query.status || 'published',
      };
      if (request.query.category) where.category = request.query.category;
      if (request.query.search) {
        where.OR = [
          { name: { contains: request.query.search, mode: 'insensitive' } },
          { description: { contains: request.query.search, mode: 'insensitive' } },
        ];
      }

      const [data, total] = await Promise.all([
        prisma.published_apps.findMany({
          where,
          orderBy: { published_at: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.published_apps.count({ where }),
      ]);

      return reply.status(200).send({
        data,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    },
  );

  /**
   * GET /api/apps/:id — Get a single published app
   */
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Get a published app',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const app = await prisma.published_apps.findFirst({
        where: { id: request.params.id, org_id: request.user!.orgId },
      });
      if (!app) return reply.status(404).send({ error: 'App not found' });
      return reply.status(200).send(app);
    },
  );

  /**
   * POST /api/apps — Register a new published app
   */
  fastify.post<{ Body: { name: string; description?: string; icon?: string; category?: string; session_id?: string; business_scope_id?: string; entry_point?: string; bundle_path: string; metadata?: Record<string, unknown> } }>(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Register a published app',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['name', 'bundle_path'],
          properties: {
            name: { type: 'string', minLength: 1 },
            description: { type: 'string' },
            icon: { type: 'string' },
            category: { type: 'string' },
            session_id: { type: 'string' },
            business_scope_id: { type: 'string' },
            entry_point: { type: 'string' },
            bundle_path: { type: 'string' },
            metadata: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const app = await prisma.published_apps.create({
        data: {
          org_id: request.user!.orgId,
          session_id: b.session_id || null,
          business_scope_id: b.business_scope_id || null,
          name: b.name,
          description: b.description || null,
          icon: b.icon || '🚀',
          category: b.category || 'tool',
          entry_point: b.entry_point || 'index.html',
          bundle_path: b.bundle_path,
          published_by: request.user!.id,
          metadata: b.metadata || {},
        },
      });
      return reply.status(201).send(app);
    },
  );

  /**
   * POST /api/apps/publish-from-workspace — Publish an app directly from a session workspace folder.
   *
   * This is the primary endpoint used by the app-publisher skill. It:
   *   1. Resolves the folder path within the session workspace
   *   2. Validates an HTML entry point exists
   *   3. Uploads the bundle to S3
   *   4. Creates the DB record
   *   5. Returns the app ID and access URL
   */
  fastify.post<{
    Body: {
      session_id: string;
      folder_path: string;
      name: string;
      description?: string;
      icon?: string;
      category?: string;
      entry_point?: string;
      status?: string;
    };
  }>(
    '/publish-from-workspace',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Publish or preview an app from a session workspace folder',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['session_id', 'folder_path', 'name'],
          properties: {
            session_id: { type: 'string', format: 'uuid' },
            folder_path: { type: 'string', minLength: 1, description: 'Relative path within the workspace to the app folder' },
            name: { type: 'string', minLength: 1 },
            description: { type: 'string' },
            icon: { type: 'string' },
            category: { type: 'string', enum: ['tool', 'dashboard', 'utility', 'game', 'internal'] },
            entry_point: { type: 'string', description: 'Relative path to the HTML entry point within the folder (default: index.html)' },
            status: { type: 'string', enum: ['published', 'preview'], description: 'App status — "preview" for staging, "published" for marketplace listing' },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.orgId;
      const { session_id, folder_path, name, description, icon, category, entry_point, status: requestedStatus } = request.body;
      const appStatus = requestedStatus === 'preview' ? 'preview' : 'published';

      // 1. Look up the session to get the business_scope_id
      let session;
      try {
        session = await chatService.getSessionById(session_id, orgId);
      } catch {
        return reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      }

      const scopeId = session.business_scope_id;
      if (!scopeId) {
        return reply.status(400).send({
          error: 'Session has no business scope — cannot resolve workspace',
          code: 'NO_SCOPE',
        });
      }

      // 2. Resolve the folder path within the workspace
      const workspacePath = workspaceManager.getSessionWorkspacePath(orgId, scopeId, session_id);
      let resolvedPath = workspaceManager.resolveWorkspaceFilePath(orgId, scopeId, session_id, folder_path);
      if (!resolvedPath) {
        return reply.status(400).send({
          error: 'Invalid folder path (path traversal detected)',
          code: 'INVALID_PATH',
        });
      }

      // 3. Verify the folder exists — if not, try auto-discovering the app root
      let folderExists = false;
      try {
        const st = await fsStat(resolvedPath);
        folderExists = st.isDirectory();
      } catch {
        // folder_path doesn't exist
      }

      if (!folderExists) {
        // Auto-discover: the agent may have created the app in a nested/different folder
        request.log.warn({ folder_path }, 'Specified folder not found, auto-discovering app root');
        const candidate = await findAppRoot(workspacePath);
        if (candidate.score > 0 && candidate.path !== workspacePath) {
          resolvedPath = candidate.path;
          request.log.info({ discovered: candidate.relativePath, score: candidate.score }, 'Auto-discovered app root');
        } else {
          return reply.status(404).send({ error: `Folder not found: ${folder_path}`, code: 'FOLDER_NOT_FOUND' });
        }
      }

      // 4. Determine entry point — check common locations
      //    Prefer dist/ and build/ over root index.html because root index.html
      //    in framework projects (Vite, CRA) is the dev template, not the built output.
      let resolvedEntry = entry_point || 'index.html';
      const candidateEntries = entry_point
        ? [entry_point]
        : ['dist/index.html', 'build/index.html', 'index.html'];

      let foundEntry = false;
      for (const candidate of candidateEntries) {
        if (existsSync(join(resolvedPath, candidate))) {
          resolvedEntry = candidate;
          foundEntry = true;
          break;
        }
      }

      if (!foundEntry) {
        // Last resort: auto-discover a better app folder that has an entry point
        const candidate = await findAppRoot(workspacePath);
        if (candidate.score > 0 && candidate.path !== resolvedPath) {
          resolvedPath = candidate.path;
          request.log.info({ discovered: candidate.relativePath, score: candidate.score }, 'Re-discovered app root for entry point');
          for (const candidate2 of candidateEntries) {
            if (existsSync(join(resolvedPath, candidate2))) {
              resolvedEntry = candidate2;
              foundEntry = true;
              break;
            }
          }
        }
      }

      if (!foundEntry) {
        return reply.status(400).send({
          error: `No HTML entry point found. Checked: ${candidateEntries.join(', ')}. If this is a framework project, run the build step first.`,
          code: 'NO_ENTRY_POINT',
        });
      }

      // If the entry is inside a build output subfolder (dist/ or build/),
      // copy only that subfolder instead of the entire project directory.
      const safePath = resolvedPath as string; // guaranteed non-null after early return above
      let copySourcePath = safePath;
      if (resolvedEntry.startsWith('dist/') || resolvedEntry.startsWith('build/')) {
        const buildDir = resolvedEntry.startsWith('dist/') ? 'dist' : 'build';
        copySourcePath = join(safePath, buildDir);
        resolvedEntry = 'index.html'; // entry is now at root of the copied folder
      }

      // 5. Check if this app was already published from the same session + folder
      const existingApp = await prisma.published_apps.findFirst({
        where: {
          org_id: orgId,
          session_id: session_id,
          status: appStatus,
          metadata: { path: ['source_folder'], equals: folder_path },
        },
      });

      if (existingApp) {
        // ── UPGRADE existing app ──

        // Bump version: 1.0.0 → 1.1.0, 1.1.0 → 1.2.0, etc.
        const parts = (existingApp.version || '1.0.0').split('.');
        const minor = parseInt(parts[1] || '0') + 1;
        const newVersion = `${parts[0]}.${minor}.0`;

        // Save old version to history
        await prisma.app_versions.create({
          data: {
            app_id: existingApp.id,
            version: existingApp.version,
            bundle_path: existingApp.bundle_path,
            published_by: existingApp.published_by,
          },
        });

        // Replace the bundle in S3
        try {
          await appStorage.deletePrefix(existingApp.id);
          await appStorage.uploadDir(existingApp.id, copySourcePath);
        } catch {
          return reply.status(500).send({ error: 'Failed to upload app bundle to S3', code: 'UPLOAD_FAILED' });
        }

        // Update DB record
        const app = await prisma.published_apps.update({
          where: { id: existingApp.id },
          data: {
            name,
            description: description || existingApp.description,
            icon: icon || existingApp.icon,
            category: category || existingApp.category,
            entry_point: resolvedEntry,
            bundle_path: appStorage.getKeyPrefix(existingApp.id),
            version: newVersion,
            published_at: new Date(),
            metadata: { source_folder: folder_path },
          },
        });

        const accessUrl = `/api/apps/${app.id}/static/${resolvedEntry}`;

        // Emit preview_ready SSE event for preview apps
        if (appStatus === 'preview' && streamRegistry.isActive(session_id)) {
          streamRegistry.push(session_id, {
            type: 'preview_ready',
            appId: app.id,
            url: accessUrl,
            appName: name,
          });
        }

        return reply.status(200).send({ ...app, access_url: accessUrl, upgraded: true, previous_version: existingApp.version });
      }

      // ── NEW publish ──

      // 6. Upload bundle to S3
      const appId = crypto.randomUUID();

      try {
        await appStorage.uploadDir(appId, copySourcePath);
      } catch (err) {
        return reply.status(500).send({
          error: 'Failed to upload app bundle to S3',
          code: 'UPLOAD_FAILED',
        });
      }

      // 7. Create DB record
      const app = await prisma.published_apps.create({
        data: {
          id: appId,
          org_id: orgId,
          session_id: session_id,
          business_scope_id: scopeId,
          name,
          description: description || null,
          icon: icon || '🚀',
          category: category || 'tool',
          status: appStatus,
          entry_point: resolvedEntry,
          bundle_path: appStorage.getKeyPrefix(appId),
          published_by: request.user!.id,
          metadata: { source_folder: folder_path },
        },
      });

      const accessUrl = `/api/apps/${appId}/static/${resolvedEntry}`;

      // Emit preview_ready SSE event for preview apps
      if (appStatus === 'preview' && streamRegistry.isActive(session_id)) {
        streamRegistry.push(session_id, {
          type: 'preview_ready',
          appId: app.id,
          url: accessUrl,
          appName: name,
        });
      }

      return reply.status(201).send({
        ...app,
        access_url: accessUrl,
      });
    },
  );

  /**
   * GET /api/apps/:id/static/* — Serve built app files
   *
   * Auth strategy: HTML entry points require a ?token= query param (verified via authenticate).
   * Non-HTML assets (JS, CSS, images, fonts) are served without auth — they are build
   * artifacts with no sensitive data, and the app ID is a non-guessable UUID.
   */
  fastify.get<{ Params: { id: string; '*': string }; Querystring: { token?: string } }>(
    '/:id/static/*',
    {
      schema: {
        description: 'Serve published app static files',
        tags: ['Apps'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            '*': { type: 'string' },
          },
        },
        querystring: {
          type: 'object',
          properties: { token: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const appId = request.params.id;
      const requestedPath = request.params['*'] || '';
      const ext = extname(requestedPath).toLowerCase();
      const isHtml = ext === '.html' || ext === '.htm' || !requestedPath;

      // HTML entry points require authentication (token comes via ?token= on the iframe src)
      if (isHtml) {
        await authenticate(request, reply);
        if (reply.sent) return; // auth failed, response already sent
      }

      // Look up the app — for HTML we can filter by org, for assets we just check existence
      const where: Record<string, unknown> = { id: appId };
      if (request.user?.orgId) where.org_id = request.user.orgId;
      const app = await prisma.published_apps.findFirst({ where });
      if (!app) return reply.status(404).send({ error: 'App not found' });

      const resolvedPath = requestedPath || app.entry_point;

      // Security: prevent path traversal
      if (resolvedPath.includes('..')) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const staticPrefix = `/api/apps/${app.id}/static/`;

      // Helper: serve HTML with absolute asset paths rewritten to the app sub-path.
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

      // HTML files get path rewriting
      if (isHtml) {
        return serveHtml(resolvedPath);
      }

      // Non-HTML assets: serve as-is with long cache
      return reply
        .type(obj.contentType)
        .header('Content-Length', obj.contentLength)
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(Buffer.from(obj.body));
    },
  );

  /**
   * DELETE /api/apps/:id — Permanently delete a published app
   *
   * Removes the DB record (cascades to usage events, ratings, versions)
   * and deletes the on-disk bundle directory.
   */
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Permanently delete a published app and its associated data',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const app = await prisma.published_apps.findFirst({
        where: { id: request.params.id, org_id: request.user!.orgId },
      });
      if (!app) return reply.status(404).send({ error: 'App not found' });

      // Delete DB record — FK cascades handle usage_events, ratings, versions
      await prisma.published_apps.delete({ where: { id: app.id } });

      // Best-effort cleanup of the S3 bundle
      try {
        await appStorage.deletePrefix(app.id);
      } catch {
        // Non-fatal — the DB record is already gone
        request.log.warn({ appId: app.id }, 'Failed to remove app bundle from S3');
      }

      return reply.status(200).send({ deleted: true, id: app.id });
    },
  );

  /**
   * DELETE /api/apps — Bulk-delete multiple published apps
   *
   * Accepts { ids: string[] } in the request body.
   */
  fastify.delete<{ Body: { ids: string[] } }>(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Bulk-delete published apps',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['ids'],
          properties: {
            ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, maxItems: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.orgId;
      const { ids } = request.body;

      // Only delete apps that belong to this org
      const apps = await prisma.published_apps.findMany({
        where: { id: { in: ids }, org_id: orgId },
        select: { id: true },
      });
      const validIds = apps.map(a => a.id);

      if (validIds.length === 0) {
        return reply.status(404).send({ error: 'No matching apps found' });
      }

      await prisma.published_apps.deleteMany({ where: { id: { in: validIds } } });

      // Best-effort cleanup of S3 bundles
      for (const id of validIds) {
        try {
          await appStorage.deletePrefix(id);
        } catch {
          request.log.warn({ appId: id }, 'Failed to remove app bundle from S3');
        }
      }

      return reply.status(200).send({ deleted: true, count: validIds.length, ids: validIds });
    },
  );
}
