import type { BaseClass, Prestige, Race } from "../content/catalog";

/** Character row. The browser store is local; a long-lived host can swap in SQL. */
export interface CharacterRecord {
  version: 1;
  username: string;
  race: Race;
  baseClass: BaseClass;
  prestigeClass: Prestige;
  level: number;
  xp: number;
  gold: number;
  x?: number;
  z?: number;
  inventory?: Record<string, number>;
  equipment?: Record<string, string>;
  trainPoints?: number;
  skills?: Record<string, number>;
  hotbar?: string[];
  shroudUntil?: number;
  attunedGates?: string[];
}

export interface CharacterStore {
  list(): CharacterRecord[];
  load(username: string): CharacterRecord | null;
  write(save: CharacterRecord): void;
  delete(username: string): void;
}
