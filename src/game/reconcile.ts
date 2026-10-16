/**
 * Keep the predicted hero from sliding toward a stale server position.
 * A stop stays put. While moving, only sideways error and a server that is
 * already ahead are allowed to nudge the hero. A real teleport (travel,
 * respawn) is the only time a stopped hero jumps.
 */
export function reconcileHero(input: {
  localX: number;
  localZ: number;
  serverX: number;
  serverZ: number;
  wishX: number;
  wishZ: number;
  moving: boolean;
  placed: boolean;
}): { x: number; z: number } {
  if (!input.placed) return { x: input.serverX, z: input.serverZ };
  const errX = input.serverX - input.localX;
  const errZ = input.serverZ - input.localZ;
  const gap = Math.hypot(errX, errZ);
  if (gap > 16) return { x: input.serverX, z: input.serverZ };
  if (!input.moving || gap < 0.08) return { x: input.localX, z: input.localZ };
  const speed = Math.hypot(input.wishX, input.wishZ);
  if (speed < 0.2) return { x: input.localX, z: input.localZ };
  const ux = input.wishX / speed;
  const uz = input.wishZ / speed;
  const along = errX * ux + errZ * uz;
  const sideX = errX - along * ux;
  const sideZ = errZ - along * uz;
  let fixX = sideX * 0.35;
  let fixZ = sideZ * 0.35;
  if (along > 0.15) {
    fixX += ux * along * 0.25;
    fixZ += uz * along * 0.25;
  }
  return { x: input.localX + fixX, z: input.localZ + fixZ };
}
