import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { WebSocket } from "ws";
import { toServerIntent } from "../../src/game/net";
import { IntentSchema, ServerMsg } from "../../src/shared/net/protocol";
import { signGameToken } from "../../src/shared/net/token";
import { allowChat, CHAT_BURST, CHAT_WINDOW_MS } from "../../src/shared/sim/chat";
import { applyGameMigrations, characterStore, memoryCharacters } from "./db";
import { applyIntent } from "./dispatch";
import { createWorld } from "../../src/shared/sim/world";
import { startServer } from "./server";

const SECRET = "test-secret-test-secret-test-secret";

test("say is the default channel and guild chat is not a public log", () => {
  assert.equal(IntentSchema.safeParse({ op: "chat", msg: "hello" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "chat", msg: "hello", channel: "guild" }).success, true);
  assert.equal(IntentSchema.safeParse({ op: "chat", msg: "hello", channel: "party" }).success, false);
  assert.deepEqual(toServerIntent({ op: "chat", msg: "hello" }), { op: "chat", msg: "hello" });
  assert.deepEqual(toServerIntent({ op: "chat", msg: "hi", channel: "guild" }), {
    op: "chat",
    msg: "hi",
    channel: "guild",
  });

  const world = createWorld({ now: () => 1_000, rand: () => 0 });
  world.join({ id: "a", username: "Ada", race: "Human", baseClass: "Fighter" });
  assert.equal(applyIntent(world, "a", { op: "chat", msg: "secret-banner", channel: "guild" }).reason, "You are not in a guild.");
  assert.equal(world.snapshot().logs.some((line) => line.includes("secret-banner")), false);
  assert.equal(applyIntent(world, "a", { op: "chat", msg: "hello square" }).ok, true);
  assert.equal(world.snapshot().logs.some((line) => line.includes("hello square")), true);
});

test("guild chat allows four lines in the window and then asks to slow down", () => {
  let stamps: number[] = [];
  for (let i = 0; i < CHAT_BURST; i++) {
    const gate = allowChat(stamps, 1_000 + i);
    assert.equal(gate.ok, true);
    stamps = gate.stamps;
  }
  const blocked = allowChat(stamps, 1_000 + CHAT_BURST);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.stamps.length, CHAT_BURST);
  const later = allowChat(blocked.stamps, 1_000 + CHAT_WINDOW_MS);
  assert.equal(later.ok, true);
});

test("a guild keeps the last 50 lines across a new store", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  const query = async (text: string, params?: unknown[]) => {
    const result = await pg.query(text, params);
    return { rows: result.rows as Array<Record<string, unknown>> };
  };
  try {
    await applyGameMigrations(query);
    const store = characterStore(query);
    for (let i = 0; i < 51; i++) {
      await store.addGuildChat({ guildId: "g1", from: "Ada", text: `m${i}`, at: 1_000 + i });
    }
    await store.addGuildChat({ guildId: "g2", from: "Bea", text: "other", at: 2_000 });
    const restarted = characterStore(query);
    const lines = await restarted.listGuildChat();
    const ash = lines.filter((line) => line.guildId === "g1");
    assert.equal(ash.length, 50);
    assert.equal(ash[0]?.text, "m1");
    assert.equal(ash[49]?.text, "m50");
    assert.equal(lines.some((line) => line.text === "other"), true);
    await restarted.deleteGuild("g1");
    const left = await restarted.listGuildChat();
    assert.equal(left.some((line) => line.guildId === "g1"), false);
    assert.equal(left.some((line) => line.text === "other"), true);
  } finally {
    await pg.close();
  }
});

test("non-members miss guild chat, history returns on join, and the fifth line is limited", async () => {
  const characters = memoryCharacters();
  await characters.insertGuild({
    id: "g1",
    userId: "user-ada",
    name: "Ash Watch",
    tag: "ASH",
    kind: "Warband",
    crest: "ash",
    rank: "leader",
  });
  await characters.addGuildChat({ guildId: "g1", from: "Ada", text: "old-banner", at: 500 });
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
    tick?: number;
    seq?: number;
    result?: { ok: boolean; reason?: string };
    state?: {
      logs?: string[];
      guild?: { tag?: string; chat?: Array<{ from: string; text: string; at: number }> } | null;
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
    const history = await until(() => {
      const snap = [...adaMsgs].reverse().find((m) => m.t === "snap");
      if (!snap?.state?.guild?.chat?.some((line) => line.text === "old-banner")) return undefined;
      return snap;
    });
    assert.equal(ServerMsg.safeParse(history).success, true);
    assert.equal(history.state?.guild?.tag, "ASH");

    const speak = async (seq: number, msg: string, channel?: "guild") => {
      ada.send(
        JSON.stringify({
          t: "intent",
          seq,
          intent: channel ? { op: "chat", msg, channel } : { op: "chat", msg },
        }),
      );
      return until(() => adaMsgs.find((m) => m.t === "ack" && m.seq === seq));
    };
    const first = await speak(1, "secret-banner", "guild");
    assert.equal(first.result?.ok, true, first.result?.reason);
    const seen = await until(() => {
      const adaSnap = [...adaMsgs].reverse().find((m) => m.state?.guild?.chat?.some((line) => line.text === "secret-banner"));
      if (!adaSnap) return undefined;
      const beaSnap = [...beaMsgs].reverse().find((m) => m.t === "snap" && (m.tick ?? 0) >= (adaSnap.tick ?? 0));
      if (!beaSnap) return undefined;
      return { adaSnap, beaSnap };
    });
    assert.equal(ServerMsg.safeParse(seen.adaSnap).success, true);
    assert.equal(ServerMsg.safeParse(seen.beaSnap).success, true);
    assert.equal(seen.adaSnap.state?.logs?.some((line) => line.includes("secret-banner")), false);
    assert.equal(seen.beaSnap.state?.guild ?? null, null);
    assert.equal(seen.beaSnap.state?.logs?.some((line) => line.includes("secret-banner")), false);

    bea.send(JSON.stringify({ t: "intent", seq: 1, intent: { op: "chat", msg: "nope", channel: "guild" } }));
    const refused = await until(() => beaMsgs.find((m) => m.t === "ack" && m.seq === 1));
    assert.equal(refused.result?.ok, false);
    assert.equal(refused.result?.reason, "You are not in a guild.");

    for (let seq = 2; seq <= CHAT_BURST; seq++) {
      const ack = await speak(seq, `more-${seq}`, "guild");
      assert.equal(ack.result?.ok, true, ack.result?.reason);
    }
    const limited = await speak(CHAT_BURST + 1, "too-fast", "guild");
    assert.equal(limited.result?.ok, false);
    assert.equal(limited.result?.reason, "You are talking too fast.");
    const stored = await characters.listGuildChat();
    assert.equal(stored.some((line) => line.text === "too-fast"), false);
    assert.equal(stored.filter((line) => line.guildId === "g1").length, 1 + CHAT_BURST);
  } finally {
    ada.close();
    bea.close();
    await game.close();
  }
});
