import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { WebSocket } from "ws";
import { IntentSchema, ServerMsg } from "../../src/shared/net/protocol";
import { signGameToken } from "../../src/shared/net/token";
import { CITY_PLOTS, CORNERSTONE_GOLD } from "../../src/shared/sim/guild";
import { createWorld, type World } from "../../src/shared/sim/world";
import { applyGameMigrations, characterStore, memoryCharacters, type StoredGuild } from "./db";
import { commitGuildAct, createGuildBook, plantCornerstone, removeCornerstone } from "./guilds";
import { startServer } from "./server";

const SECRET = "test-secret-test-secret-test-secret";
const PLOT = CITY_PLOTS[0];

function worldAt() {
  return createWorld({ now: () => 1_000_000, rand: () => 0 });
}

function hero(world: World, id: string, username: string, gold = 400) {
  const player = world.join({ id, username, race: "Human", baseClass: "Fighter" });
  assert.ok(player);
  player.x = PLOT.x;
  player.z = PLOT.z;
  player.gold = gold;
  return player;
}

function row(id: string, userId: string, name: string, tag: string, rank: StoredGuild["rank"] = "leader"): StoredGuild {
  return { id, userId, name, tag, kind: "Warband", crest: "ash", rank, username: name };
}

test("protocol accepts planting and removing a cornerstone", () => {
  assert.equal(IntentSchema.safeParse({ op: "plantCornerstone", plotId: PLOT.id }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "removeCornerstone" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "plantCornerstone" }).success, false);
});

test("only a leader standing on the plot pays for a cornerstone", async () => {
  const store = memoryCharacters();
  const book = createGuildBook();
  const world = worldAt();
  await store.insertGuild(row("g1", "user-ada", "Ash Watch", "ASH"));
  await store.addMember(row("g1", "user-off", "Ash Watch", "ASH", "officer"));
  book.load(await store.listGuilds());
  const ada = hero(world, "user-ada", "Ada", 40);
  const off = hero(world, "user-off", "Off");
  const write = (guildId: string, plotId: string | null) => store.setPlot(guildId, plotId);

  const officer = await plantCornerstone(world, book, "user-off", PLOT.id, write);
  assert.equal(officer.ok, false);
  assert.equal(officer.reason, "Only the Leader can plant a Cornerstone.");
  assert.equal(off.gold, 400);

  ada.x = PLOT.x + 20;
  const far = await plantCornerstone(world, book, "user-ada", PLOT.id, write);
  assert.equal(far.reason, "Stand on the city plot.");
  assert.equal(ada.gold, 40);

  ada.x = PLOT.x;
  const poor = await plantCornerstone(world, book, "user-ada", PLOT.id, write);
  assert.match(poor.reason ?? "", /Not enough gold/);
  assert.equal(ada.gold, 40);
  assert.deepEqual(book.plots(), []);

  ada.gold = CORNERSTONE_GOLD;
  const planted = await plantCornerstone(world, book, "user-ada", PLOT.id, write);
  assert.equal(planted.ok, true, planted.reason);
  assert.equal(ada.gold, 0);
  assert.deepEqual(book.plots(), [{ plotId: PLOT.id, guildTag: "ASH", crest: "ash" }]);
  const again = await plantCornerstone(world, book, "user-ada", CITY_PLOTS[1].id, write);
  assert.equal(again.reason, "Your guild already has a Cornerstone.");
});

test("two guilds racing for one plot pay once, and disband frees it", async () => {
  const store = memoryCharacters();
  const book = createGuildBook();
  const world = worldAt();
  await store.insertGuild(row("g1", "user-ada", "Ash Watch", "ASH"));
  await store.insertGuild(row("g2", "user-bea", "Tide Watch", "TIDE"));
  book.load(await store.listGuilds());
  const ada = hero(world, "user-ada", "Ada");
  const bea = hero(world, "user-bea", "Bea");
  const write = (guildId: string, plotId: string | null) => store.setPlot(guildId, plotId);
  const [first, second] = await Promise.all([
    plantCornerstone(world, book, "user-ada", PLOT.id, write),
    plantCornerstone(world, book, "user-bea", PLOT.id, write),
  ]);
  const won = [first, second].filter((result) => result.ok);
  assert.equal(won.length, 1);
  assert.equal(ada.gold + bea.gold, 800 - CORNERSTONE_GOLD);
  assert.equal(book.plots().length, 1);
  assert.equal((await store.listGuilds()).filter((member) => member.plotId === PLOT.id).length > 0, true);

  const winner = ada.gold === 400 - CORNERSTONE_GOLD ? "user-ada" : "user-bea";
  const loser = winner === "user-ada" ? bea : ada;
  const left = await commitGuildAct(world, book, winner, { op: "guildLeave" }, store);
  assert.equal(left.ok, true, left.reason);
  assert.deepEqual(book.plots(), []);
  assert.equal((await store.listGuilds()).some((member) => member.plotId), false);

  loser.x = PLOT.x;
  loser.z = PLOT.z;
  const freed = await plantCornerstone(world, book, loser.id, PLOT.id, write);
  assert.equal(freed.ok, true, freed.reason);
  assert.equal(loser.gold, 400 - CORNERSTONE_GOLD);
  assert.equal(book.plots()[0]?.plotId, PLOT.id);

  const removed = await removeCornerstone(world, book, loser.id, write);
  assert.equal(removed.ok, true, removed.reason);
  assert.equal(loser.gold, 400 - CORNERSTONE_GOLD);
  assert.deepEqual(book.plots(), []);
  assert.equal((await store.listGuilds()).some((member) => member.plotId), false);
});

test("a plot id is unique in the database and a deleted guild frees it", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  const query = async (text: string, params?: unknown[]) => {
    const result = await pg.query(text, params);
    return { rows: result.rows as Array<Record<string, unknown>> };
  };
  try {
    await applyGameMigrations(query);
    const store = characterStore(query);
    assert.equal(await store.insertGuild(row("g1", "user-ada", "Ash Watch", "ASH")), "ok");
    assert.equal(await store.insertGuild(row("g2", "user-bea", "Tide Watch", "TIDE")), "ok");
    const raced = await Promise.all([store.setPlot("g1", PLOT.id), store.setPlot("g2", PLOT.id)]);
    assert.deepEqual(raced.filter((result) => result === "ok"), ["ok"]);
    assert.equal(raced.includes("taken"), true);
    const held = await characterStore(query).listGuilds();
    const owners = [...new Set(held.filter((member) => member.plotId === PLOT.id).map((member) => member.id))];
    assert.deepEqual(owners, [raced[0] === "ok" ? "g1" : "g2"]);
    await store.deleteGuild(owners[0] ?? "g1");
    const freed = owners[0] === "g1" ? "g2" : "g1";
    assert.equal(await store.setPlot(freed, PLOT.id), "ok");
    const after = await characterStore(query).listGuilds();
    assert.deepEqual(
      [...new Set(after.map((member) => member.plotId).filter(Boolean))],
      [PLOT.id],
    );
    assert.equal(after.every((member) => member.id === freed), true);
  } finally {
    await pg.close();
  }
});

test("every player's snap includes the claimed plots", async () => {
  const characters = memoryCharacters();
  await characters.insertGuild(row("g1", "user-ada", "Ash Watch", "ASH"));
  assert.equal(await characters.setPlot("g1", PLOT.id), "ok");
  const game = startServer({
    port: 0,
    tokenSecret: SECRET,
    characters,
    now: () => 8_000,
    rand: () => 0,
  });
  const port = await game.ready;
  const ada = new WebSocket(`ws://127.0.0.1:${port}`);
  const bea = new WebSocket(`ws://127.0.0.1:${port}`);
  const adaMsgs: Array<{ t?: string; state?: { plots?: Array<{ plotId: string; guildTag: string; crest: string }> } }> = [];
  const beaMsgs: typeof adaMsgs = [];
  ada.on("message", (data) => adaMsgs.push(JSON.parse(data.toString())));
  bea.on("message", (data) => beaMsgs.push(JSON.parse(data.toString())));
  ada.on("error", () => undefined);
  bea.on("error", () => undefined);
  const opened = (ws: WebSocket) =>
    new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  const until = async <T>(read: () => T | undefined) => {
    const start = Date.now();
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      if (Date.now() - start > 2500) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    await Promise.all([opened(ada), opened(bea)]);
    const hello = async (ws: WebSocket, userId: string, name: string) => {
      const token = await signGameToken(SECRET, { id: userId, name });
      ws.send(JSON.stringify({ t: "hello", token, create: { name, race: "Human", baseClass: "Fighter", slot: 0 } }));
    };
    await hello(ada, "user-ada", "Ada");
    await hello(bea, "user-bea", "Bea");
    const readPlots = (msgs: typeof adaMsgs) => {
      const snap = [...msgs].reverse().find((m) => m.t === "snap" && m.state?.plots?.length);
      return snap;
    };
    const adaSnap = await until(() => readPlots(adaMsgs));
    const beaSnap = await until(() => readPlots(beaMsgs));
    assert.equal(ServerMsg.safeParse(adaSnap).success, true);
    assert.equal(ServerMsg.safeParse(beaSnap).success, true);
    assert.deepEqual(adaSnap.state?.plots, [{ plotId: PLOT.id, guildTag: "ASH", crest: "ash" }]);
    assert.deepEqual(beaSnap.state?.plots, adaSnap.state?.plots);
  } finally {
    ada.close();
    bea.close();
    await game.close();
  }
});
