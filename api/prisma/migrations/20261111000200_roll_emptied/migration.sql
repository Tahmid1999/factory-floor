-- A hint for the cut's pick, not a balance: an emptied roll is skipped
-- without summing its history. The SUM under the roll lock still decides.
ALTER TABLE "Roll" ADD COLUMN "emptiedAt" TIMESTAMP(3);
CREATE INDEX "Roll_open_idx" ON "Roll"("receivedAt", "code") WHERE "emptiedAt" IS NULL AND NOT "isTest";
