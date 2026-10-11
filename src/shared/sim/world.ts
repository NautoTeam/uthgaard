import { arrivalAt, blocked, cityAt, nearestOpen, nearestVendor, nearestWayfarer, resolveMove, screenGap } from "./geo";
import { DROPS, VENDOR_STOCK, dropChance, itemById, conXp, conFor, mobByType, mobHp, powerById, PRESTIGE_BONUS, attrsFor } from "../content/catalog";
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
}

function applyStats(p: PlayerState) {
  const a = attrsFor(p.race, p.baseClass);
  p.str = a.str;
  p.dex = a.dex;
  p.con = a.con;
  p.int = a.int;
  p.spi = a.spi;
  p.maxHp = Math.floor(70 + a.con * 2 + p.level * 9);
  p.maxMana = Math.floor(24 + a.int * 2 + p.level * 4);
  p.maxStamina = Math.floor(50 + a.dex * 2 + p.level * 2);
  const bonus = p.prestigeClass ? PRESTIGE_BONUS[p.prestigeClass] : undefined;
  if (bonus) {
    p.maxHp += bonus.hp;
    p.maxMana += bonus.mana;
  }
  if (p.hp == null || p.hp > p.maxHp) p.hp = p.maxHp;
  if (p.mana == null || p.mana > p.maxMana) p.mana = p.maxMana;
  if (p.stamina == null || p.stamina > p.maxStamina) p.stamina = p.maxStamina;
  if (!p.inventory) p.inventory = {};
}

function levelUp(p: PlayerState) {
  while (p.xp >= xpNeed(p.level) && p.level < 25) {
    p.xp -= xpNeed(p.level);
    p.level++;
    applyStats(p);
    p.hp = p.maxHp;
    p.mana = p.maxMana;
    p.stamina = p.maxStamina;
    p.stamina = p.maxStamina;
  }
}

export function createWorld() {
  const players = new Map<string, PlayerState>();
  const monsters = new Map<string, MonsterState>();
  const logs: string[] = [];
  let mid = 1;

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

  function clearOfMobs(x: number, z: number, exceptId?: string) {
    for (const m of monsters.values()) {
      if (m.hp <= 0 || m.id === exceptId) continue;
      if (screenGap(x, z, m.x, m.z) < 100) return false;
    }
    return true;
  }

  for (const camp of CAMPS) {
    const slots = campSlots(camp.cx, camp.cz, camp.count);
    for (let i = 0; i < camp.count; i++) {
      const id = "m" + mid++;
      const hp = mobHp(camp.type, camp.level);
      const placed = slots[i] ?? { x: Math.round(camp.cx + i * 3), z: Math.round(camp.cz) };
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
      });
    }
  }

  function snapshot(): PublicState {
    return {
      players: [...players.values()].map((p) => ({ ...p })),
      monsters: [...monsters.values()].map((m) => ({ ...m })),
      logs: logs.slice(),
    };
  }

  function restore(state: PublicState) {
    players.clear();
    monsters.clear();
    for (const p of state.players) {
      if (!p.inventory) p.inventory = {};
      const row = { ...p, inventory: { ...p.inventory } };
      players.set(p.id, row);
      applyStats(row);
    }
    for (const m of state.monsters) {
      const slotX = m.slotX ?? m.x;
      const slotZ = m.slotZ ?? m.z;
      monsters.set(m.id, { ...m, slotX, slotZ });
    }
    logs.splice(0, logs.length, ...state.logs.slice(-40));
  }

  function join(input: JoinInput): PlayerState {
    const existing = players.get(input.id);
    if (existing) return existing;
    const prestige = input.prestigeClass || "";
    const matched =
      prestige && PRESTIGE_OF[input.baseClass] === prestige ? prestige : "";
    const spot =
      typeof input.x === "number" && typeof input.z === "number" ? nearestOpen(input.x, input.z) : arrivalAt(0, 0);
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
    };
    applyStats(player);
    player.hp = player.maxHp;
    player.mana = player.maxMana;
    player.stamina = player.maxStamina;
    players.set(player.id, player);
    log(`${player.username} entered the Hamlet of Uthgaard.`);
    return player;
  }

  function leave(id: string): PlayerState | null {
    const p = players.get(id);
    if (!p) return null;
    players.delete(id);
    log(`${p.username} left the island.`);
    return p;
  }

  function move(id: string, x: number, z: number, rotation: number): ActionResult {
    const p = players.get(id);
    if (!p || p.hp <= 0) return { ok: false };
    const next = resolveMove(p.x, p.z, x, z);
    let nx = next.x;
    let nz = next.z;
    if (!clearOfMobs(nx, nz)) {
      if (clearOfMobs(nx, p.z) && !blocked(nx, p.z)) nz = p.z;
      else if (clearOfMobs(p.x, nz) && !blocked(p.x, nz)) nx = p.x;
      else {
        nx = p.x;
        nz = p.z;
      }
    }
    p.x = nx;
    p.z = nz;
    p.rotation = rotation || 0;
    return { ok: true };
  }

  function finishKill(p: PlayerState, m: MonsterState, gold: number, line: string) {
    if (m.respawnAt) return 0;
    m.respawnAt = Date.now() + 8000;
    const def = mobByType(m.type);
    const xp = conXp(m.level, p.level, def.xpBase + m.level * def.xpPerLevel);
    p.xp += xp;
    p.gold += gold;
    if (!p.inventory) p.inventory = {};
    for (const drop of DROPS) {
      if (drop.mob !== m.type) continue;
      if (Math.random() > dropChance(drop)) continue;
      const item = itemById(drop.itemId);
      if (!item) continue;
      p.inventory[item.id] = (p.inventory[item.id] ?? 0) + 1;
      log(`${p.username} picked up ${item.name}.`);
    }
    const before = p.level;
    levelUp(p);
    m.targetId = null;
    const ding = p.level > before ? ` and reached level ${p.level}` : "";
    log(line.replace("{xp}", String(xp)).replace("{ding}", ding));
    return xp;
  }

  function canUse(p: PlayerState, classes: string[]) {
    if (!classes.length) return true;
    return classes.includes(p.baseClass) || classes.includes(p.prestigeClass);
  }

  function strike(p: PlayerState, m: MonsterState, powerId: string, now: number): ActionResult {
    const power = powerById(powerId);
    if (!power || power.kind !== "damage") return { ok: false, reason: "That path cannot use this." };
    if (!canUse(p, power.classes)) return { ok: false, reason: "That path cannot use this." };
    if (m.hp <= 0) return { ok: false, reason: "Nothing in reach." };
    if (Math.hypot(p.x - m.x, p.z - m.z) > power.range) return { ok: false, reason: "Too far." };
    if (p.nextSwing && now < p.nextSwing) return { ok: false };
    if (power.mana > 0 && p.mana < power.mana) return { ok: false, reason: "Not enough mana." };
    if (power.stamina > 0 && p.stamina < power.stamina) return { ok: false, reason: "Not enough stamina." };
    p.mana -= power.mana;
    p.stamina -= power.stamina || 0;
    p.nextSwing = now + (powerId === "attack" ? 780 : 900);
    const bonus = power.bonus[p.baseClass] ?? power.bonus[p.prestigeClass] ?? 0;
    const strBonus = power.mana > 0 ? 0 : Math.max(0, Math.floor((p.str - 20) / 10));
    const dmg = power.damage + p.level * power.damagePerLevel + bonus + strBonus;
    m.hp = Math.max(0, m.hp - dmg);
    m.targetId = p.id;
    if (m.hp <= 0) {
      const gold = powerId === "fireball" ? 2 : 1 + Math.floor(m.level / (powerId === "stab" ? 3 : 2));
      const verb =
        powerId === "fireball"
          ? `${p.username}'s fireball destroyed a ${m.type} (+{xp} XP){ding}.`
          : powerId === "stab"
            ? `${p.username} stabbed a ${m.type} (+{xp} XP){ding}.`
            : `${p.username} slew a ${m.type} (+{xp} XP){ding}.`;
      const xp = finishKill(p, m, gold, verb);
      return { ok: true, dmg, reason: `+${xp} XP` };
    }
    const hit = powerId === "fireball" ? "Fireball" : powerId === "stab" ? "Stab" : "Attack";
    return { ok: true, dmg, reason: `${hit} hits for ${dmg}.` };
  }

  function attack(id: string, targetId: string | null): ActionResult {
    const p = players.get(id);
    const m = targetId ? monsters.get(targetId) : undefined;
    if (!p || p.hp <= 0 || !m || m.hp <= 0) return { ok: false, reason: "Nothing in reach." };
    return strike(p, m, "attack", Date.now());
  }

  function skill(id: string, name: string, targetId: string | null): ActionResult {
    const p = players.get(id);
    if (!p || p.hp <= 0) return { ok: false, reason: "You cannot act." };
    const power = powerById(name);
    if (!power) return { ok: false, reason: "That path cannot use this." };
    if (!canUse(p, power.classes)) {
      if (power.kind === "heal") return { ok: false, reason: "Only healers can mend." };
      if (name === "fireball") return { ok: false, reason: "Only mages can cast fireball." };
      if (name === "stab") return { ok: false, reason: "Only rogues can stab." };
      return { ok: false, reason: "That path cannot use this." };
    }
    if (power.kind === "heal") {
      if (p.hp >= p.maxHp - 0.5) return { ok: false, reason: "Already at full health." };
      if (p.mana < power.mana) return { ok: false, reason: "Not enough mana." };
      p.mana -= power.mana;
      const gain = Math.min(p.maxHp - p.hp, power.heal + p.level * power.healPerLevel);
      p.hp += gain;
      return { ok: true, reason: `Healed for ${Math.round(gain)}.` };
    }
    const m = targetId ? monsters.get(targetId) : undefined;
    if (!m || m.hp <= 0) return { ok: false, reason: "Nothing in reach." };
    return strike(p, m, power.id, Date.now());
  }

  function promote(id: string, cls: string): ActionResult {
    const p = players.get(id);
    const allowed = PRESTIGE_OF[p?.baseClass || "Fighter"];
    if (!p || p.level < 10 || p.prestigeClass) return { ok: false, reason: "Not ready to promote." };
    if (cls !== allowed) return { ok: false };
    p.prestigeClass = allowed;
    applyStats(p);
    log(`${p.username} promoted to ${allowed}.`);
    return { ok: true };
  }

  function travel(id: string, cityId: string): ActionResult {
    const p = players.get(id);
    const city = cityAt(cityId);
    if (!p || p.hp <= 0 || !city) return { ok: false, reason: "That gate is shut." };
    if (!nearestWayfarer(p.x, p.z, 4.2)) return { ok: false, reason: "Find a wayfarer." };
    if (Math.hypot(p.x - city.x, p.z - city.z) < 8) return { ok: true };
    const spot = arrivalAt(city.x, city.z);
    p.x = spot.x;
    p.z = spot.z;
    log(`${p.username} stepped through the gate to ${city.name}.`);
    return { ok: true };
  }

  function setLevel(id: string, level: number): ActionResult {
    const p = players.get(id);
    if (!p) return { ok: false, reason: "No such hero." };
    const next = Math.max(1, Math.min(25, Math.floor(level) || 1));
    p.level = next;
    p.xp = 0;
    applyStats(p);
    p.hp = p.maxHp;
    p.mana = p.maxMana;
    p.stamina = p.maxStamina;
    log(`${p.username} is now level ${next}.`);
    return { ok: true, reason: `Level ${next}.` };
  }

  function buy(id: string, itemId: string): ActionResult {
    const p = players.get(id);
    const offer = VENDOR_STOCK.find((row) => row.itemId === itemId);
    const item = itemById(itemId);
    if (!p || p.hp <= 0 || !offer || !item) return { ok: false, reason: "Nothing for sale." };
    if (!nearestVendor(p.x, p.z, 6.5)) return { ok: false, reason: "Find the vendor." };
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
    if (!nearestVendor(p.x, p.z, 6.5)) return { ok: false, reason: "Find the vendor." };
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

  function respawn(id: string): ActionResult {
    const p = players.get(id);
    if (!p || p.hp > 0) return { ok: false, reason: "You are still standing." };
    const goldLost = Math.min(p.gold, Math.max(p.gold > 0 ? 5 : 0, Math.floor(p.gold * 0.15)));
    const xpLost = Math.floor(p.xp * 0.1);
    p.gold -= goldLost;
    p.xp = Math.max(0, p.xp - xpLost);
    const spot = arrivalAt(0, 0);
    p.x = spot.x;
    p.z = spot.z;
    p.hp = p.maxHp;
    p.mana = p.maxMana;
    p.stamina = p.maxStamina;
    log(`${p.username} returned to Uthgaard, leaving ${goldLost} gold and ${xpLost} XP behind.`);
    return { ok: true };
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
    const others = [...monsters.values()].filter((o) => o.hp > 0 && o.id !== m.id);
    const clear = (x: number, z: number) => !blocked(x, z) && !others.some((o) => screenGap(o.x, o.z, x, z) < SLOT_GAP);
    if (Number.isFinite(m.slotX) && clear(m.slotX, m.slotZ)) return { x: m.slotX, z: m.slotZ };
    const camp = campOf(m);
    if (camp) {
      const open = campSlots(camp.cx, camp.cz, camp.count + 6).find((s) => clear(s.x, s.z));
      if (open) return open;
    }
    return { x: m.slotX ?? m.homeX, z: m.slotZ ?? m.homeZ };
  }

  function step(now: number) {
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
          m.targetId = null;
          m.respawnAt = 0;
          m.nextHit = 0;
        }
        continue;
      }
      const homeD = Math.hypot(m.x - m.homeX, m.z - m.homeZ);
      const def = mobByType(m.type);
      if (!m.nextHit) m.nextHit = 0;
      if (!m.targetId) {
        let prey: PlayerState | null = null;
        let preyD = def.aggro;
        for (const p of players.values()) {
          if (p.hp <= 0) continue;
          if (!conFor(m.level, p.level).aggro) continue;
          const d = Math.hypot(p.x - m.x, p.z - m.z);
          if (d < preyD) {
            preyD = d;
            prey = p;
          }
        }
        if (prey) {
          m.targetId = prey.id;
          m.nextHit = now + 900;
        }
      }
      if (m.targetId) {
        const t = players.get(m.targetId);
        const d = t && t.hp > 0 ? Math.hypot(t.x - m.x, t.z - m.z) : 99;
        if (!t || t.hp <= 0 || d > def.leash || homeD > (def.campLeash || 15) || !conFor(m.level, t.level).aggro) {
          m.targetId = null;
        } else if (screenGap(t.x, t.z, m.x, m.z) <= 130 || d <= 6.4) {
          if (now >= m.nextHit) {
            m.nextHit = now + def.attackMs;
            const dmg = def.damage + Math.floor(m.level * def.damagePerLevel);
            t.hp = Math.max(0, t.hp - dmg);
            if (t.hp <= 0) {
              log(`${t.username} was slain by a ${m.type}.`);
              m.targetId = null;
            }
          }
        } else {
          const stepLen = Math.min(0.42, Math.max(0, d - 5.6));
          const nx = m.x + ((t.x - m.x) / d) * stepLen;
          const nz = m.z + ((t.z - m.z) / d) * stepLen;
          const stepPos = resolveMove(m.x, m.z, nx, nz);
          m.x = stepPos.x;
          m.z = stepPos.z;
        }
      }
      if (!m.targetId) {
        const sx = m.slotX;
        const sz = m.slotZ;
        const dx = sx - m.x;
        const dz = sz - m.z;
        const sd = Math.hypot(dx, dz);
        if (sd > 0.2) {
          const stepLen = Math.min(0.55, sd);
          const stepPos = resolveMove(m.x, m.z, m.x + (dx / sd) * stepLen, m.z + (dz / sd) * stepLen);
          m.x = stepPos.x;
          m.z = stepPos.z;
        }
      }
    }
    const alive = [...monsters.values()].filter((o) => o.hp > 0);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (screenGap(a.x, a.z, b.x, b.z) >= 116 || d < 0.001) continue;
        const push = 0.55;
        const ux = (a.x - b.x) / d;
        const uz = (a.z - b.z) / d;
        const na = resolveMove(a.x, a.z, a.x + ux * push, a.z + uz * push);
        const nb = resolveMove(b.x, b.z, b.x - ux * push, b.z - uz * push);
        a.x = na.x;
        a.z = na.z;
        b.x = nb.x;
        b.z = nb.z;
      }
    }
    for (const m of alive) {
      for (const p of players.values()) {
        if (p.hp <= 0) continue;
        for (let n = 0; n < 6 && screenGap(m.x, m.z, p.x, p.z) < 108; n++) {
          const d = Math.hypot(m.x - p.x, m.z - p.z) || 1;
          const ux = d < 0.001 ? 1 : (m.x - p.x) / d;
          const uz = d < 0.001 ? 0 : (m.z - p.z) / d;
          const pos = resolveMove(m.x, m.z, m.x + ux * 1.2, m.z + uz * 1.2);
          if (pos.x === m.x && pos.z === m.z) break;
          m.x = pos.x;
          m.z = pos.z;
        }
      }
    }
    for (const p of players.values()) {
      if (p.hp <= 0) continue;
      const fighting = [...monsters.values()].some((m) => m.hp > 0 && m.targetId === p.id);
      if (p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + (fighting ? 0.45 : 1.35));
      if (p.mana < p.maxMana) p.mana = Math.min(p.maxMana, p.mana + 0.45 + (p.spi || 0) * 0.01);
      if (p.stamina < p.maxStamina) p.stamina = Math.min(p.maxStamina, p.stamina + (fighting ? 6 : 10));
    }
  }

  return {
    join,
    leave,
    move,
    attack,
    skill,
    promote,
    setLevel,
    buy,
    sell,
    useItem,
    chat,
    travel,
    respawn,
    note,
    step,
    snapshot,
    restore,
    players,
  };
}

export type World = ReturnType<typeof createWorld>;
