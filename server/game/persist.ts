import { BASE_CLASSES, CREATABLE_RACES } from "../../src/shared/content/catalog";
import type { CharacterRecord } from "../../src/shared/persist/store";
import type { PlayerState } from "../../src/shared/sim/types";
import type { JoinInput } from "../../src/shared/sim/world";

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

/** Load a stored hero, or the same Human Fighter a nameless hello used to create. */
export function joinInputFor(userId: string, name: string, save: CharacterRecord | null): JoinInput {
  const username = (usable(save) ? save.username : name).trim().slice(0, 16) || "Hero";
  if (!usable(save)) {
    return {
      id: userId,
      username,
      race: CREATABLE_RACES[0] ?? "Human",
      baseClass: BASE_CLASSES[0] ?? "Fighter",
    };
  }
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
