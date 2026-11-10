-- Payroll joins postings to events by eventId, and WIP joins events by bundle.
CREATE INDEX "BundleEvent_bundleId_idx" ON "BundleEvent"("bundleId");
CREATE INDEX "Posting_eventId_idx" ON "Posting"("eventId");
