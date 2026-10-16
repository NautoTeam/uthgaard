/** Same-browser guild roster. Founding rules live in src/shared/sim/guild.ts. */

import {
  CHARTER_GOLD,
  CITY_PLOTS,
  CORNERSTONE_GOLD,
  CRESTS,
  GUILD_KINDS,
  plotById,
  validateFoundGuild,
  type CrestId,
  type GuildKind,
} from "../shared/sim/guild";

export {
  CHARTER_GOLD,
  CITY_PLOTS,
  CORNERSTONE_GOLD,
  CRESTS,
  GUILD_KINDS,
  plotById,
  validateFoundGuild,
  type CrestId,
  type GuildKind,
};

export const GUILD_KEY = "uthgaard-guilds-v1";
export const LEADER_LEAVE =
  "A Leader leaves only when they are the last member. The guild then closes.";

export type GuildRank = "Leader" | "Officer" | "Member";

export interface GuildMember {
  name: string;
  rank: GuildRank;
}

export interface GuildRecord {
  id: string;
  name: string;
  tag: string;
  kind: GuildKind;
  crest: CrestId;
  members: GuildMember[];
  /** Set when the Leader plants on a free city plot. One per guild. */
  cornerstone?: { plotId: string; x: number; z: number } | null;
}

interface GuildStore {
  guilds: GuildRecord[];
}

let cache: GuildStore | null = null;

function browserStore(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function read(): GuildStore {
  if (cache) return cache;
  const empty = { guilds: [] as GuildRecord[] };
  const store = browserStore();
  if (!store) {
    cache = empty;
    return cache;
  }
  try {
    const raw = store.getItem(GUILD_KEY);
    const parsed = raw ? (JSON.parse(raw) as GuildStore) : null;
    cache =
      parsed && Array.isArray(parsed.guilds) ? { guilds: parsed.guilds.filter(validGuild) } : empty;
  } catch {
    cache = empty;
  }
  return cache;
}

function validGuild(guild: GuildRecord) {
  return (
    !!guild &&
    typeof guild.id === "string" &&
    typeof guild.tag === "string" &&
    Array.isArray(guild.members)
  );
}

function write(next: GuildStore) {
  cache = next;
  browserStore()?.setItem(GUILD_KEY, JSON.stringify(next));
}

export function invalidateGuilds() {
  cache = null;
}

export function listGuilds() {
  return read().guilds;
}

export function guildOf(name: string): GuildRecord | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  return (
    read().guilds.find((guild) =>
      guild.members.some((member) => member.name.toLowerCase() === want),
    ) ?? null
  );
}

export function guildTag(name: string) {
  return guildOf(name)?.tag ?? "";
}

export function memberRank(name: string) {
  const guild = guildOf(name);
  if (!guild) return null;
  return (
    guild.members.find((member) => member.name.toLowerCase() === name.trim().toLowerCase())?.rank ??
    null
  );
}

export function foundGuild(input: {
  leader: string;
  name: string;
  tag: string;
  kind: string;
  crest: string;
}): { ok: true; guild: GuildRecord } | { ok: false; reason: string } {
  const leader = input.leader.trim();
  if (!leader) return { ok: false, reason: "Name yourself before founding a guild." };
  if (guildOf(leader)) return { ok: false, reason: "You already belong to a guild." };
  const valid = validateFoundGuild(input);
  if (!valid.ok) return valid;
  const store = read();
  if (store.guilds.some((guild) => guild.tag === valid.tag))
    return { ok: false, reason: `The tag [${valid.tag}] is already taken.` };
  if (store.guilds.some((guild) => guild.name.toLowerCase() === valid.name.toLowerCase())) {
    return { ok: false, reason: "That guild name is already taken." };
  }
  const guild: GuildRecord = {
    id: "g" + Math.random().toString(36).slice(2, 10),
    name: valid.name,
    tag: valid.tag,
    kind: valid.kind,
    crest: valid.crest,
    members: [{ name: leader, rank: "Leader" }],
  };
  write({ guilds: [...store.guilds, guild] });
  return { ok: true, guild };
}

export function admit(
  guildId: string,
  name: string,
): { ok: true; guild: GuildRecord } | { ok: false; reason: string } {
  const who = name.trim();
  if (!who) return { ok: false, reason: "No name." };
  if (guildOf(who)) return { ok: false, reason: "You already belong to a guild." };
  const store = read();
  const guild = store.guilds.find((row) => row.id === guildId);
  if (!guild) return { ok: false, reason: "That guild is gone." };
  const next: GuildRecord = {
    ...guild,
    members: [...guild.members, { name: who, rank: "Member" }],
  };
  write({ guilds: store.guilds.map((row) => (row.id === guild.id ? next : row)) });
  return { ok: true, guild: next };
}

export function depart(
  name: string,
): { ok: true; closed: boolean; tag: string } | { ok: false; reason: string } {
  const who = name.trim().toLowerCase();
  const store = read();
  const guild = store.guilds.find((row) =>
    row.members.some((member) => member.name.toLowerCase() === who),
  );
  if (!guild) return { ok: false, reason: "You are not in a guild." };
  const mine = guild.members.find((member) => member.name.toLowerCase() === who);
  if (!mine) return { ok: false, reason: "You are not in a guild." };
  if (mine.rank === "Leader" && guild.members.length > 1)
    return { ok: false, reason: LEADER_LEAVE };
  const closed = mine.rank === "Leader";
  const guilds = closed
    ? store.guilds.filter((row) => row.id !== guild.id)
    : store.guilds.map((row) =>
        row.id === guild.id
          ? { ...row, members: row.members.filter((member) => member.name.toLowerCase() !== who) }
          : row,
      );
  write({ guilds });
  return { ok: true, closed, tag: guild.tag };
}

function findMembership(name: string) {
  const who = name.trim().toLowerCase();
  const store = read();
  const guild = store.guilds.find((row) =>
    row.members.some((member) => member.name.toLowerCase() === who),
  );
  const member = guild?.members.find((row) => row.name.toLowerCase() === who) ?? null;
  return { store, guild: guild ?? null, member };
}

function replaceGuild(store: GuildStore, guild: GuildRecord) {
  write({ guilds: store.guilds.map((row) => (row.id === guild.id ? guild : row)) });
}

export function guildAtPlot(plotId: string): GuildRecord | null {
  return read().guilds.find((guild) => guild.cornerstone?.plotId === plotId) ?? null;
}

export function plantCornerstone(
  actor: string,
  plotId: string,
): { ok: true; guild: GuildRecord } | { ok: false; reason: string } {
  invalidateGuilds();
  const plot = plotById(plotId);
  if (!plot) return { ok: false, reason: "There is no city plot there." };
  const mine = findMembership(actor);
  if (!mine.guild || !mine.member) return { ok: false, reason: "You are not in a guild." };
  if (mine.member.rank !== "Leader")
    return { ok: false, reason: "Only the Leader can plant a Cornerstone." };
  if (mine.guild.cornerstone) return { ok: false, reason: "Your guild already has a Cornerstone." };
  const taken = guildAtPlot(plot.id);
  if (taken) return { ok: false, reason: `That plot is taken by [${taken.tag}].` };
  const next: GuildRecord = {
    ...mine.guild,
    cornerstone: { plotId: plot.id, x: plot.x, z: plot.z },
  };
  replaceGuild(mine.store, next);
  return { ok: true, guild: next };
}

export function removeCornerstone(
  actor: string,
): { ok: true; guild: GuildRecord } | { ok: false; reason: string } {
  invalidateGuilds();
  const mine = findMembership(actor);
  if (!mine.guild || !mine.member) return { ok: false, reason: "You are not in a guild." };
  if (mine.member.rank !== "Leader")
    return { ok: false, reason: "Only the Leader can remove the Cornerstone." };
  if (!mine.guild.cornerstone) return { ok: false, reason: "Your guild has no Cornerstone." };
  const next: GuildRecord = { ...mine.guild, cornerstone: null };
  replaceGuild(mine.store, next);
  return { ok: true, guild: next };
}

export function promoteMember(
  actor: string,
  target: string,
): { ok: true; guild: GuildRecord } | { ok: false; reason: string } {
  const mine = findMembership(actor);
  const theirs = findMembership(target);
  if (!mine.guild || !mine.member) return { ok: false, reason: "You are not in a guild." };
  if (mine.member.rank !== "Leader") return { ok: false, reason: "Only the Leader can promote." };
  if (!theirs.guild || theirs.guild.id !== mine.guild.id || !theirs.member) {
    return { ok: false, reason: "They are not in your guild." };
  }
  if (theirs.member.rank !== "Member")
    return { ok: false, reason: "Only a Member can be promoted to Officer." };
  const next: GuildRecord = {
    ...mine.guild,
    members: mine.guild.members.map((row) =>
      row.name.toLowerCase() === theirs.member!.name.toLowerCase()
        ? { ...row, rank: "Officer" }
        : row,
    ),
  };
  replaceGuild(mine.store, next);
  return { ok: true, guild: next };
}

export function demoteMember(
  actor: string,
  target: string,
): { ok: true; guild: GuildRecord } | { ok: false; reason: string } {
  const mine = findMembership(actor);
  const theirs = findMembership(target);
  if (!mine.guild || !mine.member) return { ok: false, reason: "You are not in a guild." };
  if (mine.member.rank !== "Leader") return { ok: false, reason: "Only the Leader can demote." };
  if (!theirs.guild || theirs.guild.id !== mine.guild.id || !theirs.member) {
    return { ok: false, reason: "They are not in your guild." };
  }
  if (theirs.member.rank !== "Officer")
    return { ok: false, reason: "Only an Officer can be demoted to Member." };
  const next: GuildRecord = {
    ...mine.guild,
    members: mine.guild.members.map((row) =>
      row.name.toLowerCase() === theirs.member!.name.toLowerCase()
        ? { ...row, rank: "Member" }
        : row,
    ),
  };
  replaceGuild(mine.store, next);
  return { ok: true, guild: next };
}

export function kickMember(
  actor: string,
  target: string,
): { ok: true; guild: GuildRecord; name: string } | { ok: false; reason: string } {
  const mine = findMembership(actor);
  const theirs = findMembership(target);
  if (!mine.guild || !mine.member) return { ok: false, reason: "You are not in a guild." };
  if (!theirs.guild || theirs.guild.id !== mine.guild.id || !theirs.member) {
    return { ok: false, reason: "They are not in your guild." };
  }
  if (theirs.member.name.toLowerCase() === mine.member.name.toLowerCase()) {
    return { ok: false, reason: "Use /gleave to leave." };
  }
  if (theirs.member.rank === "Leader") return { ok: false, reason: "The Leader cannot be kicked." };
  if (mine.member.rank === "Member") return { ok: false, reason: "Members cannot kick." };
  if (mine.member.rank === "Officer" && theirs.member.rank !== "Member") {
    return { ok: false, reason: "Officers can only kick Members." };
  }
  const next: GuildRecord = {
    ...mine.guild,
    members: mine.guild.members.filter(
      (row) => row.name.toLowerCase() !== theirs.member!.name.toLowerCase(),
    ),
  };
  replaceGuild(mine.store, next);
  return { ok: true, guild: next, name: theirs.member.name };
}
