-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('REQUESTED', 'CONNECTED', 'MISSED');

-- CreateEnum
CREATE TYPE "OptOutSource" AS ENUM ('CALLER_KEYPAD', 'CALLER_REQUEST', 'STAFF');

-- CreateEnum
CREATE TYPE "TelephonyWebhookSource" AS ENUM ('TWILIO', 'OPENAI');

-- AlterEnum
ALTER TYPE "ConversationChannel" ADD VALUE 'PHONE';

-- AlterEnum
ALTER TYPE "ConversationOutcome" ADD VALUE 'TRANSFERRED';

-- AlterEnum
ALTER TYPE "UsageMetric" ADD VALUE 'TELEPHONY_SECONDS';

-- CreateTable
CREATE TABLE "PhoneNumber" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "agentId" TEXT,
    "e164" TEXT NOT NULL,
    "providerNumberSid" TEXT,
    "label" TEXT,
    "inboundEnabled" BOOLEAN NOT NULL DEFAULT true,
    "outboundEnabled" BOOLEAN NOT NULL DEFAULT false,
    "transferNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneCall" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "direction" "CallDirection" NOT NULL,
    "remoteNumber" TEXT,
    "providerCallSid" TEXT,
    "realtimeCallId" TEXT,
    "providerStatus" TEXT NOT NULL DEFAULT 'queued',
    "answeredBy" TEXT,
    "aiLegSeconds" INTEGER,
    "carrierSeconds" INTEGER,
    "carrierPriceMicros" INTEGER,
    "carrierPriceUnit" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "transferStatus" "TransferStatus",
    "transferRequestedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "requestedByUserId" TEXT,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallOptOut" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "source" "OptOutSource" NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelephonyWebhookEvent" (
    "id" TEXT NOT NULL,
    "source" "TelephonyWebhookSource" NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "WebhookEventStatus" NOT NULL,
    "organizationId" TEXT,
    "note" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelephonyWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhoneNumber_e164_key" ON "PhoneNumber"("e164");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneNumber_providerNumberSid_key" ON "PhoneNumber"("providerNumberSid");

-- CreateIndex
CREATE INDEX "PhoneNumber_organizationId_idx" ON "PhoneNumber"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneCall_conversationId_key" ON "PhoneCall"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneCall_providerCallSid_key" ON "PhoneCall"("providerCallSid");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneCall_realtimeCallId_key" ON "PhoneCall"("realtimeCallId");

-- CreateIndex
CREATE INDEX "PhoneCall_organizationId_createdAt_idx" ON "PhoneCall"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "PhoneCall_organizationId_remoteNumber_idx" ON "PhoneCall"("organizationId", "remoteNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CallOptOut_organizationId_phoneNumber_key" ON "CallOptOut"("organizationId", "phoneNumber");

-- CreateIndex
CREATE INDEX "TelephonyWebhookEvent_receivedAt_idx" ON "TelephonyWebhookEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelephonyWebhookEvent_source_eventKey_key" ON "TelephonyWebhookEvent"("source", "eventKey");

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneCall" ADD CONSTRAINT "PhoneCall_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneCall" ADD CONSTRAINT "PhoneCall_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneCall" ADD CONSTRAINT "PhoneCall_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallOptOut" ADD CONSTRAINT "CallOptOut_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phone numbers are stored in E.164 only, so lookups and the do-not-call check compare like with like.
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_e164_format" CHECK ("e164" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_transferNumber_format" CHECK ("transferNumber" IS NULL OR "transferNumber" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "PhoneCall" ADD CONSTRAINT "PhoneCall_remoteNumber_format" CHECK ("remoteNumber" IS NULL OR "remoteNumber" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "CallOptOut" ADD CONSTRAINT "CallOptOut_phoneNumber_format" CHECK ("phoneNumber" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "PhoneCall" ADD CONSTRAINT "PhoneCall_durations_nonnegative" CHECK (
  ("aiLegSeconds" IS NULL OR "aiLegSeconds" >= 0) AND ("carrierSeconds" IS NULL OR "carrierSeconds" >= 0)
);
