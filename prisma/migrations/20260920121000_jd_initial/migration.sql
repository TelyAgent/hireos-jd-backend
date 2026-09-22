CREATE TABLE "JobDraft" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "coreRoleVersionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "roleSummary" TEXT,
    "responsibilities" JSONB NOT NULL,
    "requirements" JSONB NOT NULL,
    "dimensions" JSONB NOT NULL,
    "mappingStatus" TEXT NOT NULL DEFAULT 'consistent',
    "contentHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobDraft_workspaceId_jobId_revision_key"
ON "JobDraft"("workspaceId", "jobId", "revision");

CREATE INDEX "JobDraft_workspaceId_jobId_status_idx"
ON "JobDraft"("workspaceId", "jobId", "status");

CREATE UNIQUE INDEX "IdempotencyKey_workspaceId_operation_key_key"
ON "IdempotencyKey"("workspaceId", "operation", "key");
