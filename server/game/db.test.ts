import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { CharacterRecord } from "../../src/shared/persist/store";
import type { GraveState } from "../../src/shared/sim/types";
import { applyGameMigrations, characterStore } from "./db";

const save: CharacterRecord = {
  version: 1,
  username: "Ada",
  race: "Human",
  baseClass: "Fighter",
  prestigeClass: "",
  level: 2,
  xp: 15,
  gold: 40,
  x: 1.5,
  z: -2,
  equipment: { weapon: "iron-sword" },
};

async function openDb() {
  const pg = new PGlite();
  await pg.waitReady;
  const query = async (text: string, params?: unknown[]) => {
    const result = await pg.query(text, params);
    return { rows: result.rows as Array<Record<string, unknown>> };
  };
  return { pg, query };
}

test("the character migration round-trips a save", async () => {
  const { pg, query } = await openDb();
  await applyGameMigrations(query);
  const store = characterStore(query);
  assert.equal(await store.create("user-ada", "Ada", save), 1);
  assert.equal(await store.save("user-ada", { ...save, gold: 37 }, 1), 2);
  const loaded = await store.load("user-ada");
  assert.equal(loaded?.rev, 2);
  assert.equal(loaded?.save.gold, 37);
  assert.equal(loaded?.save.equipment?.weapon, "iron-sword");
  assert.equal(await store.load("missing"), null);
  await pg.close();
});

test("a stale rev does not overwrite the row", async () => {
  const { pg, query } = await openDb();
  await applyGameMigrations(query);
  const store = characterStore(query);
  assert.equal(await store.create("user-ada", "Ada", save), 1);
  assert.equal(await store.save("user-ada", { ...save, gold: 37 }, 1), 2);
  assert.equal(await store.save("user-ada", { ...save, gold: 1 }, 1), null);
  const loaded = await store.load("user-ada");
  assert.equal(loaded?.rev, 2);
  assert.equal(loaded?.save.gold, 37);
  await pg.close();
});

test("character names are unique ignoring case", async () => {
  const { pg, query } = await openDb();
  await applyGameMigrations(query);
  const store = characterStore(query);
  assert.equal(await store.create("user-ada", "Ada", save), 1);
  assert.equal(await store.create("user-bea", "ada", { ...save, username: "ada" }), "name_taken");
  assert.equal(await store.load("user-bea"), null);
  await pg.close();
});

test("graves round-trip through the table", async () => {
  const { pg, query } = await openDb();
  await applyGameMigrations(query);
  const store = characterStore(query);
  const grave: GraveState = { id: "g1", owner: "Ada", x: 3, z: 4, gold: 6, items: { potion: 1 }, born: 5 };
  await store.putGrave(grave);
  assert.deepEqual(await store.listGraves(), [grave]);
  await store.deleteGrave("g1");
  assert.deepEqual(await store.listGraves(), []);
  await pg.close();
});

test("migrations run twice and apply 0001 and 0002 once each", async () => {
  const { pg, query } = await openDb();
  await applyGameMigrations(query);
  await applyGameMigrations(query);
  const rows = await pg.query<{ name: string }>("select name from _game_migrations order by name");
  assert.deepEqual(
    rows.rows.map((row) => row.name),
    ["0001_characters.sql", "0002_name_rev.sql"],
  );
  await pg.close();
});
