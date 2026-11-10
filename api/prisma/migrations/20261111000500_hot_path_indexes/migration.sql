-- Every apply asks whether a step was already paid, and a scrap sums what the
-- bundle cost, both by bundleCode; without this each was a scan of every
-- posting ever made.
CREATE INDEX "Posting_bundleCode_kind_idx" ON "Posting"("bundleCode", "kind");
-- What waits at a station. Prisma sends the status as a cast parameter, which
-- the planner cannot match to Bundle_on_line_idx's predicate, so this was a
-- scan of every bundle, shipped ones included, on each /sim/work.
CREATE INDEX "Bundle_status_nextStep_createdAt_code_idx" ON "Bundle"("status", "nextStep", "createdAt", "code");
-- Read and stamped on every batch; sim devices' notices are never purged.
CREATE INDEX "DeviceNotice_deviceId_deliveredAt_idx" ON "DeviceNotice"("deviceId", "deliveredAt");
