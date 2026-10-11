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

export function writeSave(save: CharacterSave) {
  const map = readMap();
  map[save.username] = { ...save, version: 1 };
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function deleteSave(username: string) {
  const map = readMap();
  delete map[username];
  localStorage.setItem(KEY, JSON.stringify(map));
}
