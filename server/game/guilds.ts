import type { Intent } from "../../src/shared/net/protocol";
import { nearestRegistrar } from "../../src/shared/sim/geo";
import { GUILD_CHAT_KEEP } from "../../src/shared/sim/chat";
import { CHARTER_GOLD, validateFoundGuild } from "../../src/shared/sim/guild";
import type { ActionResult, GuildView, PendingGuildInvite } from "../../src/shared/sim/types";
import type { World } from "../../src/shared/sim/world";
import type { GuildDb, GuildWrite, MemberWrite, StoredGuild, StoredGuildChat } from "./db";

/** The registrar desk stays open out to 8 tiles. Buying matches that. */
const REGISTRAR_NEAR = 8;

export interface GuildPresence {
  online: ReadonlySet<string>;
  name?: (userId: string) => string | undefined;
}

export type GuildChange =
  | { op: "invite"; userId: string; guildId: string; fromId: string; fromName: string }
  | { op: "clearInvite"; userId: string; guildId: string }
  | { op: "add"; row: StoredGuild }
  | { op: "rank"; userId: string; rank: StoredGuild["rank"] }
  | { op: "remove"; userId: string }
  | { op: "handoff"; guildId: string; toId: string; fromId: string }
  | { op: "disband"; guildId: string };

export type GuildPlan = { ok: false; reason: string } | { ok: true; reason: string; changes: GuildChange[] };

interface Member extends StoredGuild {
  joinedAt: number;
  username: string;
}

interface Invite {
  guildId: string;
  fromId: string;
  fromName: string;
}

export interface GuildBook {
  load(rows: StoredGuild[]): void;
  view(userId: string, presence?: GuildPresence): GuildView | null;
  pending(userId: string): PendingGuildInvite | null;
  tag(userId: string): string;
  hasUser(userId: string): boolean;
  /** Duplicate name or tag, or null when both are free. */
  conflict(name: string, tag: string): { ok: false; reason: string } | null;
  add(row: StoredGuild): boolean;
  /** Join-order stamp. A provided time is kept and the clock moves past it. */
  stamp(given?: number): number;
  loadChat(rows: StoredGuildChat[]): void;
  pushChat(row: StoredGuildChat): void;
  plan(world: World, playerId: string, intent: Intent): GuildPlan;
  apply(changes: GuildChange[]): void;
}

function rankLabel(rank: StoredGuild["rank"]): GuildView["rank"] {
  if (rank === "officer") return "Officer";
  if (rank === "member") return "Member";
  return "Leader";
}

export function createGuildBook(): GuildBook {
  const byUser = new Map<string, Member>();
  const invites = new Map<string, Invite>();
  const lines = new Map<string, Array<{ from: string; text: string; at: number }>>();
  let joinClock = 0;

  function nextJoinedAt(given?: number): number {
    const now = Date.now();
    if (joinClock < now) joinClock = now;
    if (typeof given === "number" && Number.isFinite(given) && given > 0) {
      if (given >= joinClock) joinClock = given + 1;
      return given;
    }
    return joinClock++;
  }

  function membersOf(guildId: string): Member[] {
    return [...byUser.values()]
      .filter((row) => row.id === guildId)
      .sort((a, b) => a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId));
  }

  function shownName(member: Member, world?: World): string {
    const live = world?.players.get(member.userId)?.username?.trim();
    return live || member.username.trim() || "Hero";
  }

  function named(guildId: string, userName: string, world: World): Member | undefined {
    const want = userName.trim().toLowerCase();
    if (!want) return undefined;
    return membersOf(guildId).find((row) => shownName(row, world).toLowerCase() === want);
  }

  function playerByName(world: World, name: string) {
    const want = name.trim().toLowerCase();
    if (!want) return undefined;
    for (const row of world.players.values()) {
      if (row.username.toLowerCase() === want) return row;
    }
    return undefined;
  }

  const book: GuildBook = {
    load(rows) {
      byUser.clear();
      for (const row of rows) this.add(row);
    },
    view(userId, presence) {
      const row = byUser.get(userId);
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        tag: row.tag,
        kind: row.kind,
        crest: row.crest,
        rank: rankLabel(row.rank),
        members: membersOf(row.id).map((member) => {
          const live = presence?.name?.(member.userId)?.trim();
          return {
            name: live || member.username.trim() || "Hero",
            rank: rankLabel(member.rank),
            online: presence?.online.has(member.userId) ?? false,
          };
        }),
        chat: (lines.get(row.id) ?? []).map((line) => ({ ...line })),
      };
    },
    pending(userId) {
      const invite = invites.get(userId);
      if (!invite) return null;
      const guild = membersOf(invite.guildId)[0];
      if (!guild) {
        invites.delete(userId);
        return null;
      }
      return {
        guildId: invite.guildId,
        fromName: invite.fromName,
        guildName: guild.name,
        tag: guild.tag,
      };
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
      byUser.set(row.userId, {
        ...row,
        joinedAt: nextJoinedAt(row.joinedAt),
        username: row.username ?? "",
      });
      return true;
    },
    stamp(given) {
      return nextJoinedAt(given);
    },
    loadChat(rows) {
      lines.clear();
      const ordered = [...rows].sort((a, b) => a.at - b.at);
      for (const row of ordered) this.pushChat(row);
    },
    pushChat(row) {
      const list = lines.get(row.guildId) ?? [];
      list.push({ from: row.from, text: row.text, at: row.at });
      lines.set(row.guildId, list.slice(-GUILD_CHAT_KEEP));
    },
    plan(world, playerId, intent) {
      const p = world.players.get(playerId);
      if (!p || p.hp <= 0) return { ok: false, reason: "You cannot do that." };
      const actor = byUser.get(playerId);
      if (intent.op === "guildInvite") {
        if (!actor) return { ok: false, reason: "You are not in a guild." };
        if (actor.rank === "member") return { ok: false, reason: "Only a Leader or Officer can invite." };
        const target = playerByName(world, intent.toName);
        if (!target) return { ok: false, reason: "No one by that name." };
        if (target.id === playerId) return { ok: false, reason: "You cannot invite yourself." };
        if (byUser.has(target.id)) return { ok: false, reason: "They already belong to a guild." };
        return {
          ok: true,
          reason: `You invite ${target.username} to [${actor.tag}].`,
          changes: [
            {
              op: "invite",
              userId: target.id,
              guildId: actor.id,
              fromId: playerId,
              fromName: p.username,
            },
          ],
        };
      }
      if (intent.op === "guildAccept") {
        const invite = invites.get(playerId);
        if (!invite || invite.guildId !== intent.guildId) return { ok: false, reason: "No invite." };
        if (actor) return { ok: false, reason: "You already belong to a guild." };
        const guild = membersOf(invite.guildId)[0];
        if (!guild) return { ok: false, reason: "That guild is gone." };
        return {
          ok: true,
          reason: `You join [${guild.tag}] ${guild.name}.`,
          changes: [
            { op: "clearInvite", userId: playerId, guildId: invite.guildId },
            {
              op: "add",
              row: {
                id: guild.id,
                userId: playerId,
                name: guild.name,
                tag: guild.tag,
                kind: guild.kind,
                crest: guild.crest,
                rank: "member",
                username: p.username,
                joinedAt: nextJoinedAt(),
              },
            },
          ],
        };
      }
      if (intent.op === "guildDecline") {
        const invite = invites.get(playerId);
        if (!invite || invite.guildId !== intent.guildId) return { ok: false, reason: "No invite." };
        return {
          ok: true,
          reason: "You decline the guild invitation.",
          changes: [{ op: "clearInvite", userId: playerId, guildId: intent.guildId }],
        };
      }
      if (intent.op === "guildLeave") {
        if (!actor) return { ok: false, reason: "You are not in a guild." };
        const rest = membersOf(actor.id).filter((row) => row.userId !== playerId);
        if (actor.rank !== "leader" || rest.length === 0) {
          if (actor.rank === "leader") {
            return {
              ok: true,
              reason: "The guild is disbanded.",
              changes: [{ op: "disband", guildId: actor.id }],
            };
          }
          return {
            ok: true,
            reason: "You leave the guild.",
            changes: [{ op: "remove", userId: playerId }],
          };
        }
        const heir = rest.find((row) => row.rank === "officer") ?? rest.find((row) => row.rank === "member") ?? rest[0];
        if (!heir) return { ok: false, reason: "You cannot do that." };
        return {
          ok: true,
          reason: `You leave the guild. ${shownName(heir, world)} is now Leader.`,
          changes: [{ op: "handoff", guildId: actor.id, toId: heir.userId, fromId: playerId }],
        };
      }
      if (intent.op === "guildKick" || intent.op === "guildPromote" || intent.op === "guildDemote") {
        if (!actor) return { ok: false, reason: "You are not in a guild." };
        const target = named(actor.id, intent.userName, world);
        if (!target) return { ok: false, reason: "They are not in your guild." };
        const label = shownName(target, world);
        if (intent.op === "guildKick") {
          if (target.userId === playerId) return { ok: false, reason: "Use /gleave to leave." };
          if (target.rank === "leader") return { ok: false, reason: "The Leader cannot be kicked." };
          if (actor.rank === "member") return { ok: false, reason: "Members cannot kick." };
          if (actor.rank === "officer" && target.rank !== "member") {
            return { ok: false, reason: "Officers can only kick Members." };
          }
          return {
            ok: true,
            reason: `${label} was removed from the guild.`,
            changes: [{ op: "remove", userId: target.userId }],
          };
        }
        if (actor.rank !== "leader") {
          return {
            ok: false,
            reason: intent.op === "guildPromote" ? "Only the Leader can promote." : "Only the Leader can demote.",
          };
        }
        if (intent.op === "guildPromote") {
          if (target.rank !== "member") return { ok: false, reason: "Only a Member can be promoted to Officer." };
          return {
            ok: true,
            reason: `${label} is now an Officer.`,
            changes: [{ op: "rank", userId: target.userId, rank: "officer" }],
          };
        }
        if (target.rank !== "officer") return { ok: false, reason: "Only an Officer can be demoted to Member." };
        return {
          ok: true,
          reason: `${label} is now a Member.`,
          changes: [{ op: "rank", userId: target.userId, rank: "member" }],
        };
      }
      return { ok: false, reason: "You cannot do that." };
    },
    apply(changes) {
      for (const change of changes) {
        if (change.op === "invite") {
          invites.set(change.userId, {
            guildId: change.guildId,
            fromId: change.fromId,
            fromName: change.fromName,
          });
        } else if (change.op === "clearInvite") {
          const invite = invites.get(change.userId);
          if (invite?.guildId === change.guildId) invites.delete(change.userId);
        } else if (change.op === "add") {
          this.add(change.row);
        } else if (change.op === "rank") {
          const row = byUser.get(change.userId);
          if (row) row.rank = change.rank;
        } else if (change.op === "remove") {
          byUser.delete(change.userId);
          invites.delete(change.userId);
        } else if (change.op === "handoff") {
          const heir = byUser.get(change.toId);
          if (heir && heir.id === change.guildId) heir.rank = "leader";
          byUser.delete(change.fromId);
        } else if (change.op === "disband") {
          for (const [id, row] of byUser) {
            if (row.id === change.guildId) byUser.delete(id);
          }
          for (const [id, invite] of invites) {
            if (invite.guildId === change.guildId) invites.delete(id);
          }
          lines.delete(change.guildId);
        }
      }
    },
  };
  return book;
}

function clearJoinedCharter(world: World, playerId: string, changes: GuildChange[]) {
  if (!changes.some((change) => change.op === "add" && change.row.userId === playerId)) return;
  const p = world.players.get(playerId);
  if (p) p.charter = false;
}

/** Memory book only. The server awaits {@link commitGuildAct} so membership hits the database first. */
export function guildAct(world: World, book: GuildBook, playerId: string, intent: Intent): ActionResult {
  const plan = book.plan(world, playerId, intent);
  if (!plan.ok) return plan;
  book.apply(plan.changes);
  clearJoinedCharter(world, playerId, plan.changes);
  return { ok: true, reason: plan.reason };
}

async function writeChange(store: GuildDb, change: GuildChange): Promise<MemberWrite> {
  if (change.op === "add") return store.addMember(change.row);
  if (change.op === "rank") {
    await store.setMemberRank(change.userId, change.rank);
    return "ok";
  }
  if (change.op === "remove") {
    await store.removeMember(change.userId);
    return "ok";
  }
  if (change.op === "handoff") {
    await store.handoffLeader(change.guildId, change.toId, change.fromId);
    return "ok";
  }
  if (change.op === "disband") {
    await store.deleteGuild(change.guildId);
    return "ok";
  }
  return "ok";
}

export async function commitGuildAct(
  world: World,
  book: GuildBook,
  playerId: string,
  intent: Intent,
  store?: GuildDb,
): Promise<ActionResult> {
  const plan = book.plan(world, playerId, intent);
  if (!plan.ok) return plan;
  if (store) {
    for (const change of plan.changes) {
      const saved = await writeChange(store, change);
      if (saved === "already") return { ok: false, reason: "You already belong to a guild." };
      if (saved === "missing") return { ok: false, reason: "That guild is gone." };
    }
  }
  book.apply(plan.changes);
  clearJoinedCharter(world, playerId, plan.changes);
  return { ok: true, reason: plan.reason };
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
      username: p.username,
      joinedAt: book.stamp(),
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
