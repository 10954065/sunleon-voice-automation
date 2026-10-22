-- Billing periods are now monthly windows counted from an anchor, with a separate paid-through
-- date, so a renewal paid before the period ends never moves the current period into the future.
ALTER TABLE "Subscription" RENAME COLUMN "currentPeriodStart" TO "billingAnchorAt";
ALTER TABLE "Subscription" RENAME COLUMN "currentPeriodEnd" TO "paidThroughAt";
