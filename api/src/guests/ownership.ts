export type Actor = { guestId?: string; sim: boolean };

// The one place that decides who may scan a bundle. `now` is unused today but
// stays in the signature: the carry rule (a bundle left by an inactive guest
// can be picked up by the sim) depends on the time and is added here later.
export function mayScan(
  actor: Actor,
  bundle: { guestId: string | null; isSimulated: boolean },
  now: Date,
): boolean {
  void now;
  if (actor.sim) return bundle.isSimulated;
  return actor.guestId !== undefined && bundle.guestId === actor.guestId;
}
