import type { CharacterRecord } from "../../src/shared/persist/store";
import { BASE_CLASSES, CREATABLE_RACES, classAllowed, type BaseClass, type Race } from "../../src/shared/sim/types";
import type { PlayerState } from "../../src/shared/sim/types";
import type { JoinInput } from "../../src/shared/sim/world";

export interface CreateChoice {
  name: string;
  race: Race;
  baseClass: BaseClass;
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

/** A stored hero, or a validated create. Nothing is invented here. */
export function joinInputFor(
  userId: string,
  save: CharacterRecord | null,
  create: CreateChoice | null,
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
  return {
    id: userId,
    username: create.name.trim().slice(0, 16),
    race: create.race,
    baseClass: create.baseClass,
  };
}
