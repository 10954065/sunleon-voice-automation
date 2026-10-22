-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'NON_RENEWING', 'PAST_DUE', 'CANCELED');

-- CreateEnum
CREATE TYPE "BillingProvider" AS ENUM ('PAYSTACK', 'MANUAL');

-- CreateEnum
CREATE TYPE "UsageMetric" AS ENUM ('VOICE_SECONDS');

-- CreateEnum
CREATE TYPE "UsageAlertKind" AS ENUM ('THRESHOLD_WARNING', 'ALLOWANCE_EXHAUSTED');

-- CreateEnum
CREATE TYPE "BillingTransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BillingTransactionKind" AS ENUM ('INITIAL', 'RENEWAL');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('PROCESSED', 'IGNORED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "reservedSeconds" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "overageBudgetMinor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "includedMinutes" INTEGER NOT NULL,
    "maxConcurrentSessions" INTEGER NOT NULL,
    "maxAgents" INTEGER NOT NULL,
    "overageRateMinorPerMinute" INTEGER,
    "warningThresholdPercent" INTEGER NOT NULL DEFAULT 80,
    "isTrial" BOOLEAN NOT NULL DEFAULT false,
    "trialDays" INTEGER,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "paystackPlanCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "providerCustomerCode" TEXT,
    "providerSubscriptionCode" TEXT,
    "providerEmailToken" TEXT,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLedgerEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "agentId" TEXT,
    "conversationId" TEXT,
    "metric" "UsageMetric" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "estimatedCostMicros" INTEGER,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageAlert" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "UsageAlertKind" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "usedSeconds" INTEGER NOT NULL,
    "allowanceSeconds" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCostRate" (
    "id" TEXT NOT NULL,
    "metric" "UsageMetric" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "microsPerUnit" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCostRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingTransaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT,
    "provider" "BillingProvider" NOT NULL,
    "kind" "BillingTransactionKind" NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "BillingTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "customerEmail" TEXT,
    "paidAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "WebhookEventStatus" NOT NULL,
    "organizationId" TEXT,
    "summary" JSONB,
    "note" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_paystackPlanCode_key" ON "Plan"("paystackPlanCode");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_organizationId_key" ON "Subscription"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_providerSubscriptionCode_key" ON "Subscription"("providerSubscriptionCode");

-- CreateIndex
CREATE INDEX "Subscription_providerCustomerCode_idx" ON "Subscription"("providerCustomerCode");

-- CreateIndex
CREATE UNIQUE INDEX "UsageLedgerEntry_idempotencyKey_key" ON "UsageLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "UsageLedgerEntry_organizationId_occurredAt_idx" ON "UsageLedgerEntry"("organizationId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageAlert_organizationId_kind_periodStart_key" ON "UsageAlert"("organizationId", "kind", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCostRate_metric_provider_model_key" ON "ProviderCostRate"("metric", "provider", "model");

-- CreateIndex
CREATE UNIQUE INDEX "BillingTransaction_reference_key" ON "BillingTransaction"("reference");

-- CreateIndex
CREATE INDEX "BillingTransaction_organizationId_createdAt_idx" ON "BillingTransaction"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_receivedAt_idx" ON "PaymentWebhookEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_eventKey_key" ON "PaymentWebhookEvent"("provider", "eventKey");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLedgerEntry" ADD CONSTRAINT "UsageLedgerEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageAlert" ADD CONSTRAINT "UsageAlert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingTransaction" ADD CONSTRAINT "BillingTransaction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingTransaction" ADD CONSTRAINT "BillingTransaction_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Integrity guards Prisma can't express: usage and money never go negative.
ALTER TABLE "UsageLedgerEntry" ADD CONSTRAINT "UsageLedgerEntry_quantity_nonnegative" CHECK ("quantity" >= 0);
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_overageBudgetMinor_nonnegative" CHECK ("overageBudgetMinor" >= 0);
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_reservedSeconds_nonnegative" CHECK ("reservedSeconds" >= 0);
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_limits_nonnegative" CHECK (
  "priceMinor" >= 0 AND "includedMinutes" >= 0 AND "maxConcurrentSessions" >= 0 AND "maxAgents" >= 0
  AND ("overageRateMinorPerMinute" IS NULL OR "overageRateMinorPerMinute" > 0)
  AND "warningThresholdPercent" BETWEEN 1 AND 100
);

-- Illustrative default plans from the product brief (Part F, section 9). Prices, allowances
-- and limits are assumptions, editable by a platform admin; overage is off until real
-- provider costs are measured. Paystack plan codes are linked by an admin once created.
INSERT INTO "Plan" ("id", "code", "name", "priceMinor", "currency", "includedMinutes", "maxConcurrentSessions", "maxAgents", "isTrial", "trialDays", "isPublic", "updatedAt")
VALUES
  ('plan_trial',   'trial',   'Trial',   0,     'GHS', 10,  1, 1,  true,  14,   false, CURRENT_TIMESTAMP),
  ('plan_starter', 'starter', 'Starter', 29900, 'GHS', 150, 2, 3,  false, NULL, true,  CURRENT_TIMESTAMP),
  ('plan_growth',  'growth',  'Growth',  79900, 'GHS', 500, 5, 10, false, NULL, true,  CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
