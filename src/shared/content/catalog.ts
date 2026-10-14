/** Game content. Camps, mobs, items, and powers are data — add a row, don't add a branch. */

import { LIVE_CAMPS, PROPOSED_CAMPS } from "./world";

export const RACES = ["Human", "Elf", "Minotaur"] as const;
export type Race = (typeof RACES)[number] | "Marshwarden";

export const BASE_CLASSES = ["Fighter", "Healer", "Mage", "Rogue"] as const;
export type BaseClass = (typeof BASE_CLASSES)[number];

export type Prestige = "" | "Warrior" | "Priest" | "Wizard" | "Scout";

export const PRESTIGE_OF: Record<BaseClass, Exclude<Prestige, "">> = {
  Fighter: "Warrior",
  Healer: "Priest",
  Mage: "Wizard",
  Rogue: "Scout",
};

/**
 * Starting attributes. A character's five stats are
 * BASE_ATTRS + RACE_ATTRS[race] + CLASS_ATTRS[class].
 *
 * |          | STR | DEX | CON | INT | SPI |
 * | Human    | +2  | +2  |  0  |  0  | +2  |
 * | Elf      | −4  | +6  | −4  | +12 | +4  |
 * | Minotaur | +8  | −4  | +16 | −8  | −2  |
 * | Fighter  | +6  | +2  | +6  |  0  |  0  |
 * | Healer   |  0  |  0  |  0  | +6  | +8  |
 * | Mage     | −2  |  0  |  0  | +10 | +6  |
 * | Rogue    | +2  | +6  | +2  |  0  |  0  |
 *
 * Human Fighter is STR 28, Elf Fighter is STR 22, Minotaur Fighter is STR 34.
 * CON sets max HP (70 + CON×2 + level×9). INT sets max mana.
 * DEX sets max stamina. STR adds 1 melee damage per 10 points above 20.
 * SPI adds a little mana regen. Edit these rows to change a race or class.
 */
export interface AttrBlock {
  str: number;
  dex: number;
  con: number;
  int: number;
  spi: number;
}

export const BASE_ATTRS: AttrBlock = { str: 20, dex: 20, con: 30, int: 30, spi: 16 };

export const RACE_ATTRS: Record<Race, AttrBlock> = {
  Human: { str: 2, dex: 2, con: 0, int: 0, spi: 2 },
  Elf: { str: -4, dex: 6, con: -4, int: 12, spi: 4 },
  Minotaur: { str: 8, dex: -4, con: 16, int: -8, spi: -2 },
  /** Home city is Fenhollow, on the create screen with the other havens. */
  Marshwarden: { str: 2, dex: 4, con: 6, int: -4, spi: 2 },
};

/** Off until the race and its city are approved for the create screen. */
export const MARSHWARDEN_ENABLED = true;

export const FENHOLLOW = {
  id: "fenhollow",
  name: "Fenhollow",
  enabled: true,
  race: "Marshwarden" as const,
  stone: "#5f6b48",
  stoneAlt: "#54603e",
};

/** Races offered on the create screen. */
export const CREATABLE_RACES: readonly Race[] = MARSHWARDEN_ENABLED ? [...RACES, "Marshwarden"] : RACES;

export function classDenied(race: Race, cls: BaseClass): string {
  if (classAllowed(race, cls)) return "";
  if (race === "Minotaur") return "Minotaurs cannot take Mage or Rogue.";
  if (race === "Marshwarden") return "Marshwardens cannot take Mage.";
  return "That path is closed.";
}

export const CLASS_ATTRS: Record<BaseClass, AttrBlock> = {
  Fighter: { str: 6, dex: 2, con: 6, int: 0, spi: 0 },
  Healer: { str: 0, dex: 0, con: 0, int: 6, spi: 8 },
  Mage: { str: -2, dex: 0, con: 0, int: 10, spi: 6 },
  Rogue: { str: 2, dex: 6, con: 2, int: 0, spi: 0 },
};

/** Classes a race may not pick at creation. */
export const RACE_BLOCKS: Record<Race, BaseClass[]> = {
  Human: [],
  Elf: [],
  Minotaur: ["Mage", "Rogue"],
  Marshwarden: ["Mage"],
};

export function classAllowed(race: Race, cls: BaseClass) {
  return !RACE_BLOCKS[race].includes(cls);
}

export function attrsFor(race: Race, cls: BaseClass): AttrBlock {
  const r = RACE_ATTRS[race];
  const c = CLASS_ATTRS[cls];
  return {
    str: BASE_ATTRS.str + r.str + c.str,
    dex: BASE_ATTRS.dex + r.dex + c.dex,
    con: BASE_ATTRS.con + r.con + c.con,
    int: BASE_ATTRS.int + r.int + c.int,
    spi: BASE_ATTRS.spi + r.spi + c.spi,
  };
}

/**
 * Death shroud lasts this long after respawn.
 * Any power with mana > 0 is a spell and cannot be cast while shrouded.
 * Stamina powers (Attack, Shield Block, Cleave, Bulwark Stance, Stealth, Backstab, Stab) still work.
 * Another healer's Rekindle clears Grave Chill early.
 */
export const DEATH_SHROUD_MS = 60_000;

/** QA switch. Set false to hide the character-sheet "set level" control. */
export const DEBUG_SET_LEVEL = true;

export const PRESTIGE_BONUS: Record<Exclude<Prestige, "">, { hp: number; mana: number }> = {
  Warrior: { hp: 45, mana: 0 },
  Priest: { hp: 0, mana: 20 },
  Wizard: { hp: 0, mana: 35 },
  Scout: { hp: 18, mana: 0 },
};

/** Level-scaled HP, mana, and stamina. The HUD and set-level both read this. */
export function poolsFor(p: { race: Race; baseClass: BaseClass; level: number; prestigeClass?: string }) {
  const a = attrsFor(p.race, p.baseClass);
  let maxHp = Math.floor(70 + a.con * 2 + p.level * 9);
  let maxMana = Math.floor(24 + a.int * 2 + p.level * 4);
  let maxStamina = Math.floor(50 + a.dex * 2 + p.level * 2);
  const bonus = p.prestigeClass ? PRESTIGE_BONUS[p.prestigeClass as Exclude<Prestige, "">] : undefined;
  if (bonus) {
    maxHp += bonus.hp;
    maxMana += bonus.mana;
  }
  return { maxHp, maxMana, maxStamina };
}

export interface CampDef {
  type: string;
  level: number;
  count: number;
  cx: number;
  cz: number;
}

/** Live Reach camps plus phase-1 proposals. Later phases stay out of PROPOSED_CAMPS. */
export const CAMPS: CampDef[] = [
  ...LIVE_CAMPS,
  ...PROPOSED_CAMPS.map(({ type, level, count, cx, cz }) => ({ type, level, count, cx, cz })),
];

export interface MobDef {
  type: string;
  /** 0 = use the scaled formula 36 + level * 11. */
  hp: number;
  xpBase: number;
  xpPerLevel: number;
  damage: number;
  damagePerLevel: number;
  attackMs: number;
  aggro: number;
  /** Give up the chase when the player is this far from the mob. */
  leash: number;
  /** Give up and walk home when this far from the camp center. */
  campLeash: number;
  /** Draw scale. Edit this to change how big the mob looks. */
  scale: number;
}

export const MOBS: MobDef[] = [
  { type: "Spider", hp: 40, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.18 },
  { type: "Snake", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.18 },
  { type: "Lizard", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.18 },
  { type: "Orc", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.18 },
  { type: "Bandit", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.18 },
  { type: "Beast", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.18 },
  { type: "Boar", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.18 },
  { type: "Thornling", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.18 },
  { type: "BogHound", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.18 },
  { type: "CragHarpy", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.18 },
  { type: "ThunderElk", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.2 },
  { type: "FenCrawler", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.18 },
  { type: "MireWitch", hp: 0, xpBase: 14, xpPerLevel: 6, damage: 3, damagePerLevel: 0.45, attackMs: 1400, aggro: 3.05, leash: 6.2, campLeash: 15, scale: 0.24 },
];

const FALLBACK_MOB: MobDef = {
  type: "Creature",
  hp: 36,
  xpBase: 8,
  xpPerLevel: 5,
  damage: 2,
  damagePerLevel: 0.35,
  attackMs: 1100,
  aggro: 3.05,
  leash: 6.2,
  campLeash: 15,
  scale: 0.18,
};

export function mobByType(type: string): MobDef {
  return MOBS.find((m) => m.type === type) ?? { ...FALLBACK_MOB, type };
}

export function mobHp(type: string, level: number) {
  const def = mobByType(type);
  return def.hp > 0 ? def.hp : 36 + level * 11;
}

/**
 * Con bands by (mob level − player level). Rows are sorted by maxDelta.
 * The first row whose maxDelta is still ≥ the delta wins.
 *
 * | color  | delta | example (you are Lv10) | XP    | aggro |
 * | grey   | ≤ −7  | mob Lv3 and below       | 0     | no    |
 * | green  | −6..−5| mob Lv4–5               | 20%   | no    |
 * | cyan   | −4..−2| mob Lv6–8               | 60%   | yes   |
 * | blue   | −1..0 | mob Lv9–10              | 100%  | yes   |
 * | yellow | +1..+2| mob Lv11–12             | 100%  | yes   |
 * | orange | +3..+4| mob Lv13–14             | 100%  | yes   |
 * | red    | ≥ +5  | mob Lv15+               | 100%  | yes   |
 *
 * A Lv1 vs a Lv2 spider is delta +1 (yellow), so the camp still pays full XP.
 * Green and grey are 5+ levels below the player and do not aggro.
 * Edit this table to change name-plate colors and kill XP. Combat code only reads it.
 */
export interface ConBand {
  id: "grey" | "green" | "cyan" | "blue" | "yellow" | "orange" | "red";
  maxDelta: number;
  color: string;
  xp: number;
  aggro: boolean;
}

export const CON_BANDS: ConBand[] = [
  { id: "grey", maxDelta: -7, color: "#9aa0a6", xp: 0, aggro: false },
  { id: "green", maxDelta: -5, color: "#3ddc6a", xp: 0.2, aggro: false },
  { id: "cyan", maxDelta: -2, color: "#3ecbff", xp: 0.6, aggro: true },
  { id: "blue", maxDelta: 0, color: "#4c7dff", xp: 1, aggro: true },
  { id: "yellow", maxDelta: 2, color: "#ffe14a", xp: 1, aggro: true },
  { id: "orange", maxDelta: 4, color: "#ff9a2e", xp: 1, aggro: true },
  { id: "red", maxDelta: 99, color: "#ff3b30", xp: 1, aggro: true },
];

export function conFor(mobLevel: number, playerLevel: number): ConBand {
  const delta = mobLevel - playerLevel;
  for (const band of CON_BANDS) {
    if (delta <= band.maxDelta) return band;
  }
  return CON_BANDS[CON_BANDS.length - 1];
}

export function conXp(mobLevel: number, playerLevel: number, base: number) {
  return Math.max(0, Math.floor(base * conFor(mobLevel, playerLevel).xp));
}

export type EquipSlot = "weapon" | "offhand" | "head" | "chest" | "legs" | "hands" | "feet" | "ring" | "neck";

/** Paper-doll rows. Rings use the item slot "ring" and fill ring, then ring2. */
export const EQUIP_SLOTS: Array<{ id: string; label: string }> = [
  { id: "weapon", label: "Weapon" },
  { id: "offhand", label: "Offhand" },
  { id: "head", label: "Head" },
  { id: "chest", label: "Chest" },
  { id: "legs", label: "Legs" },
  { id: "hands", label: "Hands" },
  { id: "feet", label: "Feet" },
  { id: "ring", label: "Ring" },
  { id: "ring2", label: "Ring" },
  { id: "neck", label: "Necklace" },
];

/** Classes that cannot wear weight "heavy". Edit this list, not the equip function. */
export const HEAVY_ARMOR_DENY = ["Mage", "Wizard"];

export interface ItemDef {
  id: string;
  name: string;
  kind: "junk" | "consumable" | "equipment";
  /** Gold the hamlet vendor pays. */
  sell: number;
  /** HP restored when used. 0 if it is not a consumable. */
  heal: number;
  /** Empty if the item cannot be equipped. */
  slot: "" | EquipSlot;
  damage: number;
  defense: number;
  weight: "" | "light" | "heavy";
}

export const ITEMS: ItemDef[] = [
  { id: "spider-silk", name: "Spider Silk", kind: "junk", sell: 5, heal: 0, slot: "", damage: 0, defense: 0, weight: "" },
  { id: "minor-potion", name: "Minor Potion", kind: "consumable", sell: 4, heal: 25, slot: "", damage: 0, defense: 0, weight: "" },
  { id: "iron-sword", name: "Iron Sword", kind: "equipment", sell: 6, heal: 0, slot: "weapon", damage: 6, defense: 0, weight: "" },
  { id: "iron-hauberk", name: "Iron Hauberk", kind: "equipment", sell: 8, heal: 0, slot: "chest", damage: 0, defense: 8, weight: "heavy" },
];

export interface DropDef {
  mob: string;
  itemId: string;
  /** 0–1. Occasional unless TEST_GENEROUS_DROPS raises it. */
  chance: number;
}

export const DROPS: DropDef[] = [{ mob: "Spider", itemId: "spider-silk", chance: 0.45 }];

/**
 * QA switch. While true, each drop row is at least an 85% chance
 * so a short spider session puts silk in the bag. Set false to use DROPS.chance.
 */
export const TEST_GENEROUS_DROPS = true;

export function dropChance(row: DropDef) {
  return TEST_GENEROUS_DROPS ? Math.max(row.chance, 0.85) : row.chance;
}

/** What Marta sells. Price is the gold the player pays. */
export const VENDOR_STOCK: Array<{ itemId: string; price: number }> = [
  { itemId: "minor-potion", price: 12 },
  { itemId: "iron-sword", price: 16 },
  { itemId: "iron-hauberk", price: 22 },
];

export function itemById(id: string) {
  return ITEMS.find((item) => item.id === id) ?? null;
}

export function gearTotals(equipment?: Record<string, string>) {
  let damage = 0;
  let defense = 0;
  for (const id of Object.values(equipment ?? {})) {
    const item = itemById(id);
    if (!item) continue;
    damage += item.damage;
    defense += item.defense;
  }
  return { damage, defense };
}

/** Empty string if the character may equip it. */
export function equipDenied(baseClass: string, prestigeClass: string, item: ItemDef) {
  if (item.weight !== "heavy") return "";
  if (HEAVY_ARMOR_DENY.includes(baseClass) || (prestigeClass && HEAVY_ARMOR_DENY.includes(prestigeClass))) {
    return "Mages cannot wear heavy armor.";
  }
  return "";
}

export interface PowerDef {
  id: string;
  label: string;
  /** Base classes and prestige names that may use it. Empty = everyone. */
  classes: string[];
  /** Usable at this level. Hotbar fills the slot once the character reaches it. */
  level: number;
  /** Default hotbar slot, 1–8. 0 means not pre-slotted. */
  slot: number;
  mana: number;
  /** Stamina spent. Melee powers use this. Spells spend mana and 0 stamina. */
  stamina: number;
  /** 0 is self-cast. */
  range: number;
  cooldown: number;
  damage: number;
  damagePerLevel: number;
  bonus: Record<string, number>;
  heal: number;
  healPerLevel: number;
  kind: "damage" | "heal" | "buff" | "snare" | "stealth";
}

export const POWERS: PowerDef[] = [
  { id: "attack", label: "Attack", classes: [], level: 1, slot: 1, mana: 0, stamina: 8, range: 7.6, cooldown: 780, damage: 7, damagePerLevel: 2, bonus: { Fighter: 5, Warrior: 5 }, heal: 0, healPerLevel: 0, kind: "damage" },
  { id: "shield", label: "Shield Block", classes: ["Fighter", "Warrior"], level: 1, slot: 2, mana: 0, stamina: 12, range: 0, cooldown: 8000, damage: 0, damagePerLevel: 0, bonus: {}, heal: 0, healPerLevel: 0, kind: "buff" },
  { id: "cleave", label: "Cleave", classes: ["Fighter", "Warrior"], level: 4, slot: 3, mana: 0, stamina: 16, range: 3.6, cooldown: 4000, damage: 10, damagePerLevel: 2, bonus: {}, heal: 0, healPerLevel: 0, kind: "damage" },
  { id: "wall", label: "Bulwark Stance", classes: ["Fighter", "Warrior"], level: 8, slot: 4, mana: 0, stamina: 22, range: 0, cooldown: 18000, damage: 0, damagePerLevel: 0, bonus: {}, heal: 0, healPerLevel: 0, kind: "buff" },
  { id: "heal", label: "Mending", classes: ["Healer", "Priest"], level: 1, slot: 2, mana: 10, stamina: 0, range: 0, cooldown: 2500, damage: 0, damagePerLevel: 0, bonus: {}, heal: 28, healPerLevel: 2, kind: "heal" },
  { id: "succor", label: "Rekindle", classes: ["Healer", "Priest"], level: 4, slot: 3, mana: 18, stamina: 0, range: 8, cooldown: 6000, damage: 0, damagePerLevel: 0, bonus: {}, heal: 48, healPerLevel: 4, kind: "heal" },
  { id: "ward", label: "Ward", classes: ["Healer", "Priest"], level: 8, slot: 4, mana: 16, stamina: 0, range: 0, cooldown: 12000, damage: 0, damagePerLevel: 0, bonus: {}, heal: 12, healPerLevel: 1, kind: "buff" },
  { id: "fireball", label: "Fireball", classes: ["Mage", "Wizard"], level: 1, slot: 1, mana: 10, stamina: 0, range: 9, cooldown: 1200, damage: 14, damagePerLevel: 3, bonus: {}, heal: 0, healPerLevel: 0, kind: "damage" },
  { id: "frostbind", label: "Frostbind", classes: ["Mage", "Wizard"], level: 1, slot: 2, mana: 12, stamina: 0, range: 8, cooldown: 6000, damage: 6, damagePerLevel: 1, bonus: {}, heal: 0, healPerLevel: 0, kind: "snare" },
  { id: "bolt", label: "Arcane Bolt", classes: ["Mage", "Wizard"], level: 4, slot: 3, mana: 8, stamina: 0, range: 9, cooldown: 800, damage: 9, damagePerLevel: 2, bonus: {}, heal: 0, healPerLevel: 0, kind: "damage" },
  { id: "nova", label: "Nova", classes: ["Mage", "Wizard"], level: 8, slot: 4, mana: 22, stamina: 0, range: 7, cooldown: 8000, damage: 22, damagePerLevel: 3, bonus: {}, heal: 0, healPerLevel: 0, kind: "damage" },
  { id: "stealth", label: "Stealth", classes: ["Rogue", "Scout"], level: 1, slot: 2, mana: 0, stamina: 10, range: 0, cooldown: 12000, damage: 0, damagePerLevel: 0, bonus: {}, heal: 0, healPerLevel: 0, kind: "stealth" },
  { id: "backstab", label: "Backstab", classes: ["Rogue", "Scout"], level: 4, slot: 3, mana: 0, stamina: 16, range: 3.2, cooldown: 5000, damage: 18, damagePerLevel: 3, bonus: {}, heal: 0, healPerLevel: 0, kind: "damage" },
  { id: "stab", label: "Stab", classes: ["Rogue", "Scout"], level: 1, slot: 4, mana: 0, stamina: 14, range: 3.4, cooldown: 2000, damage: 12, damagePerLevel: 2, bonus: {}, heal: 0, healPerLevel: 0, kind: "damage" },
  { id: "rally", label: "Rallying Blow", classes: ["Warrior"], level: 10, slot: 5, mana: 0, stamina: 18, range: 3.6, cooldown: 5000, damage: 16, damagePerLevel: 3, bonus: {}, heal: 0, healPerLevel: 0, kind: "damage" },
  { id: "ironveil", label: "Iron Veil", classes: ["Warrior"], level: 10, slot: 6, mana: 0, stamina: 16, range: 0, cooldown: 14000, damage: 0, damagePerLevel: 0, bonus: {}, heal: 0, healPerLevel: 0, kind: "buff" },
  { id: "hymn", label: "Hymn of Ease", classes: ["Priest"], level: 10, slot: 5, mana: 16, stamina: 0, range: 0, cooldown: 4000, damage: 0, damagePerLevel: 0, bonus: {}, heal: 40, healPerLevel: 3, kind: "heal" },
  { id: "aegis", label: "Soft Aegis", classes: ["Priest"], level: 10, slot: 6, mana: 18, stamina: 0, range: 0, cooldown: 14000, damage: 0, damagePerLevel: 0, bonus: {}, heal: 10, healPerLevel: 1, kind: "buff" },
  { id: "cinder", label: "Cinder Lance", classes: ["Wizard"], level: 10, slot: 5, mana: 16, stamina: 0, range: 9, cooldown: 2500, damage: 20, damagePerLevel: 3, bonus: {}, heal: 0, healPerLevel: 0, kind: "damage" },
  { id: "glass", label: "Glass Snare", classes: ["Wizard"], level: 10, slot: 6, mana: 14, stamina: 0, range: 8, cooldown: 7000, damage: 8, damagePerLevel: 2, bonus: {}, heal: 0, healPerLevel: 0, kind: "snare" },
  { id: "venom", label: "Venom Nick", classes: ["Scout"], level: 10, slot: 5, mana: 0, stamina: 14, range: 3.2, cooldown: 3000, damage: 14, damagePerLevel: 2, bonus: {}, heal: 0, healPerLevel: 0, kind: "damage" },
  { id: "fade", label: "Fade Step", classes: ["Scout"], level: 10, slot: 6, mana: 0, stamina: 12, range: 0, cooldown: 14000, damage: 0, damagePerLevel: 0, bonus: {}, heal: 0, healPerLevel: 0, kind: "stealth" },
];

export function powerById(id: string) {
  return POWERS.find((p) => p.id === id) ?? null;
}

/** Class powers overwrite the shared Attack slot. Empty slots stay empty until that level. */
export function defaultHotbar(baseClass: string, prestige: string, level: number) {
  const slots = ["", "", "", "", "", "", "", ""];
  const usable = (power: PowerDef) => {
    if (power.level > level || power.slot < 1 || power.slot > 8) return false;
    if (!power.classes.length) return true;
    return power.classes.includes(baseClass) || (!!prestige && power.classes.includes(prestige));
  };
  for (const power of POWERS) if (usable(power) && !power.classes.length) slots[power.slot - 1] = power.id;
  for (const power of POWERS) if (usable(power) && power.classes.length) slots[power.slot - 1] = power.id;
  return slots;
}

/** Sheet damage: basic attack plus weapon. Unequip drops the weapon term. */
export function meleeDamage(p: { level: number; baseClass: string; prestigeClass: string; str: number; equipment?: Record<string, string> }) {
  const power = powerById("attack");
  if (!power) return 0;
  const bonus = power.bonus[p.baseClass] ?? power.bonus[p.prestigeClass] ?? 0;
  const strBonus = Math.max(0, Math.floor((p.str - 20) / 10));
  return power.damage + p.level * power.damagePerLevel + bonus + strBonus + gearTotals(p.equipment).damage;
}

/**
 * Training. A level-up grants TRAIN_POINTS[race] points (Human 5, everyone else 4).
 * One point plus `gold` buys one rank. A rank adds `perRank` percent.
 * Sword adds that percent of melee damage, and at least +1 once trained.
 * Focus adds that percent to hit chance. Base hit chance is 90, capped at 99.
 * Edit SKILLS or TRAIN_POINTS to change the costs and the effect. Combat only reads them.
 */
export const TRAIN_POINTS: Record<string, number> = { Human: 5, Elf: 4, Minotaur: 4, Marshwarden: 4 };

export function trainPointsFor(race: string) {
  return TRAIN_POINTS[race] ?? 4;
}

export interface SkillDef {
  id: string;
  name: string;
  /** What the percent improves. */
  affects: "damage" | "hit";
  /** Percent gained per training point. */
  perRank: number;
  gold: number;
  max: number;
}

export const SKILLS: SkillDef[] = [
  { id: "sword", name: "Sword", affects: "damage", perRank: 5, gold: 5, max: 100 },
  { id: "focus", name: "Focus", affects: "hit", perRank: 5, gold: 5, max: 100 },
];

export function skillById(id: string) {
  return SKILLS.find((s) => s.id === id) ?? null;
}

export function hitChance(p: { skills?: Record<string, number> }) {
  return Math.min(99, 90 + (p.skills?.focus ?? 0));
}

export function trainedDamage(p: { level: number; baseClass: string; prestigeClass: string; str: number; equipment?: Record<string, string>; skills?: Record<string, number> }) {
  const base = meleeDamage(p);
  const sword = p.skills?.sword ?? 0;
  if (sword <= 0) return base;
  return base + Math.max(1, Math.round((base * sword) / 100));
}
