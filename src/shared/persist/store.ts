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
  /** Current health. Missing on older saves, which arrive at full health. */
  hp?: number;
  inventory?: Record<string, number>;
  equipment?: Record<string, string>;
  trainPoints?: number;
  skills?: Record<string, number>;
  hotbar?: string[];
  shroudUntil?: number;
  attunedGates?: string[];
  /** True once this death has already taken gold and XP. */
  deathSettled?: boolean;
  /** Paid the Registrar and has not founded a guild yet. */
  charter?: boolean;
  /** Monotonic save generation. A write with an older inputAt is ignored. */
  rev?: number;
  /** Last time this tab handled player input. Newer input wins over a stale tab. */
  inputAt?: number;
}

export interface CharacterStore {
  list(): CharacterRecord[];
  load(username: string): CharacterRecord | null;
  write(save: CharacterRecord): void;
  delete(username: string): void;
}
