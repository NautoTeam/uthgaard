import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { WebSocket } from "ws";
import { answerNeedCreate, helloAfterNeedCreate, toServerIntent } from "../../src/game/net";
import { backoffMs, interpolateXZ, reconnectPlan, snapAlpha } from "../../src/game/remote";
import { signGameToken } from "../../src/shared/net/token";
import { ClientMsg, IntentSchema, ServerMsg } from "../../src/shared/net/protocol";
import type { CharacterRecord } from "../../src/shared/persist/store";
import { blocked, inSpawnGuard, onRoad, TREES } from "../../src/shared/sim/geo";
import { attrsFor } from "../../src/shared/sim/types";
import { createWorld } from "../../src/shared/sim/world";
import { applyGameMigrations, characterStore, memoryCharacters, type GameDb } from "./db";
import { applyIntent, MOVE_ALLOW } from "./dispatch";
import { originAllowed, startServer, userTag } from "./server";

const maxStep = MOVE_ALLOW;
/** A short step. Must stay inside one normal walk report. */
const step = 0.2;
const SECRET = "test-secret-test-secret-test-secret";

function gameOpts(extra: { characters?: GameDb } = {}) {
  return {
    port: 0,
    tokenSecret: SECRET,
    characters: extra.characters ?? memoryCharacters(),
  };
}

async function hello(
  ws: WebSocket,
  userId: string,
  name: string,
  create?: { name?: string; race?: string; baseClass?: string; slot?: number } | false,
) {
  const token = await signGameToken(SECRET, { id: userId, name });
  if (create === false) {
    ws.send(JSON.stringify({ t: "hello", token, slot: 0 }));
    return token;
  }
  ws.send(
    JSON.stringify({
      t: "hello",
      token,
      create: {
        name: create?.name ?? name,
        race: create?.race ?? "Human",
        baseClass: create?.baseClass ?? "Fighter",
        slot: create?.slot ?? 0,
      },
    }),
  );
  return token;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function opened(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>, ms = 2500): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function closeCode(ws: WebSocket, ms: number) {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket stayed open")), ms);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

type Msg = {
  t?: string;
  reason?: string;
  playerId?: string;
  seq?: number;
  result?: { ok: boolean; reason?: string };
  state?: {
    players?: Array<{
      id: string;
      username: string;
      x: number;
      z: number;
      gold?: number;
      hp?: number;
      maxHp?: number;
      level?: number;
      xp?: number;
      inventory?: Record<string, number>;
      equipment?: Record<string, string>;
    }>;
    graves?: Array<{ id: string; owner: string; gold: number }>;
  };
};

async function pgliteDb() {
  const pg = new PGlite();
  await pg.waitReady;
  const query = async (text: string, params?: unknown[]) => {
    const result = await pg.query(text, params);
    return { rows: result.rows as Array<Record<string, unknown>> };
  };
  await applyGameMigrations(query);
  return { pg, characters: characterStore(query) };
}

async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs: Msg[] = [];
  ws.on("message", (data) => msgs.push(JSON.parse(data.toString())));
  ws.on("error", () => undefined);
  await opened(ws);
  return { ws, msgs };
}

test("protocol rejects unknown ops, debug ops, and an extra id", () => {
  assert.equal(IntentSchema.safeParse({ op: "dance" }).success, false);
  for (const intent of [
    { op: "setLevel", level: 20 },
    { op: "setHp", hp: 1 },
    { op: "spawnTest" },
    { op: "spawn" },
    { op: "grantXp", amount: 10 },
    { op: "adoptGraves" },
    { op: "note", msg: "x" },
    { op: "removeGrave", id: "g" },
  ]) {
    assert.equal(IntentSchema.safeParse(intent).success, false, intent.op);
    assert.equal(toServerIntent(intent), null, intent.op);
  }
  assert.equal(
    ClientMsg.safeParse({
      t: "intent",
      seq: 1,
      intent: { op: "move", x: 1, z: 2, rotation: 0, id: "p1" },
    }).success,
    false,
  );
  assert.equal(
    ClientMsg.safeParse({ t: "intent", seq: 1, id: "p1", intent: { op: "respawn" } }).success,
    false,
  );
  assert.equal(ClientMsg.safeParse({ t: "hello", name: "Ada" }).success, false);
  assert.equal(ClientMsg.safeParse({ t: "hello", token: "x".repeat(20) }).success, true);
  assert.equal(ClientMsg.safeParse({ t: "hello", token: "short" }).success, false);
  assert.equal(ClientMsg.safeParse({ t: "hello", token: "x".repeat(20), userId: "user-b" }).success, false);
  assert.equal(
    ClientMsg.safeParse({
      t: "hello",
      token: "x".repeat(20),
      create: { name: "Ada", race: "Human", baseClass: "Fighter" },
    }).success,
    false,
  );
  assert.equal(
    ClientMsg.safeParse({
      t: "hello",
      token: "x".repeat(20),
      create: { name: "Ada", race: "Human", baseClass: "Fighter", slot: 0 },
    }).success,
    true,
  );
  assert.equal(
    ClientMsg.safeParse({
      t: "hello",
      token: "x".repeat(20),
      create: { name: "A", race: "Human", baseClass: "Fighter", slot: 0 },
    }).success,
    false,
  );
  assert.equal(
    ClientMsg.safeParse({
      t: "hello",
      token: "x".repeat(20),
      create: { name: "Ada", race: "Human", baseClass: "Fighter", slot: 0 },
      import: { level: 40, gold: 9999, inventory: { "spider-silk": 2 }, x: 12 },
    }).success,
    false,
  );
  assert.equal(
    ClientMsg.safeParse({
      t: "hello",
      token: "x".repeat(20),
      create: { name: "Ada", race: "Human", baseClass: "Fighter", slot: 0 },
      import: { level: 40, gold: 9999, inventory: { "spider-silk": 2 } },
    }).success,
    false,
  );
  assert.equal(
    ClientMsg.safeParse({
      t: "intent",
      seq: 1,
      intent: { op: "move", x: 1, z: 2, rotation: 0 },
      import: { level: 2, gold: 1 },
    }).success,
    false,
  );
});

test("move rejects a jump past max speed and a blocked tile", () => {
  const world = createWorld({ now: () => 1_000, rand: mulberry32(1) });
  const hero = world.join({
    id: "hero",
    username: "qa",
    race: "Human",
    baseClass: "Fighter",
    x: 0,
    z: 0,
  });
  const before = { x: hero.x, z: hero.z };
  const far = applyIntent(world, hero.id, {
    op: "move",
    x: hero.x + 8,
    z: hero.z,
    rotation: 0,
  });
  assert.equal(far.ok, false);
  assert.equal(far.reason, "Too fast.");
  assert.equal(hero.x, before.x);
  assert.equal(hero.z, before.z);

  let walked = false;
  for (const [dx, dz] of [
    [0.45, 0],
    [0, 0.45],
    [-0.45, 0],
    [0, -0.45],
    [0.3, 0.3],
  ] as const) {
    if (blocked(hero.x + dx, hero.z + dz)) continue;
    const walk = applyIntent(world, hero.id, {
      op: "move",
      x: hero.x + dx,
      z: hero.z + dz,
      rotation: 0,
    });
    assert.equal(walk.ok, true, walk.reason ?? "walk");
    assert.ok(Math.hypot(hero.x - before.x, hero.z - before.z) > 0.2);
    walked = true;
    break;
  }
  assert.equal(walked, true);
  hero.x = before.x;
  hero.z = before.z;

  const tree = TREES[0];
  assert.ok(tree, "a tree solid exists");
  let stand: { x: number; z: number } | null = null;
  let into: { x: number; z: number } | null = null;
  for (let away = 0.9; away <= 2.4 && !stand; away += 0.05) {
    const sx = tree[0] + away;
    const ix = sx - step;
    if (blocked(sx, tree[1]) || !blocked(ix, tree[1])) continue;
    if (Math.abs(sx - ix) > maxStep) continue;
    stand = { x: sx, z: tree[1] };
    into = { x: ix, z: tree[1] };
  }
  assert.ok(stand && into, "found a blocked tile within one tick of walk speed");
  hero.x = stand.x;
  hero.z = stand.z;
  const blockedMove = applyIntent(world, hero.id, {
    op: "move",
    x: into.x,
    z: into.z,
    rotation: 0,
  });
  assert.equal(blockedMove.ok, false);
  assert.equal(blockedMove.reason, "Blocked.");
  assert.equal(hero.x, stand.x);

  const forged = applyIntent(world, hero.id, { op: "setLevel", level: 9 } as never);
  assert.deepEqual(forged, { ok: false, reason: "unknown op" });
});

test("two worlds with the same seed and clock fight the same way", () => {
  function fight(seed: number) {
    let t = 50_000;
    const world = createWorld({ now: () => t, rand: mulberry32(seed) });
    const hero = world.join({
      id: "hero",
      username: "qa",
      race: "Human",
      baseClass: "Fighter",
      x: 62,
      z: 12,
      level: 5,
    });
    const snake = world.snapshot().monsters.find((m) => m.type === "Snake");
    assert.ok(snake, "snake camp is in range");
    hero.x = snake.x + 1.2;
    hero.z = snake.z;
    const swings = [];
    for (let i = 0; i < 6; i++) {
      t += 3000;
      hero.stamina = hero.maxStamina;
      hero.cooldowns.attack = 0;
      hero.nextSwing = 0;
      swings.push(world.attack(hero.id, snake.id));
      world.step(t);
    }
    const after = world.snapshot();
    const mob = after.monsters.find((m) => m.id === snake.id);
    return {
      swings,
      xp: hero.xp,
      hp: Math.round(hero.hp),
      gold: hero.gold,
      mobHp: mob ? Math.round(mob.hp) : null,
      logs: after.logs,
    };
  }
  assert.deepEqual(fight(7), fight(7));
});

test("a socket without hello is closed when the hello deadline passes", async () => {
  let clock = 1_000;
  const game = startServer({ port: 0, now: () => clock, rand: mulberry32(3) });
  const port = await game.ready;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("error", () => undefined);
  try {
    await opened(ws);
    clock += 5_000;
    assert.equal(await closeCode(ws, 2000), 4401);
  } finally {
    ws.close();
    await game.close();
  }
});

test("garbage and oversize frames do not kill /healthz", async () => {
  const game = startServer({ port: 0, rand: mulberry32(4) });
  const port = await game.ready;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("error", () => undefined);
  try {
    await opened(ws);
    for (let i = 0; i < 100; i++) {
      try {
        ws.send(`{not-json ${i}`);
      } catch {
        /* socket already closed */
      }
    }
    for (let i = 0; i < 100; i++) {
      try {
        ws.send("x".repeat(6000));
      } catch {
        /* oversize frames close the socket */
      }
    }
    await until(() => (game.dropped >= 1 ? true : undefined));
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; players: number; tick: number };
    assert.equal(body.ok, true);
    assert.equal(typeof body.players, "number");
    assert.equal(typeof body.tick, "number");
    assert.ok(game.dropped >= 1);
  } finally {
    ws.close();
    await game.close();
  }
});

test("a socket that has not joined receives no snaps", async () => {
  const game = startServer({ ...gameOpts(), now: () => 5_000, rand: mulberry32(7) });
  const port = await game.ready;
  const ada = new WebSocket(`ws://127.0.0.1:${port}`);
  const lurker = new WebSocket(`ws://127.0.0.1:${port}`);
  const adaMsgs: Array<{ t?: string }> = [];
  const lurkMsgs: Array<{ t?: string }> = [];
  ada.on("message", (data) => adaMsgs.push(JSON.parse(data.toString())));
  lurker.on("message", (data) => lurkMsgs.push(JSON.parse(data.toString())));
  ada.on("error", () => undefined);
  lurker.on("error", () => undefined);
  try {
    await Promise.all([opened(ada), opened(lurker)]);
    await hello(ada, "user-ada", "Ada");
    await until(() => adaMsgs.filter((m) => m.t === "snap").length >= 3 ? true : undefined);
    assert.equal(lurkMsgs.some((m) => m.t === "snap"), false);
    await hello(lurker, "user-lurk", "Lurk");
    await until(() => lurkMsgs.find((m) => m.t === "welcome"));
    await until(() => lurkMsgs.find((m) => m.t === "snap"));
  } finally {
    ada.close();
    lurker.close();
    await game.close();
  }
});

test("two clients both receive a snap that contains both heroes", async () => {
  const game = startServer({ ...gameOpts(), now: () => 5_000, rand: mulberry32(5) });
  const port = await game.ready;
  const ada = new WebSocket(`ws://127.0.0.1:${port}`);
  const bea = new WebSocket(`ws://127.0.0.1:${port}`);
  const adaMsgs: unknown[] = [];
  const beaMsgs: unknown[] = [];
  ada.on("message", (data) => adaMsgs.push(JSON.parse(data.toString())));
  bea.on("message", (data) => beaMsgs.push(JSON.parse(data.toString())));
  ada.on("error", () => undefined);
  bea.on("error", () => undefined);
  try {
    await Promise.all([opened(ada), opened(bea)]);
    ada.send(JSON.stringify({ t: "intent", seq: 0, intent: { op: "respawn" } }));
    await hello(ada, "user-ada", "Ada");
    await hello(bea, "user-bea", "Bea");
    const welcome = await until(
      () =>
        adaMsgs.find((m) => (m as { t?: string }).t === "welcome") as
          { playerId: string } | undefined,
    );
    assert.equal(typeof welcome.playerId, "string");
    assert.equal(
      adaMsgs.some((m) => (m as { t?: string }).t === "ack"),
      false,
    );
    const both = (m: unknown) => {
      const msg = m as { t?: string; state?: { players?: Array<{ username: string }> } };
      if (msg.t !== "snap") return false;
      const names = (msg.state?.players ?? []).map((p) => p.username);
      return names.includes("Ada") && names.includes("Bea");
    };
    const snapA = await until(() => adaMsgs.find(both));
    const snapB = await until(() => beaMsgs.find(both));
    const parsedA = ServerMsg.safeParse(snapA);
    const parsedB = ServerMsg.safeParse(snapB);
    assert.equal(parsedA.success, true, parsedA.success ? "" : parsedA.error.message);
    assert.equal(parsedB.success, true, parsedB.success ? "" : parsedB.error.message);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = (await health.json()) as { ok: boolean; players: number };
    assert.equal(body.ok, true);
    assert.equal(body.players, 2);

    ada.send(
      JSON.stringify({
        t: "intent",
        seq: 4,
        intent: { op: "move", x: 400, z: 400, rotation: 0 },
      }),
    );
    const ack = await until(() =>
      adaMsgs.find(
        (m) => (m as { t?: string; seq?: number }).t === "ack" && (m as { seq?: number }).seq === 4,
      ),
    );
    assert.equal((ack as { result: { ok: boolean } }).result.ok, false);
  } finally {
    ada.close();
    bea.close();
    await game.close();
  }
});

test("two clients each receive the other's position", async () => {
  const game = startServer({ ...gameOpts(), now: () => 6_000, rand: mulberry32(52) });
  const port = await game.ready;
  const ada = new WebSocket(`ws://127.0.0.1:${port}`);
  const bea = new WebSocket(`ws://127.0.0.1:${port}`);
  const adaMsgs: Msg[] = [];
  const beaMsgs: Msg[] = [];
  ada.on("message", (data) => adaMsgs.push(JSON.parse(data.toString())));
  bea.on("message", (data) => beaMsgs.push(JSON.parse(data.toString())));
  ada.on("error", () => undefined);
  bea.on("error", () => undefined);
  const hero = (msgs: Msg[], name: string) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const row = msgs[i].state?.players?.find((p) => p.username === name);
      if (row) return row;
    }
    return undefined;
  };
  try {
    await Promise.all([opened(ada), opened(bea)]);
    await hello(ada, "user-ada", "Ada");
    await hello(bea, "user-bea", "Bea");
    const spawnA = await until(() => hero(beaMsgs, "Ada"));
    const spawnB = await until(() => hero(adaMsgs, "Bea"));
    assert.ok(Math.hypot(spawnA.x - spawnB.x, spawnA.z - spawnB.z) > 1, "heroes share a tile");
    const from = { x: spawnA.x, z: spawnA.z };
    let dest: { x: number; z: number } | null = null;
    for (const [dx, dz] of [
      [0.6, 0],
      [0, 0.6],
      [-0.6, 0],
      [0, -0.6],
      [0.4, 0.4],
    ] as const) {
      if (blocked(from.x + dx, from.z + dz)) continue;
      dest = { x: from.x + dx, z: from.z + dz };
      break;
    }
    assert.ok(dest, "no open step");
    ada.send(
      JSON.stringify({
        t: "intent",
        seq: 1,
        intent: { op: "move", x: dest.x, z: dest.z, rotation: 0.4 },
      }),
    );
    const ack = await until(() => adaMsgs.find((m) => m.t === "ack" && m.seq === 1));
    assert.equal(ack.result?.ok, true, JSON.stringify(ack.result));
    const moved = game.world.players.get("user-ada");
    assert.ok(moved);
    assert.ok(Math.hypot(moved.x - from.x, moved.z - from.z) > 0.2);
    await until(() => {
      const row = hero(beaMsgs, "Ada");
      if (!row) return undefined;
      return Math.hypot(row.x - moved.x, row.z - moved.z) < 0.05 ? row : undefined;
    });

    const liveBea = game.world.players.get("user-bea");
    assert.ok(liveBea);
    const beaStart = { x: liveBea.x, z: liveBea.z };
    let beaDest: { x: number; z: number } | null = null;
    for (const [dx, dz] of [
      [-0.6, 0],
      [0, -0.6],
      [0.6, 0],
      [0, 0.6],
    ] as const) {
      if (blocked(liveBea.x + dx, liveBea.z + dz)) continue;
      beaDest = { x: liveBea.x + dx, z: liveBea.z + dz };
      break;
    }
    assert.ok(beaDest, "no open step for Bea");
    bea.send(
      JSON.stringify({
        t: "intent",
        seq: 1,
        intent: { op: "move", x: beaDest.x, z: beaDest.z, rotation: 1 },
      }),
    );
    const ackB = await until(() => beaMsgs.find((m) => m.t === "ack" && m.seq === 1));
    assert.equal(ackB.result?.ok, true, JSON.stringify(ackB.result));
    const movedB = game.world.players.get("user-bea");
    assert.ok(movedB);
    assert.ok(Math.hypot(movedB.x - beaStart.x, movedB.z - beaStart.z) > 0.2);
    await until(() => {
      const row = hero(adaMsgs, "Bea");
      if (!row) return undefined;
      return Math.hypot(row.x - movedB.x, row.z - movedB.z) < 0.05 ? row : undefined;
    });
    const withOnline = [...beaMsgs].reverse().find((m) => m.t === "snap") as { online?: number } | undefined;
    assert.equal(withOnline?.online, 2);
  } finally {
    ada.close();
    bea.close();
    await game.close();
  }
});

test("hello verifies the game token and reloads the saved character", async () => {
  const characters = memoryCharacters();
  const game = startServer({ ...gameOpts({ characters }), now: () => 8_000, rand: mulberry32(6) });
  const port = await game.ready;
  const bad = new WebSocket(`ws://127.0.0.1:${port}`);
  const badMsgs: Msg[] = [];
  bad.on("message", (data) => badMsgs.push(JSON.parse(data.toString())));
  bad.on("error", () => undefined);
  let movedX = 0;
  try {
    await opened(bad);
    const started = Date.now();
    const closed = closeCode(bad, 800);
    bad.send(JSON.stringify({ t: "hello", token: "x".repeat(40) }));
    const err = await until(() => badMsgs.find((m) => m.t === "error"));
    assert.equal(err.reason, "bad token");
    assert.equal(await closed, 4401);
    assert.ok(Date.now() - started < 500);
    const early = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { players: number };
    assert.equal(early.players, 0);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const msgs: Msg[] = [];
    ws.on("message", (data) => msgs.push(JSON.parse(data.toString())));
    ws.on("error", () => undefined);
    try {
      await opened(ws);
      await hello(ws, "user-ada", "Ada");
      const welcome = await until(() => msgs.find((m) => m.t === "welcome"));
      assert.equal(welcome.playerId, "user-ada");
      const placed = await until(() => {
        const snap = [...msgs].reverse().find((m) => m.t === "snap");
        return snap?.state?.players?.find((p) => p.id === "user-ada");
      });
      const dest = { x: placed.x + step, z: placed.z };
      ws.send(JSON.stringify({ t: "intent", seq: 1, intent: { op: "move", ...dest, rotation: 1 } }));
      const ack = await until(() => msgs.find((m) => m.t === "ack" && m.seq === 1));
      assert.equal(ack.result?.ok, true);
      const after = await until(() => {
        const snap = [...msgs].reverse().find((m) => m.t === "snap");
        const hero = snap?.state?.players?.find((p) => p.id === "user-ada");
        if (!hero || Math.abs(hero.x - placed.x) < 0.01) return undefined;
        return hero;
      });
      movedX = after.x;
      ws.close();
      const saved = await until(async () => {
        const row = await characters.load("user-ada");
        if (!row || Math.abs((row.save.x ?? 0) - movedX) > 0.05) return undefined;
        return row;
      });
      assert.equal(saved.save.username, "Ada");
      assert.equal(saved.save.equipment?.weapon, "iron-sword");
      assert.equal(saved.rev, 2);
    } finally {
      ws.close();
    }
  } finally {
    bad.close();
    await game.close();
  }

  const again = startServer({ ...gameOpts({ characters }), now: () => 9_000, rand: mulberry32(7) });
  const port2 = await again.ready;
  const ws2 = new WebSocket(`ws://127.0.0.1:${port2}`);
  const msgs2: Msg[] = [];
  ws2.on("message", (data) => msgs2.push(JSON.parse(data.toString())));
  ws2.on("error", () => undefined);
  try {
    await opened(ws2);
    await hello(ws2, "user-ada", "Someone Else", false);
    const back = await until(() => {
      const snap = [...msgs2].reverse().find((m) => m.t === "snap");
      return snap?.state?.players?.find((p) => p.username === "Ada");
    });
    assert.equal(back.username, "Ada");
    assert.ok(inSpawnGuard(back.x, back.z));
    assert.equal(onRoad(back.x, back.z, 2.4), false);
    const row = await characters.load("user-ada");
    assert.equal(row?.save.username, "Ada");
    assert.notEqual(row?.save.username, "Someone Else");
    assert.ok(Math.hypot(back.x - (row?.save.x ?? back.x), back.z - (row?.save.z ?? back.z)) > 0.05);
  } finally {
    ws2.close();
    await again.close();
  }
});

test("need_create is answered with the creation-screen hello", () => {
  const token = "t".repeat(30);
  const choice = { username: "Ada", race: "Human" as const, baseClass: "Fighter" as const, slot: 0 };
  assert.equal(helloAfterNeedCreate(token, "bad token", choice), null);
  assert.equal(helloAfterNeedCreate(token, "need_create", { ...choice, username: "A" }), null);
  const sent: unknown[] = [];
  answerNeedCreate({ t: "error", reason: "need_create" }, token, choice, (body) => sent.push(body));
  answerNeedCreate({ t: "snap" }, token, choice, (body) => sent.push(body));
  assert.deepEqual(sent, [
    {
      t: "hello",
      token,
      create: { name: "Ada", race: "Human", baseClass: "Fighter", slot: 0 },
    },
  ]);
});

test("a second hello for the same user closes the first socket", async () => {
  const { pg, characters } = await pgliteDb();
  const game = startServer({ ...gameOpts({ characters }), now: () => 20_000, rand: mulberry32(11) });
  const port = await game.ready;
  const first = await connect(port);
  const second = await connect(port);
  try {
    await hello(first.ws, "user-ada", "Ada");
    const welcome = await until(() => first.msgs.find((m) => m.t === "welcome"));
    assert.equal(welcome.playerId, "user-ada");
    const placed = await until(() => {
      const snap = [...first.msgs].reverse().find((m) => m.t === "snap");
      return snap?.state?.players?.find((p) => p.id === "user-ada");
    });
    const dest = { x: placed.x + step, z: placed.z };
    first.ws.send(JSON.stringify({ t: "intent", seq: 1, intent: { op: "move", ...dest, rotation: 0.4 } }));
    const ack = await until(() => first.msgs.find((m) => m.t === "ack" && m.seq === 1));
    assert.equal(ack.result?.ok, true);
    const moved = await until(() => {
      const hero = game.world.players.get("user-ada");
      if (!hero || Math.abs(hero.x - placed.x) < 0.01) return undefined;
      return hero.x;
    });
    const closed = closeCode(first.ws, 2500);
    await hello(second.ws, "user-ada", "Someone Else", false);
    assert.equal(await closed, 4409);
    const again = await until(() => second.msgs.find((m) => m.t === "welcome"));
    assert.equal(again.playerId, "user-ada");
    assert.equal(game.world.players.size, 1);
    const row = await characters.load("user-ada");
    assert.ok(row);
    assert.ok(Math.abs((row.save.x ?? 0) - moved) < 0.05);
    assert.equal(row.save.username, "Ada");
    assert.equal(game.world.players.get("user-ada")?.username, "Ada");
  } finally {
    first.ws.close();
    second.ws.close();
    await game.close();
    await pg.close();
  }
});

test("a token cannot load another user's row", async () => {
  const { pg, characters } = await pgliteDb();
  const bea: CharacterRecord = {
    version: 1,
    username: "Bea",
    race: "Elf",
    baseClass: "Mage",
    prestigeClass: "",
    level: 4,
    xp: 12,
    gold: 777,
    x: 3,
    z: 4,
    hp: 40,
    equipment: { weapon: "oak-staff" },
  };
  assert.equal(await characters.create("user-bea", "Bea", bea), 1);
  const game = startServer({ ...gameOpts({ characters }), now: () => 30_000, rand: mulberry32(12) });
  const port = await game.ready;
  const { ws, msgs } = await connect(port);
  try {
    const token = await signGameToken(SECRET, { id: "user-ada", name: "Ada" });
    assert.equal(ClientMsg.safeParse({ t: "hello", token, userId: "user-bea" }).success, false);
    ws.send(JSON.stringify({ t: "hello", token, create: { name: "Bea", race: "Human", baseClass: "Fighter", slot: 0 } }));
    const taken = await until(() => msgs.find((m) => m.t === "error"));
    assert.equal(taken.reason, "name_taken");
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(game.world.players.size, 0);
    assert.equal((await characters.load("user-bea"))?.save.gold, 777);
    ws.send(JSON.stringify({ t: "hello", token, create: { name: "Ada", race: "Human", baseClass: "Fighter", slot: 0 } }));
    const welcome = await until(() => msgs.find((m) => m.t === "welcome"));
    assert.equal(welcome.playerId, "user-ada");
    const hero = game.world.players.get("user-ada");
    assert.ok(hero);
    assert.equal(hero.username, "Ada");
    assert.equal(hero.race, "Human");
    assert.equal(hero.gold, 40);
    assert.equal(hero.str, attrsFor("Human", "Fighter").str);
    assert.equal(game.world.players.has("user-bea"), false);
    assert.equal((await characters.load("user-bea"))?.save.gold, 777);
    assert.equal((await characters.load("user-ada"))?.rev, 1);
  } finally {
    ws.close();
    await game.close();
    await pg.close();
  }
});

test("the same token is rejected on a second socket", async () => {
  const { pg, characters } = await pgliteDb();
  const game = startServer({ ...gameOpts({ characters }), now: () => 40_000, rand: mulberry32(13) });
  const port = await game.ready;
  const first = await connect(port);
  const second = await connect(port);
  try {
    const token = await hello(first.ws, "user-ada", "Ada");
    await until(() => first.msgs.find((m) => m.t === "welcome"));
    const started = Date.now();
    const closed = closeCode(second.ws, 500);
    second.ws.send(JSON.stringify({ t: "hello", token, create: { name: "Ada", race: "Human", baseClass: "Fighter", slot: 0 } }));
    assert.equal(await closed, 4401);
    assert.ok(Date.now() - started < 500);
    const reason = await until(() => second.msgs.find((m) => m.t === "error"));
    assert.equal(reason.reason, "bad token");
    assert.equal(first.ws.readyState, WebSocket.OPEN);
    assert.equal(game.world.players.size, 1);
  } finally {
    first.ws.close();
    second.ws.close();
    await game.close();
    await pg.close();
  }
});

test("a bad or wrong-secret token closes 4401 immediately", async () => {
  const { pg, characters } = await pgliteDb();
  const game = startServer({ ...gameOpts({ characters }), now: () => 50_000, rand: mulberry32(14) });
  const port = await game.ready;
  const garbage = await connect(port);
  const forged = await connect(port);
  try {
    const garbageStarted = Date.now();
    const garbageClosed = closeCode(garbage.ws, 500);
    garbage.ws.send(JSON.stringify({ t: "hello", token: "x".repeat(40) }));
    assert.equal(await garbageClosed, 4401);
    assert.ok(Date.now() - garbageStarted < 500);
    assert.equal((await until(() => garbage.msgs.find((m) => m.t === "error"))).reason, "bad token");

    const token = await signGameToken("other-secret-other-secret-other", { id: "user-ada", name: "Ada" });
    const forgedStarted = Date.now();
    const forgedClosed = closeCode(forged.ws, 500);
    forged.ws.send(JSON.stringify({ t: "hello", token }));
    assert.equal(await forgedClosed, 4401);
    assert.ok(Date.now() - forgedStarted < 500);
    assert.equal((await until(() => forged.msgs.find((m) => m.t === "error"))).reason, "bad token");
    assert.equal(game.world.players.size, 0);
  } finally {
    garbage.ws.close();
    forged.ws.close();
    await game.close();
    await pg.close();
  }
});

test("not ready closes 4401", async () => {
  const game = startServer({ port: 0, now: () => 1_000, rand: mulberry32(15) });
  const port = await game.ready;
  const { ws, msgs } = await connect(port);
  try {
    const started = Date.now();
    const closed = closeCode(ws, 500);
    ws.send(JSON.stringify({ t: "hello", token: "x".repeat(30) }));
    assert.equal(await closed, 4401);
    assert.ok(Date.now() - started < 500);
    assert.equal((await until(() => msgs.find((m) => m.t === "error"))).reason, "not ready");
  } finally {
    ws.close();
    await game.close();
  }
});

test("create is required, validated, and stored at rev 1", async () => {
  const { pg, characters } = await pgliteDb();
  const game = startServer({ ...gameOpts({ characters }), now: () => 60_000, rand: mulberry32(16) });
  const port = await game.ready;
  const { ws, msgs } = await connect(port);
  const other = await connect(port);
  try {
    const token = await signGameToken(SECRET, { id: "user-ada", name: "Ada" });
    ws.send(JSON.stringify({ t: "hello", token }));
    assert.equal((await until(() => msgs.find((m) => m.reason === "need_create"))).reason, "need_create");
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(game.world.players.size, 0);

    ws.send(JSON.stringify({ t: "hello", token, create: { name: "Ada", race: "Dragon", baseClass: "Fighter", slot: 0 } }));
    assert.equal((await until(() => msgs.find((m) => m.reason === "bad_create"))).reason, "bad_create");
    assert.equal(ws.readyState, WebSocket.OPEN);

    ws.send(JSON.stringify({ t: "hello", token, create: { name: "Ada", race: "Minotaur", baseClass: "Mage", slot: 0 } }));
    await until(() => (msgs.filter((m) => m.reason === "bad_create").length >= 2 ? true : undefined));
    assert.equal(game.world.players.size, 0);

    ws.send(JSON.stringify({ t: "hello", token, create: { name: "Ada", race: "Human", baseClass: "Fighter", slot: 0 } }));
    const welcome = await until(() => msgs.find((m) => m.t === "welcome"));
    assert.equal(welcome.playerId, "user-ada");
    const row = await characters.load("user-ada");
    assert.equal(row?.rev, 1);
    assert.equal(row?.save.username, "Ada");
    assert.equal(row?.save.race, "Human");
    assert.equal(row?.save.baseClass, "Fighter");
    assert.equal(game.world.players.get("user-ada")?.str, attrsFor("Human", "Fighter").str);

    const horn = await signGameToken(SECRET, { id: "user-horn", name: "Horn" });
    other.ws.send(JSON.stringify({ t: "hello", token: horn, create: { name: "ada", race: "Minotaur", baseClass: "Fighter", slot: 0 } }));
    const taken = await until(() => other.msgs.find((m) => m.t === "error"));
    assert.equal(taken.reason, "name_taken");
    assert.equal(other.ws.readyState, WebSocket.OPEN);
    assert.equal(await characters.load("user-horn"), null);
    assert.equal(game.world.players.has("user-horn"), false);

    other.ws.send(JSON.stringify({ t: "hello", token: horn, create: { name: "Horn", race: "Minotaur", baseClass: "Fighter", slot: 0 } }));
    const hornWelcome = await until(() => other.msgs.find((m) => m.t === "welcome"));
    assert.equal(hornWelcome.playerId, "user-horn");
    assert.equal((await characters.load("user-horn"))?.rev, 1);
    assert.equal(game.world.players.get("user-horn")?.race, "Minotaur");
  } finally {
    ws.close();
    other.ws.close();
    await game.close();
    await pg.close();
  }
});

test("a digit in the name still joins, and a one-letter name is rejected", async () => {
  const characters = memoryCharacters();
  const game = startServer({ ...gameOpts({ characters }), now: () => 60_000, rand: mulberry32(36) });
  const port = await game.ready;
  const { ws, msgs } = await connect(port);
  try {
    const token = await signGameToken(SECRET, { id: "user-two", name: "Two" });
    ws.send(JSON.stringify({ t: "hello", token, create: { name: "Hero2", race: "Human", baseClass: "Fighter", slot: 0 } }));
    const welcome = await until(() => msgs.find((m) => m.t === "welcome"));
    assert.equal(welcome.playerId, "user-two");
    assert.equal(game.world.players.get("user-two")?.username, "Hero2");

    ws.send(JSON.stringify({ t: "hello", token, create: { name: "A", race: "Human", baseClass: "Fighter", slot: 0 } }));
    assert.equal((await until(() => msgs.find((m) => m.reason === "bad_create"))).reason, "bad_create");
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(game.world.players.get("user-two")?.username, "Hero2");
  } finally {
    ws.close();
    await game.close();
  }
});

test("death writes a grave and a new server restores it with the character", async () => {
  const { pg, characters } = await pgliteDb();
  const bornAt = 50_000_000;
  const game = startServer({ ...gameOpts({ characters }), now: () => bornAt, rand: mulberry32(17) });
  const port = await game.ready;
  const { ws, msgs } = await connect(port);
  try {
    await hello(ws, "user-ada", "Ada");
    await until(() => msgs.find((m) => m.t === "welcome"));
    const before = game.world.players.get("user-ada");
    assert.ok(before);
    const goldBefore = before.gold;
    game.world.setHp("user-ada", 0);
    const grave = await until(async () => {
      const list = await characters.listGraves();
      return list.length ? list[0] : undefined;
    });
    assert.equal(grave.owner, "Ada");
    assert.ok(grave.gold > 0);
    const saved = await until(async () => {
      const row = await characters.load("user-ada");
      if (!row || (row.save.hp ?? 1) > 0) return undefined;
      return row;
    });
    assert.ok((saved.save.gold ?? 0) < goldBefore);
    assert.equal(saved.save.deathSettled, true);
    ws.close();
  } finally {
    ws.close();
    await game.close();
  }

  const again = startServer({ ...gameOpts({ characters }), now: () => bornAt + 1_000, rand: mulberry32(18) });
  try {
    await again.ready;
    const restored = await until(() => {
      const graves = again.world.snapshot().graves;
      return graves.length ? graves : undefined;
    });
    assert.equal(restored.length, 1);
    assert.equal(restored[0].id, graveId(await characters.listGraves()));
    assert.equal(restored[0].owner, "Ada");
    const port2 = await again.ready;
    const back = await connect(port2);
    try {
      await hello(back.ws, "user-ada", "Ada", false);
      const welcome = await until(() => back.msgs.find((m) => m.t === "welcome"));
      assert.equal(welcome.playerId, "user-ada");
      const hero = again.world.players.get("user-ada");
      assert.ok(hero);
      assert.equal(hero.hp, 0);
      assert.ok(hero.gold < 40);
      assert.equal(again.world.snapshot().graves.length, 1);
      assert.equal((await characters.listGraves()).length, 1);
    } finally {
      back.ws.close();
    }
  } finally {
    await again.close();
    await pg.close();
  }
});

function graveId(list: Array<{ id: string }>) {
  return list[0]?.id;
}

test("a 30s tick saves dirty players and close saves everyone online", async () => {
  const { pg, characters } = await pgliteDb();
  let clock = 1_000_000;
  const game = startServer({ ...gameOpts({ characters }), now: () => clock, rand: mulberry32(19) });
  const port = await game.ready;
  const ada = await connect(port);
  const bea = await connect(port);
  try {
    await hello(ada.ws, "user-ada", "Ada");
    await hello(bea.ws, "user-bea", "Bea");
    await until(() => ada.msgs.find((m) => m.t === "welcome"));
    await until(() => bea.msgs.find((m) => m.t === "welcome"));
    const dirty = game.world.players.get("user-ada");
    const clean = game.world.players.get("user-bea");
    assert.ok(dirty && clean);
    dirty.x = 500;
    dirty.z = 500;
    clean.x = 506;
    clean.z = 500;
    dirty.hp = dirty.maxHp;
    clean.hp = clean.maxHp;
    const baseGold = dirty.gold;
    clock += 30_000;
    await until(async () => {
      const row = await characters.load("user-ada");
      const other = await characters.load("user-bea");
      if (!row || !other || row.rev < 2 || other.rev < 2) return undefined;
      if (row.save.gold !== baseGold) return undefined;
      return true;
    });
    dirty.gold = baseGold + 9;
    clock += 30_000;
    const saved = await until(async () => {
      const row = await characters.load("user-ada");
      if (!row || row.rev < 3 || row.save.gold !== baseGold + 9) return undefined;
      return row;
    });
    assert.equal(saved.rev, 3);
    assert.equal((await characters.load("user-bea"))?.rev, 2);
    const seenTick = game.tick;
    await until(() => (game.tick >= seenTick + 2 ? true : undefined));
    assert.equal((await characters.load("user-bea"))?.rev, 2);
    await game.close();
    assert.equal((await characters.load("user-ada"))?.rev, 4);
    assert.equal((await characters.load("user-ada"))?.save.gold, baseGold + 9);
    assert.equal((await characters.load("user-bea"))?.rev, 3);
    assert.equal((await characters.load("user-bea"))?.save.x, 506);
  } finally {
    ada.ws.close();
    bea.ws.close();
    await game.close();
    await pg.close();
  }
});

test("slots create, reject a taken or fourth hero, and persist across login", async () => {
  const { pg, characters } = await pgliteDb();
  const game = startServer({ ...gameOpts({ characters }), now: () => 70_000, rand: mulberry32(21) });
  let again: ReturnType<typeof startServer> | null = null;
  try {
    const port = await game.ready;
    const tokenFor = () => signGameToken(SECRET, { id: "user-ada", name: "Ada" });
    const { ws, msgs } = await connect(port);
    try {
      ws.send(
        JSON.stringify({
          t: "hello",
          token: await tokenFor(),
          create: { name: "Ada", race: "Human", baseClass: "Fighter", slot: 1 },
        }),
      );
      const welcome = await until(() => msgs.find((m) => m.t === "welcome"));
      assert.equal(welcome.playerId, "user-ada");
      assert.equal((await characters.load("user-ada", 1))?.save.username, "Ada");
      assert.equal(await characters.load("user-ada", 0), null);
    } finally {
      ws.close();
    }

    const taken = await connect(port);
    try {
      taken.ws.send(
        JSON.stringify({
          t: "hello",
          token: await tokenFor(),
          create: { name: "Bea", race: "Elf", baseClass: "Mage", slot: 1 },
        }),
      );
      assert.equal((await until(() => taken.msgs.find((m) => m.t === "error"))).reason, "slot_taken");
      assert.equal((await characters.load("user-ada", 1))?.save.username, "Ada");
    } finally {
      taken.ws.close();
    }

    for (const slot of [0, 2]) {
      const sock = await connect(port);
      try {
        sock.ws.send(
          JSON.stringify({
            t: "hello",
            token: await tokenFor(),
            create: { name: slot === 0 ? "Ann" : "Cy", race: "Human", baseClass: "Rogue", slot },
          }),
        );
        await until(() => sock.msgs.find((m) => m.t === "welcome"));
      } finally {
        sock.ws.close();
      }
    }

    const fourth = await connect(port);
    const fourthToken = await tokenFor();
    try {
      fourth.ws.send(
        JSON.stringify({
          t: "hello",
          token: fourthToken,
          create: { name: "Dee", race: "Human", baseClass: "Healer", slot: 0 },
        }),
      );
      assert.equal((await until(() => fourth.msgs.find((m) => m.t === "error"))).reason, "slot_taken");
      fourth.ws.send(
        JSON.stringify({
          t: "hello",
          token: fourthToken,
          create: { name: "Dee", race: "Human", baseClass: "Healer", slot: 3 },
        }),
      );
      assert.equal(await until(() => (fourth.msgs.some((m) => m.reason === "bad_slot") ? true : undefined)), true);
    } finally {
      fourth.ws.close();
    }

    await game.close();
    again = startServer({ ...gameOpts({ characters }), now: () => 80_000, rand: mulberry32(22) });
    const port2 = await again.ready;
    const back = await connect(port2);
    const login = await tokenFor();
    try {
      const list = await fetch(`http://127.0.0.1:${port2}/characters`, {
        headers: { authorization: `Bearer ${login}` },
      });
      const body = (await list.json()) as { slots: Array<{ slot: number; name: string } | null> };
      assert.deepEqual(
        body.slots.map((row) => row?.name ?? null),
        ["Ann", "Ada", "Cy"],
      );
      back.ws.send(JSON.stringify({ t: "hello", token: login, slot: 1 }));
      await until(() => back.msgs.find((m) => m.t === "welcome"));
      assert.equal(again.world.players.get("user-ada")?.username, "Ada");
      assert.equal((await characters.load("user-ada", 1))?.save.baseClass, "Fighter");
    } finally {
      back.ws.close();
    }
  } finally {
    await game.close();
    if (again) await again.close();
    await pg.close();
  }
});

test("interpolation delays other bodies and reconnect backoff is capped", () => {
  assert.equal(snapAlpha(0, 100, 150), 0.5);
  assert.equal(snapAlpha(0, 100, 1000), 1);
  const rows = interpolateXZ(
    [{ id: "a", x: 0, z: 0 }],
    [{ id: "a", x: 10, z: 4 }],
    0.5,
  );
  assert.equal(rows[0].x, 5);
  assert.equal(rows[0].z, 2);
  const own = interpolateXZ([{ id: "me", x: 0, z: 0 }], [{ id: "me", x: 10, z: 0 }], 0.5, "me");
  assert.equal(own[0].x, 10);
  assert.equal(backoffMs(0, () => 0), 400);
  assert.equal(backoffMs(0, () => 1), 600);
  assert.equal(backoffMs(9, () => 0), 6400);
  assert.equal(reconnectPlan(4409, 0).reconnect, false);
  assert.equal(reconnectPlan(4409, 0).notice, "Signed in elsewhere");
  assert.equal(reconnectPlan(4401, 0).reconnect, true);
  assert.equal(reconnectPlan(4401, 1).notice, "sign in again");
  assert.equal(reconnectPlan(4401, 1).reconnect, false);
  assert.equal(reconnectPlan(1006, 0).reconnect, true);
  assert.equal(reconnectPlan(1001, 0).reconnect, true);
});

test("origins are open in dev, denied in production, and matched from the list", () => {
  assert.equal(originAllowed("https://evil.test", "", "production"), false);
  assert.equal(originAllowed("https://evil.test", undefined, "development"), true);
  assert.equal(originAllowed(undefined, undefined, "test"), true);
  assert.equal(
    originAllowed("http://localhost:3000", "http://localhost:3000, https://app.vercel.app", "production"),
    true,
  );
  assert.equal(originAllowed("https://nope", "http://localhost:3000", "production"), false);
  assert.equal(originAllowed("", "http://localhost:3000", "test"), false);
});

test("more than 30 intents a second are dropped and a flood closes 4429", async () => {
  const game = startServer({ ...gameOpts(), now: () => 80_000, rand: mulberry32(30) });
  const port = await game.ready;
  const { ws, msgs } = await connect(port);
  try {
    await hello(ws, "user-fast", "Fast");
    await until(() => msgs.find((m) => m.t === "welcome"));
    const placed = await until(() => {
      const snap = [...msgs].reverse().find((m) => m.t === "snap");
      return snap?.state?.players?.find((p) => p.id === "user-fast");
    });
    const closed = closeCode(ws, 3000);
    for (let i = 0; i < 200; i++) {
      ws.send(
        JSON.stringify({
          t: "intent",
          seq: i + 1,
          intent: { op: "move", x: placed.x, z: placed.z, rotation: 0 },
        }),
      );
    }
    const acksReady = until(() => {
      const n = msgs.filter((m) => m.t === "ack").length;
      return n >= 60 ? n : undefined;
    });
    assert.equal(await closed, 4429);
    const acks = await acksReady;
    assert.equal(acks, 60);
  } finally {
    ws.close();
    await game.close();
  }
});

test("twenty malformed frames close 4400", async () => {
  const game = startServer({ port: 0, rand: mulberry32(31) });
  const port = await game.ready;
  const { ws } = await connect(port);
  try {
    for (let i = 0; i < 19; i++) ws.send("{");
    await until(() => (game.dropped >= 19 ? true : undefined));
    assert.equal(ws.readyState, WebSocket.OPEN);
    const closed = closeCode(ws, 2000);
    ws.send("{");
    assert.equal(await closed, 4400);
  } finally {
    ws.close();
    await game.close();
  }
});

test("a 5kb frame is rejected", async () => {
  const game = startServer({ port: 0, rand: mulberry32(32) });
  const port = await game.ready;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("error", () => undefined);
  try {
    await opened(ws);
    const closed = closeCode(ws, 2000);
    ws.send("x".repeat(5 * 1024));
    const code = await closed;
    assert.ok(code === 1009 || code === 1006, `close ${code}`);
    assert.notEqual(ws.readyState, WebSocket.OPEN);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
  } finally {
    ws.close();
    await game.close();
  }
});

test("a bad Origin is 403 and a listed origin connects", async () => {
  const game = startServer({
    ...gameOpts(),
    now: () => 81_000,
    rand: mulberry32(33),
    allowedOrigins: "http://localhost:3000",
  });
  const port = await game.ready;
  const url = `ws://127.0.0.1:${port}`;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: "https://evil.example" } });
      const timer = setTimeout(() => reject(new Error("origin check hung")), 2000);
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      ws.on("open", () => {
        clearTimeout(timer);
        ws.close();
        resolve(101);
      });
      ws.on("error", () => undefined);
    });
    assert.equal(status, 403);

    const good = new WebSocket(url, { headers: { Origin: "http://localhost:3000" } });
    good.on("error", () => undefined);
    await opened(good);
    assert.equal(good.readyState, WebSocket.OPEN);
    good.close();
  } finally {
    await game.close();
  }
});

test("a client cannot raise xp or gold with setLevel, setHp, or spawn", async () => {
  const game = startServer({ ...gameOpts(), now: () => 82_000, rand: mulberry32(34) });
  const port = await game.ready;
  const { ws, msgs } = await connect(port);
  try {
    await hello(ws, "user-ada", "Ada");
    await until(() => msgs.find((m) => m.t === "welcome"));
    const before = game.world.players.get("user-ada");
    assert.ok(before);
    const level = before.level;
    const gold = before.gold;
    const xp = before.xp;
    const hp = before.hp;
    const mobs = game.world.snapshot().monsters.length;
    const forged = [
      { op: "setLevel", level: 20 },
      { op: "setHp", hp: 1 },
      { op: "spawn" },
    ];
    forged.forEach((intent, i) => {
      ws.send(JSON.stringify({ t: "intent", seq: i + 1, intent }));
    });
    const acks = await until(() => {
      const rows = msgs.filter((m) => m.t === "ack" && m.result?.reason === "unknown op");
      return rows.length >= forged.length ? rows : undefined;
    });
    assert.equal(acks.length, forged.length);
    assert.equal(acks.every((m) => m.result?.ok === false), true);
    const after = game.world.players.get("user-ada");
    assert.equal(after?.level, level);
    assert.equal(after?.xp, xp);
    assert.equal(after?.gold, gold);
    assert.equal(after?.hp, hp);
    assert.equal(game.world.snapshot().monsters.length, mobs);
    assert.equal(ws.readyState, WebSocket.OPEN);
  } finally {
    ws.close();
    await game.close();
  }
});

test("log tags hide the user id", () => {
  const tag = userTag("user-ada");
  assert.match(tag, /^[0-9a-f]{10}$/);
  assert.equal(tag.includes("ada"), false);
  assert.equal(userTag("user-ada"), tag);
  assert.equal(userTag(null), "-");
});

test("create retry for the same hero resumes it; another name on that slot does not kick the live session", async () => {
  const characters = memoryCharacters();
  const game = startServer({ ...gameOpts({ characters }), rand: mulberry32(91) });
  const port = await game.ready;
  const first = await connect(port);
  const other = await connect(port);
  const again = await connect(port);
  try {
    await hello(first.ws, "user-mira", "Mira", { name: "Mira", race: "Elf", baseClass: "Mage", slot: 0 });
    await until(() => first.msgs.find((m) => m.t === "welcome"));
    assert.equal((await characters.load("user-mira", 0))?.save.username, "Mira");

    await hello(other.ws, "user-mira", "Mira", { name: "Nope", race: "Human", baseClass: "Fighter", slot: 0 });
    assert.equal((await until(() => other.msgs.find((m) => m.t === "error"))).reason, "slot_taken");
    assert.equal(first.ws.readyState, WebSocket.OPEN);

    const kicked = closeCode(first.ws, 2500);
    await hello(again.ws, "user-mira", "Mira", { name: "mira", race: "Elf", baseClass: "Mage", slot: 0 });
    assert.equal((await until(() => again.msgs.find((m) => m.t === "welcome"))).playerId, "user-mira");
    assert.equal(await kicked, 4409);
    assert.equal(again.msgs.some((m) => m.t === "error"), false);
    assert.equal((await characters.list("user-mira")).filter(Boolean).length, 1);
  } finally {
    first.ws.close();
    other.ws.close();
    again.ws.close();
    await game.close();
  }
});



