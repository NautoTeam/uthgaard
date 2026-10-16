import { blocked } from "../../src/shared/sim/geo";
import { MAX_SPEED, type World } from "../../src/shared/sim/world";
import type { ActionResult } from "../../src/shared/sim/types";
import type { Intent } from "../../src/shared/net/protocol";
import { buyCharter, foundGuildNow, guildAct, type GuildBook } from "./guilds";

/** One authoritative tick. 20 Hz, matching the server loop. */
export const TICK_DT = 1 / 20;

/**
 * Furthest a single move intent may land from the hero.
 * The client walks at MAX_SPEED and reports a position about every 70ms.
 * Half a second of that pace covers send jitter and a dropped packet.
 * A multi-tile teleport still fails.
 */
export const MOVE_ALLOW = MAX_SPEED * 0.5;

/**
 * Apply one client intent. `move` is rejected when it jumps farther than
 * {@link MOVE_ALLOW}, or when the destination tile is not walkable.
 */
export function applyIntent(
  world: World,
  playerId: string,
  intent: Intent,
  guilds?: GuildBook,
): ActionResult {
  switch (intent.op) {
    case "move": {
      const p = world.players.get(playerId);
      if (!p || p.hp <= 0) return { ok: false, reason: "You cannot move." };
      const dist = Math.hypot(intent.x - p.x, intent.z - p.z);
      if (dist > MOVE_ALLOW) return { ok: false, reason: "Too fast." };
      if (blocked(intent.x, intent.z)) return { ok: false, reason: "Blocked." };
      return world.move(playerId, intent.x, intent.z, intent.rotation);
    }
    case "attack":
      return world.attack(playerId, intent.targetId);
    case "skill":
      return world.skill(playerId, intent.name, intent.targetId);
    case "travel":
      return world.travel(playerId, intent.cityId);
    case "buy":
      return world.buy(playerId, intent.itemId);
    case "sell":
      return world.sell(playerId, intent.itemId);
    case "useItem":
      return world.useItem(playerId, intent.itemId);
    case "equip":
      return world.equip(playerId, intent.itemId);
    case "unequip":
      return world.unequip(playerId, intent.slot);
    case "train":
      return world.train(playerId, intent.skillId);
    case "promote":
      return world.promote(playerId, intent.cls);
    case "chat":
      return world.chat(playerId, intent.msg);
    case "respawn":
      return world.respawn(playerId);
    case "loot":
      return world.loot(playerId, intent.graveId);
    case "partyInvite":
      return world.partyInvite(playerId, intent.toName);
    case "partyAccept":
      return world.partyAccept(playerId, intent.fromId);
    case "partyDecline":
      return world.partyDecline(playerId, intent.fromId);
    case "partyLeave":
      return world.partyLeave(playerId);
    case "buyCharter":
      return buyCharter(world, playerId, guilds);
    case "foundGuild":
      if (!guilds) return { ok: false, reason: "You cannot do that." };
      return foundGuildNow(world, guilds, playerId, intent);
    case "guildInvite":
    case "guildAccept":
    case "guildDecline":
    case "guildLeave":
    case "guildKick":
    case "guildPromote":
    case "guildDemote":
      if (!guilds) return { ok: false, reason: "You cannot do that." };
      return guildAct(world, guilds, playerId, intent);
    default:
      return { ok: false, reason: "unknown op" };
  }
}
