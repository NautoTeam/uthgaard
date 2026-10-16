import { createWorld, type World } from "../../src/shared/sim/world";
import type { PublicState } from "../../src/shared/sim/types";

/** The only simulation. The browser predicts movement; it does not run this. */
export function createAuthority(opts: { now?: () => number; rand?: () => number } = {}) {
  const world: World = createWorld(opts);
  return {
    world,
    step(now: number) {
      world.step(now);
    },
    snapshot(): PublicState {
      return world.snapshot();
    },
  };
}
