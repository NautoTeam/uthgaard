import type { BaseClass, Prestige, Race } from "../content/catalog";
import { BOUNDS } from "../content/world";

export type { BaseClass, CampDef, Prestige, Race } from "../content/catalog";
export { BASE_CLASSES, CAMPS, CREATABLE_RACES, PRESTIGE_OF, RACES, attrsFor, classAllowed, classDenied, DEBUG_SET_LEVEL } from "../content/catalog";

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
  trainPoints: number;
  skills: Record<string, number>;
  hotbar: string[];
  cooldowns: Record<string, number>;
  guardUntil: number;
  wallUntil: number;
  stealthUntil: number;
  shroudUntil: number;
  graveDropped: boolean;
  /** Ley Gate stones this hero has stood beside. Missing on old saves. */
  attunedGates?: string[];
  /** Paid the Registrar and has not founded yet. Stripped from public snaps. */
  charter?: boolean;
  /** Set on the snap only, so nameplates can show another hero's tag. */
  guildTag?: string;
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
  snareUntil: number;
}

export interface GraveState {
  id: string;
  owner: string;
  x: number;
  z: number;
  gold: number;
  items: Record<string, number>;
  /** When the stone was raised. Missing on older saves, which are expired. */
  born?: number;
}

export interface PartyMemberView {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
}

/** The viewer's party. Absent from the shared world snapshot; attached per player. */
export interface PartyView {
  id: string;
  leader: string;
  members: PartyMemberView[];
}

export interface PendingInvite {
  fromId: string;
  fromName: string;
}

/** The viewer's own guild. Absent from the shared world snapshot. */
export interface GuildView {
  id: string;
  name: string;
  tag: string;
  kind: string;
  crest: string;
  rank: "Leader" | "Officer" | "Member";
}

export interface PublicState {
  players: PlayerState[];
  monsters: MonsterState[];
  graves: GraveState[];
  logs: string[];
  /** Present only on the snap sent to one player. Not stored. */
  party?: PartyView | null;
  pendingInvite?: PendingInvite | null;
  /** Present only on the snap sent to one player. Not stored. */
  charter?: boolean;
  guild?: GuildView | null;
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
  dmg?: number;
}

export function xpNeed(level: number) {
  return level * 70;
}

export function clampX(v: number) {
  return Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, v));
}

export function clampZ(v: number) {
  return Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, v));
}

/** @deprecated Use clampX or clampZ. Still clamps a single axis to the old isle edge. */
export function clampCoord(v: number) {
  return Math.max(-168, Math.min(168, v));
}
