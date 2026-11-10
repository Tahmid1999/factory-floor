ALTER TYPE "PostingKind" ADD VALUE 'trims';

CREATE TYPE "MovementKind" AS ENUM ('receive', 'issue_to_cutting', 'return', 'scrap', 'adjust');

ALTER TABLE "Style" ADD COLUMN "fobMills" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Posting" ALTER COLUMN "bundleCode" DROP NOT NULL;
CREATE INDEX "Posting_period_kind_isSimulated_idx" ON "Posting"("period", "kind", "isSimulated");

CREATE TABLE "Roll" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "lengthCm" INTEGER NOT NULL,
    "costPerMetreMills" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "isSimulated" BOOLEAN NOT NULL,

    CONSTRAINT "Roll_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "rollId" TEXT NOT NULL,
    "kind" "MovementKind" NOT NULL,
    "deltaCm" INTEGER NOT NULL,
    "bundleCode" TEXT,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "isSimulated" BOOLEAN NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PeriodClose" (
    "period" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "closedBy" TEXT NOT NULL,
    "wipMills" INTEGER NOT NULL,
    "wipGuestMills" INTEGER NOT NULL,
    "totals" JSONB NOT NULL,

    CONSTRAINT "PeriodClose_pkey" PRIMARY KEY ("period")
);

CREATE UNIQUE INDEX "Roll_code_key" ON "Roll"("code");
CREATE INDEX "StockMovement_rollId_idx" ON "StockMovement"("rollId");
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_rollId_fkey" FOREIGN KEY ("rollId") REFERENCES "Roll"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The stock ledger is append-only. The REVOKE stops the app role at the
-- grant; the trigger also stops the owner role and any DELETE, except for the
-- movements of a test roll, which the stress purge has to clear.
REVOKE UPDATE ON "StockMovement" FROM ff_app;

CREATE FUNCTION stock_movement_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM "Roll" WHERE "id" = OLD."rollId" AND "isTest") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'StockMovement is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movement_guard BEFORE UPDATE OR DELETE ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION stock_movement_guard();

-- Without this the app role could flip isTest on a real roll and then delete
-- its history through the movement trigger's test-roll exception.
CREATE FUNCTION roll_test_flag_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."isTest" IS DISTINCT FROM OLD."isTest" THEN
    RAISE EXCEPTION 'Roll.isTest cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER roll_test_flag_guard BEFORE UPDATE ON "Roll"
  FOR EACH ROW EXECUTE FUNCTION roll_test_flag_guard();
