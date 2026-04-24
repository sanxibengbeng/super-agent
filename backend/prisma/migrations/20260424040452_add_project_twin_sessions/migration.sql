-- CreateTable
CREATE TABLE "project_twin_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "issue_id" UUID,
    "created_by" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "visibility" VARCHAR(10) NOT NULL DEFAULT 'private',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_twin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_twin_sessions_session_id_key" ON "project_twin_sessions"("session_id");

-- CreateIndex
CREATE INDEX "project_twin_sessions_project_id_created_by_idx" ON "project_twin_sessions"("project_id", "created_by");

-- CreateIndex
CREATE INDEX "project_twin_sessions_project_id_issue_id_idx" ON "project_twin_sessions"("project_id", "issue_id");

-- CreateIndex
CREATE INDEX "project_twin_sessions_project_id_visibility_idx" ON "project_twin_sessions"("project_id", "visibility");

-- AddForeignKey
ALTER TABLE "project_twin_sessions" ADD CONSTRAINT "project_twin_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_twin_sessions" ADD CONSTRAINT "project_twin_sessions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_twin_sessions" ADD CONSTRAINT "project_twin_sessions_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "project_issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_twin_sessions" ADD CONSTRAINT "project_twin_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_twin_sessions" ADD CONSTRAINT "project_twin_sessions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
