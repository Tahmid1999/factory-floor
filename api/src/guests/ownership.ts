import { POLO_ROUTE } from '../line/line';

export type Actor = { guestId?: string; sim: boolean };

export type Scannable = {
  guestId: string | null;
  isSimulated: boolean;
  nextStep: number;
  // The owning guest's last activity, null for a bundle with no guest.
  guestLastActiveAt: Date | null;
};

const QUIET_MS = 5 * 60 * 1000;
const PAST_SLEEVE = POLO_ROUTE.indexOf('sew_sleeve');

// The one place that decides who may scan a bundle. A guest owns their own.
// The sim owns the ones it cut, and carries a guest's bundle when the guest
// has left it (quiet for 5 minutes) or it is past the sleeve, so a visitor
// who walks away at the side seam does not leave a dead bundle on the floor.
export function mayScan(actor: Actor, bundle: Scannable, now: Date): boolean {
  if (!actor.sim) return actor.guestId !== undefined && bundle.guestId === actor.guestId;
  if (bundle.isSimulated) return true;
  if (bundle.guestId === null) return false;
  if (bundle.nextStep > PAST_SLEEVE) return true;
  return bundle.guestLastActiveAt !== null && now.getTime() - bundle.guestLastActiveAt.getTime() >= QUIET_MS;
}
