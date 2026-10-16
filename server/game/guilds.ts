import { nearestRegistrar } from "../../src/shared/sim/geo";
import { CHARTER_GOLD, validateFoundGuild } from "../../src/shared/sim/guild";
import type { ActionResult, GuildView } from "../../src/shared/sim/types";
import type { World } from "../../src/shared/sim/world";
import type { GuildWrite, StoredGuild } from "./db";

/** The registrar desk stays open out to 8 tiles. Buying matches that. */
const REGISTRAR_NEAR = 8;

export interface GuildBook {
  load(rows: StoredGuild[]): void;
  view(userId: string): GuildView | null;
  tag(userId: string): string;
  hasUser(userId: string): boolean;
  /** Duplicate name or tag, or null when both are free. */
  conflict(name: string, tag: string): { ok: false; reason: string } | null;
  add(row: StoredGuild): boolean;
}

function rankLabel(rank: StoredGuild["rank"]): GuildView["rank"] {
  if (rank === "officer") return "Officer";
  if (rank === "member") return "Member";
  return "Leader";
}

function viewOf(row: StoredGuild): GuildView {
  return {
    id: row.id,
    name: row.name,
    tag: row.tag,
    kind: row.kind,
    crest: row.crest,
    rank: rankLabel(row.rank),
  };
}

export function createGuildBook(): GuildBook {
  const byUser = new Map<string, StoredGuild>();
  return {
    load(rows) {
      byUser.clear();
      for (const row of rows) this.add(row);
    },
    view(userId) {
      const row = byUser.get(userId);
      return row ? viewOf(row) : null;
    },
    tag(userId) {
      return byUser.get(userId)?.tag ?? "";
    },
    hasUser(userId) {
      return byUser.has(userId);
    },
    conflict(name, tag) {
      for (const row of byUser.values()) {
        if (row.name.toLowerCase() === name.toLowerCase()) {
          return { ok: false, reason: "That guild name is already taken." };
        }
        if (row.tag.toLowerCase() === tag.toLowerCase()) {
          return { ok: false, reason: `The tag [${tag}] is already taken.` };
        }
      }
      return null;
    },
    add(row) {
      if (byUser.has(row.userId)) return false;
      for (const existing of byUser.values()) {
        if (existing.id === row.id) continue;
        if (existing.name.toLowerCase() === row.name.toLowerCase()) return false;
        if (existing.tag.toLowerCase() === row.tag.toLowerCase()) return false;
      }
      byUser.set(row.userId, { ...row });
      return true;
    },
  };
}

export function buyCharter(world: World, playerId: string, book?: GuildBook): ActionResult {
  const p = world.players.get(playerId);
  if (!p || p.hp <= 0) return { ok: false, reason: "You cannot do that." };
  if (book?.hasUser(playerId)) return { ok: false, reason: "You already belong to a guild." };
  if (p.charter) return { ok: false, reason: "You already hold a charter." };
  if (!nearestRegistrar(p.x, p.z, REGISTRAR_NEAR)) return { ok: false, reason: "Find the registrar." };
  if (p.gold < CHARTER_GOLD) {
    return { ok: false, reason: `A charter costs ${CHARTER_GOLD} gold. You have ${p.gold}.` };
  }
  p.gold -= CHARTER_GOLD;
  p.charter = true;
  return { ok: true, reason: "The Registrar seals your charter." };
}

export function prepareFound(
  world: World,
  book: GuildBook,
  playerId: string,
  input: { name: string; tag: string; kind: string; crest: string },
): { ok: true; row: StoredGuild } | { ok: false; reason: string } {
  const p = world.players.get(playerId);
  if (!p || p.hp <= 0) return { ok: false, reason: "You cannot do that." };
  if (book.hasUser(playerId)) return { ok: false, reason: "You already belong to a guild." };
  if (!p.charter) return { ok: false, reason: "Buy a charter first." };
  const valid = validateFoundGuild(input);
  if (!valid.ok) return valid;
  const clash = book.conflict(valid.name, valid.tag);
  if (clash) return clash;
  return {
    ok: true,
    row: {
      id: "g" + Math.random().toString(36).slice(2, 10),
      userId: playerId,
      name: valid.name,
      tag: valid.tag,
      kind: valid.kind,
      crest: valid.crest,
      rank: "leader",
    },
  };
}

export function finishFound(world: World, book: GuildBook, playerId: string, row: StoredGuild): ActionResult {
  const p = world.players.get(playerId);
  if (!p) return { ok: false, reason: "No such hero." };
  if (!book.add(row)) return { ok: false, reason: "That guild name is already taken." };
  p.charter = false;
  return { ok: true, reason: `You found [${row.tag}] ${row.name}. You are Leader.` };
}

/** Memory book only. The server awaits {@link foundGuild} so the row hits the database first. */
export function foundGuildNow(
  world: World,
  book: GuildBook,
  playerId: string,
  input: { name: string; tag: string; kind: string; crest: string },
): ActionResult {
  const ready = prepareFound(world, book, playerId, input);
  if (!ready.ok) return ready;
  return finishFound(world, book, playerId, ready.row);
}

function saveReason(saved: Exclude<GuildWrite, "ok">, tag: string): string {
  if (saved === "name_taken") return "That guild name is already taken.";
  if (saved === "tag_taken") return `The tag [${tag}] is already taken.`;
  return "You already belong to a guild.";
}

export async function foundGuild(
  world: World,
  book: GuildBook,
  playerId: string,
  input: { name: string; tag: string; kind: string; crest: string },
  write?: (row: StoredGuild) => Promise<GuildWrite>,
): Promise<ActionResult> {
  const ready = prepareFound(world, book, playerId, input);
  if (!ready.ok) return ready;
  if (write) {
    const saved = await write(ready.row);
    if (saved !== "ok") return { ok: false, reason: saveReason(saved, ready.row.tag) };
  }
  return finishFound(world, book, playerId, ready.row);
}
