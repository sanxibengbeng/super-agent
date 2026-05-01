/**
 * Published Apps Routes
 * REST API endpoints for the internal mini-SaaS marketplace.
 */

import { FastifyInstance } from 'fastify';
import { extname } from 'path';
import { authenticate } from '../middleware/auth.js';
import { prisma } from '../config/database.js';
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
          metadata: (b.metadata || {}) as any,
        },
      });
      return reply.status(201).send(app);
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
