import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { toServerIntent } from "../../src/game/net";
import { conXp, mobByType } from "../../src/shared/content/catalog";
import { IntentSchema, ServerMsg } from "../../src/shared/net/protocol";
import { signGameToken } from "../../src/shared/net/token";
import { GROUP_NEAR, INVITE_MS, createWorld, type World } from "../../src/shared/sim/world";
import { applyIntent } from "./dispatch";
import { memoryCharacters } from "./db";
import { startServer } from "./server";

const SECRET = "test-secret-test-secret-test-secret";

function worldAt(time: { t: number }) {
  return createWorld({ now: () => time.t, rand: () => 0 });
}

function hero(world: World, id: string, username: string) {
  return world.join({ id, username, race: "Human", baseClass: "Fighter" });
}

test("protocol and dispatch route party intents", () => {
  assert.equal(IntentSchema.safeParse({ op: "partyInvite", toName: "Bea" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "partyAccept", fromId: "user-ada" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "partyDecline", fromId: "user-ada" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "partyLeave" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "partyInvite", toName: "" }).success, false);
  assert.deepEqual(toServerIntent({ op: "partyInvite", toName: "Bea" }), {
    op: "partyInvite",
    toName: "Bea",
  });
  assert.deepEqual(toServerIntent({ op: "partyLeave" }), { op: "partyLeave" });

  const time = { t: 1_000_000 };
  const world = worldAt(time);
  hero(world, "a", "Ada");
  hero(world, "b", "Bea");
  const invited = applyIntent(world, "a", { op: "partyInvite", toName: "bea" });
  assert.equal(invited.ok, true);
  assert.equal(world.social("b").pendingInvite?.fromId, "a");
  assert.equal(applyIntent(world, "b", { op: "partyDecline", fromId: "a" }).ok, true);
  assert.equal(world.social("b").pendingInvite, null);
});

test("invite, accept, and leave", () => {
  const time = { t: 5_000 };
  const world = worldAt(time);
  hero(world, "a", "Ada");
  hero(world, "b", "Bea");
  hero(world, "c", "Cal");
  assert.equal(world.social("a").party, null);
  assert.equal(world.partyInvite("a", "Bea").ok, true);
  assert.deepEqual(world.social("b").pendingInvite, { fromId: "a", fromName: "Ada" });
  assert.equal(world.social("a").pendingInvite, null);
  assert.equal(world.partyAccept("b", "a").reason, "You join the group.");
  const party = world.social("a").party;
  assert.ok(party);
  assert.equal(party.leader, "a");
  assert.deepEqual(
    party.members.map((member) => member.id),
    ["a", "b"],
  );
  assert.equal(world.social("b").party?.id, party.id);
  assert.equal(world.social("b").pendingInvite, null);
  assert.equal(Object.hasOwn(world.snapshot(), "party"), false);

  assert.equal(world.partyInvite("a", "Cal").ok, true);
  assert.equal(world.partyAccept("c", "a").ok, true);
  assert.equal(world.partyLeave("b").reason, "You leave the group.");
  assert.deepEqual(
    world.social("a").party?.members.map((member) => member.id),
    ["a", "c"],
  );
  assert.equal(world.social("b").party, null);

  world.restore(world.snapshot());
  assert.equal(world.social("a").party, null, "parties are not restored with the world");
});

test("invites expire after 60s and a full party refuses another", () => {
  const time = { t: 10_000 };
  const world = worldAt(time);
  hero(world, "a", "Ada");
  hero(world, "b", "Bea");
  assert.equal(world.partyInvite("a", "Bea").ok, true);
  time.t += INVITE_MS - 1;
  assert.equal(world.social("b").pendingInvite?.fromId, "a");
  time.t += 1;
  const expired = world.partyAccept("b", "a");
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "That invite expired.");
  assert.equal(world.social("b").pendingInvite, null);

  const names = ["Ada", "Bea", "Cal", "Dee", "Eve", "Fay"];
  const full = worldAt(time);
  for (let i = 0; i < names.length; i++) hero(full, "p" + i, names[i]);
  for (let i = 1; i <= 4; i++) {
    assert.equal(full.partyInvite("p0", names[i]).ok, true, names[i]);
    assert.equal(full.partyAccept("p" + i, "p0").ok, true, names[i]);
  }
  assert.equal(full.social("p0").party?.members.length, 5);
  const refused = full.partyInvite("p0", "Fay");
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "The party is full.");
});

test("offline member is removed on leave()", () => {
  const world = worldAt({ t: 2_000 });
  hero(world, "a", "Ada");
  hero(world, "b", "Bea");
  hero(world, "c", "Cal");
  assert.equal(world.partyInvite("a", "Bea").ok, true);
  assert.equal(world.partyAccept("b", "a").ok, true);
  assert.equal(world.partyInvite("a", "Cal").ok, true);
  assert.equal(world.partyAccept("c", "a").ok, true);
  const left = world.leave("b");
  assert.equal(left?.username, "Bea");
  assert.equal(world.players.has("b"), false);
  assert.equal(world.social("b").party, null);
  const party = world.social("a").party;
  assert.ok(party);
  assert.equal(party.leader, "a");
  assert.deepEqual(
    party.members.map((member) => member.id),
    ["a", "c"],
  );
  world.leave("a");
  const promoted = world.social("c").party;
  assert.equal(promoted, null, "two members became one, so the party ends");
});

function expectXp(xp: number, level: number, gain: number) {
  let nextXp = xp + gain;
  let nextLevel = level;
  while (nextXp >= nextLevel * 70 && nextLevel < 25) {
    nextXp -= nextLevel * 70;
    nextLevel++;
  }
  return { xp: nextXp, level: nextLevel };
}

function lowestMobs(world: World) {
  return world
    .snapshot()
    .monsters.filter((mob) => mob.hp > 0)
    .sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
}

function killMob(world: World, id: string, mobId: string) {
  for (let swing = 0; swing < 80; swing++) {
    const p = world.players.get(id);
    if (!p) throw new Error("no killer");
    p.cooldowns.attack = 0;
    p.nextSwing = 0;
    p.stamina = p.maxStamina;
    p.mana = p.maxMana;
    world.attack(id, mobId);
    const mob = world.snapshot().monsters.find((row) => row.id === mobId);
    if (!mob || mob.hp <= 0 || mob.respawnAt > 0) return;
  }
  throw new Error(`mob ${mobId} survived`);
}

test("nearby party members each gain kill XP plus 10% per other member", () => {
  const world = worldAt({ t: 3_000 });
  const ada = hero(world, "a", "Ada");
  const bea = hero(world, "b", "Bea");
  const cal = hero(world, "c", "Cal");
  const mobs = lowestMobs(world);
  assert.ok(mobs.length >= 2, "need two mobs");
  const first = mobs[0];
  const second = mobs[1];
  const award = (mob: { type: string; level: number }, killerLevel: number) => {
    const def = mobByType(mob.type);
    return conXp(mob.level, killerLevel, def.xpBase + mob.level * def.xpPerLevel);
  };

  ada.x = first.x;
  ada.z = first.z;
  const solo = award(first, ada.level);
  const goldBefore = ada.gold;
  const beaGold = bea.gold;
  killMob(world, "a", first.id);
  assert.equal(solo > 0, true);
  assert.deepEqual({ xp: ada.xp, level: ada.level }, expectXp(0, 1, solo));
  assert.equal(bea.xp, 0);
  assert.equal(bea.gold, beaGold);
  assert.ok(ada.gold > goldBefore);

  assert.equal(world.partyInvite("a", "Bea").ok, true);
  assert.equal(world.partyAccept("b", "a").ok, true);
  assert.equal(world.partyInvite("a", "Cal").ok, true);
  assert.equal(world.partyAccept("c", "a").ok, true);
  ada.x = second.x;
  ada.z = second.z;
  bea.x = second.x + 1;
  bea.z = second.z;
  cal.x = second.x + GROUP_NEAR + 1;
  cal.z = second.z;
  const base = award(second, ada.level);
  const bonus = Math.ceil(base * 0.1);
  const beforeAda = { xp: ada.xp, level: ada.level };
  const beforeBea = { xp: bea.xp, level: bea.level };
  const beforeCal = { xp: cal.xp, level: cal.level };
  const goldAda = ada.gold;
  const goldBea = bea.gold;
  const goldCal = cal.gold;
  killMob(world, "a", second.id);
  assert.deepEqual({ xp: ada.xp, level: ada.level }, expectXp(beforeAda.xp, beforeAda.level, base + bonus));
  assert.deepEqual({ xp: bea.xp, level: bea.level }, expectXp(beforeBea.xp, beforeBea.level, base + bonus));
  assert.deepEqual({ xp: cal.xp, level: cal.level }, expectXp(beforeCal.xp, beforeCal.level, 0));
  assert.ok(ada.gold > goldAda);
  assert.equal(bea.gold, goldBea);
  assert.equal(cal.gold, goldCal);
});

test("a snap carries party state only for that player", async () => {
  const game = startServer({
    port: 0,
    tokenSecret: SECRET,
    characters: memoryCharacters(),
    now: () => 8_000,
    rand: () => 0,
  });
  const port = await game.ready;
  const ada = new WebSocket(`ws://127.0.0.1:${port}`);
  const bea = new WebSocket(`ws://127.0.0.1:${port}`);
  const adaMsgs: Array<{
    t?: string;
    playerId?: string;
    seq?: number;
    result?: { ok: boolean; reason?: string };
    state?: {
      party?: { id?: string; leader?: string; members: Array<{ id: string }> } | null;
      pendingInvite?: { fromId: string; fromName: string } | null;
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
    const adaWelcome = await until(() => adaMsgs.find((m) => m.t === "welcome"));
    await until(() => beaMsgs.find((m) => m.t === "welcome"));
    ada.send(JSON.stringify({ t: "intent", seq: 1, intent: { op: "partyInvite", toName: "Bea" } }));
    const ack = await until(() => adaMsgs.find((m) => m.t === "ack" && m.seq === 1));
    assert.equal(ack.result?.ok, true, ack.result?.reason);
    const views = await until(() => {
      const beaSnap = [...beaMsgs].reverse().find((m) => m.t === "snap");
      const adaSnap = [...adaMsgs].reverse().find((m) => m.t === "snap");
      if (beaSnap?.state?.pendingInvite?.fromName !== "Ada") return undefined;
      if (!adaSnap || adaSnap.state?.pendingInvite) return undefined;
      return { adaSnap, beaSnap };
    });
    assert.equal(ServerMsg.safeParse(views.adaSnap).success, true);
    assert.equal(ServerMsg.safeParse(views.beaSnap).success, true);
    assert.equal(views.adaSnap.state?.party, null);
    assert.deepEqual(views.beaSnap.state?.pendingInvite, { fromId: adaWelcome.playerId, fromName: "Ada" });
    bea.send(
      JSON.stringify({
        t: "intent",
        seq: 2,
        intent: { op: "partyAccept", fromId: adaWelcome.playerId },
      }),
    );
    const joined = await until(() => {
      const adaSnap = [...adaMsgs].reverse().find((m) => m.t === "snap");
      const beaSnap = [...beaMsgs].reverse().find((m) => m.t === "snap");
      if (adaSnap?.state?.party?.members.length !== 2) return undefined;
      if (beaSnap?.state?.party?.members.length !== 2) return undefined;
      if (beaSnap.state?.pendingInvite) return undefined;
      return { adaSnap, beaSnap };
    });
    assert.equal(joined.adaSnap.state?.party?.members.length, 2);
    assert.equal(joined.beaSnap.state?.pendingInvite, null);
    assert.equal(joined.adaSnap.state?.party?.id, joined.beaSnap.state?.party?.id);
  } finally {
    ada.close();
    bea.close();
    await game.close();
  }
});
