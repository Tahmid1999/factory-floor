import { Prisma } from '@prisma/client';
import { Clock } from '../clock';

export type AuditEntry = {
  actor: string;
  role: string;
  action: string;
  entity: string;
  before?: unknown;
  after?: unknown;
};

// Takes the caller's transaction so the audit row commits or rolls back with
// the change it describes; a write with no audit row cannot exist.
export async function audit(tx: Prisma.TransactionClient, e: AuditEntry, clock: Clock): Promise<void> {
  await tx.auditLog.create({
    data: {
      actor: e.actor,
      role: e.role,
      action: e.action,
      entity: e.entity,
      before: e.before === undefined ? undefined : (e.before as Prisma.InputJsonValue),
      after: e.after === undefined ? undefined : (e.after as Prisma.InputJsonValue),
      at: clock.now(),
    },
  });
}
