-- CreateEnum
CREATE TYPE "ConversationOutcome" AS ENUM ('NOT_CONNECTED', 'FAILED', 'ABANDONED', 'SHORT', 'ENGAGED', 'LEAD_CAPTURED');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "outcome" "ConversationOutcome",
ADD COLUMN     "transcriptConsent" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
ADD COLUMN     "statusChangedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "leadRetentionDays" INTEGER NOT NULL DEFAULT 365,
ADD COLUMN     "storeTranscripts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transcriptRetentionDays" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "ConversationTranscript" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entries" JSONB NOT NULL,
    "entryCount" INTEGER NOT NULL,
    "summary" TEXT,
    "summaryModel" TEXT,
    "summarizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorReport" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "route" TEXT,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "digest" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "status" "JobRunStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "details" JSONB,
    "error" TEXT,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTranscript_conversationId_key" ON "ConversationTranscript"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationTranscript_organizationId_createdAt_idx" ON "ConversationTranscript"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ErrorReport_fingerprint_key" ON "ErrorReport"("fingerprint");

-- CreateIndex
CREATE INDEX "ErrorReport_lastSeenAt_idx" ON "ErrorReport"("lastSeenAt");

-- CreateIndex
CREATE INDEX "JobRun_job_startedAt_idx" ON "JobRun"("job", "startedAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Conversation_organizationId_startedAt_idx" ON "Conversation"("organizationId", "startedAt");

-- CreateIndex
CREATE INDEX "Lead_organizationId_createdAt_idx" ON "Lead"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "ConversationTranscript" ADD CONSTRAINT "ConversationTranscript_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTranscript" ADD CONSTRAINT "ConversationTranscript_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Retention windows the settings form also enforces (src/lib/validation/privacy.ts).
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_transcriptRetentionDays_check" CHECK ("transcriptRetentionDays" BETWEEN 1 AND 365);
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_leadRetentionDays_check" CHECK ("leadRetentionDays" BETWEEN 30 AND 1095);
ALTER TABLE "ConversationTranscript" ADD CONSTRAINT "ConversationTranscript_entryCount_check" CHECK ("entryCount" >= 0);
ALTER TABLE "ErrorReport" ADD CONSTRAINT "ErrorReport_occurrences_check" CHECK ("occurrences" >= 1);

-- Backfill outcomes for sessions that ended before outcomes existed, using the same rules and
-- precedence as src/server/conversations/outcome.ts. Sessions from before the usage ledger
-- (Phase 3) fall back to their measured wall-clock length.
UPDATE "Conversation" c SET "outcome" = (CASE
  WHEN c."status" = 'FAILED' THEN 'FAILED'
  WHEN c."tokenIssuedAt" IS NULL THEN 'NOT_CONNECTED'
  WHEN EXISTS (SELECT 1 FROM "Lead" l WHERE l."conversationId" = c."id") THEN 'LEAD_CAPTURED'
  WHEN c."closeReason" = 'abandoned' THEN 'ABANDONED'
  WHEN COALESCE(
    (SELECT u."quantity" FROM "UsageLedgerEntry" u WHERE u."conversationId" = c."id" AND u."metric" = 'VOICE_SECONDS' LIMIT 1),
    EXTRACT(EPOCH FROM (c."endedAt" - c."tokenIssuedAt")),
    0
  ) < 15 THEN 'SHORT'
  ELSE 'ENGAGED'
END)::"ConversationOutcome"
WHERE c."status" <> 'ACTIVE';
