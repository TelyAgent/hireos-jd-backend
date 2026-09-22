ALTER TABLE "JobDraft"
  ADD COLUMN "hiringContext" JSONB,
  ADD COLUMN "successCriteria" JSONB,
  ADD COLUMN "internalCompensation" JSONB,
  ADD COLUMN "publicCompensation" JSONB,
  ADD COLUMN "sourceRefs" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'jd_module';
