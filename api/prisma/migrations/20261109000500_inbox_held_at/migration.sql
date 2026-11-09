-- When a scan was first held. The HeldEvent row is deleted on release, so this
-- is what tells the timeline a scan waited and was later released.
ALTER TABLE "ScanInbox" ADD COLUMN "heldAt" TIMESTAMP(3);
