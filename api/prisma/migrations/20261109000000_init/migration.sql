-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "GuestMode" AS ENUM ('hybrid', 'async');

-- CreateEnum
CREATE TYPE "BundleStatus" AS ENUM ('active', 'rework', 'scrapped', 'packed', 'shipped');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('batch', 'gate');

-- CreateEnum
CREATE TYPE "PostingKind" AS ENUM ('labour', 'fabric', 'writeoff', 'revenue', 'adjustment');

-- CreateTable
CREATE TABLE "Style" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "piecesPerBundle" INTEGER NOT NULL,
    "route" TEXT[],

    CONSTRAINT "Style_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operation" (
    "code" TEXT NOT NULL,
    "isGate" BOOLEAN NOT NULL,
    "trimsMills" INTEGER NOT NULL,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "PieceRate" (
    "id" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "ratePerPieceMills" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PieceRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guest" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL,
    "refillsToday" INTEGER NOT NULL DEFAULT 0,
    "mode" "GuestMode" NOT NULL DEFAULT 'hybrid',

    CONSTRAINT "Guest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "guestId" TEXT,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" TIMESTAMP(3),
    "lastPending" INTEGER NOT NULL DEFAULT 0,
    "clockOffsetMs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bundle" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "pieces" INTEGER NOT NULL,
    "status" "BundleStatus" NOT NULL,
    "nextStep" INTEGER NOT NULL DEFAULT 0,
    "reworkRound" INTEGER NOT NULL DEFAULT 0,
    "guestId" TEXT,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanInbox" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "bundleCode" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "offsetMs" INTEGER NOT NULL,
    "correctedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "ScanInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HeldEvent" (
    "id" TEXT NOT NULL,
    "inboxId" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HeldEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleEvent" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "source" "EventSource" NOT NULL,
    "deviceId" TEXT,
    "inboxId" TEXT,
    "gateId" TEXT,
    "round" INTEGER NOT NULL,
    "correctedAt" TIMESTAMP(3) NOT NULL,
    "wasted" BOOLEAN NOT NULL DEFAULT false,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BundleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Posting" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "kind" "PostingKind" NOT NULL,
    "amountMills" INTEGER NOT NULL,
    "bundleCode" TEXT NOT NULL,
    "eventId" TEXT,
    "guestId" TEXT,
    "guestPurged" BOOLEAN NOT NULL DEFAULT false,
    "adjustsPeriod" TEXT,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Posting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceNotice" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "bundleCode" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "DeviceNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Style_code_key" ON "Style"("code");

-- CreateIndex
CREATE INDEX "PieceRate_styleId_op_effectiveFrom_idx" ON "PieceRate"("styleId", "op", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Guest_name_key" ON "Guest"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Device_guestId_code_key" ON "Device"("guestId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_code_key" ON "Bundle"("code");

-- CreateIndex
CREATE INDEX "ScanInbox_result_receivedAt_idx" ON "ScanInbox"("result", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScanInbox_deviceId_seq_key" ON "ScanInbox"("deviceId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "HeldEvent_inboxId_key" ON "HeldEvent"("inboxId");

-- CreateIndex
CREATE UNIQUE INDEX "BundleEvent_inboxId_key" ON "BundleEvent"("inboxId");

-- CreateIndex
CREATE UNIQUE INDEX "BundleEvent_gateId_key" ON "BundleEvent"("gateId");

-- CreateIndex
CREATE UNIQUE INDEX "User_login_key" ON "User"("login");

-- AddForeignKey
ALTER TABLE "PieceRate" ADD CONSTRAINT "PieceRate_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "Style"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "Style"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

