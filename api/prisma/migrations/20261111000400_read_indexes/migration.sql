-- Payroll reads one UTC day of events by correctedAt.
CREATE INDEX "BundleEvent_correctedAt_idx" ON "BundleEvent"("correctedAt");
-- Partial, so they stay small: the purged-pay row reads only these postings,
-- and live WIP starts from the bundles still on the line.
CREATE INDEX "Posting_purged_labour_idx" ON "Posting"("createdAt") WHERE "guestPurged" AND "kind" = 'labour';
CREATE INDEX "Bundle_on_line_idx" ON "Bundle"("id") WHERE "status" IN ('active', 'rework', 'packed');
