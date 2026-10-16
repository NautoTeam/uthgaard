/** Pure guild rules. The server and the browser both use these. */

export const CHARTER_GOLD = 80;
export const CORNERSTONE_GOLD = 150;

/** How close a leader must stand to plant. Matches the city-plot mark. */
export const PLOT_NEAR = 3.2;

/** Open ground outside a haven. Beastmarch is just south of Fenhollow's PvP line. */
export const CITY_PLOTS = [
  { id: "beastmarch-south", zone: "Beastmarch", x: 40, z: 140 },
  { id: "reedrot-fen", zone: "Reedrot Fen", x: 10, z: 305 },
] as const;

export function plotById(id: string) {
  return CITY_PLOTS.find((plot) => plot.id === id) ?? null;
}

export const GUILD_KINDS = ["Warband", "Syndicate", "Order"] as const;
export type GuildKind = (typeof GUILD_KINDS)[number];

export const CRESTS = [
  { id: "ash", label: "Ash", color: "#c4b08a" },
  { id: "tide", label: "Tide", color: "#6aa8c8" },
  { id: "thorn", label: "Thorn", color: "#6e9a4a" },
  { id: "sun", label: "Sun", color: "#e2b15a" },
] as const;
export type CrestId = (typeof CRESTS)[number]["id"];

export interface FoundGuildInput {
  name: string;
  tag: string;
  kind: string;
  crest: string;
}

export interface FoundGuildFields {
  name: string;
  tag: string;
  kind: GuildKind;
  crest: CrestId;
}

function cleanName(raw: string) {
  return raw.trim().replace(/\s+/g, " ");
}

/** Name, tag, kind, and crest. Membership and uniqueness are the caller's. */
export function validateFoundGuild(
  input: FoundGuildInput,
): { ok: true } & FoundGuildFields | { ok: false; reason: string } {
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
  return { ok: true, name, tag, kind, crest: crest.id };
}
