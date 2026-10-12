import { loadSave, writeSave } from "./save";
import {
  CITIES,
  FIRES,
  HALLS,
  LAKES,
  NPCS,
  ROADS,
  WORLD_EDGE,
  cityAt,
  nearestWayfarer,
  resolveMove,
  tileFill,
  TREES,
  arrivalAt,
  blocked,
  clearLine,
  nearestOpen,
  nearestTrainer,
  nearestVendor,
  routeTo,
  screenGap,
} from "./geo";
import { CAMPS, PRESTIGE_OF, xpNeed, type BaseClass, type PublicState, type Race } from "./types";
import { MOBS, RACES, EQUIP_SLOTS, SKILLS, VENDOR_STOCK, attrsFor, conFor, defaultHotbar, gearTotals, hitChance, itemById, poolsFor, trainedDamage, mobByType, powerById, DEBUG_SET_LEVEL } from "../shared/content/catalog";
import { createAuthority } from "../server/authority";
import type { JoinInput, World } from "../shared/sim/world";

export interface IsleProfile {
  username: string;
  race: Race;
  baseClass: BaseClass;
}

const TW = 48;
const TH = 24;
const MOVE = 20;
const NAMES = [...new Set([...RACES.map((r) => r.toLowerCase()), ...MOBS.map((m) => m.type.toLowerCase()), "hall", "tree", "fire"])];

type Intent =
  | { op: "join"; body: JoinInput }
  | { op: "leave"; id: string }
  | { op: "move"; id: string; x: number; z: number; rotation: number }
  | { op: "attack"; id: string; targetId: string | null }
  | { op: "skill"; id: string; skill: string; targetId: string | null }
  | { op: "promote"; id: string; cls: string }
  | { op: "chat"; id: string; msg: string }
  | { op: "travel"; id: string; cityId: string }
  | { op: "respawn"; id: string }
  | { op: "setLevel"; id: string; level: number }
  | { op: "buy"; id: string; itemId: string }
  | { op: "sell"; id: string; itemId: string }
  | { op: "use"; id: string; itemId: string }
  | { op: "equip"; id: string; itemId: string }
  | { op: "unequip"; id: string; slot: string }
  | { op: "train"; id: string; skillId: string };

declare global {
  interface Window {
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      getPos?: () => { x: number; z: number; hp: number; mana: number; gold: number; xp: number };
      hurt?: (amount: number) => void;
      setKeys?: (codes: string[]) => void;
      monsters?: () => Array<{ id: string; type: string; hp: number; x: number; z: number }>;
      place?: (x: number, z: number) => void;
      swing?: () => void;
      setLevel?: (level: number) => void;
    };
  }
}

function applyIntent(world: World, intent: Intent) {
  if (intent.op === "join") return world.join(intent.body);
  if (intent.op === "leave") return world.leave(intent.id);
  if (intent.op === "move") return world.move(intent.id, intent.x, intent.z, intent.rotation);
  if (intent.op === "attack") return world.attack(intent.id, intent.targetId);
  if (intent.op === "skill") return world.skill(intent.id, intent.skill, intent.targetId);
  if (intent.op === "promote") return world.promote(intent.id, intent.cls);
  if (intent.op === "chat") return world.chat(intent.id, intent.msg);
  if (intent.op === "travel") return world.travel(intent.id, intent.cityId);
  if (intent.op === "respawn") return world.respawn(intent.id);
  if (intent.op === "setLevel") return world.setLevel(intent.id, intent.level);
  if (intent.op === "buy") return world.buy(intent.id, intent.itemId);
  if (intent.op === "sell") return world.sell(intent.id, intent.itemId);
  if (intent.op === "use") return world.useItem(intent.id, intent.itemId);
  if (intent.op === "equip") return world.equip(intent.id, intent.itemId);
  if (intent.op === "unequip") return world.unequip(intent.id, intent.slot);
  if (intent.op === "train") return world.train(intent.id, intent.skillId);
  return { ok: false };
}

export function mountIsle(root: HTMLElement, profile: IsleProfile) {
  const canvas = root.querySelector<HTMLCanvasElement>("#view")!;
  const ctx = canvas.getContext("2d")!;
  const statsEl = root.querySelector<HTMLElement>("#stats")!;
  const messages = root.querySelector<HTMLElement>("#messages")!;
  const promoteBtn = root.querySelector<HTMLButtonElement>("#promoteBtn")!;
  const mapOverlay = root.querySelector<HTMLElement>("#mapOverlay")!;
  const mapCanvas = root.querySelector<HTMLCanvasElement>("#mapCanvas")!;
  const chat = root.querySelector<HTMLElement>("#chat")!;
  const stick = root.querySelector<HTMLElement>("#stick")!;
  const knob = root.querySelector<HTMLElement>("#knob")!;
  const chatInput = root.querySelector<HTMLInputElement>("#chatInput")!;
  const talkBtn = root.querySelector<HTMLButtonElement>("#talkBtn")!;
  const travelPanel = root.querySelector<HTMLElement>("#travel")!;
  const travelTitle = root.querySelector<HTMLElement>("#travelTitle")!;
  const travelHint = root.querySelector<HTMLElement>("#travelHint")!;
  const travelButtons = root.querySelector<HTMLElement>("#travelButtons")!;
  const deathEl = root.querySelector<HTMLElement>("#death")!;
  const deathHint = root.querySelector<HTMLElement>("#deathHint")!;
  const respawnBtn = root.querySelector<HTMLButtonElement>("#respawnBtn")!;
  const sheet = root.querySelector<HTMLElement>("#sheet")!;
  const shop = root.querySelector<HTMLElement>("#shop")!;
  const shopGold = root.querySelector<HTMLElement>("#shopGold")!;
  const shopStock = root.querySelector<HTMLElement>("#shopStock")!;
  const shopBag = root.querySelector<HTMLElement>("#shopBag")!;
  const trainPanel = root.querySelector<HTMLElement>("#train")!;
  const trainPointsEl = root.querySelector<HTMLElement>("#trainPoints")!;
  const trainList = root.querySelector<HTMLElement>("#trainList")!;
  const bag = root.querySelector<HTMLElement>("#bag")!;
  const bagBody = root.querySelector<HTMLElement>("#bagBody")!;
  const dollSlots = root.querySelector<HTMLElement>("#dollSlots")!;
  const debugRow = root.querySelector<HTMLElement>("#debugLevel");
  if (DEBUG_SET_LEVEL && debugRow) debugRow.hidden = false;

  const sprites: Record<string, HTMLImageElement> = {};
  for (const name of NAMES) {
    const img = new Image();
    img.src = `/sprites/${name}.png`;
    img.onload = () => {
      sprites[name] = img;
    };
  }
  const frames: Record<string, HTMLImageElement> = {};
  for (const race of ["human", "elf", "minotaur"]) {
    for (let i = 0; i < 16; i++) {
      const img = new Image();
      const key = `${race}-walk-${i}`;
      img.onload = () => {
        frames[key] = img;
      };
      img.src = `/sprites/anim/${key}.png?v=6`;
    }
    for (let i = 0; i < 4; i++) {
      const img = new Image();
      const key = `${race}-atk-${i}`;
      img.onload = () => {
        frames[key] = img;
      };
      img.src = `/sprites/anim/${key}.png?v=6`;
    }
  }
  const fx: Record<string, HTMLImageElement> = {};
  for (const name of ["fireball", "impact"]) {
    const img = new Image();
    img.onload = () => {
      fx[name] = img;
    };
    img.src = `/sprites/anim/${name}.png?v=1`;
  }
  const bolts: Array<{ x0: number; z0: number; x1: number; z1: number; born: number }> = [];
  let pinnedId: string | null = null;
  const actors = new Map<
    string,
    { x: number; z: number; facing: number; attackUntil: number; castUntil: number; moving: boolean; phase: number; stamp: number }
  >();

  const saved = loadSave(profile.username);
  const myId = "p" + Math.random().toString(36).slice(2, 10);
  const joinBody: JoinInput = {
    id: myId,
    username: profile.username,
    race: profile.race,
    baseClass: profile.baseClass,
    prestigeClass: saved && saved.baseClass === profile.baseClass ? saved.prestigeClass : "",
    level: saved?.level || 1,
    xp: saved?.xp || 0,
    gold: saved?.gold ?? 40,
    x: saved?.x,
    z: saved?.z,
    inventory: saved?.inventory,
    equipment: saved?.equipment,
    trainPoints: saved?.trainPoints,
    skills: saved?.skills,
    hotbar: saved?.hotbar,
  };

  const authority = createAuthority();
  const world = authority.world;
  world.join(joinBody);

  const claim = Date.now() + Math.random();
  let bestClaim = claim;
  let host = true;
  let remote: PublicState | null = null;
  let lastHeard = performance.now();
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("uthgaard-isle-v2") : null;

  const keys = new Set<string>();
  let stickActive = false;
  const stickVec = { x: 0, z: 0 };
  let dest: { x: number; z: number } | null = null;
  let path: Array<{ x: number; z: number }> = [];
  let talkNpc: string | null = null;
  let seenGold = -1;
  let chaseId: string | null = null;
  let repaths = 0;
  let stuckFor = 0;
  let lastSpeed = 0;
  let lastLogs = "";
  let viewW = 1;
  let viewH = 1;
  const cam = { x: 0, z: 0 };
  const notes: string[] = [];
  const floaters: Array<{ x: number; z: number; text: string; born: number; color: string; lift: number; size: number; life: number }> = [];
  let dead = false;
  let raf = 0;
  let lastFrame = performance.now();
  let lastSend = 0;

  function floatText(text: string, color = "#f6e7b2", lift = 120) {
    const xp = text.includes("XP");
    const p = me();
    floaters.push({
      x: p?.x ?? 0,
      z: p?.z ?? 0,
      text,
      born: performance.now(),
      color: xp ? "#7CFF4A" : color,
      lift: xp ? 168 : lift,
      size: xp ? 26 : 15,
      life: xp ? 2600 : 1700,
    });
  }

  function floatAt(x: number, z: number, text: string, color: string, lift = 78) {
    floaters.push({ x, z, text, born: performance.now(), color, lift, size: 15, life: 1700 });
  }

  const seenHp = new Map<string, number>();
  function puffDamage(id: string, x: number, z: number, hp: number, color: string) {
    const prev = seenHp.get(id);
    if (prev != null && hp < prev - 0.4) floatAt(x, z, `-${Math.max(1, Math.round(prev - hp))}`, color);
    seenHp.set(id, hp);
  }

  function note(line: string) {
    notes.push(line);
    if (notes.length > 5) notes.shift();
    lastLogs = "";
    floatText(line);
  }

  function localPlayer() {
    return world.players.get(myId) ?? null;
  }

  function view(): PublicState {
    if (host || !remote) return world.snapshot();
    const snap = remote;
    const mine = localPlayer();
    if (!mine) return snap;
    const players = snap.players.some((p) => p.id === myId)
      ? snap.players.map((p) => (p.id === myId ? { ...p, x: mine.x, z: mine.z, rotation: mine.rotation } : p))
      : [...snap.players, { ...mine }];
    return { ...snap, players };
  }

  function me() {
    return view().players.find((p) => p.id === myId) ?? localPlayer();
  }

  function send(intent: Intent) {
    if (host) {
      const result = applyIntent(world, intent);
      if (result && "ok" in result && result.reason) {
        if (result.ok === false) note(result.reason);
        else if (result.reason.startsWith("+")) floatText(result.reason, "#b6e38a");
        else if (!result.reason.includes("hits for") && result.reason !== "Missed.") floatText(result.reason);
      }
      if (intent.op === "buy" || intent.op === "sell" || intent.op === "use" || intent.op === "equip" || intent.op === "unequip" || intent.op === "train") {
        bagSig = "";
        shopSig = "";
        trainSig = "";
        paintBag();
        paintShop();
        paintTrain();
      }
      return result;
    }
    channel?.postMessage({ t: "intent", intent });
    return { ok: true };
  }

  function publishSnap() {
    if (!host || !channel) return;
    channel.postMessage({ t: "snap", id: myId, claim, snap: world.snapshot() });
  }

  channel?.addEventListener("message", (ev: MessageEvent) => {
    const msg = ev.data as { t?: string; id?: string; claim?: number; snap?: PublicState; intent?: Intent };
    if (!msg || typeof msg !== "object") return;
    if ((msg.t === "claim" || msg.t === "beat" || msg.t === "snap") && typeof msg.claim === "number" && msg.id && msg.id !== myId) {
      if (msg.claim < bestClaim) {
        bestClaim = msg.claim;
        host = false;
        lastHeard = performance.now();
      } else if (msg.claim === bestClaim) lastHeard = performance.now();
    }
    if (msg.t === "snap" && msg.snap && msg.id !== myId && typeof msg.claim === "number" && msg.claim <= bestClaim) {
      bestClaim = msg.claim;
      host = false;
      const mine = localPlayer();
      const incoming = msg.snap.players.find((p) => p.id === myId);
      if (mine && incoming && Math.hypot(incoming.x - mine.x, incoming.z - mine.z) > 12) {
        mine.x = incoming.x;
        mine.z = incoming.z;
        mine.rotation = incoming.rotation;
      }
      if (mine && incoming) {
        mine.hp = incoming.hp;
        mine.maxHp = incoming.maxHp;
        mine.mana = incoming.mana;
        mine.maxMana = incoming.maxMana;
        mine.level = incoming.level;
        mine.xp = incoming.xp;
        mine.gold = incoming.gold;
        mine.inventory = incoming.inventory;
        mine.equipment = incoming.equipment;
        mine.trainPoints = incoming.trainPoints;
        mine.skills = incoming.skills;
        mine.prestigeClass = incoming.prestigeClass;
      }
      remote = msg.snap;
      lastHeard = performance.now();
    }
    if (msg.t === "intent" && msg.intent && host) applyIntent(world, msg.intent);
  });

  channel?.postMessage({ t: "claim", id: myId, claim });
  if (!host) send({ op: "join", body: joinBody });

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    viewW = canvas.clientWidth || window.innerWidth;
    viewH = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.floor(viewW * dpr));
    canvas.height = Math.max(1, Math.floor(viewH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  function worldToScreen(x: number, z: number) {
    return {
      x: (x - z) * (TW / 2) + viewW / 2 - cam.x,
      y: (x + z) * (TH / 2) + viewH / 2 - 20 - cam.z,
    };
  }

  function screenToWorld(sx: number, sy: number) {
    const x = sx - viewW / 2 + cam.x;
    const y = sy - viewH / 2 + 20 + cam.z;
    return {
      x: (x / (TW / 2) + y / (TH / 2)) / 2,
      z: (y / (TH / 2) - x / (TW / 2)) / 2,
    };
  }

  function tileColor(x: number, z: number) {
    return tileFill(x, z);
  }

  function drawDiamond(x: number, z: number, fill: string) {
    const p = worldToScreen(x, z);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - TH / 2);
    ctx.lineTo(p.x + TW / 2, p.y);
    ctx.lineTo(p.x, p.y + TH / 2);
    ctx.lineTo(p.x - TW / 2, p.y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function shadowAt(x: number, z: number, w: number) {
    const p = worldToScreen(x, z);
    ctx.save();
    ctx.translate(p.x, p.y + 4);
    ctx.scale(1, 0.4);
    ctx.beginPath();
    ctx.arc(0, 0, w, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.fill();
    ctx.restore();
  }

  function drawSprite(name: string, x: number, z: number, scale: number) {
    const img = sprites[name];
    if (!img) return false;
    const p = worldToScreen(x, z);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, p.x - w / 2, p.y - h + 10, w, h);
    return true;
  }

  function drawFallback(label: string, x: number, z: number) {
    const p = worldToScreen(x, z);
    ctx.save();
    ctx.fillStyle = "#6a3030";
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - 22, 16, 22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f0e2b0";
    ctx.font = "12px Georgia";
    ctx.textAlign = "center";
    ctx.fillText(label, p.x, p.y - 50);
    ctx.restore();
  }

  function trackActor(id: string, x: number, z: number) {
    let actor = actors.get(id);
    if (!actor) {
      actor = { x, z, facing: 0, attackUntil: 0, castUntil: 0, moving: false, phase: 0, stamp: 0 };
      actors.set(id, actor);
      return actor;
    }
    const dx = x - actor.x;
    const dz = z - actor.z;
    actor.moving = Math.hypot(dx, dz) > 0.02;
    if (actor.moving) {
      const sx = dx - dz;
      const sy = dx + dz;
      actor.facing = Math.abs(sy) >= Math.abs(sx) ? (sy > 0 ? 0 : 3) : sx > 0 ? 2 : 1;
    }
    if (id === myId) {
      const foe = livingMonster(chaseId);
      if (foe) {
        const sx = foe.x - x - (foe.z - z);
        const sy = foe.x - x + (foe.z - z);
        actor.facing = Math.abs(sy) >= Math.abs(sx) ? (sy > 0 ? 0 : 3) : sx > 0 ? 2 : 1;
      }
    }
    actor.x = x;
    actor.z = z;
    return actor;
  }

  const classFilter: Record<string, string> = {
    fighter: "none",
    healer: "sepia(0.65) saturate(1.5) brightness(1.08)",
    mage: "hue-rotate(185deg) saturate(1.45) brightness(1.06)",
    rogue: "hue-rotate(78deg) saturate(0.7) brightness(0.78) contrast(1.08)",
  };
  const classRing: Record<string, string> = {
    fighter: "rgba(215, 194, 138, .9)",
    healer: "rgba(255, 214, 120, .95)",
    mage: "rgba(130, 196, 255, .95)",
    rogue: "rgba(150, 210, 96, .95)",
  };

  function classKind(cls?: string) {
    if (cls === "Healer" || cls === "Priest") return "healer";
    if (cls === "Mage" || cls === "Wizard") return "mage";
    if (cls === "Rogue" || cls === "Scout") return "rogue";
    return "fighter";
  }

  function drawFrame(key: string, x: number, z: number, cell: number, lift = 0, filter = "none") {
    const img = frames[key];
    if (!img) return false;
    const p = worldToScreen(x, z);
    const dw = cell;
    const dh = cell * (img.height / img.width);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.filter = filter;
    ctx.drawImage(img, p.x - dw / 2, p.y - dh + 16 - lift, dw, dh);
    ctx.restore();
    return true;
  }

  function drawClassMark(kind: string, x: number, z: number, facing: number, phase: number, casting: boolean) {
    const p = worldToScreen(x, z);
    const side = facing === 1 || facing === 3 ? -1 : 1;
    const bob = Math.sin(phase * Math.PI) * 5;
    ctx.save();
    ctx.translate(p.x + side * 22, p.y - 78 + bob);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    if (kind === "mage") {
      ctx.strokeStyle = "#d7ecff";
      ctx.beginPath();
      ctx.moveTo(0, 28);
      ctx.lineTo(-side * 6, -26);
      ctx.stroke();
      ctx.fillStyle = casting ? "#fff6c2" : "#7ec8ff";
      ctx.beginPath();
      ctx.arc(-side * 6, -30, casting ? 7 : 5, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === "rogue") {
      ctx.strokeStyle = "#e8e8e8";
      ctx.beginPath();
      ctx.moveTo(-6, 10);
      ctx.lineTo(8, -16);
      ctx.moveTo(6, 12);
      ctx.lineTo(-4, -12);
      ctx.stroke();
    } else if (kind === "healer") {
      ctx.strokeStyle = "#fff4c8";
      ctx.fillStyle = "rgba(255, 236, 170, .85)";
      ctx.beginPath();
      ctx.arc(0, -8, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -16);
      ctx.lineTo(0, 2);
      ctx.moveTo(-7, -7);
      ctx.lineTo(7, -7);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "#d7c28a";
      ctx.beginPath();
      ctx.arc(-side * 8, 4, 9, 0.4, Math.PI * 1.7);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCast(x: number, z: number, t: number) {
    const p = worldToScreen(x, z);
    ctx.save();
    ctx.translate(p.x, p.y - 64);
    for (let i = 0; i < 3; i++) {
      const a = t * Math.PI * 2 + (i * Math.PI * 2) / 3;
      ctx.fillStyle = i === 0 ? "#fff6c2" : "#9fd0ff";
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 22, Math.sin(a) * 10 - t * 28, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHero(race: string, id: string, x: number, z: number, cls?: string) {
    const actor = trackActor(id, x, z);
    const now = performance.now();
    const dt = actor.stamp ? Math.min(0.05, (now - actor.stamp) / 1000) : 0;
    actor.stamp = now;
    const moving = actor.moving || (id === myId && lastSpeed > 0.2);
    actor.moving = moving;
    if (moving) {
      const rate = id === myId ? Math.max(0.45, Math.min(1.4, lastSpeed / MOVE)) : 1;
      actor.phase += dt * 9 * rate;
    }
    const kind = classKind(cls);
    const filter = classFilter[kind];
    const cell = race === "minotaur" ? 128 : 112;
    const lift = moving ? Math.abs(Math.sin(actor.phase * Math.PI)) * 5 : Math.sin(now / 420) * 1.2;
    const casting = now < actor.castUntil;
    const attacking = now < actor.attackUntil;
    if (cls && kind !== "fighter") {
      const foot = worldToScreen(x, z);
      ctx.save();
      ctx.translate(foot.x, foot.y + 4);
      ctx.scale(1, 0.42);
      ctx.beginPath();
      ctx.arc(0, 0, 20, 0, Math.PI * 2);
      ctx.strokeStyle = classRing[kind];
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
    if (attacking) {
      const t = 1 - (actor.attackUntil - now) / 640;
      const frame = Math.min(3, Math.floor(Math.max(0, t) * 4));
      if (!drawFrame(`${race}-atk-${frame}`, x, z, cell, lift, filter)) drawSprite(race, x, z, race === "minotaur" ? 0.2 : 0.18);
    } else {
      const col = moving ? Math.floor(actor.phase) % 4 : 0;
      const row = actor.facing * 4;
      if (!drawFrame(`${race}-walk-${row + col}`, x, z, cell, lift, filter)) drawSprite(race, x, z, race === "minotaur" ? 0.2 : 0.18);
    }
    if (cls) drawClassMark(kind, x, z, actor.facing, actor.phase, casting);
    if (casting) drawCast(x, z, 1 - (actor.castUntil - now) / 700);
  }

  function hud() {
    const p = me();
    if (!p) return;
    const pools = poolsFor(p);
    const maxHp = pools.maxHp;
    const maxMana = pools.maxMana;
    const maxStamina = pools.maxStamina;
    const hp = p.maxHp === maxHp ? p.hp : p.hp >= p.maxHp - 0.5 || p.maxHp === 100 ? maxHp : Math.min(p.hp, maxHp);
    const mana = p.maxMana === maxMana ? p.mana : p.mana >= p.maxMana - 0.5 || p.maxMana === 50 ? maxMana : Math.min(p.mana, maxMana);
    const stamina = p.maxStamina === maxStamina ? p.stamina ?? 0 : (p.stamina ?? 0) >= p.maxStamina - 0.5 || p.maxStamina === 50 ? maxStamina : Math.min(p.stamina ?? 0, maxStamina);
    const hpPct = Math.max(0, (hp / maxHp) * 100);
    const mpPct = Math.max(0, (mana / maxMana) * 100);
    const spPct = Math.max(0, (stamina / (maxStamina || 1)) * 100);
    const need = xpNeed(p.level);
    const xpPct = p.level >= 25 ? 100 : Math.max(0, Math.min(100, (p.xp / need) * 100));
    const xpLabel = p.level >= 25 ? `XP ${p.xp}` : `XP ${p.xp}/${need}`;
    statsEl.innerHTML =
      `<b>${p.username}</b> ${p.race} ${p.prestigeClass || p.baseClass} · Lv ${p.level}` +
      `<div class="gold-line">Gold ${p.gold}</div>` +
      `<div class="bar hp"><i style="width:${hpPct}%"></i><span>HP ${Math.round(hp)}/${maxHp}</span></div>` +
      `<div class="bar mp"><i style="width:${mpPct}%"></i><span>MP ${Math.round(mana)}/${maxMana}</span></div>` +
      `<div class="bar sp"><i style="width:${spPct}%"></i><span>SP ${Math.round(stamina)}/${maxStamina}</span></div>` +
      `<div class="bar xp"><i style="width:${xpPct}%"></i><span>${xpLabel}</span></div>`;
    const sheetBody = root.querySelector<HTMLElement>("#sheetBody");
    if (sheetBody) {
      const a = attrsFor(p.race, p.baseClass);
      sheetBody.innerHTML =
        `<div class="sheet-who">${p.username} · ${p.race} ${p.prestigeClass || p.baseClass} · Lv ${p.level}</div>` +
        `<div class="gold-line">Gold ${p.gold}</div>` +
        `<table class="sheet-attrs"><tbody>` +
        `<tr><th>STR</th><td>${a.str}</td><th>DEX</th><td>${a.dex}</td></tr>` +
        `<tr><th>CON</th><td>${a.con}</td><th>INT</th><td>${a.int}</td></tr>` +
        `<tr><th>SPI</th><td>${a.spi}</td><th>DEF</th><td>${gearTotals(p.equipment).defense}</td></tr>` +
        `<tr><th>DMG</th><td>${trainedDamage(p)}</td><th>Hit</th><td>${hitChance(p)}%</td></tr>` +
        `</tbody></table>` +
        `<p class="sheet-note">Training points ${p.trainPoints ?? 0}. Sword ${p.skills?.sword ?? 0}% adds damage. Focus ${p.skills?.focus ?? 0}% adds hit chance.</p>` +
        `<p class="sheet-note">Basic attack spends a little stamina and refills between swings. Stab spends more. Spells spend mana.</p>`;
    }
    const bar = p.hotbar?.length === 8 ? p.hotbar : defaultHotbar(p.baseClass, p.prestigeClass, p.level);
    root.querySelectorAll<HTMLButtonElement>("#hotbar button").forEach((btn, i) => {
      const id = bar[i] || "";
      const power = id ? powerById(id) : null;
      const name = btn.querySelector(".nm");
      if (name) name.textContent = power ? power.label : "—";
      const until = id ? (p.cooldowns?.[id] ?? 0) : 0;
      const left = Math.max(0, until - Date.now());
      const cd = btn.querySelector<HTMLElement>(".cd");
      if (cd) cd.style.height = power && left > 0 ? `${Math.min(100, (left / power.cooldown) * 100)}%` : "0%";
    });
    if (seenGold >= 0 && p.gold > seenGold) floatText(`+${p.gold - seenGold} gold`, "#e6c56a", 132);
    seenGold = p.gold;
    paintShop();
    const ready = p.level >= 10 && !p.prestigeClass;
    promoteBtn.hidden = !ready;
    if (ready) promoteBtn.textContent = `Promote to ${PRESTIGE_OF[p.baseClass]}`;
    deathEl.hidden = p.hp > 0;
    if (p.hp <= 0) {
      const goldLost = Math.min(p.gold, Math.max(p.gold > 0 ? 5 : 0, Math.floor(p.gold * 0.15)));
      const xpLost = Math.floor(p.xp * 0.1);
      deathHint.textContent = `Respawn in Uthgaard leaves ${goldLost} gold and ${xpLost} XP behind.`;
    }
    const near = nearestWayfarer(p.x, p.z);
    talkBtn.hidden = !near;
    if (!near) travelPanel.hidden = true;
    const state = view();
    const lines = [...state.logs, ...notes];
    const sig = lines.join("\n");
    if (sig !== lastLogs) {
      messages.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
      messages.scrollTop = messages.scrollHeight;
      lastLogs = sig;
    }
  }

  function drawWorldMap() {
    const g = mapCanvas.getContext("2d");
    if (!g) return;
    const w = mapCanvas.width;
    const h = mapCanvas.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#0e1c18";
    g.fillRect(0, 0, w, h);
    const span = 360;
    const to = (x: number, z: number) => ({ x: w / 2 + (x / span) * w, y: h / 2 + (z / span) * h });
    g.fillStyle = "#123e46";
    g.beginPath();
    g.ellipse(w / 2, h / 2, (168 / span) * w, (168 / span) * h, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#2f4a34";
    g.beginPath();
    g.ellipse(w / 2, h / 2, (150 / span) * w, (150 / span) * h, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#8a7344";
    g.lineWidth = 3;
    g.beginPath();
    for (const [ax, az, bx, bz] of ROADS) {
      const a = to(ax, az);
      const b = to(bx, bz);
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
    }
    g.stroke();
    g.fillStyle = "#184e58";
    for (const lake of LAKES) {
      const pt = to(lake.x, lake.z);
      g.beginPath();
      g.arc(pt.x, pt.y, (lake.r / span) * w, 0, Math.PI * 2);
      g.fill();
    }
    g.font = "14px Georgia";
    g.textAlign = "center";
    for (const city of CITIES) {
      const pt = to(city.x, city.z);
      g.fillStyle = city.stone;
      g.fillRect(pt.x - 7, pt.y - 7, 14, 14);
      g.fillStyle = "#f0e2b0";
      g.fillText(city.name, pt.x, pt.y - 12);
    }
    const colors = ["#6a3030", "#2f6a38", "#6a6a30", "#6a4a28", "#4a306a", "#6a3060"];
    CAMPS.forEach((camp, i) => {
      const pt = to(camp.cx, camp.cz);
      g.fillStyle = colors[i] || "#6a3030";
      g.beginPath();
      g.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#efe6c8";
      g.font = "13px Georgia";
      g.fillText(`${camp.type}s  ${camp.level}`, pt.x, pt.y - 12);
    });
    for (const p of view().players) {
      if (p.hp <= 0) continue;
      const pt = to(p.x, p.z);
      g.fillStyle = p.id === myId ? "#f2d36b" : "#d8d8d8";
      g.beginPath();
      g.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
      g.fill();
      g.fillText(p.username, pt.x, pt.y + 16);
    }
    g.fillStyle = "#cbb";
    g.font = "12px Georgia";
    g.fillText("Gold mark is you. Roads link the three cities.", w / 2, h - 16);
  }

  function nearestId(range: number) {
    const p = me();
    if (!p) return null;
    let id: string | null = null;
    let best = range;
    for (const m of view().monsters) {
      if (m.hp <= 0) continue;
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d < best) {
        best = d;
        id = m.id;
      }
    }
    return id;
  }

  function targetRange() {
    const p = me();
    if (!p) return 4.6;
    if (p.baseClass === "Mage" || p.prestigeClass === "Wizard") return 9;
    return 4.6;
  }

  function currentTarget() {
    const p = me();
    if (!p) return null;
    const monsters = view().monsters.filter((m) => m.hp > 0);
    if (pinnedId) {
      const pin = monsters.find((m) => m.id === pinnedId);
      if (pin && Math.hypot(pin.x - p.x, pin.z - p.z) < 14) return pin;
      pinnedId = null;
    }
    const range = targetRange();
    let best: (typeof monsters)[number] | null = null;
    let bestD = range;
    for (const m of monsters) {
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  const MELEE_GAP = 108;

  function livingMonster(id: string | null) {
    if (!id) return null;
    return view().monsters.find((m) => m.id === id && m.hp > 0) ?? null;
  }

  function adjacentStand(mx: number, mz: number, px: number, pz: number, minGap = MELEE_GAP) {
    const d = Math.hypot(px - mx, pz - mz) || 1;
    const ux = (px - mx) / d;
    const uz = (pz - mz) / d;
    let best: { x: number; z: number } | null = null;
    let bestScore = Infinity;
    for (let dist = 1.5; dist <= 8; dist += 0.5) {
      const x = Math.round(mx + ux * dist);
      const z = Math.round(mz + uz * dist);
      if (blocked(x, z)) continue;
      const gap = screenGap(x, z, mx, mz);
      if (gap < minGap || gap > minGap + 48) continue;
      const score = gap + Math.hypot(x - px, z - pz);
      if (score < bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    return best ?? nearestOpen(mx + ux * 4, mz + uz * 4);
  }

  function rangedStand(mx: number, mz: number, px: number, pz: number) {
    const d = Math.hypot(px - mx, pz - mz) || 1;
    const x = Math.round(mx + ((px - mx) / d) * 7.2);
    const z = Math.round(mz + ((pz - mz) / d) * 7.2);
    if (!blocked(x, z)) return { x, z };
    return nearestOpen(mx + ((px - mx) / d) * 7.2, mz + ((pz - mz) / d) * 7.2);
  }

  function combat() {
    const p = localPlayer();
    if (!p || p.hp <= 0 || !mapOverlay.hidden) return;
    const moving = keys.has("KeyW") || keys.has("KeyA") || keys.has("KeyS") || keys.has("KeyD") || keys.has("ArrowUp") || keys.has("ArrowDown") || keys.has("ArrowLeft") || keys.has("ArrowRight") || stickActive;
    if (keys.has("Space")) {
      const aimed = currentTarget();
      if (aimed) {
        pinnedId = aimed.id;
        chaseId = aimed.id;
      }
    }
    const chase = livingMonster(chaseId);
    const ranged = p.baseClass === "Mage" || p.prestigeClass === "Wizard";
    if (chase && !moving) {
      const gap = screenGap(chase.x, chase.z, p.x, p.z);
      const closeEnough = ranged ? Math.hypot(chase.x - p.x, chase.z - p.z) <= 7.2 : gap >= MELEE_GAP;
      if (closeEnough) {
        dest = null;
        path = [];
        p.rotation = Math.atan2(chase.x - p.x, chase.z - p.z);
      } else {
        const spot = ranged ? rangedStand(chase.x, chase.z, p.x, p.z) : adjacentStand(chase.x, chase.z, p.x, p.z);
        if (!dest || Math.hypot(dest.x - spot.x, dest.z - spot.z) > 0.75) {
          dest = { x: spot.x, z: spot.z };
          talkNpc = null;
          path = routeTo(p.x, p.z, spot.x, spot.z);
          repaths = 0;
        }
      }
    } else if (chaseId && !chase) {
      chaseId = null;
    }
    const foe = chase ?? currentTarget();
    if (!foe) return;
    const dist = Math.hypot(foe.x - p.x, foe.z - p.z);
    if (ranged && dist <= 8 && p.mana >= 10 && Date.now() >= (p.cooldowns?.fireball ?? 0)) {
      pinnedId = foe.id;
      act("fireball");
      return;
    }
    if (dist <= (powerById("attack")?.range ?? 7.6) && Date.now() >= Math.max(p.nextSwing || 0, p.cooldowns?.attack ?? 0)) {
      pinnedId = foe.id;
      act("attack");
    }
  }

  function markTarget(x: number, z: number) {
    const p = worldToScreen(x, z);
    const pulse = 0.62 + 0.38 * Math.sin(performance.now() / 140);
    ctx.save();
    ctx.translate(p.x, p.y + 5);
    ctx.scale(1, 0.42);
    ctx.beginPath();
    ctx.arc(0, 0, 28, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(170, 12, 12, ${0.38 * pulse})`;
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = `rgba(255, 36, 36, ${pulse})`;
    ctx.stroke();
    ctx.restore();
  }

  function drawFx(name: string, frame: number, cols: number, rows: number, x: number, z: number, size: number, lift: number) {
    const img = fx[name];
    if (!img) return;
    const cw = img.width / cols;
    const ch = img.height / rows;
    const col = frame % cols;
    const row = Math.floor(frame / cols) % rows;
    const p = worldToScreen(x, z);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, col * cw, row * ch, cw, ch, p.x - size / 2, p.y - size * 0.72 - lift, size, size);
    ctx.restore();
  }

  function integrate(dt: number) {
    const p = localPlayer();
    if (!p || p.hp <= 0 || !mapOverlay.hidden) {
      lastSpeed = 0;
      return;
    }
    let ix = 0;
    let iz = 0;
    if (keys.has("KeyW") || keys.has("ArrowUp")) {
      ix -= 1;
      iz -= 1;
    }
    if (keys.has("KeyS") || keys.has("ArrowDown")) {
      ix += 1;
      iz += 1;
    }
    if (keys.has("KeyA") || keys.has("ArrowLeft")) {
      ix -= 1;
      iz += 1;
    }
    if (keys.has("KeyD") || keys.has("ArrowRight")) {
      ix += 1;
      iz -= 1;
    }
    if (stickActive) {
      ix += stickVec.x + stickVec.z;
      iz += stickVec.z - stickVec.x;
    }
    let vx = 0;
    let vz = 0;
    if (ix || iz) {
      dest = null;
      path = [];
      talkNpc = null;
      chaseId = null;
      repaths = 0;
      const len = Math.hypot(ix, iz) || 1;
      vx = (ix / len) * MOVE;
      vz = (iz / len) * MOVE;
    } else if (dest) {
      if (talkNpc) {
        const npc = NPCS.find((n) => n.id === talkNpc);
        if (npc && Math.hypot(npc.x - p.x, npc.z - p.z) <= 8) {
          const npcId = talkNpc;
          dest = null;
          path = [];
          talkNpc = null;
          repaths = 0;
          stuckFor = 0;
          openNpc(npcId);
        }
      }
      if (dest) {
      let aim = dest;
      if (path.length) {
        let idx = 0;
        const far = Math.min(path.length - 1, 12);
        for (let i = far; i >= 0; i--) {
          if (clearLine(p.x, p.z, path[i].x, path[i].z)) {
            idx = i;
            break;
          }
        }
        if (idx > 0) path.splice(0, idx);
        aim = path[0];
        if (Math.hypot(aim.x - p.x, aim.z - p.z) < 0.45) {
          path.shift();
          aim = path[0] ?? dest;
        }
      }
      const dx = aim.x - p.x;
      const dz = aim.z - p.z;
      const d = Math.hypot(dx, dz);
      const goalD = Math.hypot(dest.x - p.x, dest.z - p.z);
      if (goalD < 0.35) {
        const npcId = talkNpc;
        dest = null;
        path = [];
        talkNpc = null;
        repaths = 0;
        stuckFor = 0;
        if (npcId) openNpc(npcId);
      } else if (d > 0.05) {
        vx = (dx / d) * MOVE;
        vz = (dz / d) * MOVE;
      }
      }
    }
    const next = resolveMove(p.x, p.z, p.x + vx * dt, p.z + vz * dt);
    let nx = next.x;
    let nz = next.z;
    const crowded = (x: number, z: number) =>
      view().monsters.some((m) => m.hp > 0 && screenGap(m.x, m.z, x, z) < 100);
    if (crowded(nx, nz)) {
      if (!crowded(nx, p.z) && !blocked(nx, p.z)) nz = p.z;
      else if (!crowded(p.x, nz) && !blocked(p.x, nz)) nx = p.x;
      else {
        nx = p.x;
        nz = p.z;
      }
    }
    const stuck = Math.hypot(nx - p.x, nz - p.z) < 0.001;
    if (stuck && dest) {
      stuckFor += dt;
      if (stuckFor > 0.28 && repaths < 3) {
        repaths++;
        stuckFor = 0;
        path = routeTo(p.x, p.z, dest.x, dest.z);
      } else if (repaths >= 3 && stuckFor > 0.35) {
        const npcId = talkNpc;
        dest = null;
        path = [];
        talkNpc = null;
        repaths = 0;
        stuckFor = 0;
        if (npcId) openNpc(npcId);
      }
      lastSpeed = 0;
      return;
    }
    stuckFor = 0;
    repaths = 0;
    lastSpeed = stuck ? 0 : Math.hypot(vx, vz);
    if (stuck) return;
    p.x = nx;
    p.z = nz;
    p.rotation = Math.atan2(vx, vz);
    const now = performance.now();
    if (now - lastSend > 70) {
      lastSend = now;
      if (host) world.move(p.id, p.x, p.z, p.rotation);
      else channel?.postMessage({ t: "intent", intent: { op: "move", id: p.id, x: p.x, z: p.z, rotation: p.rotation } });
    }
  }

  function frame(now: number) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!host && performance.now() - lastHeard > 1600) {
      host = true;
      bestClaim = claim;
      if (remote) world.restore(remote);
      if (!world.players.get(myId)) world.join(joinBody);
      remote = null;
    }
    integrate(dt);
    combat();
    const p = me();
    if (p) {
      const tx = (p.x - p.z) * (TW / 2);
      const tz = (p.x + p.z) * (TH / 2);
      cam.x += (tx - cam.x) * Math.min(1, 0.45);
      cam.z += (tz - cam.z) * Math.min(1, 0.45);
    }
    ctx.fillStyle = "#10241f";
    ctx.fillRect(0, 0, viewW, viewH);
    const corners = [
      screenToWorld(-40, -40),
      screenToWorld(viewW + 40, -40),
      screenToWorld(-40, viewH + 40),
      screenToWorld(viewW + 40, viewH + 40),
    ];
    let minX = WORLD_EDGE;
    let maxX = -WORLD_EDGE;
    let minZ = WORLD_EDGE;
    let maxZ = -WORLD_EDGE;
    for (const c of corners) {
      minX = Math.min(minX, c.x);
      maxX = Math.max(maxX, c.x);
      minZ = Math.min(minZ, c.z);
      maxZ = Math.max(maxZ, c.z);
    }
    const x0 = Math.max(-WORLD_EDGE, Math.floor(minX) - 1);
    const x1 = Math.min(WORLD_EDGE, Math.ceil(maxX) + 1);
    const z0 = Math.max(-WORLD_EDGE, Math.floor(minZ) - 1);
    const z1 = Math.min(WORLD_EDGE, Math.ceil(maxZ) + 1);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) drawDiamond(x, z, tileColor(x, z));
    }
    const state = view();
    for (const m of state.monsters) puffDamage(m.id, m.x, m.z, m.hp, "#ffe08a");
    for (const pl of state.players) puffDamage(pl.id, pl.x, pl.z, pl.hp, "#ff6b5a");
    const drawables: Array<{ key: number; draw: () => void }> = [];
    for (const hall of HALLS) {
      drawables.push({
        key: hall.x + hall.z,
        draw: () => {
          shadowAt(hall.x, hall.z, 16);
          drawSprite("hall", hall.x, hall.z, hall.scale);
        },
      });
    }
    for (const npc of NPCS) {
      drawables.push({
        key: npc.x + npc.z,
        draw: () => {
          const p = worldToScreen(npc.x, npc.z);
          ctx.save();
          ctx.translate(p.x, p.y + 4);
          ctx.scale(1, 0.42);
          const vendor = npc.role === "vendor";
          const trainer = npc.role === "trainer";
          ctx.beginPath();
          ctx.arc(0, 0, vendor || trainer ? 40 : 22, 0, Math.PI * 2);
          ctx.strokeStyle = vendor ? "#39ff6a" : trainer ? "#7ecbff" : "rgba(240, 210, 120, .9)";
          ctx.lineWidth = vendor || trainer ? 8 : 3;
          ctx.stroke();
          if (vendor || trainer) {
            ctx.beginPath();
            ctx.arc(0, 0, 28, 0, Math.PI * 2);
            ctx.strokeStyle = trainer ? "#f4fbff" : "#f4fff6";
            ctx.lineWidth = 3;
            ctx.stroke();
          }
          ctx.restore();
          shadowAt(npc.x, npc.z, 12);
          drawHero(npc.race, npc.id, npc.x, npc.z);
          const tag = npc.role === "vendor" ? "VENDOR" : npc.role === "trainer" ? "TRAINER" : "WAYFARER";
          const tagColor = npc.role === "vendor" ? "#39ff6a" : npc.role === "trainer" ? "#7ecbff" : "#f0e2b0";
          ctx.fillStyle = "rgba(8,10,8,.82)";
          ctx.fillRect(p.x - 46, p.y - 148, 92, 34);
          ctx.font = "bold 13px Georgia";
          ctx.textAlign = "center";
          ctx.fillStyle = tagColor;
          ctx.fillText(tag, p.x, p.y - 134);
          ctx.font = "13px Georgia";
          ctx.fillStyle = "#fff6d8";
          ctx.fillText(npc.name, p.x, p.y - 118);
        },
      });
    }
    for (const [x, z] of TREES) {
      drawables.push({
        key: x + z,
        draw: () => {
          shadowAt(x, z, 22);
          drawSprite("tree", x, z, 0.28);
        },
      });
    }
    for (const [x, z] of FIRES) {
      drawables.push({
        draw: () => {
          shadowAt(x, z, 10);
          drawSprite("fire", x, z, 0.16);
        },
        key: x + z,
      });
    }
    const aimed = currentTarget();
    for (const m of state.monsters) {
      if (m.hp <= 0) continue;
      drawables.push({
        key: m.x + m.z,
        draw: () => {
          shadowAt(m.x, m.z, 14);
          if (!drawSprite(m.type.toLowerCase(), m.x, m.z, mobByType(m.type).scale || 0.18)) drawFallback(m.type, m.x, m.z);
          if (aimed && aimed.id === m.id) markTarget(m.x, m.z);
        },
      });
    }
    const nowDraw = performance.now();
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      const age = nowDraw - b.born;
      if (age > 380 + 340) {
        bolts.splice(i, 1);
        continue;
      }
      if (age < 380) {
        const t = age / 380;
        const x = b.x0 + (b.x1 - b.x0) * t;
        const z = b.z0 + (b.z1 - b.z0) * t;
        drawables.push({
          key: x + z + 0.2,
          draw: () => drawFx("fireball", Math.floor(nowDraw / 70) % 4, 2, 2, x, z, 72, 28),
        });
      } else {
        const frame = Math.min(3, Math.floor((age - 380) / 80));
        drawables.push({
          key: b.x1 + b.z1 + 0.3,
          draw: () => drawFx("impact", frame, 2, 2, b.x1, b.z1, 96, 16),
        });
      }
    }
    const heroes = state.players.filter((pl) => pl.hp > 0);
    for (const pl of heroes) {
      drawables.push({
        key: pl.x + pl.z,
        draw: () => {
          const race = (pl.race || "human").toLowerCase();
          shadowAt(pl.x, pl.z, 14);
          drawHero(race, pl.id, pl.x, pl.z, pl.prestigeClass || pl.baseClass);
          const pt = worldToScreen(pl.x, pl.z);
          ctx.fillStyle = pl.id === myId ? "#f0e2b0" : "#ddd";
          ctx.font = "13px Georgia";
          ctx.textAlign = "center";
          ctx.fillText(pl.username, pt.x, pt.y - (race === "minotaur" ? 136 : 120));
        },
      });
    }
    drawables.sort((a, b) => a.key - b.key);
    for (const d of drawables) d.draw();
    for (const m of state.monsters) {
      if (m.hp <= 0) continue;
      const pt = worldToScreen(m.x, m.z);
      const barW = 48;
      const barY = pt.y - 108;
      const pct = m.maxHp > 0 ? Math.max(0, Math.min(1, m.hp / m.maxHp)) : 0;
      ctx.fillStyle = "rgba(0,0,0,.75)";
      ctx.fillRect(pt.x - barW / 2 - 1, barY - 1, barW + 2, 9);
      ctx.fillStyle = "#3a1515";
      ctx.fillRect(pt.x - barW / 2, barY, barW, 7);
      ctx.fillStyle = pct > 0.35 ? "#e24b3a" : "#e2b15a";
      ctx.fillRect(pt.x - barW / 2, barY, barW * pct, 7);
      ctx.font = "13px Georgia";
      ctx.textAlign = "center";
      ctx.fillStyle = conFor(m.level, me()?.level ?? 1).color;
      ctx.fillText(m.type, pt.x, barY - 16);
      ctx.font = "12px Georgia";
      ctx.fillStyle = "#fff6d8";
      ctx.fillText(`HP ${Math.ceil(m.hp)}/${m.maxHp}`, pt.x, barY - 3);
    }
    ctx.font = "15px Georgia";
    ctx.textAlign = "center";
    ctx.fillStyle = "#f0e2b0";
    for (const city of CITIES) {
      const plaza = worldToScreen(city.x, city.z);
      const npc = NPCS.find((n) => n.city === city.id);
      const npcPt = npc ? worldToScreen(npc.x, npc.z) : plaza;
      const vx = plaza.x - npcPt.x;
      const vy = plaza.y - npcPt.y - 70;
      const len = Math.hypot(vx, vy) || 1;
      ctx.fillText(city.name, plaza.x + (vx / len) * 150, plaza.y + (vy / len) * 72 - 28);
    }
    if (dest) {
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 160);
      drawDiamond(dest.x, dest.z, `rgba(240, 214, 120, ${0.34 * pulse})`);
      const mark = worldToScreen(dest.x, dest.z);
      ctx.save();
      ctx.translate(mark.x, mark.y);
      ctx.beginPath();
      ctx.moveTo(0, -TH / 2);
      ctx.lineTo(TW / 2, 0);
      ctx.lineTo(0, TH / 2);
      ctx.lineTo(-TW / 2, 0);
      ctx.closePath();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = `rgba(255, 228, 140, ${pulse})`;
      ctx.stroke();
      ctx.restore();
    }
    const floatNow = performance.now();
    ctx.save();
    ctx.textAlign = "center";
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      const age = floatNow - f.born;
      const life = f.life ?? 1700;
      if (age > life) {
        floaters.splice(i, 1);
        continue;
      }
      const fadeAt = life - 700;
      const pt = worldToScreen(f.x, f.z);
      const rise = f.size >= 22 ? 0.07 : 0.03;
      const y = pt.y - f.lift - age * rise;
      ctx.globalAlpha = age > fadeAt ? Math.max(0, 1 - (age - fadeAt) / 700) : 1;
      ctx.font = `${f.size >= 22 ? "bold " : ""}${f.size ?? 15}px Georgia`;
      ctx.lineWidth = f.size >= 22 ? 4 : 3;
      ctx.strokeStyle = "#10200c";
      ctx.strokeText(f.text, pt.x, y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, pt.x, y);
    }
    ctx.restore();
    const g = ctx.createRadialGradient(viewW / 2, viewH / 2, viewH * 0.3, viewW / 2, viewH / 2, viewH * 0.72);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(6,10,8,.55)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, viewW, viewH);
    hud();
    if (!mapOverlay.hidden) drawWorldMap();
  }

  function persist() {
    const p = me();
    if (!p) return;
    writeSave({
      version: 1,
      username: p.username,
      race: p.race,
      baseClass: p.baseClass,
      prestigeClass: p.prestigeClass,
      level: p.level,
      xp: p.xp,
      gold: p.gold,
      x: p.x,
      z: p.z,
      inventory: p.inventory,
      equipment: p.equipment,
      trainPoints: p.trainPoints,
      skills: p.skills,
      hotbar: p.hotbar,
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (!bag.hidden) {
        bag.hidden = true;
        return;
      }
      if (!shop.hidden) {
        shop.hidden = true;
        return;
      }
      if (!trainPanel.hidden) {
        trainPanel.hidden = true;
        return;
      }
      if (!sheet.hidden) {
        sheet.hidden = true;
        return;
      }
      if (!mapOverlay.hidden) {
        e.preventDefault();
        mapOverlay.hidden = true;
        return;
      }
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const digit = /^Digit([1-8])$/.exec(e.code) || /^Numpad([1-8])$/.exec(e.code);
    if (digit) {
      e.preventDefault();
      pressSlot(Number(digit[1]) - 1);
      return;
    }
    if (e.code === "KeyI") {
      e.preventDefault();
      bag.hidden = !bag.hidden;
      if (!bag.hidden) {
        bagSig = "";
        paintBag();
      }
      return;
    }
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
      e.preventDefault();
    }
    keys.add(e.code);
  }
  function onKeyUp(e: KeyboardEvent) {
    keys.delete(e.code);
  }
  function onBlur() {
    if (!window.__controlsTest) keys.clear();
  }

  function canvasPoint(e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    return {
      sx: ((e.clientX - rect.left) / Math.max(1, rect.width)) * viewW,
      sy: ((e.clientY - rect.top) / Math.max(1, rect.height)) * viewH,
    };
  }

  function pickTile(sx: number, sy: number) {
    const rough = screenToWorld(sx, sy);
    let bestX = Math.round(rough.x);
    let bestZ = Math.round(rough.z);
    let best = Infinity;
    for (let x = bestX - 3; x <= bestX + 3; x++) {
      for (let z = bestZ - 3; z <= bestZ + 3; z++) {
        const p = worldToScreen(x, z);
        const d = Math.abs(sx - p.x) / (TW / 2) + Math.abs(sy - p.y) / (TH / 2);
        if (d < best) {
          best = d;
          bestX = x;
          bestZ = z;
        }
      }
    }
    if (!blocked(bestX, bestZ)) return { x: bestX, z: bestZ };
    for (let r = 1; r <= 6; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = bestX + dx;
          const z = bestZ + dz;
          if (!blocked(x, z)) return { x, z };
        }
      }
    }
    return { x: bestX, z: bestZ };
  }

  function goTo(x: number, z: number, talk: string | null, keepChase = false) {
    const p = localPlayer();
    dest = { x, z };
    talkNpc = talk;
    if (!keepChase) chaseId = null;
    repaths = 0;
    path = p ? routeTo(p.x, p.z, x, z) : [];
  }

  function spriteHit(sx: number, sy: number, x: number, z: number, height: number) {
    const p = worldToScreen(x, z);
    const above = p.y - sy;
    return Math.abs(sx - p.x) < 48 && above > -18 && above < height;
  }
  function onPointer(e: PointerEvent) {
    if (e.button !== 0 || !mapOverlay.hidden) return;
    const p = me();
    if (!p || p.hp <= 0) return;
    const { sx, sy } = canvasPoint(e);
    const w = screenToWorld(sx, sy);
    let pickedNpc: (typeof NPCS)[number] | null = null;
    for (const npc of NPCS) {
      if (spriteHit(sx, sy, npc.x, npc.z, 124)) {
        pickedNpc = npc;
        break;
      }
    }
    if (!pickedNpc) {
      let npcBest = 2.1;
      for (const npc of NPCS) {
        const d = Math.hypot(npc.x - w.x, npc.z - w.z);
        if (d < npcBest) {
          npcBest = d;
          pickedNpc = npc;
        }
      }
    }
    if (pickedNpc) {
      const dist = Math.hypot(pickedNpc.x - p.x, pickedNpc.z - p.z);
      chaseId = null;
      if (dist < 6.2) {
        dest = null;
        path = [];
        talkNpc = null;
        openNpc(pickedNpc.id);
      } else {
        const ang = Math.atan2(p.z - pickedNpc.z, p.x - pickedNpc.x);
        const spot = nearestOpen(pickedNpc.x + Math.cos(ang) * 2.3, pickedNpc.z + Math.sin(ang) * 2.3);
        goTo(spot.x, spot.z, pickedNpc.id);
      }
      return;
    }
    let picked: string | null = null;
    let best = 1.7;
    for (const m of view().monsters) {
      if (m.hp <= 0) continue;
      const d = Math.hypot(m.x - w.x, m.z - w.z);
      if (d < best) {
        best = d;
        picked = m.id;
      }
    }
    if (picked) {
      pinnedId = picked;
      chaseId = picked;
      const m = view().monsters.find((mon) => mon.id === picked);
      if (m) {
        const mage = p.baseClass === "Mage" || p.prestigeClass === "Wizard";
        const gap = screenGap(m.x, m.z, p.x, p.z);
        const inRange = mage ? Math.hypot(m.x - p.x, m.z - p.z) <= 7.2 : gap >= MELEE_GAP;
        if (!inRange) {
          const spot = mage ? rangedStand(m.x, m.z, p.x, p.z) : adjacentStand(m.x, m.z, p.x, p.z);
          goTo(spot.x, spot.z, null, true);
        } else {
          dest = null;
          path = [];
        }
      }
      return;
    }
    pinnedId = null;
    chaseId = null;
    const tile = pickTile(sx, sy);
    goTo(tile.x, tile.z, null);
  }

  function openNpc(id: string) {
    const npc = NPCS.find((n) => n.id === id);
    if (!npc) return;
    const p = me();
    if (!p || Math.hypot(npc.x - p.x, npc.z - p.z) > 8) return;
    if (npc.role === "vendor") openShop();
    else if (npc.role === "trainer") openTrain();
    else openTravel(npc.city);
  }

  function openTrain() {
    const p = me();
    if (!p || !nearestTrainer(p.x, p.z, 8)) return;
    trainSig = "";
    trainPanel.hidden = false;
    paintTrain();
  }

  function paintTrain() {
    const p = me();
    if (!p || trainPanel.hidden) return;
    const sig = `${p.gold}|${p.trainPoints}|${JSON.stringify(p.skills ?? {})}`;
    trainPointsEl.textContent = `Training points ${p.trainPoints ?? 0} · Gold ${p.gold}`;
    if (sig === trainSig) return;
    trainSig = sig;
    trainList.innerHTML = SKILLS.map((skill) => {
      const cur = p.skills?.[skill.id] ?? 0;
      const effect = skill.affects === "hit" ? `hit ${hitChance(p)}%` : `damage ${trainedDamage(p)}`;
      return `<button type="button" data-train="${skill.id}">${skill.name} ${cur}% — 1 pt, ${skill.gold}g (${effect})</button>`;
    }).join("");
  }

  function openShop() {
    const p = me();
    if (!p || !nearestVendor(p.x, p.z, 8)) return;
    shopSig = "";
    shop.hidden = false;
    paintShop();
  }

  let shopSig = "";
  let bagSig = "";
  let trainSig = "";

  function paintShop() {
    const p = me();
    if (!p || shop.hidden) return;
    const sig = `${p.gold}|${JSON.stringify(p.inventory ?? {})}`;
    shopGold.textContent = `Gold ${p.gold}`;
    if (sig === shopSig) return;
    shopSig = sig;
    shopStock.innerHTML = VENDOR_STOCK.map((row) => {
      const item = itemById(row.itemId);
      return `<button type="button" data-buy="${row.itemId}">Buy ${item?.name ?? row.itemId} — ${row.price}g</button>`;
    }).join("");
    const rows = Object.entries(p.inventory ?? {}).filter(([, n]) => n > 0);
    shopBag.innerHTML = rows.length
      ? rows
          .map(([id, n]) => {
            const item = itemById(id);
            return `<button type="button" data-sell="${id}">Sell ${item?.name ?? id} ×${n} — ${item?.sell ?? 0}g</button>`;
          })
          .join("")
      : `<p class="sheet-note">Nothing to sell.</p>`;
  }

  function paintBag() {
    const p = me();
    if (!p || bag.hidden) return;
    const sig = JSON.stringify(p.inventory ?? {}) + "|" + JSON.stringify(p.equipment ?? {});
    if (sig === bagSig) return;
    bagSig = sig;
    dollSlots.innerHTML = EQUIP_SLOTS.map((slot) => {
      const worn = p.equipment?.[slot.id];
      const item = worn ? itemById(worn) : null;
      const btn = item ? `<button type="button" data-unequip="${slot.id}">Unequip</button>` : "";
      return `<div class="bag-row"><span>${slot.label}</span><span>${item?.name ?? "—"}</span>${btn}</div>`;
    }).join("");
    const rows = Object.entries(p.inventory ?? {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => a[0].localeCompare(b[0]));
    bagBody.innerHTML = rows.length
      ? rows
          .map(([id, n]) => {
            const item = itemById(id);
            const use = item?.kind === "consumable" ? `<button type="button" data-use="${id}">Use</button>` : "";
            const equip = item?.slot ? `<button type="button" data-equip="${id}">Equip</button>` : "";
            return `<div class="bag-row"><span>${item?.name ?? id} ×${n}</span><span>${equip}${use}</span></div>`;
          })
          .join("")
      : `<p class="sheet-note">Your bag is empty.</p>`;
  }

  function openTravel(cityId: string) {
    const city = cityAt(cityId);
    const p = me();
    if (!city || !p || !nearestWayfarer(p.x, p.z, 8)) return;
    travelTitle.textContent = `Wayfarer of ${city.name}`;
    travelHint.textContent = "The gate can carry you to another city.";
    travelButtons.innerHTML = CITIES.filter((c) => c.id !== city.id)
      .map((c) => `<button type="button" data-city="${c.id}">${c.name}</button>`)
      .join("");
    travelPanel.hidden = false;
  }

  function goCity(cityId: string) {
    const p = localPlayer();
    const city = cityAt(cityId);
    if (!p || !city || p.hp <= 0) return;
    if (!nearestWayfarer(p.x, p.z, 4.2)) return;
    dest = null;
    path = [];
    talkNpc = null;
    travelPanel.hidden = true;
    if (host) world.travel(p.id, cityId);
    else {
      const spot = arrivalAt(city.x, city.z);
      p.x = spot.x;
      p.z = spot.z;
      channel?.postMessage({ t: "intent", intent: { op: "travel", id: myId, cityId } });
    }
  }

  function onTalk(e: Event) {
    e.preventDefault();
    const p = me();
    if (!p) return;
    const npc = nearestWayfarer(p.x, p.z);
    if (npc) openTravel(npc.city);
  }

  function onTravelClick(e: Event) {
    const btn = (e.target as HTMLElement).closest("button[data-city]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const cityId = (btn as HTMLElement).dataset.city;
    if (cityId) goCity(cityId);
  }

  function onRespawn(e: Event) {
    e.preventDefault();
    dest = null;
    path = [];
    talkNpc = null;
    if (host) world.respawn(myId);
    else channel?.postMessage({ t: "intent", intent: { op: "respawn", id: myId } });
  }

  function onTravelClose(e: Event) {
    e.preventDefault();
    travelPanel.hidden = true;
  }

  function act(skill: string) {
    const power = powerById(skill);
    const selfCast = !power || power.range <= 0 || power.kind === "heal" || power.kind === "buff" || power.kind === "stealth";
    const range = power && power.range > 0 ? power.range : 3.8;
    const pinned = pinnedId ? view().monsters.find((m) => m.id === pinnedId && m.hp > 0) : null;
    const p = me();
    const pinOk = pinned && p && Math.hypot(pinned.x - p.x, pinned.z - p.z) <= range;
    const targetId = selfCast ? null : pinOk ? pinned.id : nearestId(range);
    const actor = actors.get(myId) ?? {
      x: 0,
      z: 0,
      facing: 0,
      attackUntil: 0,
      castUntil: 0,
      moving: false,
      phase: 0,
      stamp: 0,
    };
    const now = performance.now();
    actor.attackUntil = now + 640;
    if (power && power.mana > 0) actor.castUntil = now + 700;
    actors.set(myId, actor);
    if (power && power.mana > 0 && power.kind !== "heal" && power.kind !== "buff" && targetId && p) {
      const m = view().monsters.find((mon) => mon.id === targetId);
      if (m) bolts.push({ x0: p.x, z0: p.z, x1: m.x, z1: m.z, born: performance.now() });
    }
    if (skill === "attack") send({ op: "attack", id: myId, targetId });
    else send({ op: "skill", id: myId, skill, targetId });
  }

  function pressSlot(index: number) {
    const p = me();
    const bar = p?.hotbar?.length === 8 ? p.hotbar : defaultHotbar(p?.baseClass || "Fighter", p?.prestigeClass || "", p?.level || 1);
    const id = bar[index] || "";
    if (!id) {
      floatText("Nothing in that slot.");
      return;
    }
    const power = powerById(id);
    const t = currentTarget();
    if (power && power.range > 0 && p && t && Math.hypot(t.x - p.x, t.z - p.z) > power.range) {
      pinnedId = t.id;
      chaseId = t.id;
      const mage = power.mana > 0;
      const spot = mage ? rangedStand(t.x, t.z, p.x, p.z) : adjacentStand(t.x, t.z, p.x, p.z);
      goTo(spot.x, spot.z, null, true);
    }
    act(id);
  }

  function onHotbar(e: Event) {
    const slot = Number((e.currentTarget as HTMLElement).dataset.slot || 0);
    e.preventDefault();
    pressSlot(slot);
  }

  function onSheet(e: Event) {
    e.preventDefault();
    sheet.hidden = !sheet.hidden;
  }
  function onBagToggle(e: Event) {
    e.preventDefault();
    bag.hidden = !bag.hidden;
    if (!bag.hidden) {
      bagSig = "";
      paintBag();
    }
  }
  function onBagClick(e: Event) {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn) return;
    e.preventDefault();
    const itemId = btn.dataset.use;
    const equipId = btn.dataset.equip;
    const slot = btn.dataset.unequip;
    if (itemId) send({ op: "use", id: myId, itemId });
    else if (equipId) send({ op: "equip", id: myId, itemId: equipId });
    else if (slot) send({ op: "unequip", id: myId, slot });
  }
  function onShopClick(e: Event) {
    const btn = (e.target as HTMLElement).closest("button[data-buy], button[data-sell]");
    if (!btn) return;
    e.preventDefault();
    const buyId = (btn as HTMLElement).dataset.buy;
    const sellId = (btn as HTMLElement).dataset.sell;
    if (buyId) send({ op: "buy", id: myId, itemId: buyId });
    else if (sellId) send({ op: "sell", id: myId, itemId: sellId });
  }
  function onTrainClick(e: Event) {
    const btn = (e.target as HTMLElement).closest("button[data-train]");
    if (!btn) return;
    e.preventDefault();
    const skillId = (btn as HTMLElement).dataset.train;
    if (skillId) send({ op: "train", id: myId, skillId });
  }
  function onTrainClose(e: Event) {
    e.preventDefault();
    trainPanel.hidden = true;
  }
  function onShopClose(e: Event) {
    e.preventDefault();
    shop.hidden = true;
  }
  function onBagClose(e: Event) {
    e.preventDefault();
    bag.hidden = true;
  }
  function onSheetClose(e: Event) {
    e.preventDefault();
    sheet.hidden = true;
  }
  function onDebugLevel(e: Event) {
    e.preventDefault();
    const input = root.querySelector<HTMLInputElement>("#debugLevelInput");
    send({ op: "setLevel", id: myId, level: Number(input?.value || 10) });
  }

  function onPromote(e: Event) {
    e.preventDefault();
    const p = me();
    if (!p) return;
    const cls = PRESTIGE_OF[p.baseClass];
    if (window.confirm(`Promote to ${cls}?`)) send({ op: "promote", id: myId, cls });
  }

  function onChatToggle(e: Event) {
    e.preventDefault();
    chat.classList.toggle("open");
    if (chat.classList.contains("open")) chatInput.focus();
  }

  function onMap(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    mapOverlay.hidden = !mapOverlay.hidden;
    if (!mapOverlay.hidden) drawWorldMap();
  }

  function onMapClose(e: Event) {
    e.preventDefault();
    mapOverlay.hidden = true;
  }

  function onChatKey(e: KeyboardEvent) {
    if (e.key === "Enter" && chatInput.value.trim()) {
      send({ op: "chat", id: myId, msg: chatInput.value.trim() });
      chatInput.value = "";
    }
  }

  function setStick(clientX: number, clientY: number) {
    const r = stick.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const max = r.width / 2 - 8;
    const len = Math.hypot(dx, dy) || 1;
    const scale = Math.min(1, max / len);
    dx *= scale;
    dy *= scale;
    knob.style.left = `${r.width / 2 - 20 + dx}px`;
    knob.style.top = `${r.height / 2 - 20 + dy}px`;
    stickVec.x = dx / max;
    stickVec.z = dy / max;
  }
  function resetStick() {
    stickActive = false;
    stickVec.x = 0;
    stickVec.z = 0;
    knob.style.left = "35px";
    knob.style.top = "35px";
  }
  function onStickDown(e: PointerEvent) {
    stick.setPointerCapture(e.pointerId);
    stickActive = true;
    setStick(e.clientX, e.clientY);
  }
  function onStickMove(e: PointerEvent) {
    if (stickActive) setStick(e.clientX, e.clientY);
  }

  const hotbarButtons = [...root.querySelectorAll<HTMLButtonElement>("#hotbar button")];
  hotbarButtons.forEach((btn) => btn.addEventListener("pointerup", onHotbar));
  promoteBtn.addEventListener("pointerup", onPromote);
  root.querySelector("#sheetBtn")!.addEventListener("pointerup", onSheet);
  root.querySelector("#sheetClose")!.addEventListener("pointerup", onSheetClose);
  root.querySelector("#bagBtn")!.addEventListener("pointerup", onBagToggle);
  root.querySelector("#bagClose")!.addEventListener("pointerup", onBagClose);
  bag.addEventListener("pointerup", onBagClick);
  shopStock.addEventListener("pointerup", onShopClick);
  shopBag.addEventListener("pointerup", onShopClick);
  root.querySelector("#shopClose")!.addEventListener("pointerup", onShopClose);
  trainList.addEventListener("pointerup", onTrainClick);
  root.querySelector("#trainClose")!.addEventListener("pointerup", onTrainClose);
  root.querySelector("#debugLevelBtn")?.addEventListener("pointerup", onDebugLevel);
  root.querySelector("#chatToggle")!.addEventListener("pointerup", onChatToggle);
  root.querySelector("#mapBtn")!.addEventListener("pointerup", onMap);
  root.querySelector("#mapClose")!.addEventListener("pointerup", onMapClose);
  talkBtn.addEventListener("pointerup", onTalk);
  travelButtons.addEventListener("pointerup", onTravelClick);
  root.querySelector("#travelClose")!.addEventListener("pointerup", onTravelClose);
  respawnBtn.addEventListener("pointerup", onRespawn);
  chatInput.addEventListener("keydown", onChatKey);
  canvas.addEventListener("pointerdown", onPointer);
  stick.addEventListener("pointerdown", onStickDown);
  stick.addEventListener("pointermove", onStickMove);
  stick.addEventListener("pointerup", resetStick);
  stick.addEventListener("pointercancel", resetStick);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", resize);

  const stepTimer = window.setInterval(() => {
    if (host && mapOverlay.hidden) authority.step(Date.now());
  }, 400);
  const snapTimer = window.setInterval(() => {
    if (host) {
      channel?.postMessage({ t: "beat", id: myId, claim });
      publishSnap();
    } else {
      channel?.postMessage({ t: "claim", id: myId, claim });
      if (!remote?.players.some((p) => p.id === myId)) send({ op: "join", body: joinBody });
    }
  }, 180);
  const saveTimer = window.setInterval(persist, 2000);

  function onLeave() {
    persist();
    send({ op: "leave", id: myId });
  }
  window.addEventListener("pagehide", onLeave);

  window.__controlsTest = {
    getYaw: () => localPlayer()?.rotation ?? 0,
    getSpeed: () => lastSpeed,
    getPos: () => {
      const p = localPlayer();
      return { x: p?.x ?? 0, z: p?.z ?? 0, hp: p?.hp ?? 0, mana: p?.mana ?? 0, gold: p?.gold ?? 0, xp: p?.xp ?? 0 };
    },
    hurt: (amount: number) => {
      const p = localPlayer();
      if (p) p.hp = Math.max(0, p.hp - amount);
    },
    setKeys: (codes) => {
      keys.clear();
      for (const code of codes) keys.add(code);
    },
    monsters: () =>
      view().monsters.filter((m) => m.hp > 0).map((m) => ({ id: m.id, type: m.type, hp: m.hp, x: m.x, z: m.z })),
    place: (x: number, z: number) => {
      const p = localPlayer();
      if (!p) return;
      const spot = nearestOpen(x, z);
      p.x = spot.x;
      p.z = spot.z;
      dest = null;
      path = [];
      chaseId = null;
    },
    swing: () => act("attack"),
    setLevel: (level: number) => send({ op: "setLevel", id: myId, level }),
  };

  resize();
  raf = requestAnimationFrame(frame);

  return () => {
    dead = true;
    cancelAnimationFrame(raf);
    window.clearInterval(stepTimer);
    window.clearInterval(snapTimer);
    window.clearInterval(saveTimer);
    onLeave();
    channel?.close();
    hotbarButtons.forEach((btn) => btn.removeEventListener("pointerup", onHotbar));
    promoteBtn.removeEventListener("pointerup", onPromote);
    root.querySelector("#chatToggle")?.removeEventListener("pointerup", onChatToggle);
    root.querySelector("#mapBtn")?.removeEventListener("pointerup", onMap);
    root.querySelector("#mapClose")?.removeEventListener("pointerup", onMapClose);
    talkBtn.removeEventListener("pointerup", onTalk);
    travelButtons.removeEventListener("pointerup", onTravelClick);
    root.querySelector("#travelClose")?.removeEventListener("pointerup", onTravelClose);
    respawnBtn.removeEventListener("pointerup", onRespawn);
    chatInput.removeEventListener("keydown", onChatKey);
    canvas.removeEventListener("pointerdown", onPointer);
    stick.removeEventListener("pointerdown", onStickDown);
    stick.removeEventListener("pointermove", onStickMove);
    stick.removeEventListener("pointerup", resetStick);
    stick.removeEventListener("pointercancel", resetStick);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", resize);
    window.removeEventListener("pagehide", onLeave);
    if (window.__controlsTest) delete window.__controlsTest;
  };
}

function escapeHtml(s: string) {
  const amp = String.fromCharCode(38) + "amp;";
  const lt = String.fromCharCode(38) + "lt;";
  const gt = String.fromCharCode(38) + "gt;";
  const quot = String.fromCharCode(38) + "quot;";
  const apos = String.fromCharCode(38) + "#39;";
  return s
    .replace(/&/g, amp)
    .replace(/</g, lt)
    .replace(/>/g, gt)
    .replace(/"/g, quot)
    .replace(/'/g, apos);
}
