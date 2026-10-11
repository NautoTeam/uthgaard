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

export const RACE_MODS: Record<Race, { con: number; intel: number }> = {
  Human: { con: 0, intel: 0 },
  Elf: { con: -4, intel: 12 },
  Minotaur: { con: 16, intel: -8 },
};

export const CLASS_MODS: Record<BaseClass, { con: number; intel: number }> = {
  Fighter: { con: 6, intel: 0 },
  Healer: { con: 0, intel: 6 },
  Mage: { con: 0, intel: 10 },
  Rogue: { con: 2, intel: 0 },
};

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
  leash: number;
  /** Draw scale. Edit this to change how big the mob looks. */
  scale: number;
}

export const MOBS: MobDef[] = [
  { type: "Spider", hp: 40, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, scale: 0.18 },
  { type: "Snake", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, scale: 0.18 },
  { type: "Lizard", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, scale: 0.18 },
  { type: "Orc", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, scale: 0.18 },
  { type: "Bandit", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, scale: 0.18 },
  { type: "Beast", hp: 0, xpBase: 8, xpPerLevel: 5, damage: 2, damagePerLevel: 0.35, attackMs: 1100, aggro: 3.05, leash: 6.2, scale: 0.18 },
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
  scale: 0.18,
};

export function mobByType(type: string): MobDef {
  return MOBS.find((m) => m.type === type) ?? { ...FALLBACK_MOB, type };
}

export function mobHp(type: string, level: number) {
  const def = mobByType(type);
  return def.hp > 0 ? def.hp : 36 + level * 11;
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
    mana: 8,
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
