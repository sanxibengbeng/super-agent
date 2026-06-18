-- CreateIndex
CREATE INDEX "chat_sessions_status_idx" ON "chat_sessions"("status");

-- CreateIndex
CREATE INDEX "chat_sessions_organization_id_status_idx" ON "chat_sessions"("organization_id", "status");
