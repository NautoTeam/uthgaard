import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { CharacterRecord } from "../../src/shared/persist/store";
import { characterStore } from "./db";

test("the character migration round-trips a save", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  const sql = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../../migrations/game/0001_characters.sql"),
    "utf8",
  );
  await pg.exec(sql);
  const store = characterStore((text, params) => pg.query(text, params));
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
  await store.save("user-ada", save);
  await store.save("user-ada", { ...save, gold: 37 });
  const loaded = await store.load("user-ada");
  assert.equal(loaded?.gold, 37);
  assert.equal(loaded?.equipment?.weapon, "iron-sword");
  assert.equal(await store.load("missing"), null);
  await pg.close();
});
