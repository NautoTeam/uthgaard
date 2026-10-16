import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileHero } from "../../src/game/reconcile";
import type { CharacterRecord } from "../../src/shared/persist/store";
import { inSpawnGuard, onRoad, SPAWN_GUARD, starterStand } from "../../src/shared/sim/geo";
import { CAMPS } from "../../src/shared/sim/types";
import { createWorld } from "../../src/shared/sim/world";
import { joinInputFor } from "./persist";

function world() {
  return createWorld({ now: () => 1_000, rand: () => 0.2 });
}

function campGap(x: number, z: number) {
  let best = Infinity;
  for (const camp of CAMPS) {
    if (camp.type !== "Spider" && camp.type !== "Snake") continue;
    best = Math.min(best, Math.hypot(camp.cx - x, camp.cz - z));
  }
  return best;
}

test("new heroes stand at the campfire, off the spider road", () => {
  const sim = world();
  const human = sim.join({ id: "h", username: "Ada", race: "Human", baseClass: "Fighter" });
  const village = starterStand("uthgaard");
  assert.ok(inSpawnGuard(human.x, human.z));
  assert.equal(onRoad(human.x, human.z, 2.4), false);
  assert.ok(Math.hypot(human.x - village.x, human.z - village.z) <= SPAWN_GUARD);
  assert.ok(campGap(human.x, human.z) > 20);

  const marsh = sim.join({ id: "m", username: "Mire", race: "Marshwarden", baseClass: "Healer" });
  const fen = starterStand("fenhollow");
  assert.ok(inSpawnGuard(marsh.x, marsh.z));
  assert.equal(onRoad(marsh.x, marsh.z, 2.4), false);
  assert.ok(Math.hypot(marsh.x - fen.x, marsh.z - fen.z) <= SPAWN_GUARD);
  assert.ok(campGap(marsh.x, marsh.z) > 20);
});

test("a saved road tile does not come back on login", () => {
  const save: CharacterRecord = {
    version: 1,
    username: "Ada",
    race: "Human",
    baseClass: "Fighter",
    prestigeClass: "",
    level: 3,
    xp: 10,
    gold: 40,
    x: 26,
    z: 22,
    hp: 80,
  };
  const input = joinInputFor("user-ada", save, null);
  assert.equal(input?.x, undefined);
  assert.equal(input?.z, undefined);
  const hero = world().join(input!);
  assert.ok(inSpawnGuard(hero.x, hero.z));
  assert.equal(onRoad(hero.x, hero.z, 2.4), false);
  assert.ok(Math.hypot(hero.x - 26, hero.z - 22) > 10);
});

test("an explicit join coordinate is still honored", () => {
  const hero = world().join({
    id: "s",
    username: "Scout",
    race: "Human",
    baseClass: "Rogue",
    x: 62,
    z: 12,
  });
  assert.ok(Math.hypot(hero.x - 62, hero.z - 12) < 2);
});

test("respawn returns to the campfire guard", () => {
  const sim = world();
  sim.join({ id: "h", username: "Ada", race: "Human", baseClass: "Fighter", x: 80, z: 40 });
  assert.equal(sim.setHp("h", 0).ok, true);
  assert.equal(sim.respawn("h").ok, true);
  const back = sim.players.get("h");
  assert.ok(back);
  assert.ok(inSpawnGuard(back.x, back.z));
  assert.equal(onRoad(back.x, back.z, 2.4), false);
});

test("mobs do not aggro a hero standing in the spawn guard", () => {
  const sim = world();
  const hero = sim.join({ id: "h", username: "Ada", race: "Human", baseClass: "Fighter" });
  const hp = hero.hp;
  assert.equal(sim.spawnTest("h").ok, true);
  for (let i = 0; i < 40; i++) sim.step(1_000 + i * 50);
  const aimed = sim.snapshot().monsters.filter((mob) => mob.targetId === "h");
  assert.equal(aimed.length, 0);
  assert.equal(sim.players.get("h")?.hp, hp);
});

test("reconcile does not drag a stopped hero back toward the server", () => {
  const stopped = reconcileHero({
    localX: 10,
    localZ: 10,
    serverX: 0,
    serverZ: 0,
    wishX: 0,
    wishZ: 0,
    moving: false,
    placed: true,
  });
  assert.deepEqual(stopped, { x: 10, z: 10 });

  const behind = reconcileHero({
    localX: 10,
    localZ: 0,
    serverX: 8,
    serverZ: 0,
    wishX: 1,
    wishZ: 0,
    moving: true,
    placed: true,
  });
  assert.ok(behind.x >= 10);

  const teleport = reconcileHero({
    localX: 0,
    localZ: 0,
    serverX: 40,
    serverZ: 0,
    wishX: 0,
    wishZ: 0,
    moving: false,
    placed: true,
  });
  assert.deepEqual(teleport, { x: 40, z: 0 });

  const unplaced = reconcileHero({
    localX: 1,
    localZ: 1,
    serverX: 4,
    serverZ: 5,
    wishX: 1,
    wishZ: 0,
    moving: true,
    placed: false,
  });
  assert.deepEqual(unplaced, { x: 4, z: 5 });

  const clickWalk = reconcileHero({
    localX: 5,
    localZ: 5,
    serverX: 3,
    serverZ: 4,
    wishX: 0,
    wishZ: 0,
    moving: true,
    placed: true,
  });
  assert.deepEqual(clickWalk, { x: 5, z: 5 });
});
