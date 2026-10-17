import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PublicStateSchema } from "../../src/shared/net/protocol";
import {
  CAST_RELEASE_MS,
  MARSH_FX_SCALE,
  POISON_LINGER_MS,
  groundFxScale,
  parseSpellSheet,
  spellFrame,
  spellVisual,
  visualFor,
} from "../../src/shared/sim/spellfx";
import { createWorld } from "../../src/shared/sim/world";

const SHEETS = ["heal", "holy-smite", "frost-bolt", "frost-impact", "lightning", "poison-cloud", "shield"] as const;

test("spell sheets publish fps, loop, anchor, and additive blend", () => {
  const heal = parseSpellSheet(JSON.parse(readFileSync("public/sprites/fx/heal/sheet.json", "utf8")));
  assert.ok(heal);
  assert.equal(heal.fps, 12);
  assert.equal(heal.loop, true);
  assert.equal(heal.anchorX, 128);
  assert.equal(heal.anchorY, 200);
  assert.equal(heal.ground, true);
  assert.equal(heal.additive, true);
  assert.equal(heal.frames.length, 12);

  const bolt = parseSpellSheet(JSON.parse(readFileSync("public/sprites/fx/frost-bolt/sheet.json", "utf8")));
  assert.ok(bolt);
  assert.equal(bolt.fps, 5);
  assert.equal(bolt.loop, true);
  assert.equal(bolt.anchorX, 128);
  assert.equal(bolt.anchorY, 128);
  assert.equal(bolt.ground, false);
  assert.equal(bolt.rotate, true);
  assert.equal(bolt.frames.length, 4);

  const impact = parseSpellSheet(JSON.parse(readFileSync("public/sprites/fx/frost-impact/sheet.json", "utf8")));
  assert.ok(impact);
  assert.equal(impact.loop, false);
  assert.equal(impact.anchorX, 128);
  assert.equal(impact.anchorY, 128);

  const lightning = parseSpellSheet(JSON.parse(readFileSync("public/sprites/fx/lightning/sheet.json", "utf8")));
  assert.ok(lightning);
  assert.equal(lightning.fps, 15);
  assert.equal(lightning.loop, false);
  assert.equal(lightning.anchorY, 205);

  const poison = parseSpellSheet(JSON.parse(readFileSync("public/sprites/fx/poison-cloud/sheet.json", "utf8")));
  assert.ok(poison);
  assert.equal(poison.fps, 10);
  assert.equal(poison.loop, true);
  assert.equal(poison.anchorY, 195);
  assert.equal(poison.frames.length, 16);

  const shield = parseSpellSheet(JSON.parse(readFileSync("public/sprites/fx/shield/sheet.json", "utf8")));
  assert.ok(shield);
  assert.equal(shield.loop, true);
  assert.equal(shield.anchorX, 128);
  assert.equal(shield.anchorY, 205);

  const smite = parseSpellSheet(JSON.parse(readFileSync("public/sprites/fx/holy-smite/sheet.json", "utf8")));
  assert.ok(smite);
  assert.equal(smite.loop, false);
  assert.equal(smite.anchorY, 200);

  for (const name of SHEETS) {
    const sheet = parseSpellSheet(JSON.parse(readFileSync(`public/sprites/fx/${name}/sheet.json`, "utf8")));
    assert.ok(sheet, name);
    assert.equal(sheet.additive, true, name);
  }
});

test("spell frame clock honors loop and one-shot", () => {
  assert.equal(spellFrame(12, 12, true, 0), 0);
  assert.equal(spellFrame(12, 12, true, 1000), 0);
  assert.equal(spellFrame(12, 12, false, 0), 0);
  assert.equal(spellFrame(12, 12, false, 999), 11);
  assert.equal(spellFrame(12, 12, false, 1000), null);
  assert.equal(spellFrame(4, 5, true, 200), 1);
});

test("ground effects grow on a Marshwarden", () => {
  assert.equal(groundFxScale("Marshwarden"), MARSH_FX_SCALE);
  assert.equal(groundFxScale("marshwarden"), MARSH_FX_SCALE);
  assert.equal(groundFxScale("Human"), 1);
  assert.equal(groundFxScale(""), 1);
});

test("healer, mage, and rogue powers pick the painted effect", () => {
  assert.equal(spellVisual("heal"), "heal");
  assert.equal(spellVisual("succor"), "heal");
  assert.equal(spellVisual("hymn"), "heal");
  assert.equal(spellVisual("ward"), "shield");
  assert.equal(spellVisual("aegis"), "shield");
  assert.equal(spellVisual("frostbind"), "frost");
  assert.equal(spellVisual("glass"), "frost");
  assert.equal(spellVisual("bolt"), "lightning");
  assert.equal(spellVisual("venom"), "poison");
  assert.equal(spellVisual("fireball"), null);
  assert.equal(spellVisual("nova"), null);
  assert.equal(spellVisual("attack"), null);
  assert.equal(spellVisual("shield"), null);
  assert.equal(spellVisual("stealth"), null);
  assert.equal(visualFor({ id: "smite", kind: "damage", classes: ["Healer"] }), "holy-smite");
  assert.equal(visualFor({ id: "smite", kind: "damage", classes: ["Priest"] }), "holy-smite");
  assert.equal(visualFor({ id: "smite", kind: "damage", classes: ["Fighter"] }), null);
});

test("a successful cast is broadcast and a miss or a full heal is not", () => {
  const clock = { t: 20_000 };
  const world = createWorld({ now: () => clock.t, rand: () => 0 });
  assert.equal(Object.hasOwn(world.snapshot(), "fx"), false);
  const ada = world.join({ id: "ada", username: "Ada", race: "Marshwarden", baseClass: "Healer" });
  world.setLevel("ada", 8);
  ada.hp = ada.maxHp;
  assert.equal(world.skill("ada", "heal", null).ok, false);
  assert.equal(world.snapshot().fx, undefined);
  ada.hp = 10;
  ada.mana = ada.maxMana;
  assert.equal(world.skill("ada", "heal", null).ok, true);
  const heal = world.snapshot().fx ?? [];
  assert.equal(heal.length, 1);
  assert.equal(heal[0].kind, "heal");
  assert.equal(heal[0].casterId, "ada");
  assert.equal(heal[0].targetId, "ada");
  assert.equal(heal[0].race, "Marshwarden");
  assert.equal(heal[0].cast, true);
  assert.equal(heal[0].linger, 0);
  assert.equal(heal[0].x1, ada.x);
  assert.equal(heal[0].z1, ada.z);

  ada.mana = ada.maxMana;
  assert.equal(world.skill("ada", "ward", null).ok, true);
  const ward = world.snapshot().fx?.find((row) => row.kind === "shield");
  assert.ok(ward);
  assert.equal(ward.linger, 8000 - CAST_RELEASE_MS);
  assert.equal(ward.race, "Marshwarden");

  const mag = world.join({ id: "mag", username: "Mag", race: "Human", baseClass: "Mage", level: 4 });
  assert.equal(world.spawnTest("mag").ok, true);
  const foe = world.snapshot().monsters.find((mob) => mob.id.startsWith("t"));
  assert.ok(foe);
  mag.x = foe.x + 0.4;
  mag.z = foe.z;
  mag.mana = mag.maxMana;
  assert.equal(world.skill("mag", "frostbind", foe.id).ok, true);
  const frost = world.snapshot().fx?.find((row) => row.kind === "frost");
  assert.ok(frost);
  assert.equal(frost.casterId, "mag");
  assert.equal(frost.targetId, foe.id);
  assert.equal(frost.x, mag.x);
  assert.equal(frost.z, mag.z);
  assert.equal(frost.x1, foe.x);
  assert.equal(frost.z1, foe.z);
  assert.equal(frost.cast, true);

  mag.mana = mag.maxMana;
  mag.cooldowns.bolt = 0;
  assert.equal(world.skill("mag", "bolt", foe.id).ok, true);
  assert.equal(world.snapshot().fx?.some((row) => row.kind === "lightning" && row.targetId === foe.id), true);

  const nick = world.join({
    id: "nick",
    username: "Nick",
    race: "Human",
    baseClass: "Rogue",
    level: 10,
    x: foe.x,
    z: foe.z,
  });
  nick.prestigeClass = "Scout";
  nick.x = foe.x;
  nick.z = foe.z;
  assert.equal(world.skill("nick", "venom", foe.id).ok, true);
  const cloud = world.snapshot().fx?.find((row) => row.kind === "poison");
  assert.ok(cloud);
  assert.equal(cloud.linger, POISON_LINGER_MS);
  assert.equal(cloud.cast, false);
  assert.equal(cloud.x1, foe.x);
  assert.equal(cloud.z1, foe.z);

  const before = world.snapshot().fx?.length ?? 0;
  nick.stamina = nick.maxStamina;
  nick.cooldowns.attack = 0;
  nick.nextSwing = 0;
  world.attack("nick", foe.id);
  assert.equal(world.snapshot().fx?.length, before);

  const parsed = PublicStateSchema.safeParse(world.snapshot());
  assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);

  clock.t += 30_000;
  assert.equal(world.snapshot().fx, undefined);
});
