-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN     "source" VARCHAR(20) NOT NULL DEFAULT 'user';

-- AlterTable
ALTER TABLE "workflow_executions" ADD COLUMN     "chat_session_id" UUID;

-- CreateIndex
CREATE INDEX "chat_sessions_source_idx" ON "chat_sessions"("source");

-- CreateIndex
CREATE INDEX "workflow_executions_chat_session_id_idx" ON "workflow_executions"("chat_session_id");

-- AddForeignKey
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_chat_session_id_fkey" FOREIGN KEY ("chat_session_id") REFERENCES "chat_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
