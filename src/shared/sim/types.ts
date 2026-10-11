import type { BaseClass, Prestige, Race } from "../content/catalog";

export type { BaseClass, CampDef, Prestige, Race } from "../content/catalog";
export { BASE_CLASSES, CAMPS, PRESTIGE_OF, RACES, attrsFor, classAllowed, DEBUG_SET_LEVEL } from "../content/catalog";

export type MonsterType = string;
export type SkillName = "attack" | "heal" | "fireball" | "stab";

export interface PlayerInit {
  id: string;
  username: string;
  race: Race;
  baseClass: BaseClass;
  prestigeClass: Prestige;
  level: number;
  xp: number;
  gold: number;
}

export interface PlayerState extends PlayerInit {
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  stamina: number;
  maxStamina: number;
  str: number;
  dex: number;
  con: number;
  int: number;
  spi: number;
  x: number;
  z: number;
  rotation: number;
  nextSwing: number;
  inventory: Record<string, number>;
  equipment: Record<string, string>;
}

export interface MonsterState {
  id: string;
  type: MonsterType;
  level: number;
  hp: number;
  maxHp: number;
  x: number;
  z: number;
  homeX: number;
  homeZ: number;
  /** Idle tile. Mobs return here instead of the camp center so a pack does not stack. */
  slotX: number;
  slotZ: number;
  targetId: string | null;
  respawnAt: number;
  nextHit: number;
}

export interface PublicState {
  players: PlayerState[];
  monsters: MonsterState[];
  logs: string[];
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
  dmg?: number;
}

export function xpNeed(level: number) {
  return level * 70;
}

export function clampCoord(v: number) {
  return Math.max(-168, Math.min(168, v));
}
