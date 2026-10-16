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
import { commitGuildAct, createGuildBook, foundGuild } from "./guilds";
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
  assert.equal(IntentSchema.safeParse({ op: "guildInvite", toName: "Bea" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "guildAccept", guildId: "g1" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "guildDecline", guildId: "g1" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "guildLeave" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "guildKick", userName: "Bea" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "guildPromote", userName: "Bea" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "guildDemote", userName: "Bea" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "guildInvite", toName: "" }).success, false);
  assert.deepEqual(toServerIntent({ op: "guildInvite", toName: "Bea" }), { op: "guildInvite", toName: "Bea" });
  assert.deepEqual(toServerIntent({ op: "guildKick", userName: "Bea" }), { op: "guildKick", userName: "Bea" });
  assert.deepEqual(toServerIntent({ op: "guildLeave" }), { op: "guildLeave" });
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
      guild?: {
        tag?: string;
        rank?: string;
        name?: string;
        members?: Array<{ name: string; rank: string; online: boolean }>;
      } | null;
      pendingGuildInvite?: { guildId: string; fromName: string; guildName: string; tag: string } | null;
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

    ada.send(JSON.stringify({ t: "intent", seq: 3, intent: { op: "guildInvite", toName: "Bea" } }));
    const invited = await until(() => adaMsgs.find((m) => m.t === "ack" && m.seq === 3));
    assert.equal(invited.result?.ok, true, invited.result?.reason);
    const toast = await until(() =>
      [...beaMsgs].reverse().find((m) => m.t === "snap" && m.state?.pendingGuildInvite?.tag === "ASH"),
    );
    assert.equal(ServerMsg.safeParse(toast).success, true);
    assert.equal(toast.state?.pendingGuildInvite?.fromName, "Ada");
    assert.equal(toast.state?.pendingGuildInvite?.guildName, "Ash Watch");
    const guildId = toast.state?.pendingGuildInvite?.guildId;
    assert.ok(guildId);
    bea.send(JSON.stringify({ t: "intent", seq: 4, intent: { op: "guildAccept", guildId } }));
    const joined = await until(() => beaMsgs.find((m) => m.t === "ack" && m.seq === 4));
    assert.equal(joined.result?.ok, true, joined.result?.reason);
    const roster = await until(() =>
      [...adaMsgs].reverse().find((m) => m.state?.guild?.members?.some((member) => member.name === "Bea" && member.online)),
    );
    assert.equal(ServerMsg.safeParse(roster).success, true);
    assert.equal(roster.state?.guild?.members?.find((member) => member.name === "Bea")?.rank, "Member");
    const stored = await characters.listGuilds();
    assert.equal(stored.length, 2);
    assert.equal(stored.find((row) => row.userId === "user-bea")?.rank, "member");
  } finally {
    ada.close();
    bea.close();
    await game.close();
  }
});

function foundHouse(world: World, book: ReturnType<typeof createGuildBook>, id: string, username: string, name: string, tag: string) {
  hero(world, id, username);
  const p = world.players.get(id);
  assert.ok(p);
  p.charter = true;
  const result = applyIntent(world, id, { op: "foundGuild", name, tag, kind: "Warband", crest: "ash" }, book);
  assert.equal(result.ok, true, result.reason);
  const view = book.view(id);
  assert.ok(view);
  return view;
}

function acceptInvite(world: World, book: ReturnType<typeof createGuildBook>, fromId: string, toId: string, toName: string) {
  const guildId = book.view(fromId)?.id;
  assert.ok(guildId);
  const invited = applyIntent(world, fromId, { op: "guildInvite", toName }, book);
  assert.equal(invited.ok, true, invited.reason);
  const accepted = applyIntent(world, toId, { op: "guildAccept", guildId }, book);
  assert.equal(accepted.ok, true, accepted.reason);
}

test("each rank can invite, kick, promote, and demote only as allowed", () => {
  const world = worldAt();
  const book = createGuildBook();
  foundHouse(world, book, "a", "Ada", "Ash Watch", "ASH");
  hero(world, "b", "Bea");
  hero(world, "c", "Cal");
  hero(world, "d", "Dee");
  acceptInvite(world, book, "a", "b", "Bea");
  acceptInvite(world, book, "a", "c", "Cal");
  assert.equal(book.view("b")?.rank, "Member");

  const memberInvite = applyIntent(world, "b", { op: "guildInvite", toName: "Dee" }, book);
  assert.equal(memberInvite.ok, false);
  assert.equal(memberInvite.reason, "Only a Leader or Officer can invite.");
  assert.equal(applyIntent(world, "b", { op: "guildKick", userName: "Cal" }, book).reason, "Members cannot kick.");
  assert.equal(applyIntent(world, "b", { op: "guildKick", userName: "Ada" }, book).reason, "The Leader cannot be kicked.");
  assert.equal(applyIntent(world, "b", { op: "guildPromote", userName: "Cal" }, book).reason, "Only the Leader can promote.");
  assert.equal(applyIntent(world, "b", { op: "guildDemote", userName: "Ada" }, book).reason, "Only the Leader can demote.");

  assert.equal(applyIntent(world, "a", { op: "guildPromote", userName: "Bea" }, book).reason, "Bea is now an Officer.");
  assert.equal(book.view("b")?.rank, "Officer");
  assert.equal(applyIntent(world, "b", { op: "guildKick", userName: "Cal" }, book).reason, "Cal was removed from the guild.");
  assert.equal(book.hasUser("c"), false);

  acceptInvite(world, book, "a", "c", "Cal");
  assert.equal(applyIntent(world, "a", { op: "guildPromote", userName: "Cal" }, book).ok, true);
  assert.equal(applyIntent(world, "b", { op: "guildKick", userName: "Cal" }, book).reason, "Officers can only kick Members.");
  assert.equal(applyIntent(world, "b", { op: "guildDemote", userName: "Cal" }, book).reason, "Only the Leader can demote.");
  assert.equal(applyIntent(world, "b", { op: "guildPromote", userName: "Cal" }, book).reason, "Only the Leader can promote.");
  assert.equal(book.hasUser("c"), true);

  assert.equal(applyIntent(world, "a", { op: "guildDemote", userName: "Cal" }, book).reason, "Cal is now a Member.");
  assert.equal(book.view("c")?.rank, "Member");
  assert.equal(applyIntent(world, "a", { op: "guildKick", userName: "Cal" }, book).ok, true);
  assert.equal(applyIntent(world, "a", { op: "guildPromote", userName: "Bea" }, book).reason, "Only a Member can be promoted to Officer.");
  assert.equal(applyIntent(world, "c", { op: "guildInvite", toName: "Dee" }, book).reason, "You are not in a guild.");
});

test("a leader's leave hands leadership to the oldest officer, then the oldest member, else disbands", () => {
  const world = worldAt();
  const book = createGuildBook();
  foundHouse(world, book, "a", "Ada", "Ash Watch", "ASH");
  hero(world, "b", "Bea");
  hero(world, "c", "Cal");
  hero(world, "d", "Dee");
  acceptInvite(world, book, "a", "b", "Bea");
  acceptInvite(world, book, "a", "c", "Cal");
  acceptInvite(world, book, "a", "d", "Dee");
  assert.equal(applyIntent(world, "a", { op: "guildPromote", userName: "Cal" }, book).ok, true);

  const handed = applyIntent(world, "a", { op: "guildLeave" }, book);
  assert.equal(handed.ok, true);
  assert.equal(handed.reason, "You leave the guild. Cal is now Leader.");
  assert.equal(book.hasUser("a"), false);
  assert.equal(book.view("c")?.rank, "Leader");
  assert.equal(book.view("b")?.rank, "Member");
  assert.equal(book.tag("d"), "ASH");

  const noOfficer = applyIntent(world, "c", { op: "guildLeave" }, book);
  assert.equal(noOfficer.reason, "You leave the guild. Bea is now Leader.");
  assert.equal(book.view("b")?.rank, "Leader");
  assert.equal(book.view("d")?.rank, "Member");

  assert.equal(applyIntent(world, "b", { op: "guildLeave" }, book).reason, "You leave the guild. Dee is now Leader.");
  assert.equal(applyIntent(world, "d", { op: "guildLeave" }, book).reason, "The guild is disbanded.");
  assert.equal(book.view("d"), null);
  assert.equal(book.hasUser("b"), false);
});

test("an invite to someone already in a guild is rejected", () => {
  const world = worldAt();
  const book = createGuildBook();
  const ash = foundHouse(world, book, "a", "Ada", "Ash Watch", "ASH");
  foundHouse(world, book, "e", "Eve", "Tide Watch", "TIDE");
  hero(world, "b", "Bea");
  const taken = applyIntent(world, "a", { op: "guildInvite", toName: "Eve" }, book);
  assert.equal(taken.ok, false);
  assert.equal(taken.reason, "They already belong to a guild.");
  assert.equal(book.pending("e"), null);
  assert.equal(book.view("e")?.tag, "TIDE");

  acceptInvite(world, book, "a", "b", "Bea");
  const again = applyIntent(world, "e", { op: "guildInvite", toName: "Bea" }, book);
  assert.equal(again.reason, "They already belong to a guild.");
  assert.equal(book.view("b")?.id, ash.id);
  const declined = applyIntent(world, "b", { op: "guildDecline", guildId: ash.id }, book);
  assert.equal(declined.reason, "No invite.");
});

test("membership is written through and a reloaded book hands off the oldest officer", async () => {
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
    hero(world, "a", "Ada");
    hero(world, "b", "Bea");
    hero(world, "c", "Cal");
    const ada = world.players.get("a");
    assert.ok(ada);
    ada.charter = true;
    const found = await foundGuild(
      world,
      book,
      "a",
      { name: "Ash Watch", tag: "ASH", kind: "Warband", crest: "ash" },
      (row) => store.insertGuild(row),
    );
    assert.equal(found.ok, true, found.reason);
    assert.equal((await commitGuildAct(world, book, "a", { op: "guildInvite", toName: "Bea" }, store)).ok, true);
    assert.equal((await commitGuildAct(world, book, "b", { op: "guildAccept", guildId: book.view("a")!.id }, store)).ok, true);
    assert.equal((await commitGuildAct(world, book, "a", { op: "guildInvite", toName: "Cal" }, store)).ok, true);
    assert.equal((await commitGuildAct(world, book, "c", { op: "guildAccept", guildId: book.view("a")!.id }, store)).ok, true);
    assert.equal(
      (await commitGuildAct(world, book, "a", { op: "guildPromote", userName: "Bea" }, store)).reason,
      "Bea is now an Officer.",
    );

    const reloaded = createGuildBook();
    const store2 = characterStore(query);
    reloaded.load(await store2.listGuilds());
    assert.equal(reloaded.view("b")?.rank, "Officer");
    assert.equal(reloaded.view("c")?.rank, "Member");
    const left = await commitGuildAct(world, reloaded, "a", { op: "guildLeave" }, store2);
    assert.equal(left.reason, "You leave the guild. Bea is now Leader.");

    const after = createGuildBook();
    const store3 = characterStore(query);
    after.load(await store3.listGuilds());
    assert.equal(after.view("a"), null);
    assert.equal(after.view("b")?.rank, "Leader");
    assert.equal(after.view("c")?.rank, "Member");
    assert.equal((await commitGuildAct(world, after, "b", { op: "guildLeave" }, store3)).reason, "You leave the guild. Cal is now Leader.");
    const last = createGuildBook();
    const store4 = characterStore(query);
    last.load(await store4.listGuilds());
    assert.equal(last.view("c")?.rank, "Leader");
    assert.equal((await commitGuildAct(world, last, "c", { op: "guildLeave" }, store4)).reason, "The guild is disbanded.");
    assert.deepEqual(await store4.listGuilds(), []);
  } finally {
    await pg.close();
  }
});
