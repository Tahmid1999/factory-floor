import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// Everything a guest owns, in an order that leaves nothing pointing at a
// deleted row. Nothing here has a foreign key to cascade, so each table is
// named. Postings are not touched: the caller decides whether they are
// orphaned (the purge) or deleted (the reset).
export async function deleteGuestData(tx: Tx, guestIds: string[]): Promise<void> {
  if (guestIds.length === 0) return;
  const devices = Prisma.sql`(SELECT "id" FROM "Device" WHERE "guestId" = ANY(${guestIds}))`;
  const bundles = Prisma.sql`(SELECT "id" FROM "Bundle" WHERE "guestId" = ANY(${guestIds}))`;
  await tx.$executeRaw`DELETE FROM "ScanInbox" WHERE "deviceId" IN ${devices}`;
  await tx.$executeRaw`DELETE FROM "DeviceNotice" WHERE "deviceId" IN ${devices}`;
  await tx.$executeRaw`DELETE FROM "HeldEvent" WHERE "bundleId" IN ${bundles}`;
  // A sim device cut the guest's bundles, so its events are found by bundle too.
  await tx.$executeRaw`DELETE FROM "BundleEvent" WHERE "bundleId" IN ${bundles} OR "deviceId" IN ${devices}`;
  await tx.$executeRaw`DELETE FROM "Bundle" WHERE "guestId" = ANY(${guestIds})`;
  await tx.$executeRaw`DELETE FROM "Device" WHERE "guestId" = ANY(${guestIds})`;
  await tx.$executeRaw`DELETE FROM "Guest" WHERE "id" = ANY(${guestIds})`;
}
