import { BundleStatus } from '@prisma/client';
import { POLO_ROUTE } from '../line/line';

export type Actor = { guestId?: string; sim: boolean };

export type Scannable = {
  guestId: string | null;
  isSimulated: boolean;
  status: BundleStatus;
  nextStep: number;
  // The owning guest's last activity, null for a bundle with no guest.
  guestLastActiveAt: Date | null;
};

const QUIET_MS = 5 * 60 * 1000;
const PACK = POLO_ROUTE.indexOf('pack');

// The one place that decides who may scan a bundle. A guest owns their own.
// The sim owns the ones it cut. A guest's bundle goes to the sim in full once
// the guest has been quiet for 5 minutes, so a visitor who walks away does not
// leave a dead bundle on the floor. While the guest is still here the sim only
// packs and ships it, the two stations a visitor cannot stand at: anything
// earlier would sew, flag or clear a bundle the visitor is in the middle of,
// and the trap would read the sim's work as the visitor's.
export function mayScan(actor: Actor, bundle: Scannable, now: Date): boolean {
  if (!actor.sim) return actor.guestId !== undefined && bundle.guestId === actor.guestId;
  if (bundle.isSimulated) return true;
  if (bundle.guestId === null) return false;
  const quiet = bundle.guestLastActiveAt !== null && now.getTime() - bundle.guestLastActiveAt.getTime() >= QUIET_MS;
  if (quiet) return true;
  return bundle.status === 'packed' || (bundle.status === 'active' && bundle.nextStep >= PACK);
}
