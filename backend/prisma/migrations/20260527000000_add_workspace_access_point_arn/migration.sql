-- Add S3 Files workspace access point ARN to business_scopes
ALTER TABLE "business_scopes" ADD COLUMN "workspace_access_point_arn" TEXT;
