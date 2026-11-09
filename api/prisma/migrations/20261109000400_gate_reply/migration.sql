-- The answer a gate call gave, so a repeat of the same gateId gets it back word
-- for word. It holds the bundle's state right after the call, which later
-- events move on, so it cannot be rebuilt from the event afterwards.
ALTER TABLE "BundleEvent" ADD COLUMN "gateReply" JSONB;
