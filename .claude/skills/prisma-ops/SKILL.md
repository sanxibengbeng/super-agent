---
name: prisma-ops
description: Prisma database operations for Super Agent - create/run migrations, generate client, seed data, reset database, introspect schema, view data with Prisma Studio. Use this skill whenever the user mentions: migration, prisma, database schema, seed, db reset, generate client, schema change, add table, add field, add column, prisma studio, view data, database error, PrismaClientKnownRequestError, shadow database, migrate dev, migrate deploy, npx prisma, or any variation of database schema/migration operations. Also use when user encounters Prisma-related errors or wants to modify the data model.
---

# Prisma Ops - Database Operations

## Purpose

Handle all Prisma-related database operations for Super Agent including migrations, schema changes, client generation, seeding, and database management.

## Trigger Keywords

- "migration", "create migration", "run migration"
- "prisma generate", "generate client"
- "seed database", "seed data"
- "reset database", "db reset"
- "schema change", "add table", "add field"
- "prisma studio", "view data"

## Schema Location

Prisma schema files are in `backend/prisma/schema/`:
- Multi-file schema using `prismaSchemaFolder` preview feature
- Main models: Organization, User, BusinessScope, Agent, Skill, Workflow, ChatSession, Document

## Common Operations

### Generate Prisma Client

After any schema change:
```bash
cd backend && npm run prisma:generate
```

### Create Migration

After modifying schema files:
```bash
cd backend && npx prisma migrate dev --name <migration-name>
```

Migration naming conventions:
- `add_<table>` - New table
- `add_<field>_to_<table>` - New field
- `update_<table>_<change>` - Modify existing
- `remove_<field>_from_<table>` - Remove field

Examples:
```bash
npx prisma migrate dev --name add_workflow_triggers
npx prisma migrate dev --name add_status_to_execution
npx prisma migrate dev --name update_agent_add_memory_config
```

### Apply Migrations (Production)

```bash
cd backend && npm run prisma:migrate:prod
# or
cd backend && npx prisma migrate deploy
```

### Reset Database

**Warning: Destroys all data**
```bash
cd backend && npx prisma migrate reset
```

This will:
1. Drop all tables
2. Re-run all migrations
3. Run seed script if exists

### Seed Database

```bash
cd backend && npx prisma db seed
```

Seed files:
- `backend/prisma/seed.ts` - Main seed
- `backend/prisma/seed-showcase.ts` - Showcase data
- `backend/prisma/seed-local-auth.ts` - Local auth testing

### View Database (Prisma Studio)

```bash
cd backend && npx prisma studio
```
Opens browser at http://localhost:5555

### Introspect Existing Database

```bash
cd backend && npx prisma db pull
```

### Check Migration Status

```bash
cd backend && npx prisma migrate status
```

### Format Schema

```bash
cd backend && npx prisma format
```

## Schema Change Workflow

1. **Edit schema file** in `backend/prisma/schema/`
2. **Format schema**: `npx prisma format`
3. **Create migration**: `npx prisma migrate dev --name <name>`
4. **Generate client**: `npm run prisma:generate`
5. **Update repository/service code** if needed
6. **Test the change**

## Common Schema Patterns

### Add New Model
```prisma
model NewEntity {
  id             String   @id @default(uuid())
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  
  @@index([organizationId])
}
```

### Add Relation
```prisma
// In parent model
children Child[]

// In child model
parentId String
parent   Parent @relation(fields: [parentId], references: [id])
@@index([parentId])
```

### Add Enum
```prisma
enum Status {
  PENDING
  RUNNING
  COMPLETED
  FAILED
}
```

### Add Optional Field with Default
```prisma
isActive Boolean @default(true)
config   Json    @default("{}")
```

## Troubleshooting

### Migration Conflict
```
Error: Migration failed to apply
```
Solution: Check migration files for conflicts, may need `prisma migrate resolve`.

### Client Out of Sync
```
Error: PrismaClientKnownRequestError
```
Solution: Run `npm run prisma:generate` to regenerate client.

### Shadow Database Issues
```
Error: shadow database
```
Solution: Ensure DATABASE_URL user has CREATE DATABASE permissions.

### Pending Migrations in Production
```bash
# Check status
npx prisma migrate status

# Apply pending
npx prisma migrate deploy
```

## Quick Reference

| Action | Command |
|--------|---------|
| Generate client | `npm run prisma:generate` |
| Create migration | `npx prisma migrate dev --name <name>` |
| Apply migrations | `npx prisma migrate deploy` |
| Reset database | `npx prisma migrate reset` |
| Seed data | `npx prisma db seed` |
| Open Studio | `npx prisma studio` |
| Check status | `npx prisma migrate status` |
| Format schema | `npx prisma format` |
| Pull from DB | `npx prisma db pull` |
