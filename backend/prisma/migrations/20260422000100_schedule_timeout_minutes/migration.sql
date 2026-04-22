-- Add configurable timeout (in minutes) to workflow schedules
ALTER TABLE "workflow_schedules" ADD COLUMN "timeout_minutes" INTEGER NOT NULL DEFAULT 10;
