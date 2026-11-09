-- Set when a supervisor clears rework. A batch scan corrected to before it
-- was made in the round that just ended, so the worker rejects it as stale.
ALTER TABLE "Bundle" ADD COLUMN "lastClearedAt" TIMESTAMP(3);
