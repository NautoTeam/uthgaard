import type { CharacterRecord } from "../../src/shared/persist/store";
import { EQUIP_SLOTS, itemById } from "../../src/shared/content/catalog";
import { BASE_CLASSES, CREATABLE_RACES, classAllowed, type BaseClass, type Race } from "../../src/shared/sim/types";
import type { PlayerState } from "../../src/shared/sim/types";
import type { JoinInput } from "../../src/shared/sim/world";

export interface CreateChoice {
  name: string;
  race: Race;
  baseClass: BaseClass;
}

/** What the client may offer from a local save. Position, health, and gates are not fields. */
export interface ImportDraft {
  level: number;
  gold: number;
  inventory?: Record<string, number>;
  equipment?: Record<string, string>;
}

export interface ClampedImport {
  level: number;
  gold: number;
  xp: number;
  inventory: Record<string, number>;
  equipment: Record<string, string>;
  importedAt: number;
}

const DOLL = new Set(EQUIP_SLOTS.map((slot) => slot.id));

/** Level 1–5, gold 0–500, known items, stacks 1–99, equipment only in a matching slot. XP is the level floor. */
export function clampImport(raw: ImportDraft, at = Date.now()): ClampedImport {
  const level = Math.max(1, Math.min(5, Math.floor(Number(raw.level) || 1)));
  const gold = Math.max(0, Math.min(500, Math.floor(Number(raw.gold) || 0)));
  const inventory: Record<string, number> = {};
  for (const [id, count] of Object.entries(raw.inventory ?? {})) {
    if (!itemById(id)) continue;
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n < 1) continue;
    inventory[id] = Math.min(99, n);
  }
  const equipment: Record<string, string> = {};
  for (const [slot, itemId] of Object.entries(raw.equipment ?? {})) {
    if (!DOLL.has(slot)) continue;
    const item = itemById(itemId);
    if (!item?.slot) continue;
    const fits = item.slot === slot || (item.slot === "ring" && (slot === "ring" || slot === "ring2"));
    if (!fits) continue;
    equipment[slot] = item.id;
  }
  return { level, gold, xp: 0, inventory, equipment, importedAt: at };
}

export function validateCreate(input: { name: string; race: string; baseClass: string } | undefined): CreateChoice | null {
  if (!input) return null;
  const race = input.race as Race;
  const baseClass = input.baseClass as BaseClass;
  if (!(CREATABLE_RACES as readonly string[]).includes(race)) return null;
  if (!(BASE_CLASSES as readonly string[]).includes(baseClass)) return null;
  if (!classAllowed(race, baseClass)) return null;
  const name = input.name.trim();
  if (name.length < 2 || name.length > 16) return null;
  return { name, race, baseClass };
}

export function recordFromPlayer(p: PlayerState): CharacterRecord {
  return {
    version: 1,
    username: p.username,
    race: p.race,
    baseClass: p.baseClass,
    prestigeClass: p.prestigeClass,
    level: p.level,
    xp: p.xp,
    gold: p.gold,
    x: p.x,
    z: p.z,
    hp: p.hp,
    inventory: { ...p.inventory },
    equipment: { ...p.equipment },
    trainPoints: p.trainPoints,
    skills: { ...p.skills },
    hotbar: [...p.hotbar],
    shroudUntil: p.shroudUntil,
    attunedGates: p.attunedGates ? [...p.attunedGates] : undefined,
    deathSettled: p.hp <= 0 && p.graveDropped,
  };
}

function usable(save: CharacterRecord | null): save is CharacterRecord {
  return !!save && save.version === 1 && typeof save.race === "string" && typeof save.baseClass === "string";
}

/** A stored hero, or a validated create. Import applies only when there is no row. */
export function joinInputFor(
  userId: string,
  save: CharacterRecord | null,
  create: CreateChoice | null,
  imported?: ClampedImport | null,
): JoinInput | null {
  if (usable(save)) {
    const username = save.username.trim().slice(0, 16) || "Hero";
    return {
      id: userId,
      username,
      race: save.race,
      baseClass: save.baseClass,
      prestigeClass: save.prestigeClass || undefined,
      level: save.level,
      xp: save.xp,
      gold: save.gold,
      x: save.x,
      z: save.z,
      hp: save.hp,
      inventory: save.inventory,
      equipment: save.equipment,
      trainPoints: save.trainPoints,
      skills: save.skills,
      hotbar: save.hotbar,
      shroudUntil: save.shroudUntil,
      attunedGates: save.attunedGates,
      deathSettled: save.deathSettled,
    };
  }
  if (!create) return null;
  const base: JoinInput = {
    id: userId,
    username: create.name.trim().slice(0, 16),
    race: create.race,
    baseClass: create.baseClass,
  };
  if (!imported) return base;
  return {
    ...base,
    level: imported.level,
    xp: imported.xp,
    gold: imported.gold,
    inventory: imported.inventory,
    equipment: imported.equipment,
  };
}
