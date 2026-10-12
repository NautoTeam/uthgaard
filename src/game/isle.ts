import { loadSave, writeSave, loadGraves, writeGraves } from "./save";
import {
  CITIES,
  FIRES,
  HALLS,
  LAKES,
  NPCS,
  ROADS,
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
import { BOUNDS, CIRCUITS, DEFAULT_ATTUNED, GATES, ISLANDS, LATER_ISLANDS, LINKS, TERRAIN_PALETTE, WORLD_CITIES, gateHop, insideIsland, islandAt } from "../shared/content/world";
import { terrainAt, zoneAt } from "../shared/sim/mask";
import { CAMPS, PRESTIGE_OF, xpNeed, type BaseClass, type PublicState, type Race } from "./types";
import { MOBS, RACES, EQUIP_SLOTS, SKILLS, VENDOR_STOCK, attrsFor, conFor, defaultHotbar, gearTotals, hitChance, itemById, poolsFor, trainedDamage, mobByType, powerById, DEBUG_SET_LEVEL } from "../shared/content/catalog";
import { diamondDistance, resolveClick, screenToWorld as isoScreenToWorld, worldToScreen as isoWorldToScreen } from "./iso";
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
const NAMES = [...new Set([...RACES.map((r) => r.toLowerCase()), "marshwarden", ...MOBS.map((m) => m.type.toLowerCase()), "hall", "tree", "fire"])];

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
  | { op: "loot"; id: string; graveId: string }
  | { op: "setLevel"; id: string; level: number }
  | { op: "setHp"; id: string; hp: number }
  | { op: "buy"; id: string; itemId: string }
  | { op: "sell"; id: string; itemId: string }
  | { op: "use"; id: string; itemId: string }
  | { op: "equip"; id: string; itemId: string }
  | { op: "unequip"; id: string; slot: string }
  | { op: "train"; id: string; skillId: string }
  | { op: "spawn"; id: string };

declare global {
  interface Window {
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      getPos?: () => { x: number; z: number; hp: number; mana: number; gold: number; xp: number; level: number };
      hurt?: (amount: number) => void;
      setKeys?: (codes: string[]) => void;
      monsters?: () => Array<{ id: string; type: string; level: number; hp: number; x: number; z: number }>;
      npcs?: () => Array<{ id: string; name: string; role: string; city: string; x: number; z: number }>;
      mapOpen?: () => boolean;
      place?: (x: number, z: number) => void;
      swing?: () => void;
      setLevel?: (level: number) => void;
      project?: (x: number, z: number) => { x: number; y: number };
      unproject?: (sx: number, sy: number) => { x: number; z: number };
      viewSize?: () => {
        viewW: number;
        viewH: number;
        camX: number;
        camZ: number;
        dpr: number;
        backingW: number;
        backingH: number;
      };
      resolveClick?: (input: {
        clientX: number;
        clientY: number;
        offsetX?: number;
        offsetY?: number;
        rect?: { left: number; top: number; width: number; height: number };
      }) => { sx: number; sy: number; x: number; z: number; camX: number; camZ: number; heroX: number; heroZ: number };
      lastClick?: () => {
        clientX: number;
        clientY: number;
        sx: number;
        sy: number;
        camX: number;
        camZ: number;
        tx: number;
        tz: number;
        heroX: number;
        heroZ: number;
      } | null;
      dest?: () => { x: number; z: number } | null;
      flushSave?: () => void;
      panels?: () => { shop: boolean; travel: boolean; train: boolean; shopTitle: string; trainTitle: string };
      groupMembers?: () => Array<{ id: string; name: string; level: number; hp: number; maxHp: number }>;
      spawnMob?: () => void;
      attackPeer?: () => string;
      zoneText?: () => string;
      pvpLines?: () => string[];
      floats?: () => string[];
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
  if (intent.op === "loot") return world.loot(intent.id, intent.graveId);
  if (intent.op === "setLevel") return world.setLevel(intent.id, intent.level);
  if (intent.op === "setHp") return world.setHp(intent.id, intent.hp);
  if (intent.op === "buy") return world.buy(intent.id, intent.itemId);
  if (intent.op === "sell") return world.sell(intent.id, intent.itemId);
  if (intent.op === "use") return world.useItem(intent.id, intent.itemId);
  if (intent.op === "equip") return world.equip(intent.id, intent.itemId);
  if (intent.op === "unequip") return world.unequip(intent.id, intent.slot);
  if (intent.op === "train") return world.train(intent.id, intent.skillId);
  if (intent.op === "spawn") return world.spawnTest(intent.id);
  return { ok: false };
}

type IsleSlot = { dispose?: () => void };

function isleSlot(): IsleSlot {
  const g = globalThis as typeof globalThis & { __caldrenmoorIsle?: IsleSlot };
  if (!g.__caldrenmoorIsle) g.__caldrenmoorIsle = {};
  return g.__caldrenmoorIsle;
}

export function mountIsle(root: HTMLElement, profile: IsleProfile) {
  const slot = isleSlot();
  if (slot.dispose) {
    const prev = slot.dispose;
    slot.dispose = undefined;
    prev();
  }
  const canvas = root.querySelector<HTMLCanvasElement>("#view")!;
  const ctx = canvas.getContext("2d")!;
  const statsEl = root.querySelector<HTMLElement>("#stats")!;
  const messages = root.querySelector<HTMLElement>("#messages")!;
  const pvpBox = root.querySelector<HTMLElement>("#pvpMessages");
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
  const shopTitle = root.querySelector<HTMLElement>("#shopTitle");
  const shopGold = root.querySelector<HTMLElement>("#shopGold")!;
  const shopStock = root.querySelector<HTMLElement>("#shopStock")!;
  const shopBag = root.querySelector<HTMLElement>("#shopBag")!;
  const trainPanel = root.querySelector<HTMLElement>("#train")!;
  const trainTitle = root.querySelector<HTMLElement>("#trainTitle");
  const trainPointsEl = root.querySelector<HTMLElement>("#trainPoints")!;
  const trainList = root.querySelector<HTMLElement>("#trainList")!;
  const bag = root.querySelector<HTMLElement>("#bag")!;
  const bagBody = root.querySelector<HTMLElement>("#bagBody")!;
  const dollSlots = root.querySelector<HTMLElement>("#dollSlots")!;
  const debugRow = root.querySelector<HTMLElement>("#debugLevel");
  if (DEBUG_SET_LEVEL && debugRow) debugRow.hidden = false;
  const debugHud = root.querySelector<HTMLElement>("#debugHud");
  const showDebugHud = new URLSearchParams(window.location.search).get("debug") === "1";
  if (debugHud && showDebugHud) debugHud.hidden = false;
  const groupFrame = root.querySelector<HTMLElement>("#groupFrame");
  const inviteToast = root.querySelector<HTMLElement>("#inviteToast");
  const inviteText = root.querySelector<HTMLElement>("#inviteText");
  const ctxMenu = root.querySelector<HTMLElement>("#ctxMenu");
  const clickDebug = root.querySelector<HTMLElement>("#clickDebug");
  const clickDebugToggle = root.querySelector<HTMLInputElement>("#clickDebugToggle");

  let blockPanelClicks = false;
  function armPanelBlock() {
    if (blockPanelClicks) return;
    blockPanelClicks = true;
    const release = () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      setTimeout(() => {
        blockPanelClicks = false;
      }, 0);
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
  }
  const panelStack: HTMLElement[] = [];
  function setOpen(el: HTMLElement, open: boolean) {
    const drop = (other: HTMLElement) => {
      other.hidden = true;
      const j = panelStack.indexOf(other);
      if (j >= 0) panelStack.splice(j, 1);
    };
    const mine = panelStack.indexOf(el);
    if (mine >= 0) panelStack.splice(mine, 1);
    if (!open) {
      el.hidden = true;
      return;
    }
    for (const other of [sheet, bag, shop, trainPanel, travelPanel, mapOverlay]) {
      if (other !== el) drop(other);
    }
    el.hidden = false;
    panelStack.push(el);
  }
  function closeTopPanel() {
    for (let i = panelStack.length - 1; i >= 0; i--) {
      const el = panelStack[i];
      if (!el.hidden) {
        setOpen(el, false);
        return true;
      }
    }
    const leftover = [travelPanel, sheet, bag, shop, trainPanel, mapOverlay].find((el) => !el.hidden);
    if (!leftover) return false;
    setOpen(leftover, false);
    return true;
  }

  const sprites: Record<string, HTMLImageElement> = {};
  for (const name of NAMES) {
    const img = new Image();
    img.src = `/sprites/${name}.png`;
    img.onload = () => {
      sprites[name] = img;
    };
  }
  const frames: Record<string, HTMLImageElement> = {};
  for (const race of ["human", "elf", "minotaur", "marshwarden"]) {
    for (let i = 0; i < 16; i++) {
      const img = new Image();
      const key = `${race}-walk-${i}`;
      img.onload = () => {
        frames[key] = img;
      };
      img.src = `/sprites/anim/${key}.png?v=7`;
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
    shroudUntil: saved?.shroudUntil,
    attunedGates: saved?.attunedGates,
    hp: saved?.hp,
  };

  const authority = createAuthority();
  const world = authority.world;
  world.join(joinBody);
  world.adoptGraves(loadGraves());

  const claim = Date.now() + Math.random();
  let bestClaim = claim;
  let host = true;
  let remote: PublicState | null = null;
  let lastHeard = performance.now();
  // Tabs do not share a world. An older tab used to win the BroadcastChannel
  // host role and paste a stale hero over a fresh click, death, or respawn.
  let lastInput = saved?.inputAt ?? 0;

  const keys = new Set<string>();
  let stickActive = false;
  const stickVec = { x: 0, z: 0 };
  let dest: { x: number; z: number } | null = null;
  let path: Array<{ x: number; z: number }> = [];
  let talkNpc: string | null = null;
  let lootGrave: string | null = null;
  let seenGold = -1;
  let graveSig = "";
  let chaseId: string | null = null;
  let pvpId: string | null = null;
  let repaths = 0;
  let stuckFor = 0;
  let lastSpeed = 0;
  let lastLogs = "";
  const pvpLines: string[] = [];
  let lastPvp = "";
  let chatTab: "say" | "pvp" = "say";
  let viewW = 1;
  let viewH = 1;
  type GroupPeer = {
    id: string;
    name: string;
    level: number;
    hp: number;
    maxHp: number;
    x: number;
    z: number;
    race: string;
    group: string | null;
    seen: number;
  };
  const groupPresence = new Map<string, GroupPeer>();
  let myGroup: string | null = null;
  let pendingInvite: { fromId: string; fromName: string; group: string } | null = null;
  const GROUP_NEAR = 20;
  const cam = { x: 0, z: 0 };
  {
    const spawned = localPlayer();
    if (spawned) {
      cam.x = (spawned.x - spawned.z) * (TW / 2);
      cam.z = (spawned.x + spawned.z) * (TH / 2);
    }
  }
  const notes: string[] = [];
  const floaters: Array<{ x: number; z: number; text: string; born: number; color: string; lift: number; size: number; life: number }> = [];
  let dead = false;
  let raf = 0;
  let lastFrame = performance.now();
  let lastSend = 0;

  function placeFloater(x: number, z: number, text: string, color: string, lift: number, size: number, life: number) {
    const now = performance.now();
    for (let i = floaters.length - 1; i >= 0; i--) {
      if (now - floaters[i].born > floaters[i].life) floaters.splice(i, 1);
    }
    const near = () => floaters.filter((f) => Math.hypot(f.x - x, f.z - z) < 2);
    const crowded = near();
    if (crowded.length >= 4) {
      const oldest = crowded.reduce((a, b) => (a.born < b.born ? a : b));
      const idx = floaters.indexOf(oldest);
      if (idx >= 0) floaters.splice(idx, 1);
    }
    floaters.push({ x, z, text, born: now, color, lift: lift + near().length * 26, size, life });
  }

  function floatText(text: string, color = "#f6e7b2", lift = 120) {
    const xp = text.includes("XP");
    const p = me();
    placeFloater(p?.x ?? 0, p?.z ?? 0, text, xp ? "#7CFF4A" : color, xp ? 168 : lift, xp ? 26 : 15, xp ? 2600 : 1700);
  }

  function floatAt(x: number, z: number, text: string, color: string, lift = 78) {
    placeFloater(x, z, text, color, lift, 15, 1700);
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
        if (result.ok === false && result.reason === "Nothing in reach.") {
          const live = localPlayer();
          if (live) live.nextSwing = Date.now() + 900;
          note(result.reason);
        } else if (result.ok === false) note(result.reason);
        else if (result.reason.startsWith("+")) {
          if (!(result.reason.includes("XP") && shareKillXp(result.reason))) floatText(result.reason, "#b6e38a");
        } else if (!result.reason.includes("hits for") && result.reason !== "Missed.") floatText(result.reason);
      }
      if (intent.op === "buy" || intent.op === "sell" || intent.op === "use" || intent.op === "equip" || intent.op === "unequip" || intent.op === "train" || intent.op === "promote") {
        bagSig = "";
        shopSig = "";
        trainSig = "";
        paintBag();
        paintShop();
        paintTrain();
      }
      return result;
    }
    return { ok: true };
  }

  let drawScaleX = 1;
  let drawScaleY = 1;
  let drawOx = 0;
  let drawOy = 0;

  function applyDrawTransform() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const wantW = Math.max(1, Math.floor(viewW * dpr));
    const wantH = Math.max(1, Math.floor(viewH * dpr));
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const t = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
    drawScaleX = t?.a || dpr;
    drawScaleY = t?.d || dpr;
    drawOx = t?.e || 0;
    drawOy = t?.f || 0;
  }

  function resize() {
    viewW = canvas.clientWidth || window.innerWidth;
    viewH = canvas.clientHeight || window.innerHeight;
    applyDrawTransform();
  }

  function worldToScreen(x: number, z: number) {
    return isoWorldToScreen(x, z, cam.x, cam.z, viewW, viewH);
  }

  function screenToWorld(sx: number, sy: number) {
    return isoScreenToWorld(sx, sy, cam.x, cam.z, viewW, viewH);
  }

  function tileColor(x: number, z: number) {
    if (x * x + z * z <= 156 * 156) return tileFill(x, z);
    const name = terrainAt(x, z);
    if (name === "plaza") {
      let best = WORLD_CITIES[0];
      let bestD = 1e9;
      for (const city of WORLD_CITIES) {
        const d = Math.hypot(city.x - x, city.z - z);
        if (d < bestD) {
          best = city;
          bestD = d;
        }
      }
      return (x * 3 + z) % 5 === 0 ? best.stoneAlt : best.stone;
    }
    if (name === "road") return (x + z) & 1 ? "#7a6848" : "#6a563c";
    if (name === "camp") return "#5a4032";
    if (name === "lake") return (x + z) & 1 ? "#1d5c68" : "#184e58";
    const pair = TERRAIN_PALETTE[name] ?? TERRAIN_PALETTE.deep;
    return (x + z) & 1 ? pair[1] : pair[0];
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
    const drawn = race;
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
      if (!drawFrame(`${drawn}-atk-${frame}`, x, z, cell, lift, filter)) drawSprite(drawn, x, z, drawn === "minotaur" ? 0.2 : 0.18);
    } else {
      const col = moving ? Math.floor(actor.phase) % 4 : 0;
      const row = actor.facing * 4;
      if (!drawFrame(`${drawn}-walk-${row + col}`, x, z, cell, lift, filter)) drawSprite(drawn, x, z, drawn === "minotaur" ? 0.2 : 0.18);
    }
    if (cls) drawClassMark(kind, x, z, actor.facing, actor.phase, casting);
    if (casting) drawCast(x, z, 1 - (actor.castUntil - now) / 700);
  }

  function townNear(x: number, z: number) {
    let best: (typeof CITIES)[number] | null = null;
    let bestD = 16;
    for (const city of CITIES) {
      if ((city.phase ?? 1) > 1) continue;
      const d = Math.hypot(city.x - x, city.z - z);
      if (d < bestD) {
        best = city;
        bestD = d;
      }
    }
    return best;
  }

  function pvpOpen(x: number, z: number) {
    return zoneAt(x, z)?.pvp === true;
  }

  function placeName(x: number, z: number) {
    return zoneAt(x, z)?.name ?? townNear(x, z)?.name ?? islandAt(x, z)?.name ?? "the wild";
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
    const zone = zoneAt(p.x, p.z);
    const town = townNear(p.x, p.z);
    const pvp = zone?.pvp ? " · PvP area" : "";
    const zoneLabel = town && zone
      ? `${town.name} · ${zone.name} · Lv ${zone.levels[0]}–${zone.levels[1]}${pvp}`
      : town
        ? `${town.name}${pvp}`
        : zone
          ? `${zone.name} · Lv ${zone.levels[0]}–${zone.levels[1]}${pvp}`
          : (islandAt(p.x, p.z)?.name ?? "The Reach");
    statsEl.innerHTML =
      `<b>${p.username}</b> ${p.race} ${p.prestigeClass || p.baseClass} · Lv ${p.level}` +
      `<div class="zone-line">${zoneLabel}</div>` +
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
        `${(p.shroudUntil ?? 0) > Date.now() ? `<p class="shroud">Grave Chill ${Math.ceil(((p.shroudUntil ?? 0) - Date.now()) / 1000)}s. Spells are sealed. Melee still works.</p>` : ""}` +
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
    const ready = p.level >= 10 && !p.prestigeClass && !!nearestTrainer(p.x, p.z, 8);
    promoteBtn.hidden = !ready;
    if (ready) promoteBtn.textContent = `Promote to ${PRESTIGE_OF[p.baseClass]}`;
    deathEl.hidden = p.hp > 0;
    const homeTown = p.race === "Marshwarden" ? "Fenhollow" : "Caldrenmoor";
    respawnBtn.textContent = `Respawn in ${homeTown}`;
    if (p.hp <= 0) {
      if (!notedDeath) {
        notedDeath = true;
        if (!dirty) {
          lastInput = Date.now();
          dirty = true;
        }
        persist();
      }
      const xpLost = Math.floor(p.xp * 0.1);
      const stone = [...(view().graves ?? [])].reverse().find((g) => g.owner === p.username);
      deathHint.textContent = stone
        ? `A tombstone holds ${stone.gold} gold. Respawn in ${homeTown} under Grave Chill for 60s (${xpLost} XP). Spells stay sealed; melee still works.`
        : `Respawn in ${homeTown} under Grave Chill. Spells stay sealed; melee still works.`;
    } else {
      notedDeath = false;
    }
    const shroudLeft = Math.max(0, (p.shroudUntil ?? 0) - Date.now());
    if (shroudLeft > 0) {
      statsEl.innerHTML += `<div class="shroud">Grave Chill ${Math.ceil(shroudLeft / 1000)}s · spells sealed</div>`;
    }
    const talkNear = nearestWayfarer(p.x, p.z);
    talkBtn.hidden = !talkNear;
    // Stay open out to the same range a click uses to start the conversation.
    // The button itself stays short-range so it does not appear across the plaza.
    if (!nearestWayfarer(p.x, p.z, 8) && !travelPanel.hidden) setOpen(travelPanel, false);
    const state = view();
    const lines = [...state.logs, ...notes];
    const graveKey = JSON.stringify(state.graves ?? []);
    if (graveKey !== graveSig) {
      graveSig = graveKey;
      if (mayWriteSave()) writeGraves(state.graves ?? []);
      persist();
    }
    const sig = lines.join("\n");
    if (sig !== lastLogs) {
      messages.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
      messages.scrollTop = messages.scrollHeight;
      lastLogs = sig;
    }
    const pvpSig = pvpLines.join("\n");
    if (pvpBox && pvpSig !== lastPvp) {
      pvpBox.innerHTML = pvpLines.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
      pvpBox.scrollTop = pvpBox.scrollHeight;
      lastPvp = pvpSig;
    }
    paintGroup();
  }

  let mapCache: HTMLCanvasElement | null = null;

  function hexRgb(hex: string) {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function ensureMapCache() {
    if (mapCache) return mapCache;
    const mapW = 640;
    const spanX = BOUNDS.maxX - BOUNDS.minX;
    const spanZ = BOUNDS.maxZ - BOUNDS.minZ;
    const mapH = Math.max(1, Math.round((mapW * spanZ) / spanX));
    const canvas = document.createElement("canvas");
    canvas.width = mapW;
    canvas.height = mapH;
    const g = canvas.getContext("2d");
    if (!g) return canvas;
    const image = g.createImageData(mapW, mapH);
    const pix = image.data;
    for (let py = 0; py < mapH; py++) {
      const z = BOUNDS.minZ + ((py + 0.5) / mapH) * spanZ;
      for (let px = 0; px < mapW; px++) {
        const x = BOUNDS.minX + ((px + 0.5) / mapW) * spanX;
        const name = terrainAt(x, z);
        const pair = TERRAIN_PALETTE[name] ?? TERRAIN_PALETTE.deep;
        const [r, gch, b] = hexRgb(pair[(px + py) & 1] ?? pair[0]);
        const at = (py * mapW + px) * 4;
        pix[at] = r;
        pix[at + 1] = gch;
        pix[at + 2] = b;
        pix[at + 3] = 255;
      }
    }
    g.putImageData(image, 0, 0);
    mapCache = canvas;
    return canvas;
  }

  function drawWorldMap() {
    const g = mapCanvas.getContext("2d");
    if (!g) return;
    const base = ensureMapCache();
    mapCanvas.width = base.width;
    mapCanvas.height = base.height;
    const w = mapCanvas.width;
    const h = mapCanvas.height;
    g.drawImage(base, 0, 0);
    const spanX = BOUNDS.maxX - BOUNDS.minX;
    const spanZ = BOUNDS.maxZ - BOUNDS.minZ;
    const to = (x: number, z: number) => ({
      x: ((x - BOUNDS.minX) / spanX) * w,
      y: ((z - BOUNDS.minZ) / spanZ) * h,
    });
    const hero = me();
    const title = root.querySelector("#mapTitle");
    if (title) title.textContent = (hero && islandAt(hero.x, hero.z)?.name) || "The Reach";
    g.strokeStyle = "#8a7344";
    g.lineWidth = 2;
    g.beginPath();
    for (const [ax, az, bx, bz] of ROADS) {
      const a = to(ax, az);
      const b = to(bx, bz);
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
    }
    g.stroke();
    g.font = "13px Georgia";
    g.textAlign = "center";
    for (const city of CITIES) {
      const pt = to(city.x, city.z);
      g.fillStyle = city.stone;
      g.fillRect(pt.x - 5, pt.y - 5, 10, 10);
      const gate = GATES.find((row) => row.cityId === city.id);
      const circuitId = gate?.circuits.find((id) => CIRCUITS.some((row) => row.id === id)) ?? "hearth";
      const circuit = CIRCUITS.find((row) => row.id === circuitId);
      g.fillStyle = circuit?.color ?? "#e0b050";
      g.beginPath();
      g.moveTo(pt.x, pt.y - 8);
      g.lineTo(pt.x + 6, pt.y);
      g.lineTo(pt.x, pt.y + 8);
      g.lineTo(pt.x - 6, pt.y);
      g.closePath();
      g.fill();
      g.fillStyle = "#f0e2b0";
      g.fillText(city.name, pt.x, pt.y - 12);
    }
    g.font = "12px Georgia";
    g.fillStyle = "rgba(214, 226, 214, 0.92)";
    for (const isl of ISLANDS) {
      if (isl.id === "reach") continue;
      const pt = to(isl.cx, isl.cz);
      const nearCity = CITIES.some((city) => Math.hypot(city.x - isl.cx, city.z - isl.cz) < 8);
      g.fillText(isl.name, pt.x, nearCity ? pt.y + 20 : pt.y - 16);
    }
    const level = hero?.level ?? 1;
    for (const camp of CAMPS) {
      const pt = to(camp.cx, camp.cz);
      g.fillStyle = conFor(camp.level, level).color;
      g.beginPath();
      g.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
      g.fill();
    }
    for (const p of view().players) {
      if (p.hp <= 0) continue;
      const pt = to(p.x, p.z);
      g.fillStyle = p.id === myId ? "#f2d36b" : "#d8d8d8";
      g.beginPath();
      g.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
      g.fill();
    }
    g.save();
    g.strokeStyle = "rgba(186, 196, 206, 0.45)";
    g.lineWidth = 1.5;
    g.setLineDash([4, 5]);
    for (const isl of LATER_ISLANDS) {
      g.beginPath();
      const steps = 56;
      for (let i = 0; i <= steps; i++) {
        const th = (i / steps) * Math.PI * 2;
        const reach = (isl.r ?? Math.max(isl.rx ?? 40, isl.rz ?? 40)) * 1.8;
        let lo = 0;
        let hi = reach;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) / 2;
          if (insideIsland(isl, isl.cx + Math.cos(th) * mid, isl.cz + Math.sin(th) * mid)) lo = mid;
          else hi = mid;
        }
        const edge = to(isl.cx + Math.cos(th) * lo, isl.cz + Math.sin(th) * lo);
        if (i === 0) g.moveTo(edge.x, edge.y);
        else g.lineTo(edge.x, edge.y);
      }
      g.stroke();
    }
    g.restore();
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

  function livingMonster(id: string | null) {
    if (!id) return null;
    return view().monsters.find((m) => m.id === id && m.hp > 0) ?? null;
  }

  function adjacentStand(mx: number, mz: number, px: number, pz: number) {
    const have = Math.hypot(px - mx, pz - mz) || 1;
    if (have <= 2.65) return { x: Math.round(px), z: Math.round(pz) };
    const facing = Math.atan2(pz - mz, px - mx);
    let best: { x: number; z: number } | null = null;
    let bestScore = Infinity;
    for (let ring = 2.05; ring <= 2.55; ring += 0.25) {
      for (let step = -3; step <= 3; step++) {
        const ang = facing + step * 0.42;
        const x = Math.round(mx + Math.cos(ang) * ring);
        const z = Math.round(mz + Math.sin(ang) * ring);
        if (blocked(x, z)) continue;
        const fromMob = Math.hypot(x - mx, z - mz);
        if (fromMob < 1.7 || fromMob >= have - 0.35) continue;
        const score = Math.hypot(x - px, z - pz);
        if (score < bestScore) {
          bestScore = score;
          best = { x, z };
        }
      }
    }
    if (best) return best;
    const step = Math.min(4, have - 2.2);
    const tx = px + ((mx - px) / have) * step;
    const tz = pz + ((mz - pz) / have) * step;
    const spot = nearestOpen(tx, tz, 4);
    if (Math.hypot(spot.x - mx, spot.z - mz) > have - 0.2) return { x: tx, z: tz };
    return spot;
  }

  function rangedStand(mx: number, mz: number, px: number, pz: number) {
    const d = Math.hypot(px - mx, pz - mz) || 1;
    if (d <= 7.2) return { x: Math.round(px), z: Math.round(pz) };
    const step = Math.min(6, d - 6.4);
    const x = px + ((mx - px) / d) * step;
    const z = pz + ((mz - pz) / d) * step;
    const spot = nearestOpen(x, z, 4);
    if (Math.hypot(spot.x - mx, spot.z - mz) < d - 0.4) return spot;
    return { x, z };
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
      const dist = Math.hypot(chase.x - p.x, chase.z - p.z);
      const closeEnough = ranged ? dist <= 7.2 : dist <= 2.65;
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
    if (pvpId) {
      pressPvp();
      return;
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
      lootGrave = null;
      chaseId = null;
      repaths = 0;
      const len = Math.hypot(ix, iz) || 1;
      vx = (ix / len) * MOVE;
      vz = (iz / len) * MOVE;
    } else if (dest) {
      if (talkNpc) {
        const npc = NPCS.find((n) => n.id === talkNpc);
        if (npc && Math.hypot(npc.x - p.x, npc.z - p.z) <= 3.6) {
          const npcId = talkNpc;
          dest = null;
          path = [];
          talkNpc = null;
          lootGrave = null;
          repaths = 0;
          stuckFor = 0;
          openNpc(npcId);
        }
      }
      if (lootGrave && dest) {
        const grave = view().graves?.find((g) => g.id === lootGrave);
        if (grave && Math.hypot(grave.x - p.x, grave.z - p.z) <= 4) {
          const graveId = lootGrave;
          dest = null;
          path = [];
          lootGrave = null;
          const result = send({ op: "loot", id: myId, graveId });
          if (result && "ok" in result && result.ok) postGroup({ t: "graveGone", graveId });
        }
      }
      if (dest) {
      let aim = dest;
      if (clearLine(p.x, p.z, dest.x, dest.z)) {
        path = [];
      } else if (path.length) {
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
      if (Math.hypot(aim.x - dest.x, aim.z - dest.z) > Math.hypot(p.x - dest.x, p.z - dest.z) + 1.25) {
        aim = dest;
        path = [];
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
        dirty = true;
        persist();
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
      view().monsters.some((m) => m.hp > 0 && m.id !== chaseId && screenGap(m.x, m.z, x, z) < 58);
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
    if (nx !== p.x || nz !== p.z) dirty = true;
    p.x = nx;
    p.z = nz;
    p.rotation = Math.atan2(vx, vz);
    const now = performance.now();
    if (now - lastSend > 70) {
      lastSend = now;
      if (host) world.move(p.id, p.x, p.z, p.rotation);
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
      remote = null;
      if (!world.players.get(myId)) world.join(joinBody);
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
    applyDrawTransform();
    ctx.fillStyle = "#10241f";
    ctx.fillRect(0, 0, viewW, viewH);
    const corners = [
      screenToWorld(-40, -40),
      screenToWorld(viewW + 40, -40),
      screenToWorld(-40, viewH + 40),
      screenToWorld(viewW + 40, viewH + 40),
    ];
    let minX = BOUNDS.maxX;
    let maxX = BOUNDS.minX;
    let minZ = BOUNDS.maxZ;
    let maxZ = BOUNDS.minZ;
    for (const c of corners) {
      minX = Math.min(minX, c.x);
      maxX = Math.max(maxX, c.x);
      minZ = Math.min(minZ, c.z);
      maxZ = Math.max(maxZ, c.z);
    }
    const x0 = Math.max(BOUNDS.minX, Math.floor(minX) - 1);
    const x1 = Math.min(BOUNDS.maxX, Math.ceil(maxX) + 1);
    const z0 = Math.max(BOUNDS.minZ, Math.floor(minZ) - 1);
    const z1 = Math.min(BOUNDS.maxZ, Math.ceil(maxZ) + 1);
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
          ctx.fillStyle = "#e6c56a";
          ctx.font = "12px Georgia";
          ctx.textAlign = "center";
          ctx.fillText(pl.prestigeClass || pl.baseClass, pt.x, pt.y - (race === "minotaur" ? 152 : 136));
          ctx.fillStyle = pl.id === myId ? "#f0e2b0" : "#ddd";
          ctx.font = "13px Georgia";
          ctx.fillText(pl.username, pt.x, pt.y - (race === "minotaur" ? 136 : 120));
        },
      });
    }
    for (const peer of freshPeers()) {
      drawables.push({
        key: peer.x + peer.z + 0.01,
        draw: () => {
          const race = (peer.race || "human").toLowerCase();
          shadowAt(peer.x, peer.z, 14);
          drawHero(race, `ghost-${peer.id}`, peer.x, peer.z);
          const pt = worldToScreen(peer.x, peer.z);
          ctx.font = "13px Georgia";
          ctx.textAlign = "center";
          ctx.fillStyle = "#d5e6ff";
          ctx.fillText(peer.name, pt.x, pt.y - 120);
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
    ctx.font = "13px Georgia";
    ctx.textAlign = "center";
    for (const g of state.graves ?? []) {
      const pt = worldToScreen(g.x, g.z);
      ctx.fillStyle = "#5c564c";
      ctx.fillRect(pt.x - 11, pt.y - 30, 22, 28);
      ctx.strokeStyle = "#d7c28a";
      ctx.strokeRect(pt.x - 11, pt.y - 30, 22, 28);
      ctx.fillStyle = "#f0e2b0";
      const label = typeof g.born === "number" && Date.now() - g.born < 60_000;
      if (label) ctx.fillText(`${g.owner}'s tomb`, pt.x, pt.y - 40);
      ctx.fillText(`${g.gold} gold`, pt.x, pt.y - 14);
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
      if (floatNow - floaters[i].born > floaters[i].life) floaters.splice(i, 1);
    }
    for (const f of floaters) {
      const age = floatNow - f.born;
      const life = f.life ?? 1700;
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

  let saveRev = saved?.rev ?? 0;
  let appliedAt = saved?.inputAt ?? 0;
  let dirty = false;
  let notedDeath = false;

  function saveIsNewer(disk: NonNullable<ReturnType<typeof loadSave>>) {
    return (disk.inputAt ?? 0) > appliedAt;
  }

  function adoptSave(disk: NonNullable<ReturnType<typeof loadSave>>) {
    const p = localPlayer();
    if (!p) return;
    if (typeof disk.x === "number") p.x = disk.x;
    if (typeof disk.z === "number") p.z = disk.z;
    cam.x = (p.x - p.z) * (TW / 2);
    cam.z = (p.x + p.z) * (TH / 2);
    p.gold = disk.gold ?? p.gold;
    p.level = disk.level || p.level;
    p.xp = disk.xp ?? p.xp;
    p.shroudUntil = disk.shroudUntil ?? 0;
    if (disk.inventory) p.inventory = { ...disk.inventory };
    if (disk.equipment) p.equipment = { ...disk.equipment };
    if (disk.skills) p.skills = { ...disk.skills };
    if (disk.hotbar) p.hotbar = [...disk.hotbar];
    if (typeof disk.trainPoints === "number") p.trainPoints = disk.trainPoints;
    if (disk.attunedGates) p.attunedGates = [...disk.attunedGates];
    if (typeof disk.hp === "number") {
      p.hp = Math.max(0, Math.min(p.maxHp, disk.hp));
      if (p.hp <= 0) p.graveDropped = true;
    }
    if ((p.shroudUntil ?? 0) > Date.now()) {
      p.hp = p.maxHp;
      p.mana = p.maxMana;
      p.stamina = p.maxStamina;
      p.graveDropped = false;
    }
    saveRev = disk.rev ?? 0;
    appliedAt = disk.inputAt ?? 0;
    lastInput = appliedAt;
    dirty = false;
    dest = null;
    path = [];
    talkNpc = null;
    chaseId = null;
  }

  function mayWriteSave() {
    const disk = loadSave(profile.username);
    if (disk && saveIsNewer(disk)) return false;
    if (disk && !dirty) return false;
    return true;
  }

  function touchInput() {
    lastInput = Date.now();
    dirty = true;
  }

  function persist() {
    const p = localPlayer();
    if (!p) return;
    const disk = loadSave(profile.username);
    if (disk && saveIsNewer(disk)) {
      adoptSave(disk);
      return;
    }
    if (disk && !dirty) return;
    const nextRev = saveRev + 1;
    const wrote = writeSave({
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
      shroudUntil: p.shroudUntil,
      attunedGates: p.attunedGates,
      hp: p.hp,
      rev: nextRev,
      inputAt: lastInput,
    });
    if (wrote !== false) {
      saveRev = wrote;
      appliedAt = lastInput;
      dirty = false;
    }
  }

  type GroupWire = {
    t: string;
    id?: string;
    name?: string;
    fromId?: string;
    fromName?: string;
    toName?: string;
    group?: string | null;
    level?: number;
    hp?: number;
    maxHp?: number;
    x?: number;
    z?: number;
    race?: string;
    amount?: number;
    dmg?: number;
    gold?: number;
    graveId?: string;
    place?: string;
  };

  function postGroup(msg: GroupWire) {
    groupChannel?.postMessage(msg);
  }

  function myName() {
    return me()?.username ?? profile.username;
  }

  function hideInvite() {
    pendingInvite = null;
    if (inviteToast) inviteToast.hidden = true;
  }

  function showInvite(fromName: string) {
    if (!inviteToast || !inviteText) return;
    inviteText.textContent = `${fromName} invites you.`;
    inviteToast.hidden = false;
  }

  function freshPeers() {
    const now = Date.now();
    const rows: GroupPeer[] = [];
    for (const peer of groupPresence.values()) {
      if (now - peer.seen > 1600) continue;
      rows.push(peer);
    }
    return rows;
  }

  function findPeer(name: string) {
    const want = name.trim().toLowerCase();
    if (!want) return null;
    return freshPeers().find((peer) => peer.name.toLowerCase() === want) ?? null;
  }

  function groupRoster() {
    const self = me();
    if (!myGroup || !self) return [];
    const rows = [
      {
        id: myId,
        name: self.username,
        level: self.level,
        hp: self.hp,
        maxHp: Math.max(1, self.maxHp),
      },
    ];
    for (const peer of freshPeers()) {
      if (peer.group !== myGroup) continue;
      rows.push({
        id: peer.id,
        name: peer.name,
        level: peer.level,
        hp: peer.hp,
        maxHp: Math.max(1, peer.maxHp),
      });
    }
    return rows;
  }

  function paintGroup() {
    if (!groupFrame) return;
    const rows = groupRoster();
    if (rows.length < 2) {
      groupFrame.hidden = true;
      groupFrame.innerHTML = "";
      return;
    }
    groupFrame.hidden = false;
    groupFrame.innerHTML = rows
      .map((row) => {
        const pct = Math.max(0, Math.min(100, (row.hp / row.maxHp) * 100));
        return `<div class="group-row"><b>${escapeHtml(row.name)}</b> · Lv ${row.level}<div class="bar hp"><i style="width:${pct}%"></i></div></div>`;
      })
      .join("");
  }

  function membersNear(x: number, z: number) {
    if (!myGroup) return [];
    const ids = [myId];
    for (const peer of freshPeers()) {
      if (peer.group !== myGroup) continue;
      if (Math.hypot(peer.x - x, peer.z - z) <= GROUP_NEAR) ids.push(peer.id);
    }
    return ids;
  }

  function shareKillXp(reason: string) {
    const matched = /^\+(\d+) XP$/.exec(reason);
    if (!matched || !myGroup) return false;
    const base = Number(matched[1]);
    const p = me();
    if (!p || !(base > 0)) return false;
    const near = membersNear(p.x, p.z);
    if (near.length < 2) return false;
    const bonus = Math.ceil(base * 0.1 * (near.length - 1));
    if (bonus > 0) world.grantXp(myId, bonus);
    const total = base + bonus;
    dirty = true;
    note(`+${total} XP`);
    postGroup({ t: "xp", fromId: myId, amount: total, x: p.x, z: p.z, group: myGroup });
    return true;
  }

  function ensureGroup() {
    if (!myGroup) myGroup = myId;
    return myGroup;
  }

  function inviteNamed(name: string) {
    const peer = findPeer(name);
    if (!peer) {
      note("No one nearby by that name.");
      return;
    }
    if (myGroup && peer.group === myGroup) {
      note(`${peer.name} is already in the group.`);
      return;
    }
    const group = ensureGroup();
    postGroup({ t: "invite", fromId: myId, fromName: myName(), toName: peer.name, group });
    note(`You invite ${peer.name}.`);
    pulseGroup();
  }

  function acceptInvite() {
    if (!pendingInvite) return;
    myGroup = pendingInvite.group;
    postGroup({ t: "join", id: myId, name: myName(), group: myGroup, level: me()?.level ?? 1, hp: me()?.hp ?? 0, maxHp: me()?.maxHp ?? 1, x: me()?.x ?? 0, z: me()?.z ?? 0, race: me()?.race ?? profile.race });
    note("You join the group.");
    hideInvite();
    pulseGroup();
    paintGroup();
  }

  function declineInvite() {
    if (!pendingInvite) return;
    postGroup({ t: "decline", fromId: pendingInvite.fromId, name: myName() });
    note("You decline.");
    hideInvite();
  }

  function leaveGroup() {
    if (!myGroup) return;
    const group = myGroup;
    myGroup = null;
    postGroup({ t: "leave", id: myId, group });
    note("You leave the group.");
    pulseGroup();
    paintGroup();
  }

  function rememberPeer(msg: GroupWire) {
    if (!msg.id || msg.id === myId) return;
    const prev = groupPresence.get(msg.id);
    groupPresence.set(msg.id, {
      id: msg.id,
      name: msg.name || prev?.name || "Hero",
      level: msg.level ?? prev?.level ?? 1,
      hp: msg.hp ?? prev?.hp ?? 0,
      maxHp: msg.maxHp ?? prev?.maxHp ?? 1,
      x: typeof msg.x === "number" ? msg.x : prev?.x ?? 0,
      z: typeof msg.z === "number" ? msg.z : prev?.z ?? 0,
      race: msg.race || prev?.race || "human",
      group: msg.group === undefined ? prev?.group ?? null : msg.group,
      seen: Date.now(),
    });
  }

  function onGroupMessage(ev: MessageEvent) {
    const msg = ev.data as GroupWire;
    if (!msg || typeof msg.t !== "string") return;
    if (msg.t === "hi" && msg.id) {
      rememberPeer(msg);
      return;
    }
    if (msg.t === "invite" && msg.toName && msg.toName.toLowerCase() === myName().toLowerCase() && msg.fromId && msg.fromId !== myId) {
      if (myGroup) {
        postGroup({ t: "decline", fromId: msg.fromId, name: myName() });
        return;
      }
      pendingInvite = { fromId: msg.fromId, fromName: msg.fromName || "Someone", group: msg.group || msg.fromId };
      showInvite(pendingInvite.fromName);
      return;
    }
    if (msg.t === "join" && msg.id && msg.group && msg.group === myGroup) {
      rememberPeer({ ...msg, group: msg.group });
      paintGroup();
      return;
    }
    if (msg.t === "decline" && msg.fromId === myId && msg.name) {
      note(`${msg.name} declines.`);
      if (groupRoster().length < 2) {
        myGroup = null;
        paintGroup();
      }
      return;
    }
    if (msg.t === "leave" && msg.id) {
      const peer = groupPresence.get(msg.id);
      if (peer) peer.group = null;
      paintGroup();
      return;
    }
    if (msg.t === "graveGone" && msg.graveId) {
      world.removeGrave(msg.graveId);
      return;
    }
    if (msg.t === "down" && msg.fromName && msg.name && msg.place) {
      addPvp(`${msg.fromName} defeated ${msg.name} at ${msg.place}.`);
      if (msg.graveId && typeof msg.x === "number" && typeof msg.z === "number") {
        world.adoptGraves([
          {
            id: msg.graveId,
            owner: msg.name,
            x: msg.x,
            z: msg.z,
            gold: Math.max(0, Math.floor(msg.gold ?? 0)),
            items: {},
            born: Date.now(),
          },
        ]);
      }
      return;
    }
    if (msg.t === "hit" && msg.id === myId && msg.fromId && msg.fromId !== myId) {
      const p = me();
      if (!p || p.hp <= 0) return;
      if (!pvpOpen(p.x, p.z)) return;
      if (myGroup && (msg.group === myGroup || groupPresence.get(msg.fromId)?.group === myGroup)) return;
      if (typeof msg.x !== "number" || typeof msg.z !== "number") return;
      if (Math.hypot(p.x - msg.x, p.z - msg.z) > 12) return;
      const dmg = Math.max(1, Math.floor(msg.dmg ?? 0));
      const next = Math.max(0, p.hp - dmg);
      world.setHp(myId, next);
      dirty = true;
      if (next <= 0) {
        const grave = [...(view().graves ?? [])].reverse().find((g) => g.owner === p.username);
        const place = placeName(grave?.x ?? p.x, grave?.z ?? p.z);
        addPvp(`${msg.fromName ?? "Someone"} defeated ${p.username} at ${place}.`);
        postGroup({
          t: "down",
          fromName: msg.fromName,
          name: p.username,
          x: grave?.x ?? p.x,
          z: grave?.z ?? p.z,
          gold: grave?.gold ?? 0,
          graveId: grave?.id,
          place,
          id: myId,
        });
        pulseGroup();
      }
      return;
    }
    if (msg.t === "xp" && msg.fromId && msg.fromId !== myId && msg.group && msg.group === myGroup && typeof msg.amount === "number") {
      const p = me();
      if (!p || typeof msg.x !== "number" || typeof msg.z !== "number") return;
      if (Math.hypot(p.x - msg.x, p.z - msg.z) > GROUP_NEAR) return;
      world.grantXp(myId, msg.amount);
      dirty = true;
      note(`+${Math.floor(msg.amount)} XP`);
    }
  }

  function pulseGroup() {
    const p = me();
    if (!p) return;
    postGroup({
      t: "hi",
      id: myId,
      name: p.username,
      level: p.level,
      hp: p.hp,
      maxHp: p.maxHp,
      x: p.x,
      z: p.z,
      race: p.race,
      group: myGroup,
    });
  }

  function addPvp(line: string) {
    pvpLines.push(line);
    if (pvpLines.length > 40) pvpLines.shift();
    lastPvp = "";
    showChatTab("pvp");
    chat.classList.add("open");
  }

  function strikePeer(peer: GroupPeer): string {
    const p = me();
    if (!p || p.hp <= 0) return "none";
    if (!pvpOpen(p.x, p.z)) {
      pvpId = null;
      note("This is a haven. No fighting here.");
      return "haven";
    }
    if (myGroup && peer.group === myGroup) {
      pvpId = null;
      note("You cannot strike a group member.");
      return "group";
    }
    const dist = Math.hypot(peer.x - p.x, peer.z - p.z);
    const range = powerById("attack")?.range ?? 7.6;
    if (dist > range) return "far";
    const now = Date.now();
    const power = powerById("attack");
    const ready = Math.max(p.nextSwing || 0, p.cooldowns?.attack ?? 0);
    if (now < ready) return "wait";
    const cost = power?.stamina ?? 0;
    if (cost > 0 && p.stamina < cost) {
      note("Not enough stamina.");
      return "stamina";
    }
    p.stamina = Math.max(0, p.stamina - cost);
    const cd = now + (power?.cooldown ?? 780);
    p.nextSwing = cd;
    if (!p.cooldowns) p.cooldowns = {};
    p.cooldowns.attack = cd;
    const actor = actors.get(myId);
    if (actor) actor.attackUntil = performance.now() + 640;
    if (Math.random() * 100 >= hitChance(p)) {
      floatAt(peer.x, peer.z, "Miss", "#f0e2b0", 96);
      return "miss";
    }
    const dmg = Math.max(1, trainedDamage(p));
    floatAt(peer.x, peer.z, `-${dmg}`, "#ffb4a8", 110);
    postGroup({
      t: "hit",
      fromId: myId,
      fromName: p.username,
      id: peer.id,
      group: myGroup,
      dmg,
      x: p.x,
      z: p.z,
    });
    return "hit";
  }

  function nearestPeer() {
    const p = me();
    if (!p) return null;
    let best: GroupPeer | null = null;
    let bestD = 40;
    for (const peer of freshPeers()) {
      const d = Math.hypot(peer.x - p.x, peer.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = peer;
      }
    }
    return best;
  }

  function pressPvp() {
    const p = localPlayer();
    if (!p || p.hp <= 0) {
      pvpId = null;
      return;
    }
    const peer = freshPeers().find((row) => row.id === pvpId) ?? null;
    if (!peer) {
      pvpId = null;
      return;
    }
    if (!pvpOpen(p.x, p.z) || (myGroup && peer.group === myGroup)) {
      pvpId = null;
      return;
    }
    const range = powerById("attack")?.range ?? 7.6;
    const dist = Math.hypot(peer.x - p.x, peer.z - p.z);
    if (dist > range) {
      const step = Math.min(dist - range * 0.65, 6);
      const x = p.x + ((peer.x - p.x) / dist) * step;
      const z = p.z + ((peer.z - p.z) / dist) * step;
      if (!dest || Math.hypot(dest.x - x, dest.z - z) > 1.2) goTo(x, z, null);
      return;
    }
    dest = null;
    path = [];
    strikePeer(peer);
  }

  function peerAt(sx: number, sy: number) {
    let best: GroupPeer | null = null;
    let bestD = 48;
    for (const peer of freshPeers()) {
      const sp = worldToScreen(peer.x, peer.z);
      const above = sp.y - sy;
      if (Math.abs(sx - sp.x) > 36 || above < -6 || above > 130) continue;
      const d = Math.hypot(sx - sp.x, sy - sp.y);
      if (d < bestD) {
        bestD = d;
        best = peer;
      }
    }
    return best;
  }

  function showCtx(clientX: number, clientY: number, peer: GroupPeer | null) {
    if (!ctxMenu) return;
    const items: Array<{ act: string; label: string; name: string }> = [];
    if (peer && peer.group !== myGroup) items.push({ act: "invite", label: `Invite ${peer.name}`, name: peer.name });
    if (myGroup) items.push({ act: "leave", label: "Leave group", name: "" });
    if (!items.length) {
      ctxMenu.hidden = true;
      return;
    }
    const rect = root.getBoundingClientRect();
    ctxMenu.style.left = `${Math.round(clientX - rect.left)}px`;
    ctxMenu.style.top = `${Math.round(clientY - rect.top)}px`;
    ctxMenu.innerHTML = items
      .map((item) => `<button type="button" data-act="${item.act}" data-name="${escapeHtml(item.name)}">${escapeHtml(item.label)}</button>`)
      .join("");
    ctxMenu.hidden = false;
  }

  function onContextMenu(e: MouseEvent) {
    if (!(e.target instanceof Node) || !root.contains(e.target)) return;
    e.preventDefault();
    if (!mapOverlay.hidden) return;
    const hit = readClick(e);
    showCtx(e.clientX, e.clientY, peerAt(hit.sx, hit.sy));
  }

  function onCtxClick(e: Event) {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn || !ctxMenu) return;
    e.preventDefault();
    const act = btn.dataset.act;
    const name = btn.dataset.name || "";
    ctxMenu.hidden = true;
    if (act === "invite" && name) inviteNamed(name);
    if (act === "leave") leaveGroup();
  }

  function handleSlash(text: string) {
    const body = text.slice(1).trim();
    const gap = body.indexOf(" ");
    const cmd = (gap < 0 ? body : body.slice(0, gap)).toLowerCase();
    const arg = gap < 0 ? "" : body.slice(gap + 1).trim();
    if (cmd === "invite" && arg) inviteNamed(arg);
    else if (cmd === "leave") leaveGroup();
    else if (cmd === "accept") acceptInvite();
    else note("Unknown command.");
  }

  let groupChannel: BroadcastChannel | null = null;

  function onKeyDown(e: KeyboardEvent) {
    touchInput();
    if (e.key === "Escape") {
      if (closeTopPanel()) {
        e.preventDefault();
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
    if (!e.repeat && (e.code === "KeyM" || e.key === "m" || e.key === "M")) {
      e.preventDefault();
      onMap(e);
      return;
    }
    if (e.code === "KeyI") {
      e.preventDefault();
      const open = bag.hidden;
      setOpen(bag, open);
      if (open) {
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

  type LastClick = {
    clientX: number;
    clientY: number;
    sx: number;
    sy: number;
    camX: number;
    camZ: number;
    tx: number;
    tz: number;
    heroX: number;
    heroZ: number;
    viewW: number;
    viewH: number;
    scale: number;
    bitmapW: number;
  };
  let lastClick: LastClick | null = null;

  function paintClickDebug() {
    if (!clickDebug) return;
    const on = clickDebugToggle ? clickDebugToggle.checked : true;
    clickDebug.hidden = !on;
    if (!on) return;
    if (!lastClick) {
      clickDebug.textContent = "Last click\n(waiting)";
      return;
    }
    const c = lastClick;
    clickDebug.textContent = [
      `client ${c.clientX.toFixed(0)},${c.clientY.toFixed(0)}`,
      `canvas ${c.sx.toFixed(0)},${c.sy.toFixed(0)}`,
      `camera ${c.camX.toFixed(0)},${c.camZ.toFixed(0)}`,
      `target ${c.tx.toFixed(0)},${c.tz.toFixed(0)}`,
      `hero ${c.heroX.toFixed(0)},${c.heroZ.toFixed(0)}`,
      `view ${c.viewW.toFixed(0)}×${c.viewH.toFixed(0)} scale ${c.scale.toFixed(2)} bitmap ${c.bitmapW.toFixed(0)}`,
    ].join("\n");
  }

  function readClick(e: { clientX: number; clientY: number; offsetX?: number; offsetY?: number }) {
    const cssW = canvas.clientWidth || viewW;
    const cssH = canvas.clientHeight || viewH;
    if (Math.abs(cssW - viewW) > 1 || Math.abs(cssH - viewH) > 1) resize();
    const hero = localPlayer();
    return resolveClick({
      clientX: e.clientX,
      clientY: e.clientY,
      offsetX: e.offsetX,
      offsetY: e.offsetY,
      rect: canvas.getBoundingClientRect(),
      viewW,
      viewH,
      clientW: cssW,
      clientH: cssH,
      camX: cam.x,
      camZ: cam.z,
      heroX: hero?.x,
      heroZ: hero?.z,
      bitmapW: canvas.width,
      bitmapH: canvas.height,
      transformA: drawScaleX,
      transformD: drawScaleY,
      transformE: drawOx,
      transformF: drawOy,
    });
  }

  function rememberClick(
    e: { clientX: number; clientY: number },
    hit: { sx: number; sy: number; camX: number; camZ: number; heroX: number; heroZ: number },
    tile: { x: number; z: number },
  ) {
    lastClick = {
      clientX: e.clientX,
      clientY: e.clientY,
      sx: hit.sx,
      sy: hit.sy,
      camX: hit.camX,
      camZ: hit.camZ,
      tx: tile.x,
      tz: tile.z,
      heroX: hit.heroX,
      heroZ: hit.heroZ,
      viewW,
      viewH,
      scale: drawScaleX,
      bitmapW: canvas.width,
    };
    paintClickDebug();
  }

  function pickTile(sx: number, sy: number, roughX: number, roughZ: number) {
    const hero = localPlayer();
    const cx = Math.round(roughX);
    const cz = Math.round(roughZ);
    let bestX = cx;
    let bestZ = cz;
    let best = Infinity;
    for (let z = cz - 3; z <= cz + 3; z++) {
      for (let x = cx - 3; x <= cx + 3; x++) {
        const d = diamondDistance(sx, sy, worldToScreen(x, z));
        if (d < best) {
          best = d;
          bestX = x;
          bestZ = z;
        }
      }
    }
    if (blocked(bestX, bestZ)) {
      let openD = Infinity;
      let openX = bestX;
      let openZ = bestZ;
      for (let z = cz - 8; z <= cz + 8; z++) {
        for (let x = cx - 8; x <= cx + 8; x++) {
          if (blocked(x, z)) continue;
          const d = diamondDistance(sx, sy, worldToScreen(x, z));
          if (d < openD) {
            openD = d;
            openX = x;
            openZ = z;
          }
        }
      }
      if (openD <= 6) return { x: openX, z: openZ };
      return { x: hero?.x ?? roughX, z: hero?.z ?? roughZ };
    }
    const projected = worldToScreen(bestX, bestZ);
    if (best > 1.35 || Math.hypot(projected.x - sx, projected.y - sy) > 52) {
      return { x: hero?.x ?? roughX, z: hero?.z ?? roughZ };
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
    note(`walk → (${Math.round(x)},${Math.round(z)})`);
  }

  function spriteHit(sx: number, sy: number, x: number, z: number, height: number) {
    const p = worldToScreen(x, z);
    const above = p.y - sy;
    return Math.abs(sx - p.x) < 48 && above > -18 && above < height;
  }
  function npcHit(sx: number, sy: number, x: number, z: number) {
    const p = worldToScreen(x, z);
    const above = p.y - sy;
    const dx = Math.abs(sx - p.x);
    if (above > 108 && above < 152 && dx < 48) return true;
    return dx < 34 && above > -4 && above < 112;
  }
  let pendingMove: { x: number; z: number } | null = null;
  function onPointer(e: PointerEvent) {
    if (ctxMenu) ctxMenu.hidden = true;
    if (e.button !== 0 || !mapOverlay.hidden) return;
    if (e.target !== canvas) return;
    const top = document.elementFromPoint(e.clientX, e.clientY);
    if (top && top !== canvas && !canvas.contains(top)) return;
    const hit = readClick(e);
    touchInput();
    const p = me();
    if (!p || p.hp <= 0) return;
    armPanelBlock();
    const sx = hit.sx;
    const sy = hit.sy;
    const w = { x: hit.x, z: hit.z };
    let pickedGrave: { id: string; x: number; z: number } | null = null;
    for (const g of view().graves ?? []) {
      if (spriteHit(sx, sy, g.x, g.z, 48) || Math.hypot(g.x - w.x, g.z - w.z) < 1.4) {
        pickedGrave = g;
        break;
      }
    }
    if (pickedGrave) {
      chaseId = null;
      rememberClick(e, hit, pickedGrave);
      const dist = Math.hypot(pickedGrave.x - p.x, pickedGrave.z - p.z);
      if (dist <= 4) {
        dest = null;
        path = [];
        lootGrave = null;
        const result = send({ op: "loot", id: myId, graveId: pickedGrave.id });
        if (result && "ok" in result && result.ok) postGroup({ t: "graveGone", graveId: pickedGrave.id });
      } else {
        talkNpc = null;
        goTo(pickedGrave.x, pickedGrave.z, null);
        lootGrave = pickedGrave.id;
      }
      return;
    }
    let pickedNpc: (typeof NPCS)[number] | null = null;
    for (const npc of NPCS) {
      if (npcHit(sx, sy, npc.x, npc.z)) {
        pickedNpc = npc;
        break;
      }
    }
    if (pickedNpc) {
      const dist = Math.hypot(pickedNpc.x - p.x, pickedNpc.z - p.z);
      chaseId = null;
      rememberClick(e, hit, pickedNpc);
      if (dist <= 3.6) {
        dest = null;
        path = [];
        talkNpc = null;
        openNpc(pickedNpc.id);
      } else {
        const ang = Math.atan2(p.z - pickedNpc.z, p.x - pickedNpc.x);
        const rawX = pickedNpc.x + Math.cos(ang) * 2.3;
        const rawZ = pickedNpc.z + Math.sin(ang) * 2.3;
        let spot = nearestOpen(rawX, rawZ, 4);
        if (Math.hypot(spot.x - pickedNpc.x, spot.z - pickedNpc.z) > dist - 0.4) {
          const step = Math.min(4, Math.max(1.2, dist - 2.3));
          const sx = p.x + ((pickedNpc.x - p.x) / dist) * step;
          const sz = p.z + ((pickedNpc.z - p.z) / dist) * step;
          spot = nearestOpen(sx, sz, 4);
          if (Math.hypot(spot.x - pickedNpc.x, spot.z - pickedNpc.z) > dist - 0.2) spot = { x: sx, z: sz };
        }
        goTo(spot.x, spot.z, pickedNpc.id);
      }
      return;
    }
    const peer = peerAt(sx, sy);
    if (peer) {
      pinnedId = null;
      chaseId = null;
      lootGrave = null;
      rememberClick(e, hit, peer);
      const dist = Math.hypot(peer.x - p.x, peer.z - p.z);
      const range = powerById("attack")?.range ?? 7.6;
      if (!pvpOpen(p.x, p.z) || (myGroup && peer.group === myGroup)) {
        dest = null;
        path = [];
        pvpId = null;
        pendingMove = null;
        strikePeer(peer);
        return;
      }
      pvpId = peer.id;
      if (dist > range) {
        const step = Math.min(dist - range * 0.65, 6);
        goTo(p.x + ((peer.x - p.x) / dist) * step, p.z + ((peer.z - p.z) / dist) * step, null);
      } else {
        dest = null;
        path = [];
        strikePeer(peer);
      }
      return;
    }
    let picked: string | null = null;
    for (const m of view().monsters) {
      if (m.hp <= 0) continue;
      if (spriteHit(sx, sy, m.x, m.z, 96)) {
        picked = m.id;
        break;
      }
    }
    if (!picked) {
      let best = 1.7;
      for (const m of view().monsters) {
        if (m.hp <= 0) continue;
        const d = Math.hypot(m.x - w.x, m.z - w.z);
        const sp = worldToScreen(m.x, m.z);
        if (d < best && Math.hypot(sp.x - sx, sp.y - sy) < 80) {
          best = d;
          picked = m.id;
        }
      }
    }
    if (picked) {
      pinnedId = picked;
      chaseId = picked;
      pvpId = null;
      const m = view().monsters.find((mon) => mon.id === picked);
      if (m) {
        const mage = p.baseClass === "Mage" || p.prestigeClass === "Wizard";
        const dist = Math.hypot(m.x - p.x, m.z - p.z);
        const inRange = mage ? dist <= 7.2 : dist <= 2.65;
        if (!inRange) {
          const spot = mage ? rangedStand(m.x, m.z, p.x, p.z) : adjacentStand(m.x, m.z, p.x, p.z);
          rememberClick(e, hit, spot);
          goTo(spot.x, spot.z, null, true);
        } else {
          rememberClick(e, hit, m);
          dest = null;
          path = [];
        }
      }
      return;
    }
    pinnedId = null;
    chaseId = null;
    pvpId = null;
    lootGrave = null;
    const tile = pickTile(sx, sy, w.x, w.z);
    rememberClick(e, hit, tile);
    pendingMove = { x: tile.x, z: tile.z };
  }

  function onWorldUp(e: PointerEvent) {
    const move = pendingMove;
    pendingMove = null;
    if (!move || e.button !== 0) return;
    if (e.target !== canvas) return;
    const top = document.elementFromPoint(e.clientX, e.clientY);
    if (top && top !== canvas && !canvas.contains(top)) return;
    goTo(move.x, move.z, null);
  }

  function onRootPointerDown(e: PointerEvent) {
    const target = e.target;
    if (target === canvas || (target instanceof Node && canvas.contains(target))) return;
    pendingMove = null;
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
    const trainer = p ? nearestTrainer(p.x, p.z, 8) : null;
    if (!p || !trainer) return;
    if (trainTitle) trainTitle.textContent = trainer.name;
    trainSig = "";
    setOpen(trainPanel, true);
    paintTrain();
  }

  function paintTrain() {
    const p = me();
    if (!p || trainPanel.hidden) return;
    const sig = `${p.gold}|${p.trainPoints}|${p.level}|${p.prestigeClass}|${JSON.stringify(p.skills ?? {})}`;
    trainPointsEl.textContent = `Training points ${p.trainPoints ?? 0} · Gold ${p.gold}`;
    const promo = root.querySelector<HTMLButtonElement>("#trainPromote");
    if (promo) {
      const open = p.level >= 10 && !p.prestigeClass;
      promo.hidden = !open;
      promo.textContent = open ? `Promote to ${PRESTIGE_OF[p.baseClass]}` : "Promote";
    }
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
    const vendor = p ? nearestVendor(p.x, p.z, 8) : null;
    if (!p || !vendor) return;
    if (shopTitle) shopTitle.textContent = vendor.name;
    shopSig = "";
    setOpen(shop, true);
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
    const attuned = p.attunedGates?.length ? p.attunedGates : DEFAULT_ATTUNED;
    travelTitle.textContent = `Wayfarer of ${city.name}`;
    travelHint.textContent = "The stones can carry you onward.";
    const groups = CIRCUITS.map((circuit) => {
      const hops = LINKS.filter(
        (link) => link.circuit === circuit.id && (link.from === city.id || link.to === city.id),
      ).map((link) => (link.from === city.id ? link.to : link.from));
      if (!hops.length) return "";
      const buttons = hops
        .map((id) => {
          const dest = cityAt(id);
          if (!dest) return "";
          const reason = gateHop(city.id, id, p.level, attuned);
          const disabled = reason ? " disabled" : "";
          const note = reason ? ` title="${reason.replace(/"/g, "")}"` : "";
          const label = reason ? `${dest.name} — ${reason}` : dest.name;
          return `<button type="button" data-city="${id}"${disabled}${note}>${label}</button>`;
        })
        .join("");
      return `<div class="circuit" style="color:${circuit.color}">${circuit.name}</div>${buttons}`;
    }).join("");
    travelButtons.innerHTML = groups;
    setOpen(travelPanel, true);
  }

  function goCity(cityId: string) {
    const p = localPlayer();
    const city = cityAt(cityId);
    if (!p || !city || p.hp <= 0) return;
    const here = nearestWayfarer(p.x, p.z, 4.2);
    if (!here) return;
    const attuned = p.attunedGates?.length ? p.attunedGates : DEFAULT_ATTUNED;
    const reason = gateHop(here.city, cityId, p.level, attuned);
    if (reason) {
      floatText(reason, "#f0dca0", 130);
      return;
    }
    dest = null;
    path = [];
    talkNpc = null;
    setOpen(travelPanel, false);
    const had = (p.attunedGates ?? DEFAULT_ATTUNED).includes(cityId);
    if (host) {
      const result = world.travel(p.id, cityId);
      if (!result.ok && result.reason) floatText(result.reason, "#f0dca0", 130);
      else if (result.ok && !had) floatText(`${city.name} stones attuned.`);
    } else {
      const spot = arrivalAt(city.x, city.z);
      p.x = spot.x;
      p.z = spot.z;
      if (!p.attunedGates) p.attunedGates = [...DEFAULT_ATTUNED];
      if (!p.attunedGates.includes(cityId)) {
        p.attunedGates.push(cityId);
        floatText(`${city.name} stones attuned.`);
      }
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
    if (blockPanelClicks) return;
    const btn = (e.target as HTMLElement).closest("button[data-city]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const cityId = (btn as HTMLElement).dataset.city;
    if (!cityId) return;
    touchInput();
    goCity(cityId);
    persist();
  }

  function onRespawn(e: Event) {
    e.preventDefault();
    touchInput();
    dest = null;
    path = [];
    talkNpc = null;
    if (host) world.respawn(myId);
    persist();
  }

  function onTravelClose(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    pendingMove = null;
    setOpen(travelPanel, false);
  }

  function act(skill: string) {
    const power = powerById(skill);
    const selfCast = !power || power.range <= 0 || power.kind === "buff" || power.kind === "stealth" || (power.kind === "heal" && power.id !== "succor");
    const range = power && power.range > 0 ? power.range : 3.8;
    const pinned = pinnedId ? view().monsters.find((m) => m.id === pinnedId && m.hp > 0) : null;
    const p = me();
    const pinOk = pinned && p && Math.hypot(pinned.x - p.x, pinned.z - p.z) <= range;
    let targetId = selfCast ? null : pinOk ? pinned.id : nearestId(range);
    if (skill === "succor" && p) {
      const shrouded = view().players.find(
        (pl) => pl.hp > 0 && (pl.shroudUntil ?? 0) > Date.now() && Math.hypot(pl.x - p.x, pl.z - p.z) <= 8,
      );
      targetId = shrouded?.id ?? p.id;
    }
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
      return;
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
    setOpen(sheet, sheet.hidden);
  }
  function onBagToggle(e: Event) {
    e.preventDefault();
    const open = bag.hidden;
    setOpen(bag, open);
    if (open) {
      bagSig = "";
      paintBag();
    }
  }
  function onBagClick(e: Event) {
    if (blockPanelClicks) return;
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
    if (blockPanelClicks) return;
    const btn = (e.target as HTMLElement).closest("button[data-buy], button[data-sell]");
    if (!btn) return;
    e.preventDefault();
    const buyId = (btn as HTMLElement).dataset.buy;
    const sellId = (btn as HTMLElement).dataset.sell;
    if (buyId) send({ op: "buy", id: myId, itemId: buyId });
    else if (sellId) send({ op: "sell", id: myId, itemId: sellId });
  }
  function onTrainClick(e: Event) {
    if (blockPanelClicks) return;
    const btn = (e.target as HTMLElement).closest("button[data-train]");
    if (!btn) return;
    e.preventDefault();
    const skillId = (btn as HTMLElement).dataset.train;
    if (skillId) send({ op: "train", id: myId, skillId });
  }
  function onTrainClose(e: Event) {
    e.preventDefault();
    setOpen(trainPanel, false);
  }
  function onShopClose(e: Event) {
    e.preventDefault();
    setOpen(shop, false);
  }
  function onBagClose(e: Event) {
    e.preventDefault();
    setOpen(bag, false);
  }
  function onSheetClose(e: Event) {
    e.preventDefault();
    setOpen(sheet, false);
  }
  function onSpawnMob(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    pendingMove = null;
    send({ op: "spawn", id: myId });
  }

  function showChatTab(tab: "say" | "pvp") {
    chatTab = tab;
    root.querySelector("#chatTabSay")?.classList.toggle("on", tab === "say");
    root.querySelector("#chatTabPvp")?.classList.toggle("on", tab === "pvp");
    messages.hidden = tab !== "say";
    if (pvpBox) pvpBox.hidden = tab !== "pvp";
  }

  function onChatTab(e: Event) {
    e.preventDefault();
    const id = (e.currentTarget as HTMLElement).id;
    showChatTab(id === "chatTabPvp" ? "pvp" : "say");
  }

  function onDebugLevel(e: Event) {
    e.preventDefault();
    const input = root.querySelector<HTMLInputElement>("#debugLevelInput");
    touchInput();
    send({ op: "setLevel", id: myId, level: Number(input?.value || 10) });
    persist();
  }
  function onDebugHudLevel(e: Event) {
    e.preventDefault();
    const input = root.querySelector<HTMLInputElement>("#debugHudLevel");
    touchInput();
    send({ op: "setLevel", id: myId, level: Number(input?.value || 20) });
    persist();
  }
  function onDebugPlus(e: Event) {
    e.preventDefault();
    send({ op: "setLevel", id: myId, level: (me()?.level ?? 1) + 1 });
  }
  function onDebugHp(e: Event) {
    e.preventDefault();
    send({ op: "setHp", id: myId, hp: 1 });
  }
  function onDebugKill(e: Event) {
    e.preventDefault();
    touchInput();
    send({ op: "setHp", id: myId, hp: 0 });
    persist();
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
    const open = mapOverlay.hidden;
    setOpen(mapOverlay, open);
    if (open) drawWorldMap();
  }

  function onMapClose(e: Event) {
    e.preventDefault();
    setOpen(mapOverlay, false);
  }

  function onChatKey(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    if (text.startsWith("/")) {
      handleSlash(text);
      return;
    }
    send({ op: "chat", id: myId, msg: text });
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
    touchInput();
    stick.setPointerCapture(e.pointerId);
    stickActive = true;
    setStick(e.clientX, e.clientY);
  }
  function onStickMove(e: PointerEvent) {
    if (stickActive) setStick(e.clientX, e.clientY);
  }

  const sheetBtn = root.querySelector<HTMLButtonElement>("#sheetBtn")!;
  const sheetClose = root.querySelector<HTMLButtonElement>("#sheetClose")!;
  const bagBtn = root.querySelector<HTMLButtonElement>("#bagBtn")!;
  const bagClose = root.querySelector<HTMLButtonElement>("#bagClose")!;
  const shopClose = root.querySelector<HTMLButtonElement>("#shopClose")!;
  const trainClose = root.querySelector<HTMLButtonElement>("#trainClose")!;
  const mapBtn = root.querySelector<HTMLButtonElement>("#mapBtn")!;
  const mapClose = root.querySelector<HTMLButtonElement>("#mapClose")!;
  const travelClose = root.querySelector<HTMLButtonElement>("#travelClose")!;
  const hotbarButtons = [...root.querySelectorAll<HTMLButtonElement>("#hotbar button")];
  hotbarButtons.forEach((btn) => btn.addEventListener("pointerup", onHotbar));
  promoteBtn.addEventListener("pointerup", onPromote);
  sheetBtn.addEventListener("pointerup", onSheet);
  sheetClose.addEventListener("pointerup", onSheetClose);
  bagBtn.addEventListener("pointerup", onBagToggle);
  bagClose.addEventListener("pointerup", onBagClose);
  bag.addEventListener("pointerup", onBagClick);
  shopStock.addEventListener("pointerup", onShopClick);
  shopBag.addEventListener("pointerup", onShopClick);
  shopClose.addEventListener("pointerup", onShopClose);
  trainList.addEventListener("pointerup", onTrainClick);
  trainClose.addEventListener("pointerup", onTrainClose);
  root.querySelector("#trainPromote")?.addEventListener("pointerup", onPromote);
  root.querySelector("#debugLevelBtn")?.addEventListener("pointerup", onDebugLevel);
  root.querySelector("#debugHudLevelBtn")?.addEventListener("pointerup", onDebugHudLevel);
  root.querySelector("#inviteAccept")?.addEventListener("pointerup", acceptInvite);
  root.querySelector("#inviteDecline")?.addEventListener("pointerup", declineInvite);
  ctxMenu?.addEventListener("pointerup", onCtxClick);
  root.querySelector("#debugPlusBtn")?.addEventListener("pointerup", onDebugPlus);
  root.querySelector("#debugHpBtn")?.addEventListener("pointerup", onDebugHp);
  root.querySelector("#debugKillBtn")?.addEventListener("pointerup", onDebugKill);
  clickDebugToggle?.addEventListener("change", paintClickDebug);
  paintClickDebug();
  showChatTab("say");
  root.querySelector("#chatToggle")!.addEventListener("pointerup", onChatToggle);
  root.querySelector("#chatTabSay")?.addEventListener("pointerup", onChatTab);
  root.querySelector("#chatTabPvp")?.addEventListener("pointerup", onChatTab);
  root.querySelector("#debugSpawnBtn")?.addEventListener("pointerup", onSpawnMob);
  mapBtn.addEventListener("pointerup", onMap);
  mapClose.addEventListener("pointerup", onMapClose);
  talkBtn.addEventListener("pointerup", onTalk);
  travelButtons.addEventListener("pointerup", onTravelClick);
  travelClose.addEventListener("pointerup", onTravelClose);
  respawnBtn.addEventListener("pointerup", onRespawn);
  chatInput.addEventListener("keydown", onChatKey);
  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointerup", onWorldUp);
  root.addEventListener("pointerdown", onRootPointerDown, true);
  window.addEventListener("pointerup", onWorldUp);
  stick.addEventListener("pointerdown", onStickDown);
  stick.addEventListener("pointermove", onStickMove);
  stick.addEventListener("pointerup", resetStick);
  stick.addEventListener("pointercancel", resetStick);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", resize);
  root.addEventListener("contextmenu", onContextMenu);

  try {
    groupChannel = new BroadcastChannel("caldrenmoor-group-v1");
    groupChannel.onmessage = (ev) => onGroupMessage(ev);
    pulseGroup();
  } catch {
    groupChannel = null;
  }

  const stepTimer = window.setInterval(() => {
    if (host && mapOverlay.hidden) authority.step(Date.now());
  }, 400);
  const saveTimer = window.setInterval(persist, 2000);
  const groupTimer = window.setInterval(pulseGroup, 400);

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
      return { x: p?.x ?? 0, z: p?.z ?? 0, hp: p?.hp ?? 0, mana: p?.mana ?? 0, gold: p?.gold ?? 0, xp: p?.xp ?? 0, level: p?.level ?? 1 };
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
      view().monsters.filter((m) => m.hp > 0).map((m) => ({ id: m.id, type: m.type, level: m.level, hp: m.hp, x: m.x, z: m.z })),
    npcs: () => NPCS.map((n) => ({ id: n.id, name: n.name, role: n.role, city: n.city, x: n.x, z: n.z })),
    mapOpen: () => !mapOverlay.hidden,
    place: (x: number, z: number) => {
      const p = localPlayer();
      if (!p) return;
      const spot = nearestOpen(x, z);
      p.x = spot.x;
      p.z = spot.z;
      dest = null;
      path = [];
      chaseId = null;
      cam.x = (p.x - p.z) * (TW / 2);
      cam.z = (p.x + p.z) * (TH / 2);
    },
    swing: () => act("attack"),
    setLevel: (level: number) => send({ op: "setLevel", id: myId, level }),
    project: (x: number, z: number) => worldToScreen(x, z),
    unproject: (sx: number, sy: number) => screenToWorld(sx, sy),
    viewSize: () => ({
      viewW,
      viewH,
      camX: cam.x,
      camZ: cam.z,
      dpr: Math.min(2, window.devicePixelRatio || 1),
      backingW: canvas.width,
      backingH: canvas.height,
    }),
    resolveClick: (input) =>
      readClick({
        clientX: input.clientX,
        clientY: input.clientY,
        offsetX: input.offsetX,
        offsetY: input.offsetY,
      }),
    lastClick: () => lastClick,
    dest: () => (dest ? { x: dest.x, z: dest.z } : null),
    flushSave: () => {
      dirty = true;
      persist();
    },
    panels: () => ({
      shop: !shop.hidden,
      travel: !travelPanel.hidden,
      train: !trainPanel.hidden,
      shopTitle: shopTitle?.textContent ?? "",
      trainTitle: trainTitle?.textContent ?? "",
    }),
    groupMembers: () => groupRoster().map((row) => ({ id: row.id, name: row.name, level: row.level, hp: row.hp, maxHp: row.maxHp })),
    spawnMob: () => {
      pendingMove = null;
      send({ op: "spawn", id: myId });
    },
    attackPeer: () => {
      const peer = nearestPeer();
      if (!peer) return "none";
      return strikePeer(peer);
    },
    zoneText: () => root.querySelector(".zone-line")?.textContent ?? "",
    pvpLines: () => pvpLines.slice(),
    floats: () => floaters.map((f) => f.text),
  };

  resize();
  raf = requestAnimationFrame(frame);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const slot = isleSlot();
    if (slot.dispose === dispose) slot.dispose = undefined;
    dead = true;
    cancelAnimationFrame(raf);
    window.clearInterval(stepTimer);
    window.clearInterval(saveTimer);
    window.clearInterval(groupTimer);
    onLeave();
    groupChannel?.close();
    groupChannel = null;
    hotbarButtons.forEach((btn) => btn.removeEventListener("pointerup", onHotbar));
    promoteBtn.removeEventListener("pointerup", onPromote);
    root.querySelector("#trainPromote")?.removeEventListener("pointerup", onPromote);
    root.querySelector("#chatToggle")?.removeEventListener("pointerup", onChatToggle);
    root.querySelector("#chatTabSay")?.removeEventListener("pointerup", onChatTab);
    root.querySelector("#chatTabPvp")?.removeEventListener("pointerup", onChatTab);
    root.querySelector("#debugSpawnBtn")?.removeEventListener("pointerup", onSpawnMob);
    root.querySelector("#debugLevelBtn")?.removeEventListener("pointerup", onDebugLevel);
    root.querySelector("#debugHudLevelBtn")?.removeEventListener("pointerup", onDebugHudLevel);
    root.querySelector("#inviteAccept")?.removeEventListener("pointerup", acceptInvite);
    root.querySelector("#inviteDecline")?.removeEventListener("pointerup", declineInvite);
    ctxMenu?.removeEventListener("pointerup", onCtxClick);
    root.querySelector("#debugPlusBtn")?.removeEventListener("pointerup", onDebugPlus);
    root.querySelector("#debugHpBtn")?.removeEventListener("pointerup", onDebugHp);
    root.querySelector("#debugKillBtn")?.removeEventListener("pointerup", onDebugKill);
    clickDebugToggle?.removeEventListener("change", paintClickDebug);
    mapBtn.removeEventListener("pointerup", onMap);
    mapClose.removeEventListener("pointerup", onMapClose);
    sheetBtn.removeEventListener("pointerup", onSheet);
    sheetClose.removeEventListener("pointerup", onSheetClose);
    bagBtn.removeEventListener("pointerup", onBagToggle);
    bagClose.removeEventListener("pointerup", onBagClose);
    bag.removeEventListener("pointerup", onBagClick);
    shopStock.removeEventListener("pointerup", onShopClick);
    shopBag.removeEventListener("pointerup", onShopClick);
    shopClose.removeEventListener("pointerup", onShopClose);
    trainList.removeEventListener("pointerup", onTrainClick);
    trainClose.removeEventListener("pointerup", onTrainClose);
    talkBtn.removeEventListener("pointerup", onTalk);
    travelButtons.removeEventListener("pointerup", onTravelClick);
    travelClose.removeEventListener("pointerup", onTravelClose);
    respawnBtn.removeEventListener("pointerup", onRespawn);
    chatInput.removeEventListener("keydown", onChatKey);
    canvas.removeEventListener("pointerdown", onPointer);
    canvas.removeEventListener("pointerup", onWorldUp);
    root.removeEventListener("pointerdown", onRootPointerDown, true);
    window.removeEventListener("pointerup", onWorldUp);
    stick.removeEventListener("pointerdown", onStickDown);
    stick.removeEventListener("pointermove", onStickMove);
    stick.removeEventListener("pointerup", resetStick);
    stick.removeEventListener("pointercancel", resetStick);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", resize);
    root.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("pagehide", onLeave);
    if (window.__controlsTest) delete window.__controlsTest;
  };
  isleSlot().dispose = dispose;
  return dispose;
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
