/** Game content. Camps, mobs, items, and powers are data — add a row, don't add a branch. */

export const RACES = ["Human", "Elf", "Minotaur"] as const;
export type Race = (typeof RACES)[number];

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
};

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

/** QA switch. Set false to hide the character-sheet "set level" control. */
export const DEBUG_SET_LEVEL = true;

export const PRESTIGE_BONUS: Record<Exclude<Prestige, "">, { hp: number; mana: number }> = {
  Warrior: { hp: 45, mana: 0 },
  Priest: { hp: 0, mana: 20 },
  Wizard: { hp: 0, mana: 35 },
  Scout: { hp: 18, mana: 0 },
};

export interface CampDef {
  type: string;
  level: number;
  count: number;
  cx: number;
  cz: number;
}

/** Spider camp starts at 3. Other camps keep their original packs. */
export const CAMPS: CampDef[] = [
  { type: "Spider", level: 2, count: 3, cx: 26, cz: 22 },
  { type: "Snake", level: 4, count: 5, cx: 62, cz: 12 },
  { type: "Lizard", level: 8, count: 4, cx: 96, cz: 22 },
  { type: "Orc", level: 13, count: 4, cx: -42, cz: 52 },
  { type: "Bandit", level: 18, count: 3, cx: 36, cz: -78 },
  { type: "Beast", level: 23, count: 3, cx: -24, cz: 132 },
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

export interface ItemDef {
  id: string;
  name: string;
  dropFrom: string;
  /** 0–1. A new item row is enough for it to drop. */
  chance: number;
}

export const ITEMS: ItemDef[] = [{ id: "spider-silk", name: "Spider Silk", dropFrom: "Spider", chance: 1 }];

export interface PowerDef {
  id: string;
  label: string;
  /** Base classes and prestige names that may use it. Empty = everyone. */
  classes: string[];
  mana: number;
  /**
   * Stamina spent. Melee powers use this.
   * Basic attack spends a little and refills between swings, so a new fighter
   * does not stall. Stab spends more. Spells spend mana and 0 stamina.
   */
  stamina: number;
  range: number;
  damage: number;
  damagePerLevel: number;
  /** Extra damage for these class names. */
  bonus: Record<string, number>;
  heal: number;
  healPerLevel: number;
  kind: "damage" | "heal";
}

export const POWERS: PowerDef[] = [
  {
    id: "attack",
    label: "Attack",
    classes: [],
    mana: 0,
    stamina: 8,
    range: 7.6,
    damage: 7,
    damagePerLevel: 2,
    bonus: { Fighter: 5, Warrior: 5 },
    heal: 0,
    healPerLevel: 0,
    kind: "damage",
  },
  {
    id: "heal",
    label: "Heal",
    classes: ["Healer", "Priest"],
    mana: 10,
    stamina: 0,
    range: 0,
    damage: 0,
    damagePerLevel: 0,
    bonus: {},
    heal: 28,
    healPerLevel: 2,
    kind: "heal",
  },
  {
    id: "fireball",
    label: "Fireball",
    classes: ["Mage", "Wizard"],
    mana: 10,
    stamina: 0,
    range: 9,
    damage: 14,
    damagePerLevel: 3,
    bonus: {},
    heal: 0,
    healPerLevel: 0,
    kind: "damage",
  },
  {
    id: "stab",
    label: "Stab",
    classes: ["Rogue", "Scout"],
    mana: 0,
    stamina: 14,
    range: 3.4,
    damage: 12,
    damagePerLevel: 2,
    bonus: {},
    heal: 0,
    healPerLevel: 0,
    kind: "damage",
  },
];

export function powerById(id: string) {
  return POWERS.find((p) => p.id === id) ?? null;
}
