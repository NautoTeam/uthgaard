import type { CharacterRecord } from "../shared/persist/store";

export type CharacterSave = CharacterRecord;

const KEY = "uthgaard-characters-v1";

function readMap(): Record<string, CharacterSave> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CharacterSave>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function listSaves(): CharacterSave[] {
  return Object.values(readMap()).sort((a, b) => b.level - a.level || a.username.localeCompare(b.username));
}

export function loadSave(username: string): CharacterSave | null {
  return readMap()[username] ?? null;
}

export function writeSave(save: CharacterSave): number | false {
  const map = readMap();
  const prev = map[save.username];
  const inputAt = save.inputAt ?? 0;
  const rev = save.rev ?? 0;
  if (prev) {
    const prevAt = prev.inputAt ?? 0;
    const prevRev = prev.rev ?? 0;
    if (inputAt < prevAt) return false;
    if (inputAt === prevAt && rev <= prevRev) return false;
  }
  const storedRev = prev ? Math.max(rev, (prev.rev ?? 0) + 1) : Math.max(1, rev);
  map[save.username] = {
    ...save,
    version: 1,
    inputAt,
    rev: storedRev,
  };
  localStorage.setItem(KEY, JSON.stringify(map));
  return storedRev;
}

export function deleteSave(username: string) {
  const map = readMap();
  delete map[username];
  localStorage.setItem(KEY, JSON.stringify(map));
}

const GRAVES = "uthgaard-graves-v1";

export function loadGraves<T>(): T[] {
  try {
    const raw = localStorage.getItem(GRAVES);
    const parsed = raw ? (JSON.parse(raw) as T[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeGraves(graves: unknown[]) {
  localStorage.setItem(GRAVES, JSON.stringify(graves));
}
