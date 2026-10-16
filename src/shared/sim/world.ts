import { CITIES, NPCS, arrivalAt, arrivalSalt, blocked, cityAt, nearestOpen, nearestTrainer, nearestVendor, nearestWayfarer, resolveMove, screenGap } from "./geo";
import { HAVEN_ZONE_RADIUS, havenCity } from "./mask";
import { DROPS, VENDOR_STOCK, dropChance, itemById, gearTotals, equipDenied, trainedDamage, hitChance, trainPointsFor, skillById, poolsFor, defaultHotbar, conXp, conFor, mobByType, mobHp, mobLabel, powerById, attrsFor, DEATH_SHROUD_MS } from "../content/catalog";
import { DEFAULT_ATTUNED, gateHop } from "../content/world";
import type { GraveState, PartyView, PendingInvite } from "./types";
import {
  CAMPS,
  PRESTIGE_OF,
  xpNeed,
  type ActionResult,
  type BaseClass,
  type MonsterState,
  type PlayerState,
  type Prestige,
  type PublicState,
  type Race,
} from "./types";

function starterWeapon(base: string, prestige: string) {
  if (base === "Rogue" || prestige === "Scout") return "dagger";
  if (base === "Healer" || base === "Mage" || prestige === "Priest" || prestige === "Wizard") return "oak-staff";
  return "iron-sword";
}

function hearthOf(race: Race): { x: number; z: number; name: string } {
  if (race === "Marshwarden") {
    const city = cityAt("fenhollow");
    if (city) return { x: city.x, z: city.z, name: "Fenhollow" };
  }
  const city = cityAt("uthgaard");
  return { x: city?.x ?? 0, z: city?.z ?? 0, name: "the Village of Caldrenmoor" };
}

export interface JoinInput {
  id: string;
  username: string;
  race: Race;
  baseClass: BaseClass;
  prestigeClass?: Prestige;
  level?: number;
  xp?: number;
  gold?: number;
  x?: number;
  z?: number;
  inventory?: Record<string, number>;
  equipment?: Record<string, string>;
  trainPoints?: number;
  skills?: Record<string, number>;
  hotbar?: string[];
  shroudUntil?: number;
  attunedGates?: string[];
  hp?: number;
  /** Death already took gold and XP. A reload must not take them again. */
  deathSettled?: boolean;
}

function applyStats(p: PlayerState) {
  const a = attrsFor(p.race, p.baseClass);
  p.str = a.str;
  p.dex = a.dex;
  p.con = a.con;
  p.int = a.int;
  p.spi = a.spi;
  const pools = poolsFor(p);
  p.maxHp = pools.maxHp;
  p.maxMana = pools.maxMana;
  p.maxStamina = pools.maxStamina;
  if (p.hp == null || p.hp > p.maxHp) p.hp = p.maxHp;
  if (p.mana == null || p.mana > p.maxMana) p.mana = p.maxMana;
  if (p.stamina == null || p.stamina > p.maxStamina) p.stamina = p.maxStamina;
  if (!p.inventory) p.inventory = {};
  if (!p.equipment) p.equipment = {};
  if (p.trainPoints == null) p.trainPoints = 0;
  if (!p.skills) p.skills = {};
  if (!p.cooldowns) p.cooldowns = {};
  if (!p.guardUntil) p.guardUntil = 0;
  if (!p.wallUntil) p.wallUntil = 0;
  if (!p.stealthUntil) p.stealthUntil = 0;
  if (p.shroudUntil == null) p.shroudUntil = 0;
  if (p.graveDropped == null) p.graveDropped = false;
  if (!p.attunedGates?.length) p.attunedGates = [...DEFAULT_ATTUNED];
  const bar = defaultHotbar(p.baseClass, p.prestigeClass, p.level);
  if (!p.hotbar || p.hotbar.length !== 8) p.hotbar = bar;
  else for (let i = 0; i < 8; i++) if (!p.hotbar[i]) p.hotbar[i] = bar[i];
}

function levelUp(p: PlayerState) {
  while (p.xp >= xpNeed(p.level) && p.level < 25) {
    p.xp -= xpNeed(p.level);
    p.level++;
    applyStats(p);
    p.hp = p.maxHp;
    p.mana = p.maxMana;
    p.stamina = p.maxStamina;
    p.trainPoints = (p.trainPoints || 0) + trainPointsFor(p.race);
  }
}

/** Walk pace in tiles per second. Keys, the stick, and click-to-walk all use this. */
export const MAX_SPEED = 4.55;

/** Living party members within this many tiles of the killer share the kill XP. */
export const GROUP_NEAR = 18;
export const PARTY_MAX = 5;
/** Invites older than this are gone. */
export const INVITE_MS = 60_000;

export function createWorld(opts: { now?: () => number; rand?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const rand = opts.rand ?? Math.random;
  const players = new Map<string, PlayerState>();
  const monsters = new Map<string, MonsterState>();
  const graves = new Map<string, GraveState>();
  const logs: string[] = [];
  let mid = 1;
  let partySeq = 1;
  const parties = new Map<string, { id: string; leader: string; members: string[] }>();
  const invites = new Map<string, { fromId: string; at: number }>();

  function log(msg: string) {
    logs.push(msg);
    if (logs.length > 40) logs.shift();
  }

  const SLOT_GAP = 120;

  function campSlots(cx: number, cz: number, count: number) {
    const slots: { x: number; z: number }[] = [];
    const taken = (x: number, z: number) => slots.some((s) => screenGap(x, z, s.x, s.z) < SLOT_GAP);
    for (let r = 2.2; slots.length < count && r <= 12; r += 0.4) {
      const steps = Math.max(10, Math.ceil((Math.PI * 2 * r) / 0.8));
      for (let i = 0; i < steps && slots.length < count; i++) {
        const ang = (i / steps) * Math.PI * 2 + 0.7;
        const raw = nearestOpen(cx + Math.cos(ang) * r, cz + Math.sin(ang) * r);
        const x = Math.round(raw.x);
        const z = Math.round(raw.z);
        if (blocked(x, z)) continue;
        if (Math.hypot(x - cx, z - cz) > 11) continue;
        if (taken(x, z)) continue;
        slots.push({ x, z });
      }
    }
    for (let n = 0; slots.length < count && n < 80; n++) {
      const x = Math.round(cx - 6 + (n % 13));
      const z = Math.round(cz - 6 + Math.floor(n / 13));
      if (blocked(x, z) || taken(x, z)) continue;
      slots.push({ x, z });
    }
    return slots;
  }

  function sameTile(ax: number, az: number, bx: number, bz: number) {
    // A crack on the .5 boundary rounds to two tiles but is the same spot.
    // A full step to the next tile (distance 1) must still be allowed.
    if (Math.hypot(ax - bx, az - bz) < 0.85) return true;
    return Math.round(ax) === Math.round(bx) && Math.round(az) === Math.round(bz);
  }

  function mobSharesTile(x: number, z: number, exceptId?: string) {
    for (const o of monsters.values()) {
      if (o.hp <= 0 || o.id === exceptId) continue;
      if (sameTile(x, z, o.x, o.z)) return true;
    }
    return false;
  }

  /** A point inside a haven, moved just past the rim. spin spreads a pack along the edge. */
  function outsideHaven(x: number, z: number, spin = 0) {
    const city = havenCity(x, z);
    if (!city) return { x, z };
    const d0 = Math.hypot(x - city.x, z - city.z);
    const ang = (d0 < 0.5 ? 0 : Math.atan2(z - city.z, x - city.x)) + spin;
    for (let r = HAVEN_ZONE_RADIUS + 1.2; r <= HAVEN_ZONE_RADIUS + 36; r += 1.2) {
      const spot = nearestOpen(city.x + Math.cos(ang) * r, city.z + Math.sin(ang) * r, 3);
      if (!havenCity(spot.x, spot.z)) return spot;
    }
    return {
      x: city.x + Math.cos(ang) * (HAVEN_ZONE_RADIUS + 8),
      z: city.z + Math.sin(ang) * (HAVEN_ZONE_RADIUS + 8),
    };
  }

  function inMeleeRange(ax: number, az: number, bx: number, bz: number) {
    return screenGap(ax, az, bx, bz) <= 130 || Math.hypot(ax - bx, az - bz) <= 6.4;
  }

  /** Free tile inside melee range, nearest to the fighter. Never the hero's tile. */
  function nearestMeleeStand(m: MonsterState, tx: number, tz: number) {
    if (
      inMeleeRange(m.x, m.z, tx, tz) &&
      !sameTile(m.x, m.z, tx, tz) &&
      !blocked(m.x, m.z) &&
      mobCanOccupy(m, m.x, m.z)
    ) {
      return { x: m.x, z: m.z };
    }
    let best: { x: number; z: number } | null = null;
    let bestMob = 1e9;
    for (let r = 1; r <= 6.45; r += 0.5) {
      const steps = Math.max(8, Math.ceil((Math.PI * 2 * r) / 0.55));
      for (let i = 0; i < steps; i++) {
        const ang = (i / steps) * Math.PI * 2;
        const x = tx + Math.cos(ang) * r;
        const z = tz + Math.sin(ang) * r;
        if (blocked(x, z) || sameTile(x, z, tx, tz)) continue;
        if (!inMeleeRange(x, z, tx, tz)) continue;
        if (!mobCanOccupy(m, x, z)) continue;
        const toM = Math.hypot(x - m.x, z - m.z);
        if (toM < bestMob) {
          bestMob = toM;
          best = { x, z };
        }
      }
    }
    return best;
  }

  function foeOf(m: MonsterState) {
    if (!m.targetId) return null;
    const t = players.get(m.targetId);
    if (!t || t.hp <= 0) return null;
    return t;
  }

  function mobCanOccupy(m: MonsterState, x: number, z: number) {
    // A debug foe is allowed to stand in town. Real camps still cannot enter a haven.
    if (!m.id.startsWith("t")) {
      const inside = havenCity(x, z);
      if (inside) {
        const from = havenCity(m.x, m.z);
        if (!from) return false;
        const before = Math.hypot(m.x - from.x, m.z - from.z);
        const after = Math.hypot(x - from.x, z - from.z);
        if (after <= before + 0.001) return false;
      }
    }
    const foe = foeOf(m);
    if (foe && sameTile(x, z, foe.x, foe.z)) return false;
    if (mobSharesTile(x, z, m.id)) return false;
    return true;
  }

  function applyMobStep(m: MonsterState, nx: number, nz: number) {
    const pos = resolveMove(m.x, m.z, nx, nz);
    if (!mobCanOccupy(m, pos.x, pos.z)) return false;
    if (pos.x === m.x && pos.z === m.z) return false;
    m.x = pos.x;
    m.z = pos.z;
    return true;
  }

  function stepOffTile(m: MonsterState, tx: number, tz: number) {
    let best: { x: number; z: number } | null = null;
    let bestD = 1e9;
    for (const dist of [1.15, 1.7, 2.3]) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ] as const) {
        const len = Math.hypot(dx, dz) || 1;
        const pos = resolveMove(m.x, m.z, m.x + (dx / len) * dist, m.z + (dz / len) * dist);
        if (sameTile(pos.x, pos.z, tx, tz) || blocked(pos.x, pos.z)) continue;
        if (!mobCanOccupy(m, pos.x, pos.z)) continue;
        const d = Math.hypot(pos.x - tx, pos.z - tz);
        if (d < bestD) {
          bestD = d;
          best = pos;
        }
      }
      if (best) break;
    }
    if (!best) return;
    m.x = best.x;
    m.z = best.z;
  }

  function fleeHaven(m: MonsterState) {
    const city = havenCity(m.x, m.z);
    if (!city) return false;
    const dx = m.x - city.x;
    const dz = m.z - city.z;
    const d = Math.hypot(dx, dz) || 1;
    const ux = dx / d;
    const uz = dz / d;
    const step = 0.38;
    if (applyMobStep(m, m.x + ux * step, m.z + uz * step)) return true;
    for (const turn of [0.7, -0.7, 1.4, -1.4, 2.2, -2.2]) {
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      const rx = ux * c - uz * s;
      const rz = ux * s + uz * c;
      if (applyMobStep(m, m.x + rx * step, m.z + rz * step)) return true;
    }
    return true;
  }

  /** A camp tile is free when nobody stands there and nobody is homed there. */
  function campTileFree(x: number, z: number, exceptId?: string) {
    if (blocked(x, z) || havenCity(x, z)) return false;
    for (const o of monsters.values()) {
      if (o.hp <= 0 || o.id === exceptId) continue;
      if (sameTile(x, z, o.x, o.z)) return false;
      if (Number.isFinite(o.slotX) && sameTile(x, z, o.slotX, o.slotZ)) return false;
    }
    return true;
  }

  /** Another free tile inside this camp's spawn radius. Never a shared tile. */
  function takeCampSpot(ox: number, oz: number, exceptId?: string, maxR = 11.5): { x: number; z: number } | null {
    const accept = (x: number, z: number) =>
      Number.isFinite(x) &&
      Number.isFinite(z) &&
      Math.hypot(x - ox, z - oz) <= maxR &&
      campTileFree(x, z, exceptId);
    if (accept(ox, oz)) return { x: ox, z: oz };
    const slots = campSlots(ox, oz, 24);
    for (let i = 0; i < slots.length; i++) {
      const raw = slots[i];
      const spot = havenCity(raw.x, raw.z) ? outsideHaven(raw.x, raw.z, i * 0.31) : raw;
      if (accept(spot.x, spot.z)) return spot;
    }
    for (let r = 1.1; r <= maxR; r += 0.55) {
      const steps = Math.max(10, Math.ceil((Math.PI * 2 * r) / 0.8));
      for (let i = 0; i < steps; i++) {
        const ang = (i / steps) * Math.PI * 2 + r;
        const raw = nearestOpen(ox + Math.cos(ang) * r, oz + Math.sin(ang) * r, 2);
        const spot = havenCity(raw.x, raw.z) ? outsideHaven(raw.x, raw.z, ang) : raw;
        if (accept(spot.x, spot.z)) return spot;
      }
    }
    return null;
  }

  /** Camp center, or the nearest ground outside every haven when the center is in town. */
  function campAnchor(cx: number, cz: number) {
    if (!havenCity(cx, cz) && !blocked(cx, cz)) return { x: cx, z: cz };
    const pushed = outsideHaven(cx, cz);
    if (!havenCity(pushed.x, pushed.z) && !blocked(pushed.x, pushed.z)) return pushed;
    const city = havenCity(cx, cz);
    const prefer = city ? Math.atan2(cz - city.z, cx - city.x) : 0;
    for (let r = 2; r <= 48; r += 1) {
      const steps = Math.max(16, Math.ceil((Math.PI * 2 * r) / 1.1));
      let best: { x: number; z: number } | null = null;
      let bestTurn = 1e9;
      for (let i = 0; i < steps; i++) {
        const ang = (i / steps) * Math.PI * 2;
        const x = cx + Math.cos(ang) * r;
        const z = cz + Math.sin(ang) * r;
        if (havenCity(x, z) || blocked(x, z)) continue;
        let turn = Math.abs(Math.atan2(z - cz, x - cx) - prefer);
        if (turn > Math.PI) turn = Math.PI * 2 - turn;
        if (turn < bestTurn) {
          bestTurn = turn;
          best = { x, z };
        }
      }
      if (best) return best;
    }
    return pushed;
  }

  for (const camp of CAMPS) {
    const origin = campAnchor(camp.cx, camp.cz);
    for (let i = 0; i < camp.count; i++) {
      const placed = takeCampSpot(origin.x, origin.z) ?? takeCampSpot(origin.x, origin.z, undefined, 18);
      if (!placed) continue;
      const id = "m" + mid++;
      const hp = mobHp(camp.type, camp.level);
      monsters.set(id, {
        id,
        type: camp.type,
        level: camp.level,
        maxHp: hp,
        hp,
        x: placed.x,
        z: placed.z,
        homeX: camp.cx,
        homeZ: camp.cz,
        slotX: placed.x,
        slotZ: placed.z,
        targetId: null,
        respawnAt: 0,
        nextHit: 0,
        snareUntil: 0,
      });
    }
  }

  function snapshot(): PublicState {
    return {
      players: [...players.values()].map((p) => ({ ...p })),
      monsters: [...monsters.values()]
        .filter((m) => {
          for (const p of players.values()) {
            if (p.hp <= 0) continue;
            if (Math.hypot(p.x - m.x, p.z - m.z) <= 70) return true;
          }
          return false;
        })
        .map((m) => ({ ...m })),
      logs: logs.slice(),
      graves: [...graves.values()].map((g) => ({ ...g, items: { ...g.items } })),
    };
  }

  function restore(state: PublicState) {
    players.clear();
    monsters.clear();
    parties.clear();
    invites.clear();
    for (const p of state.players) {
      if (!p.inventory) p.inventory = {};
      const row = { ...p, inventory: { ...(p.inventory ?? {}) }, equipment: { ...(p.equipment ?? {}) }, skills: { ...(p.skills ?? {}) } };
      players.set(p.id, row);
      const prevMax = row.maxHp;
      applyStats(row);
      if (prevMax !== row.maxHp && (row.hp >= prevMax - 0.5 || prevMax === 100)) {
        row.hp = row.maxHp;
        row.mana = row.maxMana;
        row.stamina = row.maxStamina;
      }
    }
    for (const m of state.monsters) {
      const slotX = m.slotX ?? m.x;
      const slotZ = m.slotZ ?? m.z;
      monsters.set(m.id, { ...m, slotX, slotZ });
    }
    logs.splice(0, logs.length, ...state.logs.slice(-40));
    if (Array.isArray(state.graves)) {
      graves.clear();
      for (const g of state.graves) graves.set(g.id, { ...g, items: { ...(g.items ?? {}) } });
    }
  }

  function join(input: JoinInput): PlayerState {
    const existing = players.get(input.id);
    if (existing) return existing;
    const prestige = input.prestigeClass || "";
    const matched =
      prestige && PRESTIGE_OF[input.baseClass] === prestige ? prestige : "";
    const home = hearthOf(input.race);
    const occupied = [...players.values()]
      .filter((p) => p.hp > 0)
      .map((p) => ({ x: p.x, z: p.z }));
    let spot =
      typeof input.x === "number" && typeof input.z === "number"
        ? nearestOpen(input.x, input.z)
        : arrivalAt(home.x, home.z, occupied, arrivalSalt(input.id));
    if (occupied.some((o) => Math.hypot(o.x - spot.x, o.z - spot.z) < 0.85)) {
      spot = arrivalAt(home.x, home.z, occupied, arrivalSalt(input.id));
    }
    const player: PlayerState = {
      id: input.id,
      username: input.username.slice(0, 16),
      race: input.race,
      baseClass: input.baseClass,
      prestigeClass: matched,
      level: input.level || 1,
      xp: input.xp || 0,
      gold: input.gold ?? 40,
      x: spot.x,
      z: spot.z,
      rotation: 0,
      hp: 0,
      mana: 0,
      stamina: 0,
      maxHp: 100,
      maxMana: 50,
      maxStamina: 50,
      str: 0,
      dex: 0,
      con: 0,
      int: 0,
      spi: 0,
      nextSwing: 0,
      inventory: { ...(input.inventory ?? {}) },
      equipment: { ...(input.equipment ?? {}) },
      trainPoints: input.trainPoints ?? 0,
      skills: { ...(input.skills ?? {}) },
      hotbar: input.hotbar ? [...input.hotbar] : [],
      cooldowns: {},
      guardUntil: 0,
      wallUntil: 0,
      stealthUntil: 0,
      shroudUntil: input.shroudUntil ?? 0,
      graveDropped: false,
      attunedGates: input.attunedGates?.length ? [...input.attunedGates] : [...DEFAULT_ATTUNED],
    };
    const ownedWeapon = ["iron-sword", "dagger", "mace", "oak-staff"].some(
      (id) => player.equipment.weapon === id || (player.inventory[id] ?? 0) > 0,
    );
    if (!player.equipment.weapon && !ownedWeapon) {
      player.equipment.weapon = starterWeapon(player.baseClass, player.prestigeClass);
    }
    applyStats(player);
    const savedHp = typeof input.hp === "number" ? input.hp : null;
    player.hp = savedHp == null ? player.maxHp : Math.max(0, Math.min(player.maxHp, savedHp));
    player.mana = player.maxMana;
    player.stamina = player.maxStamina;
    if (player.hp <= 0) {
      if (input.deathSettled) player.graveDropped = true;
      else dropGrave(player);
    }
    players.set(player.id, player);
    log(`${player.username} entered ${home.name}.`);
    return player;
  }

  function leave(id: string): PlayerState | null {
    const p = players.get(id);
    if (!p) return null;
    removeFromParty(id);
    invites.delete(id);
    for (const [toId, invite] of invites) {
      if (invite.fromId === id) invites.delete(toId);
    }
    players.delete(id);
    log(`${p.username} left the island.`);
    return p;
  }

  function move(id: string, x: number, z: number, rotation: number): ActionResult {
    const p = players.get(id);
    if (!p || p.hp <= 0) return { ok: false };
    const next = resolveMove(p.x, p.z, x, z);
    p.x = next.x;
    p.z = next.z;
    p.rotation = rotation || 0;
    attuneNearby(p);
    return { ok: true };
  }

  function attuneNearby(p: PlayerState) {
    if (!p.attunedGates) p.attunedGates = [...DEFAULT_ATTUNED];
    for (const city of CITIES) {
      const wayfarer = NPCS.find((npc) => npc.city === city.id && npc.role === "wayfarer");
      if (!wayfarer || p.attunedGates.includes(city.id)) continue;
      if (Math.hypot(p.x - wayfarer.x, p.z - wayfarer.z) > 6) continue;
      p.attunedGates.push(city.id);
      log(`${city.name} stones attuned.`);
    }
  }

  function partyOf(id: string) {
    for (const party of parties.values()) {
      if (party.members.includes(id)) return party;
    }
    return undefined;
  }

  function findByName(name: string) {
    const want = name.trim().toLowerCase();
    if (!want) return null;
    for (const row of players.values()) {
      if (row.username.toLowerCase() === want) return row;
    }
    return null;
  }

  function removeFromParty(id: string) {
    const party = partyOf(id);
    if (!party) return;
    party.members = party.members.filter((memberId) => memberId !== id);
    if (party.members.length < 2) {
      parties.delete(party.id);
      return;
    }
    if (party.leader === id) party.leader = party.members[0];
  }

  /** Drop a stale invite. `expired` is true only when this invite existed and timed out. */
  function freshInvite(toId: string, fromId: string): { ok: true } | { ok: false; expired: boolean } {
    const invite = invites.get(toId);
    if (!invite || invite.fromId !== fromId) return { ok: false, expired: false };
    if (!players.has(invite.fromId)) {
      invites.delete(toId);
      return { ok: false, expired: false };
    }
    if (now() - invite.at >= INVITE_MS) {
      invites.delete(toId);
      return { ok: false, expired: true };
    }
    return { ok: true };
  }

  function partyInvite(id: string, toName: string): ActionResult {
    const p = players.get(id);
    if (!p) return { ok: false, reason: "No such hero." };
    const target = findByName(toName);
    if (!target) return { ok: false, reason: "No one by that name." };
    if (target.id === id) return { ok: false, reason: "You cannot invite yourself." };
    const mine = partyOf(id);
    const theirs = partyOf(target.id);
    if (mine && theirs === mine) return { ok: false, reason: `${target.username} is already in the group.` };
    if (theirs) return { ok: false, reason: "They are already in a party." };
    if (mine && mine.members.length >= PARTY_MAX) return { ok: false, reason: "The party is full." };
    invites.set(target.id, { fromId: id, at: now() });
    return { ok: true, reason: `You invite ${target.username}.` };
  }

  function partyAccept(id: string, fromId: string): ActionResult {
    const p = players.get(id);
    if (!p) return { ok: false, reason: "No such hero." };
    const invite = freshInvite(id, fromId);
    if (!invite.ok) return { ok: false, reason: invite.expired ? "That invite expired." : "No invite." };
    invites.delete(id);
    if (partyOf(id)) return { ok: false, reason: "You are already in a party." };
    const leader = players.get(fromId);
    if (!leader) return { ok: false, reason: "They are no longer here." };
    let party = partyOf(fromId);
    if (party) {
      if (party.members.length >= PARTY_MAX) return { ok: false, reason: "The party is full." };
      party.members.push(id);
    } else {
      party = { id: "g" + partySeq++, leader: fromId, members: [fromId, id] };
      parties.set(party.id, party);
    }
    log(`${p.username} joins the party.`);
    return { ok: true, reason: "You join the group." };
  }

  function partyDecline(id: string, fromId: string): ActionResult {
    const p = players.get(id);
    if (!p) return { ok: false, reason: "No such hero." };
    const invite = invites.get(id);
    if (!invite || invite.fromId !== fromId) return { ok: false, reason: "No invite." };
    invites.delete(id);
    log(`${p.username} declines.`);
    return { ok: true, reason: "You decline." };
  }

  function partyLeave(id: string): ActionResult {
    const p = players.get(id);
    if (!p) return { ok: false, reason: "No such hero." };
    if (!partyOf(id)) return { ok: false, reason: "You are not in a party." };
    removeFromParty(id);
    log(`${p.username} leaves the party.`);
    return { ok: true, reason: "You leave the group." };
  }

  function membersNear(origin: PlayerState): PlayerState[] {
    const party = partyOf(origin.id);
    if (!party) return [origin];
    const rows: PlayerState[] = [];
    for (const memberId of party.members) {
      const other = players.get(memberId);
      if (!other || other.hp <= 0) continue;
      if (Math.hypot(other.x - origin.x, other.z - origin.z) > GROUP_NEAR) continue;
      rows.push(other);
    }
    if (!rows.some((row) => row.id === origin.id)) rows.unshift(origin);
    return rows;
  }

  function social(id: string): { party: PartyView | null; pendingInvite: PendingInvite | null } {
    const party = partyOf(id);
    let view: PartyView | null = null;
    if (party && party.members.length >= 2) {
      view = {
        id: party.id,
        leader: party.leader,
        members: party.members.map((memberId) => {
          const row = players.get(memberId);
          return {
            id: memberId,
            name: row?.username ?? "Hero",
            hp: row?.hp ?? 0,
            maxHp: Math.max(1, row?.maxHp ?? 1),
          };
        }),
      };
    }
    const pending = invites.get(id);
    let pendingInvite: PendingInvite | null = null;
    if (pending) {
      const fresh = freshInvite(id, pending.fromId);
      if (fresh.ok) {
        pendingInvite = {
          fromId: pending.fromId,
          fromName: players.get(pending.fromId)?.username ?? "Someone",
        };
      }
    }
    return { party: view, pendingInvite };
  }

  function finishKill(p: PlayerState, m: MonsterState, gold: number, line: string) {
    if (m.respawnAt) return 0;
    m.respawnAt = now() + 15000;
    const def = mobByType(m.type);
    const base = conXp(m.level, p.level, def.xpBase + m.level * def.xpPerLevel);
    const near = membersNear(p);
    const extra = near.length - 1;
    const bonus = base > 0 && extra > 0 ? Math.ceil(base * 0.1 * extra) : 0;
    const total = base + bonus;
    p.gold += gold;
    if (!p.inventory) p.inventory = {};
    for (const drop of DROPS) {
      if (drop.mob !== m.type) continue;
      if (rand() > dropChance(drop)) continue;
      const item = itemById(drop.itemId);
      if (!item) continue;
      p.inventory[item.id] = (p.inventory[item.id] ?? 0) + 1;
      log(`${p.username} picked up ${item.name}.`);
    }
    let killerDing = "";
    for (const member of near) {
      const before = member.level;
      member.xp += total;
      levelUp(member);
      if (member.id === p.id) killerDing = member.level > before ? ` and reached level ${member.level}` : "";
      else if (member.level > before) log(`${member.username} reached level ${member.level}.`);
    }
    m.targetId = null;
    log(line.replace("{xp}", String(total)).replace("{ding}", killerDing));
    return total;
  }

  function canUse(p: PlayerState, classes: string[]) {
    if (!classes.length) return true;
    return classes.includes(p.baseClass) || classes.includes(p.prestigeClass);
  }

  function strike(p: PlayerState, m: MonsterState, powerId: string, now: number): ActionResult {
    const power = powerById(powerId);
    if (!power || (power.kind !== "damage" && power.kind !== "snare")) return { ok: false, reason: "That path cannot use this." };
    if (!canUse(p, power.classes)) return { ok: false, reason: "That path cannot use this." };
    if (m.hp <= 0) return { ok: false, reason: "Nothing in reach." };
    if (Math.hypot(p.x - m.x, p.z - m.z) > power.range) return { ok: false, reason: "Too far." };
    if (!p.cooldowns) p.cooldowns = {};
    const readyAt = Math.max(p.cooldowns[power.id] ?? 0, powerId === "attack" ? p.nextSwing || 0 : 0);
    if (now < readyAt) return { ok: false, reason: "Not ready yet." };
    if (power.mana > 0 && p.mana < power.mana) return { ok: false, reason: "Not enough mana." };
    if (power.stamina > 0 && p.stamina < power.stamina) return { ok: false, reason: "Not enough stamina." };
    if (power.mana === 0 && rand() * 100 >= hitChance(p)) {
      const cd = now + power.cooldown;
      p.cooldowns[power.id] = cd;
      if (powerId === "attack") p.nextSwing = cd;
      return { ok: true, dmg: 0, reason: "Missed." };
    }
    p.mana -= power.mana;
    p.stamina -= power.stamina || 0;
    p.cooldowns[power.id] = now + power.cooldown;
    if (powerId === "attack") p.nextSwing = p.cooldowns[power.id];
    const bonus = power.bonus[p.baseClass] ?? power.bonus[p.prestigeClass] ?? 0;
    const strBonus = power.mana > 0 ? 0 : Math.max(0, Math.floor((p.str - 20) / 10));
    const gear = power.mana > 0 ? 0 : gearTotals(p.equipment).damage;
    let dmg =
      powerId === "attack"
        ? trainedDamage(p)
        : power.damage + p.level * power.damagePerLevel + bonus + strBonus + gear;
    if (powerId === "backstab" && p.stealthUntil > now) {
      dmg *= 2;
      p.stealthUntil = 0;
    }
    m.hp = Math.max(0, m.hp - dmg);
    m.targetId = p.id;
    p.stealthUntil = 0;
    if (power.kind === "snare") m.snareUntil = now + 4000;
    if (m.hp <= 0) {
      const gold = powerId === "fireball" ? 2 : 1 + Math.floor(m.level / (powerId === "stab" ? 3 : 2));
      const verb =
        powerId === "fireball"
          ? `${p.username}'s fireball destroyed a ${mobLabel(m.type)} (+{xp} XP){ding}.`
          : powerId === "stab"
            ? `${p.username} stabbed a ${mobLabel(m.type)} (+{xp} XP){ding}.`
            : `${p.username} slew a ${mobLabel(m.type)} (+{xp} XP){ding}.`;
      const xp = finishKill(p, m, gold, verb);
      return { ok: true, dmg, reason: `+${xp} XP` };
    }
    const hit = power.label || "Attack";
    const snare = power.kind === "snare" ? " Snared." : "";
    return { ok: true, dmg, reason: `${hit} hits for ${dmg}.${snare}` };
  }

  function attack(id: string, targetId: string | null): ActionResult {
    const p = players.get(id);
    const m = targetId ? monsters.get(targetId) : undefined;
    if (!p || p.hp <= 0 || !m || m.hp <= 0) return { ok: false, reason: "Nothing in reach." };
    return strike(p, m, "attack", now());
  }

  function beginPower(p: PlayerState, powerId: string, now: number): ActionResult | null {
    const power = powerById(powerId);
    if (!power) return { ok: false, reason: "That path cannot use this." };
    if (p.level < power.level) return { ok: false, reason: `Requires level ${power.level}.` };
    if (!canUse(p, power.classes)) return { ok: false, reason: "That path cannot use this." };
    if (power.mana > 0 && p.shroudUntil > now) return { ok: false, reason: "Grave Chill prevents casting." };
    if (!p.cooldowns) p.cooldowns = {};
    if (now < (p.cooldowns[power.id] ?? 0)) return { ok: false, reason: "Not ready yet." };
    if (power.mana > 0 && p.mana < power.mana) return { ok: false, reason: "Not enough mana." };
    if (power.stamina > 0 && p.stamina < power.stamina) return { ok: false, reason: "Not enough stamina." };
    return null;
  }

  function payPower(p: PlayerState, powerId: string, now: number) {
    const power = powerById(powerId)!;
    p.mana -= power.mana;
    p.stamina -= power.stamina || 0;
    if (!p.cooldowns) p.cooldowns = {};
    p.cooldowns[power.id] = now + power.cooldown;
  }

  function skill(id: string, name: string, targetId: string | null): ActionResult {
    const p = players.get(id);
    if (!p || p.hp <= 0) return { ok: false, reason: "You cannot act." };
    const power = powerById(name);
    if (!power) return { ok: false, reason: "That path cannot use this." };
    const at = now();
    const blockedPower = beginPower(p, name, at);
    if (blockedPower) return blockedPower;
    if (power.id === "succor") {
      let ally = targetId ? players.get(targetId) : undefined;
      if (!ally || ally.hp <= 0) {
        let best: PlayerState | null = null;
        let bestD = power.range;
        for (const other of players.values()) {
          if (other.hp <= 0 || other.shroudUntil <= at) continue;
          const d = Math.hypot(other.x - p.x, other.z - p.z);
          if (d <= bestD) {
            best = other;
            bestD = d;
          }
        }
        ally = best ?? p;
      }
      if (Math.hypot(ally.x - p.x, ally.z - p.z) > power.range) return { ok: false, reason: "Too far." };
      const shrouded = ally.shroudUntil > at;
      if (!shrouded && ally.hp >= ally.maxHp - 0.5) return { ok: false, reason: "Already at full health." };
      payPower(p, name, at);
      const gain = Math.min(ally.maxHp - ally.hp, power.heal + p.level * power.healPerLevel);
      ally.hp += gain;
      if (shrouded) {
        ally.shroudUntil = 0;
        return { ok: true, reason: `Rekindle lifts Grave Chill from ${ally.username}.` };
      }
      return { ok: true, reason: `${power.label} heals for ${Math.round(gain)}.` };
    }
    if (power.kind === "heal") {
      if (p.hp >= p.maxHp - 0.5) return { ok: false, reason: "Already at full health." };
      payPower(p, name, at);
      const gain = Math.min(p.maxHp - p.hp, power.heal + p.level * power.healPerLevel);
      p.hp += gain;
      return { ok: true, reason: `${power.label} heals for ${Math.round(gain)}.` };
    }
    if (power.kind === "buff" || power.kind === "stealth") {
      payPower(p, name, at);
      if (power.id === "wall") p.wallUntil = at + 6000;
      else if (power.kind === "stealth") p.stealthUntil = at + 10000;
      else {
        p.guardUntil = at + 8000;
        if (power.heal > 0) p.hp = Math.min(p.maxHp, p.hp + power.heal + p.level * power.healPerLevel);
      }
      if (power.kind === "stealth") return { ok: true, reason: "You slip into stealth." };
      return { ok: true, reason: `${power.label} raised.` };
    }
    const m = targetId ? monsters.get(targetId) : undefined;
    if (!m || m.hp <= 0) return { ok: false, reason: "Nothing in reach." };
    return strike(p, m, power.id, at);
  }

  function promote(id: string, cls: string): ActionResult {
    const p = players.get(id);
    const allowed = PRESTIGE_OF[p?.baseClass || "Fighter"];
    if (!p || p.level < 10 || p.prestigeClass) return { ok: false, reason: "Not ready to promote." };
    if (!nearestTrainer(p.x, p.z, 8)) return { ok: false, reason: "Find the trainer." };
    if (cls !== allowed) return { ok: false, reason: "That path is closed." };
    p.prestigeClass = allowed;
    applyStats(p);
    log(`${p.username} promoted to ${allowed}.`);
    return { ok: true };
  }

  function travel(id: string, cityId: string, extra: Array<{ x: number; z: number }> = []): ActionResult {
    const p = players.get(id);
    const city = cityAt(cityId);
    if (!p || p.hp <= 0 || !city) return { ok: false, reason: "That gate is shut." };
    const here = nearestWayfarer(p.x, p.z, 4.2);
    if (!here) return { ok: false, reason: "Find a wayfarer." };
    if (here.city === cityId) return { ok: true };
    const reason = gateHop(here.city, cityId, p.level, p.attunedGates ?? DEFAULT_ATTUNED);
    if (reason) return { ok: false, reason };
    const occupied = [
      ...[...players.values()].filter((o) => o.id !== p.id && o.hp > 0).map((o) => ({ x: o.x, z: o.z })),
      ...extra,
    ];
    const spot = arrivalAt(city.x, city.z, occupied, arrivalSalt(p.id));
    if (blocked(spot.x, spot.z)) return { ok: false, reason: "The arrival stone is blocked." };
    p.x = spot.x;
    p.z = spot.z;
    p.rotation = 0;
    if (!p.attunedGates) p.attunedGates = [...DEFAULT_ATTUNED];
    if (!p.attunedGates.includes(cityId)) {
      p.attunedGates.push(cityId);
      log(`${city.name} stones attuned.`);
    }
    log(`${p.username} stepped through the stones to ${city.name}.`);
    return { ok: true };
  }

  function setLevel(id: string, level: number): ActionResult {
    const p = players.get(id);
    if (!p) return { ok: false, reason: "No such hero." };
    const next = Math.max(1, Math.min(25, Math.floor(level) || 1));
    const gained = Math.max(0, next - p.level) * trainPointsFor(p.race);
    p.level = next;
    p.xp = 0;
    applyStats(p);
    p.hp = p.maxHp;
    p.mana = p.maxMana;
    p.stamina = p.maxStamina;
    p.trainPoints = (p.trainPoints || 0) + gained;
    log(`${p.username} is now level ${next}.`);
    return { ok: true, reason: `Level ${next}.` };
  }

  function setHp(id: string, hp: number): ActionResult {
    const p = players.get(id);
    if (!p) return { ok: false, reason: "No such hero." };
    p.hp = Math.max(0, Math.min(p.maxHp, Math.floor(hp)));
    if (p.hp <= 0) {
      dropGrave(p);
      return { ok: true, reason: "You have fallen." };
    }
    return { ok: true, reason: `HP ${Math.round(p.hp)}.` };
  }

  function buy(id: string, itemId: string): ActionResult {
    const p = players.get(id);
    const offer = VENDOR_STOCK.find((row) => row.itemId === itemId);
    const item = itemById(itemId);
    if (!p || p.hp <= 0 || !offer || !item) return { ok: false, reason: "Nothing for sale." };
    if (!nearestVendor(p.x, p.z, 8)) return { ok: false, reason: "Find the vendor." };
    if (p.gold < offer.price) return { ok: false, reason: "Not enough gold." };
    if (!p.inventory) p.inventory = {};
    p.gold -= offer.price;
    p.inventory[item.id] = (p.inventory[item.id] ?? 0) + 1;
    log(`${p.username} bought ${item.name} for ${offer.price} gold.`);
    return { ok: true, reason: `Bought ${item.name}.` };
  }

  function sell(id: string, itemId: string): ActionResult {
    const p = players.get(id);
    const item = itemById(itemId);
    const have = p?.inventory?.[itemId] ?? 0;
    if (!p || p.hp <= 0 || !item) return { ok: false, reason: "Nothing to sell." };
    if (!nearestVendor(p.x, p.z, 8)) return { ok: false, reason: "Find the vendor." };
    if (have < 1) return { ok: false, reason: "You do not have that." };
    p.inventory[itemId] = have - 1;
    if (p.inventory[itemId] <= 0) delete p.inventory[itemId];
    p.gold += item.sell;
    log(`${p.username} sold ${item.name} for ${item.sell} gold.`);
    return { ok: true, reason: `Sold ${item.name} for ${item.sell} gold.` };
  }

  function useItem(id: string, itemId: string): ActionResult {
    const p = players.get(id);
    const item = itemById(itemId);
    const have = p?.inventory?.[itemId] ?? 0;
    if (!p || p.hp <= 0 || !item) return { ok: false, reason: "You cannot use that." };
    if (item.kind !== "consumable" || item.heal <= 0) return { ok: false, reason: "You cannot use that." };
    if (have < 1) return { ok: false, reason: "You do not have that." };
    if (p.hp >= p.maxHp - 0.5) return { ok: false, reason: "Already at full health." };
    p.inventory[itemId] = have - 1;
    if (p.inventory[itemId] <= 0) delete p.inventory[itemId];
    const gain = Math.min(p.maxHp - p.hp, item.heal);
    p.hp += gain;
    return { ok: true, reason: `Used ${item.name}.` };
  }

  function equip(id: string, itemId: string): ActionResult {
    const p = players.get(id);
    const item = itemById(itemId);
    if (!p || p.hp <= 0 || !item || !item.slot) return { ok: false, reason: "You cannot equip that." };
    const denied = equipDenied(p.baseClass, p.prestigeClass, item);
    if (denied) return { ok: false, reason: denied };
    if (!p.inventory) p.inventory = {};
    if (!p.equipment) p.equipment = {};
    if ((p.inventory[itemId] ?? 0) < 1) return { ok: false, reason: "You do not have that." };
    let slot: string = item.slot;
    if (item.slot === "ring") slot = !p.equipment.ring ? "ring" : !p.equipment.ring2 ? "ring2" : "ring";
    const prev = p.equipment[slot];
    p.inventory[itemId] -= 1;
    if (p.inventory[itemId] <= 0) delete p.inventory[itemId];
    if (prev) p.inventory[prev] = (p.inventory[prev] ?? 0) + 1;
    p.equipment[slot] = itemId;
    return { ok: true, reason: `Equipped ${item.name}.` };
  }

  function unequip(id: string, slot: string): ActionResult {
    const p = players.get(id);
    if (!p || p.hp <= 0) return { ok: false, reason: "You cannot do that." };
    if (!p.equipment) p.equipment = {};
    if (!p.inventory) p.inventory = {};
    const itemId = p.equipment[slot];
    const item = itemId ? itemById(itemId) : null;
    if (!itemId || !item) return { ok: false, reason: "Nothing there." };
    delete p.equipment[slot];
    p.inventory[itemId] = (p.inventory[itemId] ?? 0) + 1;
    return { ok: true, reason: `Unequipped ${item.name}.` };
  }

  function train(id: string, skillId: string): ActionResult {
    const p = players.get(id);
    const skill = skillById(skillId);
    if (!p || p.hp <= 0 || !skill) return { ok: false, reason: "Nothing to train." };
    if (!nearestTrainer(p.x, p.z, 8)) return { ok: false, reason: "Find the trainer." };
    if ((p.trainPoints ?? 0) < 1) return { ok: false, reason: "No training points." };
    if (p.gold < skill.gold) return { ok: false, reason: "Not enough gold." };
    if (!p.skills) p.skills = {};
    const cur = p.skills[skill.id] ?? 0;
    if (cur >= skill.max) return { ok: false, reason: "That skill is mastered." };
    p.trainPoints -= 1;
    p.gold -= skill.gold;
    p.skills[skill.id] = Math.min(skill.max, cur + skill.perRank);
    log(`${p.username} trained ${skill.name} to ${p.skills[skill.id]}%.`);
    return { ok: true, reason: `${skill.name} is now ${p.skills[skill.id]}%.` };
  }

  function chat(id: string, msg: string): ActionResult {
    const p = players.get(id);
    if (!p || !msg) return { ok: false };
    log(`${p.username}: ${msg.slice(0, 120)}`);
    return { ok: true };
  }

  function note(id: string, msg: string) {
    const p = players.get(id);
    if (!p) return;
    log(`${p.username}: ${msg}`);
  }

  function respawn(
    id: string,
    extra: Array<{ x: number; z: number }> = [],
    place?: { x: number; z: number; name: string },
  ): ActionResult {
    const p = players.get(id);
    if (!p || p.hp > 0) return { ok: false, reason: "You are still standing." };
    dropGrave(p);
    const home =
      place && Number.isFinite(place.x) && Number.isFinite(place.z) ? place : hearthOf(p.race);
    const occupied = [
      ...[...players.values()].filter((o) => o.id !== p.id && o.hp > 0).map((o) => ({ x: o.x, z: o.z })),
      ...extra,
    ];
    const spot = arrivalAt(home.x, home.z, occupied, arrivalSalt(p.id));
    p.x = spot.x;
    p.z = spot.z;
    p.hp = p.maxHp;
    p.mana = p.maxMana;
    p.stamina = p.maxStamina;
    p.graveDropped = false;
    p.shroudUntil = now() + DEATH_SHROUD_MS;
    log(`${p.username} returned to ${home.name} under Grave Chill.`);
    return { ok: true, reason: "Grave Chill for 60s." };
  }

  function dropGrave(p: PlayerState) {
    if (p.hp > 0 || p.graveDropped) return;
    p.graveDropped = true;
    const pct = Math.floor(Math.max(0, p.gold) * 0.15);
    const gold = Math.min(Math.max(0, p.gold), Math.max(p.gold > 0 ? 5 : 0, pct));
    const xpLost = Math.max(0, Math.floor(Math.max(0, p.xp) * 0.1));
    p.gold = Math.max(0, p.gold - gold);
    p.xp = Math.max(0, p.xp - xpLost);
    const id = "g" + Math.floor(rand() * 1e9).toString(36);
    graves.set(id, { id, owner: p.username, x: p.x, z: p.z, gold, items: {}, born: now() });
    log(`${p.username} fell. A tombstone holds ${gold} gold. ${xpLost} XP is gone.`);
  }

  function loot(id: string, graveId: string): ActionResult {
    const p = players.get(id);
    const grave = graves.get(graveId);
    if (!p || p.hp <= 0 || !grave) return { ok: false, reason: "Nothing to loot." };
    if (Math.hypot(p.x - grave.x, p.z - grave.z) > 4) return { ok: false, reason: "Too far." };
    const gold = Math.max(0, Math.floor(grave.gold));
    grave.gold = 0;
    if (!p.inventory) p.inventory = {};
    for (const [itemId, count] of Object.entries(grave.items)) {
      if (count > 0) p.inventory[itemId] = (p.inventory[itemId] ?? 0) + count;
    }
    graves.delete(graveId);
    p.gold += gold;
    log(`${p.username} looted ${grave.owner}'s tombstone (${gold} gold).`);
    return { ok: true, reason: gold > 0 ? `+${gold} gold` : "The stone was empty." };
  }

  function adoptGraves(list: GraveState[]) {
    for (const g of list) {
      if (!g?.id || graves.has(g.id)) continue;
      graves.set(g.id, { ...g, items: { ...(g.items ?? {}) } });
    }
  }

  function campOf(m: MonsterState) {
    return CAMPS.find((c) => c.cx === m.homeX && c.cz === m.homeZ);
  }

  function livingAt(homeX: number, homeZ: number, exceptId?: string) {
    let n = 0;
    for (const o of monsters.values()) {
      if (o.id === exceptId) continue;
      if (o.hp > 0 && o.homeX === homeX && o.homeZ === homeZ) n++;
    }
    return n;
  }

  function freeSlot(m: MonsterState) {
    if (Number.isFinite(m.slotX) && campTileFree(m.slotX, m.slotZ, m.id)) return { x: m.slotX, z: m.slotZ };
    const camp = campOf(m);
    const origin = camp ? campAnchor(camp.cx, camp.cz) : { x: m.slotX ?? m.homeX, z: m.slotZ ?? m.homeZ };
    return takeCampSpot(origin.x, origin.z, m.id) ?? takeCampSpot(origin.x, origin.z, m.id, 18) ?? origin;
  }

  function step(now: number) {
    for (const [id, g] of graves) {
      // Names should not stack forever. Stones without a timestamp are leftovers.
      if (typeof g.born !== "number" || now - g.born > 3 * 60_000) graves.delete(id);
    }
    for (const camp of CAMPS) {
      const alive = [...monsters.values()]
        .filter((o) => o.hp > 0 && o.homeX === camp.cx && o.homeZ === camp.cz)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const extra of alive.slice(camp.count)) {
        extra.hp = 0;
        extra.respawnAt = 0;
        extra.targetId = null;
      }
    }
    for (const m of monsters.values()) {
      if (!Number.isFinite(m.slotX)) {
        m.slotX = m.x;
        m.slotZ = m.z;
      }
      if (!m.id.startsWith("t") && havenCity(m.slotX, m.slotZ)) {
        const camp = campOf(m);
        const origin = camp ? campAnchor(camp.cx, camp.cz) : outsideHaven(m.slotX, m.slotZ);
        const alt = takeCampSpot(origin.x, origin.z, m.id) ?? takeCampSpot(origin.x, origin.z, m.id, 18);
        if (alt) {
          m.slotX = alt.x;
          m.slotZ = alt.z;
        }
      }
      if (m.hp <= 0) {
        const camp = campOf(m);
        if (m.respawnAt && now > m.respawnAt) {
          if (camp && livingAt(camp.cx, camp.cz, m.id) >= camp.count) {
            m.respawnAt = now + 4000;
            continue;
          }
          m.hp = m.maxHp;
          const placed = freeSlot(m);
          m.x = placed.x;
          m.z = placed.z;
          m.slotX = placed.x;
          m.slotZ = placed.z;
          if (!m.id.startsWith("t") && havenCity(m.x, m.z)) {
            const ex = outsideHaven(m.x, m.z);
            if (campTileFree(ex.x, ex.z, m.id)) {
              m.x = ex.x;
              m.z = ex.z;
              m.slotX = ex.x;
              m.slotZ = ex.z;
            }
          }
          m.targetId = null;
          m.respawnAt = 0;
          m.nextHit = 0;
        }
        continue;
      }
      const camp = campOf(m);
      let campHot = !camp;
      if (camp) {
        for (const p of players.values()) {
          if (p.hp <= 0) continue;
          if (Math.hypot(p.x - camp.cx, p.z - camp.cz) <= 60) {
            campHot = true;
            break;
          }
        }
      }
      if (!campHot) continue;
      if (!m.id.startsWith("t") && fleeHaven(m)) continue;
      const leashFrom = havenCity(m.homeX, m.homeZ) ? { x: m.slotX, z: m.slotZ } : { x: m.homeX, z: m.homeZ };
      const homeD = Math.hypot(m.x - leashFrom.x, m.z - leashFrom.z);
      const def = mobByType(m.type);
      if (!m.nextHit) m.nextHit = 0;
      if (!m.targetId) {
        let prey: PlayerState | null = null;
        let preyD = def.aggro;
        for (const p of players.values()) {
          if (p.hp <= 0) continue;
          if (p.stealthUntil > now && m.targetId !== p.id) continue;
          if (!conFor(m.level, p.level).aggro) continue;
          const d = Math.hypot(p.x - m.x, p.z - m.z);
          if (d < preyD) {
            preyD = d;
            prey = p;
          }
        }
        if (prey) {
          m.targetId = prey.id;
          m.nextHit = now + 1500;
        }
      }
      if (m.targetId) {
        const t = players.get(m.targetId);
        if (!t || t.hp <= 0 || homeD > (def.campLeash || 15) || !conFor(m.level, t.level).aggro) {
          m.targetId = null;
        } else {
          if (sameTile(m.x, m.z, t.x, t.z)) stepOffTile(m, t.x, t.z);
          const spot = nearestMeleeStand(m, t.x, t.z);
          const gap = spot ? Math.hypot(spot.x - m.x, spot.z - m.z) : Infinity;
          // Still in range: hold. Leash is how far we will walk to a free tile
          // that is back in range, not a reason to drop the fight before that.
          if (!spot || gap > def.leash) {
            m.targetId = null;
          } else if (gap > 0.12 && !sameTile(m.x, m.z, t.x, t.z)) {
            const stepLen = (m.snareUntil > now ? 0.4 : 1) * Math.min(0.3, gap);
            if (stepLen > 0.001) {
              const ox = m.x;
              const oz = m.z;
              if (applyMobStep(m, m.x + ((spot.x - m.x) / gap) * stepLen, m.z + ((spot.z - m.z) / gap) * stepLen)) {
                const after = Math.hypot(m.x - spot.x, m.z - spot.z);
                if (after >= gap - 0.01) {
                  m.x = ox;
                  m.z = oz;
                }
              }
            }
          }
          if (m.targetId && !sameTile(m.x, m.z, t.x, t.z) && inMeleeRange(m.x, m.z, t.x, t.z) && now >= m.nextHit) {
            m.nextHit = now + def.attackMs;
            const raw = def.damage + Math.floor(m.level * def.damagePerLevel);
            let dmg = Math.max(1, raw - gearTotals(t.equipment).defense);
            if (t.wallUntil > now) dmg = Math.max(1, Math.floor(dmg * 0.25));
            else if (t.guardUntil > now) dmg = Math.max(1, Math.floor(dmg * 0.5));
            t.hp = Math.max(0, t.hp - dmg);
            if (t.hp <= 0) {
              log(`${t.username} was slain by a ${mobLabel(m.type)}.`);
              m.targetId = null;
            }
          }
        }
      }
      if (!m.targetId) {
        const sx = m.slotX;
        const sz = m.slotZ;
        const dx = sx - m.x;
        const dz = sz - m.z;
        const sd = Math.hypot(dx, dz);
        if (sd > 0.2) {
          const stepLen = Math.min(0.38, sd);
          applyMobStep(m, m.x + (dx / sd) * stepLen, m.z + (dz / sd) * stepLen);
        }
      }
    }
    const alive = [...monsters.values()].filter((o) => o.hp > 0);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        if (!sameTile(alive[i].x, alive[i].z, alive[j].x, alive[j].z)) continue;
        const b = alive[j];
        const bx = b.x;
        const bz = b.z;
        stepOffTile(b, alive[i].x, alive[i].z);
        if (b.targetId || (b.x === bx && b.z === bz)) continue;
        if (
          sameTile(b.slotX, b.slotZ, alive[i].x, alive[i].z) ||
          sameTile(b.slotX, b.slotZ, alive[i].slotX, alive[i].slotZ)
        ) {
          b.slotX = b.x;
          b.slotZ = b.z;
        }
      }
    }
    for (const p of players.values()) {
      if (p.hp <= 0) {
        dropGrave(p);
        continue;
      }
      const fighting = [...monsters.values()].some((m) => m.hp > 0 && m.targetId === p.id);
      if (p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + (fighting ? 0.45 : 1.35));
      if (p.mana < p.maxMana) p.mana = Math.min(p.maxMana, p.mana + 0.45 + (p.spi || 0) * 0.01);
      if (p.stamina < p.maxStamina) p.stamina = Math.min(p.maxStamina, p.stamina + (fighting ? 6 : 10));
    }
  }

  function grantXp(id: string, amount: number) {
    const p = players.get(id);
    if (!p || !(amount > 0)) return 0;
    p.xp += Math.floor(amount);
    const before = p.level;
    levelUp(p);
    return p.level - before;
  }

  function removeGrave(graveId: string) {
    graves.delete(graveId);
  }

  /** Open ground 2–3 tiles out, not on the hero and not on another fighter. */
  function testFoeSpot(px: number, pz: number): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null;
    let bestGap = -1;
    const consider = (x: number, z: number, minD: number, maxD: number) => {
      if (blocked(x, z) || sameTile(x, z, px, pz) || mobSharesTile(x, z)) return;
      const d = Math.hypot(x - px, z - pz);
      if (d < minD || d > maxD) return;
      const gap = screenGap(x, z, px, pz);
      if (!best || gap > bestGap) {
        best = { x, z };
        bestGap = gap;
      }
    };
    for (let r = 2; r <= 3.001; r += 0.2) {
      for (let i = 0; i < 24; i++) {
        const ang = (i / 24) * Math.PI * 2;
        consider(px + Math.cos(ang) * r, pz + Math.sin(ang) * r, 2, 3.05);
      }
    }
    if (best) return best;
    for (let r = 3.2; r <= 6; r += 0.35) {
      for (let i = 0; i < 24; i++) {
        const ang = (i / 24) * Math.PI * 2;
        consider(px + Math.cos(ang) * r, pz + Math.sin(ang) * r, 2, 6.05);
      }
    }
    return best;
  }

  function spawnTest(id: string): ActionResult {
    const p = players.get(id);
    if (!p || p.hp <= 0) return { ok: false, reason: "You cannot do that." };
    const level = Math.max(1, p.level);
    const type = "Spider";
    const spot = testFoeSpot(p.x, p.z);
    if (!spot) return { ok: false, reason: "No open ground." };
    // Nine swings at the basic-attack cooldown is about twenty seconds.
    const hp = Math.max(72, trainedDamage(p) * 9);
    const mobId = "t" + mid++;
    monsters.set(mobId, {
      id: mobId,
      type,
      level,
      maxHp: hp,
      hp,
      x: spot.x,
      z: spot.z,
      homeX: spot.x,
      homeZ: spot.z,
      slotX: spot.x,
      slotZ: spot.z,
      targetId: p.id,
      respawnAt: 0,
      nextHit: now() + 800,
      snareUntil: 0,
    });
    const mob = monsters.get(mobId)!;
    if (sameTile(mob.x, mob.z, p.x, p.z) || mobSharesTile(mob.x, mob.z, mob.id)) stepOffTile(mob, p.x, p.z);
    return { ok: true, reason: "A test foe appears." };
  }

  return {
    join,
    leave,
    move,
    attack,
    skill,
    promote,
    setLevel,
    setHp,
    buy,
    sell,
    useItem,
    equip,
    unequip,
    train,
    chat,
    travel,
    respawn,
    loot,
    grantXp,
    partyInvite,
    partyAccept,
    partyDecline,
    partyLeave,
    social,
    adoptGraves,
    removeGrave,
    spawnTest,
    note,
    step,
    snapshot,
    restore,
    players,
  };
}

export type World = ReturnType<typeof createWorld>;
