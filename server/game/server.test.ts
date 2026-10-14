import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { signGameToken } from "../../src/shared/net/token";
import { ClientMsg, IntentSchema, ServerMsg } from "../../src/shared/net/protocol";
import { blocked, TREES } from "../../src/shared/sim/geo";
import { createWorld, MAX_SPEED } from "../../src/shared/sim/world";
import { memoryCharacters } from "./db";
import { applyIntent, TICK_DT } from "./dispatch";
import { startServer } from "./server";

const maxStep = MAX_SPEED * TICK_DT * 1.5;
const SECRET = "test-secret-test-secret-test-secret";

function gameOpts(extra: { characters?: ReturnType<typeof memoryCharacters> } = {}) {
  return {
    port: 0,
    tokenSecret: SECRET,
    characters: extra.characters ?? memoryCharacters(),
  };
}

async function hello(ws: WebSocket, userId: string, name: string) {
  const token = await signGameToken(SECRET, { id: userId, name });
  ws.send(JSON.stringify({ t: "hello", token }));
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

test("protocol rejects unknown ops, debug ops, and an extra id", () => {
  assert.equal(IntentSchema.safeParse({ op: "dance" }).success, false);
  assert.equal(IntentSchema.safeParse({ op: "setLevel", level: 20 }).success, false);
  assert.equal(IntentSchema.safeParse({ op: "spawnTest" }).success, false);
  assert.equal(IntentSchema.safeParse({ op: "grantXp", amount: 10 }).success, false);
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

  const tree = TREES[0];
  assert.ok(tree, "a tree solid exists");
  let stand: { x: number; z: number } | null = null;
  let into: { x: number; z: number } | null = null;
  for (let away = 0.9; away <= 2.4 && !stand; away += 0.05) {
    const sx = tree[0] + away;
    const ix = sx - 0.3;
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

test("a socket without hello is closed within 5s", { timeout: 12_000 }, async () => {
  const game = startServer({ port: 0, now: () => 1_000, rand: mulberry32(3) });
  const port = await game.ready;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("error", () => undefined);
  try {
    await opened(ws);
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket stayed open")), 8000);
      ws.once("close", (closeCode) => {
        clearTimeout(timer);
        resolve(closeCode);
      });
    });
    assert.equal(code, 4401);
  } finally {
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
    await new Promise((r) => setTimeout(r, 200));
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

test("hello verifies the game token and reloads the saved character", async () => {
  const characters = memoryCharacters();
  const game = startServer({ ...gameOpts({ characters }), now: () => 8_000, rand: mulberry32(6) });
  const port = await game.ready;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs: Array<{ t?: string; reason?: string; playerId?: string; seq?: number; result?: { ok: boolean }; state?: { players?: Array<{ id: string; x: number; z: number }> } }> = [];
  ws.on("message", (data) => msgs.push(JSON.parse(data.toString())));
  ws.on("error", () => undefined);
  let movedX = 0;
  try {
    await opened(ws);
    ws.send(JSON.stringify({ t: "hello", token: "x".repeat(40) }));
    const err = await until(() => msgs.find((m) => m.t === "error"));
    assert.equal(err.reason, "bad token");
    const early = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { players: number };
    assert.equal(early.players, 0);

    await hello(ws, "user-ada", "Ada");
    const welcome = await until(() => msgs.find((m) => m.t === "welcome"));
    assert.equal(welcome.playerId, "user-ada");
    const placed = await until(() => {
      const snap = [...msgs].reverse().find((m) => m.t === "snap");
      return snap?.state?.players?.find((p) => p.id === "user-ada");
    });
    const dest = { x: placed.x + 0.3, z: placed.z };
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
      if (!row || Math.abs((row.x ?? 0) - movedX) > 0.05) return undefined;
      return row;
    });
    assert.equal(saved.username, "Ada");
    assert.equal(saved.equipment?.weapon, "iron-sword");
  } finally {
    ws.close();
    await game.close();
  }

  const again = startServer({ ...gameOpts({ characters }), now: () => 9_000, rand: mulberry32(7) });
  const port2 = await again.ready;
  const ws2 = new WebSocket(`ws://127.0.0.1:${port2}`);
  const msgs2: Array<{ t?: string; state?: { players?: Array<{ username: string; x: number }> } }> = [];
  ws2.on("message", (data) => msgs2.push(JSON.parse(data.toString())));
  ws2.on("error", () => undefined);
  try {
    await opened(ws2);
    await hello(ws2, "user-ada", "Someone Else");
    const back = await until(() => {
      const snap = [...msgs2].reverse().find((m) => m.t === "snap");
      return snap?.state?.players?.find((p) => p.username === "Ada");
    });
    assert.ok(Math.abs(back.x - movedX) < 0.05);
    const row = await characters.load("user-ada");
    assert.equal(row?.username, "Ada");
  } finally {
    ws2.close();
    await again.close();
  }
});

