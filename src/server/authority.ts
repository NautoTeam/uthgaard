import { createWorld, type World } from "../shared/sim/world";
import type { PublicState } from "../shared/sim/types";

/**
 * Authoritative simulation entry.
 *
 * This site is a Vite + TanStack app on serverless hosting. It cannot keep a
 * WebSocket process or a SQLite file alive between requests, so the browser
 * tab that wins host election runs this same module. A long-lived Node
 * process can import `createAuthority` and feed it client inputs later
 * without rewriting combat.
 */
export function createAuthority() {
  const world: World = createWorld();
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
