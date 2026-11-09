import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// The bundle rows first, in code order, the lock the worker and the gate take
// before they touch a bundle's inbox rows. Deleting the inbox rows first
// would take those locks the other way round, and a worker applying one of
// these bundles at that moment would deadlock with us.
export async function lockBundles(tx: Tx, where: Prisma.Sql): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Bundle" WHERE ${where} ORDER BY "code" FOR UPDATE`;
}

// A guest's postings outlive the guest with the reference cut, so a month's
// totals never move because a visitor left.
export async function orphanPostings(tx: Tx, guestIds: string[]): Promise<void> {
  if (guestIds.length === 0) return;
  await tx.posting.updateMany({ where: { guestId: { in: guestIds } }, data: { guestId: null, guestPurged: true } });
}

// Everything a guest owns, in an order that leaves nothing pointing at a
// deleted row. Nothing here has a foreign key to cascade, so each table is
// named. Postings are not touched: the caller deletes the ones it must and
// orphans the rest first.
export async function deleteGuestData(tx: Tx, guestIds: string[]): Promise<void> {
  if (guestIds.length === 0) return;
  await lockBundles(tx, Prisma.sql`"guestId" = ANY(${guestIds})`);
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
