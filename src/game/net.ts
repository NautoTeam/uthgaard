import type { BaseClass, Race } from "../shared/content/catalog";

const metaEnv = (import.meta as { env?: { VITE_GAME_SERVER_URL?: string } }).env;

/** WebSocket URL of the authoritative game server. Empty means local play. */
export const SERVER = String(metaEnv?.VITE_GAME_SERVER_URL ?? "").trim();

/** The creation screen's choice. Sent only after `need_create`, or immediately for a chosen slot. */
export interface HelloChoice {
  username: string;
  race: Race;
  baseClass: BaseClass;
  slot: number;
  /** False plays an existing slot. Anything else creates in that slot. */
  create?: boolean;
}

export function gameHello(token: string, choice?: HelloChoice) {
  if (!choice) return { t: "hello" as const, token };
  const slot = choice.slot;
  if (choice.create === false) return { t: "hello" as const, token, slot };
  return {
    t: "hello" as const,
    token,
    create: {
      name: choice.username.trim().slice(0, 16),
      race: choice.race,
      baseClass: choice.baseClass,
      slot,
    },
  };
}

/**
 * The server has no row yet. Send the same token again with the name, race,
 * and class the player already picked on the creation screen.
 */
export function helloAfterNeedCreate(
  token: string,
  reason: string,
  choice: HelloChoice,
): ReturnType<typeof gameHello> | null {
  if (reason !== "need_create") return null;
  const name = choice.username.trim();
  if (name.length < 2) return null;
  return gameHello(token, { ...choice, username: name });
}

/** Socket hook: on `need_create`, write the creation-screen hello back to the server. */
export function answerNeedCreate(
  msg: { t?: string; reason?: string },
  token: string,
  choice: HelloChoice,
  send: (body: ReturnType<typeof gameHello>) => void,
) {
  if (msg.t !== "error") return;
  const next = helloAfterNeedCreate(token, msg.reason ?? "", choice);
  if (next) send(next);
}

/** Map a local isle intent onto the wire. Debug ops and ids never leave the browser. */
export function toServerIntent(intent: {
  op: string;
  x?: number;
  z?: number;
  rotation?: number;
  targetId?: string | null;
  skill?: string;
  cityId?: string;
  itemId?: string;
  slot?: string;
  skillId?: string;
  cls?: string;
  msg?: string;
  graveId?: string;
  toName?: string;
  fromId?: string;
  name?: string;
  tag?: string;
  kind?: string;
  crest?: string;
  guildId?: string;
  userName?: string;
  channel?: string;
  plotId?: string;
}): Record<string, unknown> | null {
  switch (intent.op) {
    case "move":
      if (typeof intent.x !== "number" || typeof intent.z !== "number" || typeof intent.rotation !== "number")
        return null;
      return { op: "move", x: intent.x, z: intent.z, rotation: intent.rotation };
    case "attack":
      return { op: "attack", targetId: intent.targetId ?? null };
    case "skill":
      if (!intent.skill) return null;
      return { op: "skill", name: intent.skill, targetId: intent.targetId ?? null };
    case "travel":
      if (!intent.cityId) return null;
      return { op: "travel", cityId: intent.cityId };
    case "buy":
      if (!intent.itemId) return null;
      return { op: "buy", itemId: intent.itemId };
    case "sell":
      if (!intent.itemId) return null;
      return { op: "sell", itemId: intent.itemId };
    case "use":
    case "useItem":
      if (!intent.itemId) return null;
      return { op: "useItem", itemId: intent.itemId };
    case "equip":
      if (!intent.itemId) return null;
      return { op: "equip", itemId: intent.itemId };
    case "unequip":
      if (!intent.slot) return null;
      return { op: "unequip", slot: intent.slot };
    case "train":
      if (!intent.skillId) return null;
      return { op: "train", skillId: intent.skillId };
    case "promote":
      if (!intent.cls) return null;
      return { op: "promote", cls: intent.cls };
    case "chat":
      return intent.channel === "guild"
        ? { op: "chat", msg: intent.msg ?? "", channel: "guild" }
        : { op: "chat", msg: intent.msg ?? "" };
    case "respawn":
      return { op: "respawn" };
    case "loot":
      if (!intent.graveId) return null;
      return { op: "loot", graveId: intent.graveId };
    case "partyInvite":
      if (!intent.toName) return null;
      return { op: "partyInvite", toName: intent.toName };
    case "partyAccept":
      if (!intent.fromId) return null;
      return { op: "partyAccept", fromId: intent.fromId };
    case "partyDecline":
      if (!intent.fromId) return null;
      return { op: "partyDecline", fromId: intent.fromId };
    case "partyLeave":
      return { op: "partyLeave" };
    case "buyCharter":
      return { op: "buyCharter" };
    case "foundGuild":
      return {
        op: "foundGuild",
        name: intent.name ?? "",
        tag: intent.tag ?? "",
        kind: intent.kind ?? "",
        crest: intent.crest ?? "",
      };
    case "guildInvite":
      if (!intent.toName) return null;
      return { op: "guildInvite", toName: intent.toName };
    case "guildAccept":
      if (!intent.guildId) return null;
      return { op: "guildAccept", guildId: intent.guildId };
    case "guildDecline":
      if (!intent.guildId) return null;
      return { op: "guildDecline", guildId: intent.guildId };
    case "guildLeave":
      return { op: "guildLeave" };
    case "guildKick":
      if (!intent.userName) return null;
      return { op: "guildKick", userName: intent.userName };
    case "guildPromote":
      if (!intent.userName) return null;
      return { op: "guildPromote", userName: intent.userName };
    case "guildDemote":
      if (!intent.userName) return null;
      return { op: "guildDemote", userName: intent.userName };
    case "plantCornerstone":
      if (!intent.plotId) return null;
      return { op: "plantCornerstone", plotId: intent.plotId };
    case "removeCornerstone":
      return { op: "removeCornerstone" };
    default:
      return null;
  }
}
