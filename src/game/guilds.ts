/** Same-browser guild roster. No server, no guild chat. */

export const GUILD_KEY = "uthgaard-guilds-v1";
export const CHARTER_GOLD = 80;
export const LEADER_LEAVE =
  "A Leader leaves only when they are the last member. The guild then closes.";

export const GUILD_KINDS = ["Warband", "Syndicate", "Order"] as const;
export type GuildKind = (typeof GUILD_KINDS)[number];

export const CRESTS = [
  { id: "ash", label: "Ash", color: "#c4b08a" },
  { id: "tide", label: "Tide", color: "#6aa8c8" },
  { id: "thorn", label: "Thorn", color: "#6e9a4a" },
  { id: "sun", label: "Sun", color: "#e2b15a" },
] as const;
export type CrestId = (typeof CRESTS)[number]["id"];

export interface GuildMember {
  name: string;
  rank: "Leader" | "Member";
}

export interface GuildRecord {
  id: string;
  name: string;
  tag: string;
  kind: GuildKind;
  crest: CrestId;
  members: GuildMember[];
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

function cleanName(raw: string) {
  return raw.trim().replace(/\s+/g, " ");
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
  const name = cleanName(input.name);
  if (name.length < 3 || name.length > 24 || !/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(name)) {
    return { ok: false, reason: "A guild name is 3–24 letters." };
  }
  const tag = input.tag.trim().toUpperCase();
  if (!/^[A-Z]{3,4}$/.test(tag)) return { ok: false, reason: "A tag is 3 or 4 letters." };
  const kind = GUILD_KINDS.find((row) => row.toLowerCase() === input.kind.trim().toLowerCase());
  if (!kind) return { ok: false, reason: "Choose Warband, Syndicate, or Order." };
  const crest = CRESTS.find((row) => row.id === input.crest.trim().toLowerCase());
  if (!crest) return { ok: false, reason: "Choose a crest." };
  const store = read();
  if (store.guilds.some((guild) => guild.tag === tag))
    return { ok: false, reason: `The tag [${tag}] is already taken.` };
  if (store.guilds.some((guild) => guild.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, reason: "That guild name is already taken." };
  }
  const guild: GuildRecord = {
    id: "g" + Math.random().toString(36).slice(2, 10),
    name,
    tag,
    kind,
    crest: crest.id,
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
