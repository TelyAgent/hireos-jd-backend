-- AlterTable
ALTER TABLE "JobDraft" ALTER COLUMN "sourceRefs" DROP DEFAULT;

-- CreateTable
CREATE TABLE "CopilotConversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "jobId" TEXT,
    "phase" TEXT NOT NULL DEFAULT 'intake',
    "fields" JSONB NOT NULL DEFAULT '{}',
    "missingFields" JSONB NOT NULL DEFAULT '[]',
    "stateRevision" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopilotConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopilotMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT,
    "attachments" JSONB,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopilotMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT,
    "capabilityCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Queued',
    "resultJson" JSONB,
    "failureCode" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CopilotConversation_workspaceId_actorId_updatedAt_idx" ON "CopilotConversation"("workspaceId", "actorId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CopilotMessage_conversationId_sequence_key" ON "CopilotMessage"("conversationId", "sequence");

-- CreateIndex
CREATE INDEX "AiRun_workspaceId_capabilityCode_status_idx" ON "AiRun"("workspaceId", "capabilityCode", "status");

-- AddForeignKey
ALTER TABLE "CopilotMessage" ADD CONSTRAINT "CopilotMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "CopilotConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "CopilotConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
