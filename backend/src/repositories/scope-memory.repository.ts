/**
 * Scope Memory Repository
 * Data access for scope memories with full-text search support.
 */

import { prisma } from '../config/database.js';
import type { Prisma } from '@prisma/client';

export interface ScopeMemoryEntity {
  id: string;
  organization_id: string;
  business_scope_id: string;
  session_id: string | null;
  title: string;
  content: string;
  category: string;
  tags: string[];
  is_pinned: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListMemoriesOptions {
  category?: string;
  q?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export class ScopeMemoryRepository {
  async findByScope(
    organizationId: string,
    scopeId: string,
    options: ListMemoriesOptions = {},
  ): Promise<ScopeMemoryEntity[]> {
    // Full-text search requires raw query
    if (options.q) {
      return this.searchByText(organizationId, scopeId, options);
    }

    const where: Prisma.scope_memoriesWhereInput = {
      organization_id: organizationId,
      business_scope_id: scopeId,
    };
    if (options.category) where.category = options.category;
    if (options.pinned !== undefined) where.is_pinned = options.pinned;

    return prisma.scope_memories.findMany({
      where,
      orderBy: [{ is_pinned: 'desc' }, { created_at: 'desc' }],
      take: options.limit ?? 100,
      skip: options.offset ?? 0,
    }) as Promise<ScopeMemoryEntity[]>;
  }

  private async searchByText(
    organizationId: string,
    scopeId: string,
    options: ListMemoriesOptions,
  ): Promise<ScopeMemoryEntity[]> {
    const categoryFilter = options.category ? `AND category = '${options.category.replace(/'/g, "''")}'` : '';
    const pinnedFilter = options.pinned !== undefined ? `AND is_pinned = ${options.pinned}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    return prisma.$queryRawUnsafe<ScopeMemoryEntity[]>(
      `SELECT id, organization_id, business_scope_id, session_id, title, content,
              category, tags, is_pinned, created_by, created_at, updated_at
       FROM scope_memories
       WHERE organization_id = $1
         AND business_scope_id = $2
         AND search_vector @@ plainto_tsquery('english', $3)
         ${categoryFilter} ${pinnedFilter}
       ORDER BY is_pinned DESC, ts_rank(search_vector, plainto_tsquery('english', $3)) DESC
       LIMIT ${limit} OFFSET ${offset}`,
      organizationId,
      scopeId,
      options.q!,
    );
  }

  /** Load memories for CLAUDE.md injection: all pinned + recent non-pinned, capped at ~30K chars. */
  async findForContext(scopeId: string): Promise<ScopeMemoryEntity[]> {
    const pinned = await prisma.scope_memories.findMany({
      where: { business_scope_id: scopeId, is_pinned: true },
      orderBy: { created_at: 'desc' },
    }) as ScopeMemoryEntity[];

    const recent = await prisma.scope_memories.findMany({
      where: { business_scope_id: scopeId, is_pinned: false },
      orderBy: { created_at: 'desc' },
      take: 50,
    }) as ScopeMemoryEntity[];

    // Cap at ~30K chars total
    const result: ScopeMemoryEntity[] = [...pinned];
    let charCount = pinned.reduce((sum, m) => sum + m.title.length + m.content.length + 50, 0);

    for (const m of recent) {
      const entrySize = m.title.length + m.content.length + 50;
      if (charCount + entrySize > 30000) break;
      result.push(m);
      charCount += entrySize;
    }

    return result;
  }

  async findById(id: string, organizationId: string): Promise<ScopeMemoryEntity | null> {
    return prisma.scope_memories.findFirst({
      where: { id, organization_id: organizationId },
    }) as Promise<ScopeMemoryEntity | null>;
  }

  async create(
    data: Omit<ScopeMemoryEntity, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ScopeMemoryEntity> {
    return prisma.scope_memories.create({
      data: {
        organization_id: data.organization_id,
        business_scope_id: data.business_scope_id,
        session_id: data.session_id,
        title: data.title,
        content: data.content,
        category: data.category,
        tags: data.tags,
        is_pinned: data.is_pinned,
        created_by: data.created_by,
      },
    }) as Promise<ScopeMemoryEntity>;
  }

  async update(
    id: string,
    organizationId: string,
    data: Partial<Pick<ScopeMemoryEntity, 'title' | 'content' | 'category' | 'tags' | 'is_pinned'>>,
  ): Promise<ScopeMemoryEntity | null> {
    const existing = await this.findById(id, organizationId);
    if (!existing) return null;

    const updateData: Prisma.scope_memoriesUncheckedUpdateInput = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.content !== undefined) updateData.content = data.content;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.tags !== undefined) updateData.tags = data.tags;
    if (data.is_pinned !== undefined) updateData.is_pinned = data.is_pinned;

    return prisma.scope_memories.update({
      where: { id },
      data: updateData,
    }) as Promise<ScopeMemoryEntity>;
  }

  async delete(id: string, organizationId: string): Promise<boolean> {
    const existing = await this.findById(id, organizationId);
    if (!existing) return false;
    await prisma.scope_memories.delete({ where: { id } });
    return true;
  }
}

export const scopeMemoryRepository = new ScopeMemoryRepository();
