-- CreateTable
CREATE TABLE "execution_tasks" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "source" VARCHAR(30) NOT NULL,
    "source_entity_id" UUID,
    "runtime" VARCHAR(20) NOT NULL,
    "runtime_session_id" VARCHAR(100),
    "workspace_bucket" VARCHAR(200),
    "workspace_prefix" VARCHAR(500),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "error_message" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_events" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "execution_tasks_session_id_idx" ON "execution_tasks"("session_id");

-- CreateIndex
CREATE INDEX "execution_tasks_org_id_idx" ON "execution_tasks"("org_id");

-- CreateIndex
CREATE INDEX "execution_tasks_status_idx" ON "execution_tasks"("status");

-- CreateIndex
CREATE INDEX "execution_tasks_source_idx" ON "execution_tasks"("source");

-- CreateIndex
CREATE INDEX "execution_tasks_created_at_idx" ON "execution_tasks"("created_at" DESC);

-- CreateIndex
CREATE INDEX "execution_events_session_id_created_at_idx" ON "execution_events"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "execution_events_task_id_idx" ON "execution_events"("task_id");

-- AddForeignKey
ALTER TABLE "execution_tasks" ADD CONSTRAINT "execution_tasks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_tasks" ADD CONSTRAINT "execution_tasks_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "execution_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
