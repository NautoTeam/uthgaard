import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { WebSocket } from "ws";
import { toServerIntent } from "../../src/game/net";
import { IntentSchema, ServerMsg } from "../../src/shared/net/protocol";
import { signGameToken } from "../../src/shared/net/token";
import { NPCS } from "../../src/shared/sim/geo";
import { CHARTER_GOLD } from "../../src/shared/sim/guild";
import { createWorld, type World } from "../../src/shared/sim/world";
import { applyGameMigrations, characterStore, memoryCharacters } from "./db";
import { applyIntent } from "./dispatch";
import { createGuildBook, foundGuild } from "./guilds";
import { joinInputFor, recordFromPlayer } from "./persist";
import { startServer } from "./server";

const SECRET = "test-secret-test-secret-test-secret";

function worldAt() {
  return createWorld({ now: () => 1_000_000, rand: () => 0 });
}

function hero(world: World, id: string, username: string) {
  return world.join({ id, username, race: "Human", baseClass: "Fighter" });
}

function registrar() {
  const npc = NPCS.find((row) => row.role === "registrar");
  assert.ok(npc);
  return npc;
}

function atDesk(world: World, id: string, gold = 200) {
  const p = world.players.get(id);
  assert.ok(p);
  const desk = registrar();
  p.x = desk.x;
  p.z = desk.z;
  p.gold = gold;
  return p;
}

test("protocol accepts a charter purchase and a founding", () => {
  assert.equal(IntentSchema.safeParse({ op: "buyCharter" }).success, true);
  assert.equal(
    IntentSchema.safeParse({ op: "foundGuild", name: "Ash Watch", tag: "ASH", kind: "Warband", crest: "ash" })
      .success,
    true,
  );
  assert.equal(IntentSchema.safeParse({ op: "foundGuild", name: "Ash" }).success, false);
  assert.deepEqual(toServerIntent({ op: "buyCharter" }), { op: "buyCharter" });
  assert.deepEqual(
    toServerIntent({ op: "foundGuild", name: "Ash Watch", tag: "ash", kind: "Warband", crest: "ash" }),
    { op: "foundGuild", name: "Ash Watch", tag: "ash", kind: "Warband", crest: "ash" },
  );
});

test("a charter costs gold and only at the registrar", () => {
  const world = worldAt();
  const book = createGuildBook();
  hero(world, "a", "Ada");
  const p = atDesk(world, "a", 200);
  const bought = applyIntent(world, "a", { op: "buyCharter" }, book);
  assert.equal(bought.ok, true);
  assert.equal(bought.reason, "The Registrar seals your charter.");
  assert.equal(p.gold, 200 - CHARTER_GOLD);
  assert.equal(p.charter, true);

  const again = applyIntent(world, "a", { op: "buyCharter" }, book);
  assert.equal(again.ok, false);
  assert.equal(again.reason, "You already hold a charter.");
  assert.equal(p.gold, 200 - CHARTER_GOLD);

  const far = worldAt();
  const book2 = createGuildBook();
  hero(far, "b", "Bea");
  const q = atDesk(far, "b", 200);
  const desk = registrar();
  q.x = desk.x + 30;
  const away = applyIntent(far, "b", { op: "buyCharter" }, book2);
  assert.equal(away.ok, false);
  assert.equal(away.reason, "Find the registrar.");
  assert.equal(q.gold, 200);
  assert.equal(q.charter, false);

  q.x = desk.x;
  q.z = desk.z;
  q.gold = 40;
  const poor = applyIntent(far, "b", { op: "buyCharter" }, book2);
  assert.equal(poor.ok, false);
  assert.equal(poor.reason, `A charter costs ${CHARTER_GOLD} gold. You have 40.`);
  assert.equal(q.gold, 40);
  assert.notEqual(q.charter, true);
});

test("founding consumes the charter and a second founding is refused", () => {
  const world = worldAt();
  const book = createGuildBook();
  hero(world, "a", "Ada");
  const p = atDesk(world, "a");
  assert.equal(applyIntent(world, "a", { op: "buyCharter" }, book).ok, true);
  const early = applyIntent(world, "a", {
    op: "foundGuild",
    name: "No",
    tag: "NO",
    kind: "Warband",
    crest: "ash",
  }, book);
  assert.equal(early.ok, false);
  assert.equal(p.charter, true);

  const found = applyIntent(world, "a", {
    op: "foundGuild",
    name: "Ash Watch",
    tag: "ash",
    kind: "warband",
    crest: "ash",
  }, book);
  assert.equal(found.ok, true);
  assert.equal(found.reason, "You found [ASH] Ash Watch. You are Leader.");
  assert.equal(p.charter, false);
  assert.equal(book.view("a")?.tag, "ASH");
  assert.equal(book.view("a")?.rank, "Leader");
  assert.equal(book.tag("a"), "ASH");

  p.charter = true;
  const twice = applyIntent(world, "a", {
    op: "foundGuild",
    name: "Other Watch",
    tag: "OTH",
    kind: "Order",
    crest: "sun",
  }, book);
  assert.equal(twice.ok, false);
  assert.equal(twice.reason, "You already belong to a guild.");
  assert.equal(book.view("a")?.name, "Ash Watch");
  assert.equal(p.charter, true);
});

test("a duplicate name or tag is rejected and the charter stays", () => {
  const world = worldAt();
  const book = createGuildBook();
  hero(world, "a", "Ada");
  hero(world, "b", "Bea");
  hero(world, "c", "Cal");
  atDesk(world, "a");
  const bea = atDesk(world, "b");
  const cal = atDesk(world, "c");
  assert.equal(applyIntent(world, "a", { op: "buyCharter" }, book).ok, true);
  assert.equal(applyIntent(world, "b", { op: "buyCharter" }, book).ok, true);
  assert.equal(applyIntent(world, "c", { op: "buyCharter" }, book).ok, true);
  assert.equal(
    applyIntent(world, "a", { op: "foundGuild", name: "Ash Watch", tag: "ASH", kind: "Warband", crest: "ash" }, book).ok,
    true,
  );

  const sameName = applyIntent(world, "b", {
    op: "foundGuild",
    name: "ash watch",
    tag: "TIDE",
    kind: "Syndicate",
    crest: "tide",
  }, book);
  assert.equal(sameName.ok, false);
  assert.equal(sameName.reason, "That guild name is already taken.");
  assert.equal(bea.charter, true);
  assert.equal(book.hasUser("b"), false);

  const sameTag = applyIntent(world, "c", {
    op: "foundGuild",
    name: "Tide Watch",
    tag: "ash",
    kind: "Order",
    crest: "sun",
  }, book);
  assert.equal(sameTag.ok, false);
  assert.equal(sameTag.reason, "The tag [ASH] is already taken.");
  assert.equal(cal.charter, true);
  assert.equal(book.view("a")?.tag, "ASH");
});

test("the charter is stored on the character and stripped from the shared snapshot", () => {
  const world = worldAt();
  const ada = hero(world, "user-ada", "Ada");
  ada.charter = true;
  const save = recordFromPlayer(ada);
  assert.equal(save.charter, true);
  const input = joinInputFor("user-ada", save, null);
  assert.equal(input?.charter, true);
  const next = worldAt();
  const again = next.join(input!);
  assert.equal(again.charter, true);
  const snap = next.snapshot();
  assert.equal(snap.players.length, 1);
  assert.equal(Object.hasOwn(snap.players[0]!, "charter"), false);
  assert.equal(Object.hasOwn(snap, "charter"), false);
  assert.equal(Object.hasOwn(snap, "guild"), false);
});

test("a refused database write does not spend the charter", async () => {
  const world = worldAt();
  const book = createGuildBook();
  hero(world, "a", "Ada");
  const p = atDesk(world, "a");
  p.charter = true;
  const refused = await foundGuild(
    world,
    book,
    "a",
    { name: "Ash Watch", tag: "ASH", kind: "Warband", crest: "ash" },
    async () => "name_taken",
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "That guild name is already taken.");
  assert.equal(p.charter, true);
  assert.equal(book.hasUser("a"), false);
});

test("a founded guild survives a new store on the same database", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  const query = async (text: string, params?: unknown[]) => {
    const result = await pg.query(text, params);
    return { rows: result.rows as Array<Record<string, unknown>> };
  };
  try {
    await applyGameMigrations(query);
    const store = characterStore(query);
    const world = worldAt();
    const book = createGuildBook();
    hero(world, "user-ada", "Ada");
    const p = atDesk(world, "user-ada");
    p.charter = true;
    const found = await foundGuild(
      world,
      book,
      "user-ada",
      { name: "Ash Watch", tag: "ash", kind: "Order", crest: "thorn" },
      (row) => store.insertGuild(row),
    );
    assert.equal(found.ok, true);
    assert.equal(p.charter, false);

    const restarted = characterStore(query);
    const rows = await restarted.listGuilds();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, "Ash Watch");
    assert.equal(rows[0]?.tag, "ASH");
    assert.equal(rows[0]?.kind, "Order");
    assert.equal(rows[0]?.crest, "thorn");
    assert.equal(rows[0]?.userId, "user-ada");
    assert.equal(rows[0]?.rank, "leader");
    const loaded = createGuildBook();
    loaded.load(rows);
    assert.equal(loaded.view("user-ada")?.rank, "Leader");

    assert.equal(
      await restarted.insertGuild({
        id: "g-other",
        userId: "user-bea",
        name: "ash watch",
        tag: "BEA",
        kind: "Warband",
        crest: "ash",
        rank: "leader",
      }),
      "name_taken",
    );
    assert.equal(
      await restarted.insertGuild({
        id: "g-tag",
        userId: "user-cal",
        name: "Tide Watch",
        tag: "ash",
        kind: "Warband",
        crest: "tide",
        rank: "leader",
      }),
      "tag_taken",
    );
    assert.equal(
      await restarted.insertGuild({
        id: "g-ada",
        userId: "user-ada",
        name: "Sun Watch",
        tag: "SUN",
        kind: "Order",
        crest: "sun",
        rank: "leader",
      }),
      "already",
    );
    assert.equal((await restarted.listGuilds()).length, 1);
  } finally {
    await pg.close();
  }
});

test("a snap shows the buyer's charter and the public guild tag", async () => {
  const characters = memoryCharacters();
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
  const adaMsgs: Array<{
    t?: string;
    seq?: number;
    result?: { ok: boolean; reason?: string };
    state?: {
      charter?: boolean;
      guild?: { tag?: string; rank?: string; name?: string } | null;
      players?: Array<{ id: string; guildTag?: string; charter?: boolean }>;
    };
  }> = [];
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
  const until = async <T>(read: () => T | undefined, ms = 2500): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    await Promise.all([opened(ada), opened(bea)]);
    const hello = async (ws: WebSocket, userId: string, name: string) => {
      const token = await signGameToken(SECRET, { id: userId, name });
      ws.send(
        JSON.stringify({
          t: "hello",
          token,
          create: { name, race: "Human", baseClass: "Fighter", slot: 0 },
        }),
      );
    };
    await hello(ada, "user-ada", "Ada");
    await hello(bea, "user-bea", "Bea");
    await until(() => adaMsgs.find((m) => m.t === "welcome"));
    await until(() => beaMsgs.find((m) => m.t === "welcome"));
    const desk = registrar();
    const founder = game.world.players.get("user-ada");
    assert.ok(founder);
    founder.x = desk.x;
    founder.z = desk.z;
    founder.gold = 200;
    ada.send(JSON.stringify({ t: "intent", seq: 1, intent: { op: "buyCharter" } }));
    const bought = await until(() => adaMsgs.find((m) => m.t === "ack" && m.seq === 1));
    assert.equal(bought.result?.ok, true, bought.result?.reason);
    assert.equal(founder.gold, 200 - CHARTER_GOLD);
    const sealed = await until(() => {
      const snap = [...adaMsgs].reverse().find((m) => m.t === "snap");
      if (snap?.state?.charter !== true) return undefined;
      return snap;
    });
    assert.equal(ServerMsg.safeParse(sealed).success, true);
    assert.equal(sealed.state?.guild, null);

    ada.send(
      JSON.stringify({
        t: "intent",
        seq: 2,
        intent: { op: "foundGuild", name: "Ash Watch", tag: "ash", kind: "Warband", crest: "ash" },
      }),
    );
    const founded = await until(() => adaMsgs.find((m) => m.t === "ack" && m.seq === 2));
    assert.equal(founded.result?.ok, true, founded.result?.reason);
    const rows = await characters.listGuilds();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tag, "ASH");
    assert.equal(rows[0]?.userId, "user-ada");
    assert.equal(founder.charter, false);
    const views = await until(() => {
      const adaSnap = [...adaMsgs].reverse().find((m) => m.t === "snap" && m.state?.guild?.tag === "ASH");
      const beaSnap = [...beaMsgs].reverse().find((m) => m.t === "snap");
      const seen = beaSnap?.state?.players?.find((row) => row.id === "user-ada");
      if (!adaSnap || seen?.guildTag !== "ASH") return undefined;
      return { adaSnap, beaSnap };
    });
    assert.equal(views.adaSnap.state?.charter, false);
    assert.equal(views.adaSnap.state?.guild?.rank, "Leader");
    assert.equal(views.beaSnap?.state?.guild, null);
    assert.equal(views.beaSnap?.state?.charter, false);
    const plate = views.adaSnap.state?.players?.find((row) => row.id === "user-ada");
    assert.equal(plate?.guildTag, "ASH");
    assert.equal(plate ? Object.hasOwn(plate, "charter") : false, false);
    assert.equal(ServerMsg.safeParse(views.adaSnap).success, true);
    assert.equal(ServerMsg.safeParse(views.beaSnap).success, true);
  } finally {
    ada.close();
    bea.close();
    await game.close();
  }
});
