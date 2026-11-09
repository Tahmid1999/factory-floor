-- A sim-owned device has no guest, and NULL guestIds are never equal in the
-- unique index, so the sim is told apart by this name instead.
ALTER TABLE "Device" ADD COLUMN "simName" TEXT;

-- Bundle codes read like paper tickets; the first guest bundle is B-8492.
CREATE SEQUENCE bundle_code_seq START WITH 8492;
GRANT USAGE, SELECT ON SEQUENCE bundle_code_seq TO ff_app;
