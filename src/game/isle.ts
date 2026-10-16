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
  TREES,
  blocked,
  clearLine,
  nearestOpen,
  nearestTrainer,
  nearestRegistrar,
  offCampfire,
  onCampfire,
  routeTo,
  underHall,
} from "./geo";
import {
  BOUNDS,
  CIRCUITS,
  DEFAULT_ATTUNED,
  GATES,
  ISLANDS,
  LATER_ISLANDS,
  LINKS,
  TERRAIN_PALETTE,
  ZONES,
  gateHop,
  insideIsland,
  islandAt,
} from "../shared/content/world";
import { terrainAt, zoneAt, havenCity } from "../shared/sim/mask";
import { CAMPS, PRESTIGE_OF, xpNeed, type BaseClass, type PublicState, type Race } from "./types";
import {
  MOBS,
  RACES,
  EQUIP_SLOTS,
  SKILLS,
  VENDOR_STOCK,
  attrsFor,
  conFor,
  defaultHotbar,
  gearTotals,
  hitChance,
  itemById,
  poolsFor,
  trainedDamage,
  mobByType,
  mobLabel,
  powerById,
} from "../shared/content/catalog";
import {
  diamondDistance,
  resolveClick,
  tileAtScreen,
  screenToWorld as isoScreenToWorld,
  worldToScreen as isoWorldToScreen,
} from "./iso";
import { createGround } from "./ground";
import { MAX_SPEED, createWorld, type JoinInput } from "../shared/sim/world";
import { SERVER, toServerIntent } from "./net";
import { connectRemote, interpolateXZ, snapAlpha, worldMayStart, type LinkGate, type RemoteHandle } from "./remote";
import {
  CHARTER_GOLD,
  CITY_PLOTS,
  CORNERSTONE_GOLD,
  CRESTS,
  GUILD_KEY,
  GUILD_KINDS,
  guildAtPlot,
  guildOf,
  invalidateGuilds,
  memberRank,
  plantCornerstone,
  removeCornerstone,
  type CrestId,
  type GuildKind,
} from "./guilds";

export interface IsleProfile {
  username: string;
  race: Race;
  baseClass: BaseClass;
  slot: number;
  /** True when this hello should create the hero in `slot`. */
  create: boolean;
  /** Bounce name_taken / bad_create back to the creation screen. */
  onCreateError?: (reason: string) => void;
  /** 4401: the token is gone. Leave the world and show the sign-in screen. */
  onSignOut?: () => void;
}

const TW = 48;
const TH = 24;
/** Tiles per second. WASD, the stick, and click-to-walk all use this. */
const MOVE = MAX_SPEED;
const SWING_MS = 900;
function walkVelocity(dx: number, dz: number) {
  const d = Math.hypot(dx, dz) || 1;
  return { x: (dx / d) * MOVE, z: (dz / d) * MOVE };
}
const NAMES = [
  ...new Set([
    ...RACES.map((r) => r.toLowerCase()),
    "marshwarden",
    ...MOBS.map((m) => m.type.toLowerCase()),
    "hall",
    "tree",
    "fire",
  ]),
];

type Intent =
  | { op: "join"; body: JoinInput }
  | { op: "leave"; id: string }
  | { op: "move"; id: string; x: number; z: number; rotation: number }
  | { op: "attack"; id: string; targetId: string | null }
  | { op: "skill"; id: string; skill: string; targetId: string | null }
  | { op: "promote"; id: string; cls: string }
  | { op: "chat"; id: string; msg: string; channel?: "say" | "guild" }
  | { op: "travel"; id: string; cityId: string }
  | { op: "respawn"; id: string; place?: { x: number; z: number; name: string } }
  | { op: "loot"; id: string; graveId: string }
  | { op: "partyInvite"; toName: string }
  | { op: "partyAccept"; fromId: string }
  | { op: "partyDecline"; fromId: string }
  | { op: "partyLeave" }
  | { op: "buyCharter" }
  | { op: "foundGuild"; name: string; tag: string; kind: string; crest: string }
  | { op: "guildInvite"; toName: string }
  | { op: "guildAccept"; guildId: string }
  | { op: "guildDecline"; guildId: string }
  | { op: "guildLeave" }
  | { op: "guildKick"; userName: string }
  | { op: "guildPromote"; userName: string }
  | { op: "guildDemote"; userName: string }
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
      getPos?: () => {
        x: number;
        z: number;
        hp: number;
        mana: number;
        gold: number;
        xp: number;
        level: number;
      };
      hurt?: (amount: number) => void;
      setKeys?: (codes: string[]) => void;
      monsters?: () => Array<{
        id: string;
        type: string;
        level: number;
        hp: number;
        x: number;
        z: number;
      }>;
      npcs?: () => Array<{
        id: string;
        name: string;
        role: string;
        city: string;
        x: number;
        z: number;
      }>;
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
      }) => {
        sx: number;
        sy: number;
        x: number;
        z: number;
        camX: number;
        camZ: number;
        heroX: number;
        heroZ: number;
      };
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
      panels?: () => {
        shop: boolean;
        travel: boolean;
        train: boolean;
        shopTitle: string;
        trainTitle: string;
      };
      groupMembers?: () => Array<{
        id: string;
        name: string;
        level: number;
        hp: number;
        maxHp: number;
      }>;
      spawnMob?: () => void;
      attackPeer?: () => string;
      zoneText?: () => string;
      pvpLines?: () => string[];
      floats?: () => string[];
    };
  }
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
  const guildBox = root.querySelector<HTMLElement>("#guildMessages");
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
  const debugHud = root.querySelector<HTMLElement>("#debugHud");
  const showDebugHud = new URLSearchParams(window.location.search).get("debug") === "1";
  if (debugRow) debugRow.hidden = true;
  if (debugHud) debugHud.hidden = true;
  const groupFrame = root.querySelector<HTMLElement>("#groupFrame");
  const inviteToast = root.querySelector<HTMLElement>("#inviteToast");
  const inviteText = root.querySelector<HTMLElement>("#inviteText");
  const ctxMenu = root.querySelector<HTMLElement>("#ctxMenu");
  const clickDebug = root.querySelector<HTMLElement>("#clickDebug");
  const clickDebugToggle = root.querySelector<HTMLInputElement>("#clickDebugToggle");
  const guildPanel = root.querySelector<HTMLElement>("#guild")!;
  const guildTitle = root.querySelector<HTMLElement>("#guildTitle");
  const guildBody = root.querySelector<HTMLElement>("#guildBody")!;
  const guildToast = root.querySelector<HTMLElement>("#guildToast");
  const plotPrompt = root.querySelector<HTMLElement>("#plotPrompt");
  const plotPromptText = root.querySelector<HTMLElement>("#plotPromptText");
  const plotPromptBtn = root.querySelector<HTMLButtonElement>("#plotPromptBtn");
  const bindLine = root.querySelector<HTMLElement>("#bindLine");
  const guildToastText = root.querySelector<HTMLElement>("#guildToastText");
  const targetFrame = root.querySelector<HTMLElement>("#targetFrame");

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
    for (const other of [sheet, bag, shop, trainPanel, travelPanel, mapOverlay, guildPanel]) {
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
    const leftover = [travelPanel, sheet, bag, shop, trainPanel, mapOverlay, guildPanel].find(
      (el) => !el.hidden,
    );
    if (!leftover) return false;
    setOpen(leftover, false);
    return true;
  }

  const SPRITE_FILES = new Set([
    "human",
    "elf",
    "minotaur",
    "marshwarden",
    "spider",
    "snake",
    "lizard",
    "orc",
    "bandit",
    "beast",
    "hall",
    "tree",
    "fire",
  ]);
  const sprites: Record<string, HTMLImageElement> = {};
  for (const name of NAMES) {
    if (!SPRITE_FILES.has(name)) continue;
    const img = new Image();
    img.src = `/sprites/${name}.png`;
    img.onload = () => {
      sprites[name] = img;
    };
  }
  const frames: Record<string, HTMLImageElement> = {};
  function loadFrame(key: string, version: string) {
    const img = new Image();
    img.onload = () => {
      frames[key] = img;
    };
    img.src = `/sprites/anim/${key}.png?v=${version}`;
  }
  const HUMAN_ANIMS = ["idle", "walk", "atk1h", "atk2h", "block", "cast1h"] as const;
  type HumanAnim = (typeof HUMAN_ANIMS)[number];
  type RigRace = "human" | "elf" | "minotaur" | "marshwarden";
  const RIG_RACES: RigRace[] = ["human", "elf", "minotaur", "marshwarden"];
  function freshDur(): Record<HumanAnim, number[]> {
    return {
      idle: [300, 300, 300, 300],
      walk: [180, 180, 180, 180],
      atk1h: [260, 120, 180, 300],
      atk2h: [300, 140, 180, 320],
      block: [160, 160, 200, 400],
      cast1h: [260, 200, 300, 260],
    };
  }
  const rigDur: Record<RigRace, Record<HumanAnim, number[]>> = {
    human: freshDur(),
    elf: freshDur(),
    minotaur: freshDur(),
    marshwarden: freshDur(),
  };
  function rigMs(race: RigRace, anim: HumanAnim) {
    return rigDur[race][anim].reduce((sum, ms) => sum + ms, 0);
  }
  function rigStep(race: RigRace, anim: HumanAnim, elapsed: number, hold: boolean) {
    const durs = rigDur[race][anim];
    const total = rigMs(race, anim);
    if (hold && elapsed >= total) return durs.length - 1;
    let t = hold ? Math.max(0, elapsed) : ((elapsed % total) + total) % total;
    for (let i = 0; i < durs.length; i++) {
      if (t < durs[i]) return i;
      t -= durs[i];
    }
    return durs.length - 1;
  }
  const HUMAN_CELL = 112 * 1.16;
  const ELF_CELL = HUMAN_CELL * 1.1;
  const MINOTAUR_CELL = HUMAN_CELL * 1.26;
  /** Crouched body, scaled so his height matches the standing human. */
  const MARSHWARDEN_CELL = 199;
  /**
   * Source frame the anchors were authored in. Hips (torsoX) and feet (feetY)
   * are the point that sits on the tile. 180-frame races share a 6px pad
   * under the feet; the marshwarden pad is the same in a 256 frame.
   */
  const RIG_METRICS: Record<RigRace, { frame: number; torsoX: number; feetY: number }> = {
    human: { frame: 180, torsoX: 90, feetY: 174 },
    elf: { frame: 180, torsoX: 90, feetY: 174 },
    minotaur: { frame: 180, torsoX: 90, feetY: 174 },
    marshwarden: { frame: 256, torsoX: 128, feetY: 250 },
  };
  const FACE_FILE = ["S", "W", "E", "N"];
  for (const race of ["human", "elf"] as const) {
    for (const part of ["base", "chest-cloth"]) {
      for (const anim of HUMAN_ANIMS) {
        for (let i = 0; i < 16; i++) loadFrame(`${race}-${part}-${anim}-${i}`, "10");
      }
    }
  }
  for (const anim of HUMAN_ANIMS) {
    for (let i = 0; i < 16; i++) loadFrame(`minotaur-base-${anim}-${i}`, "1");
  }
  for (const anim of HUMAN_ANIMS) {
    for (let i = 0; i < 16; i++) loadFrame(`marshwarden-base-${anim}-${i}`, "1");
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
  let selected: { kind: "mob" | "player" | "npc"; id: string } | null = null;
  const actors = new Map<
    string,
    {
      x: number;
      z: number;
      facing: number;
      attackUntil: number;
      castUntil: number;
      blockAt: number;
      blockUntil: number;
      wasBlocking: boolean;
      walkMs: number;
      moving: boolean;
      phase: number;
      stamp: number;
    }
  >();

  let myId = "p" + Math.random().toString(36).slice(2, 10);
  const joinBody: JoinInput = {
    id: myId,
    username: profile.username,
    race: profile.race,
    baseClass: profile.baseClass,
  };
  const world = createWorld();
  world.join(joinBody);

  let lastHeard = performance.now();
  const snaps: Array<{ at: number; state: PublicState }> = [];
  let playersOnline = 0;
  let remoteSession: RemoteHandle | null = null;
  let intentSeq = 0;
  const sentIntents = new Map<number, Intent>();
  // Tabs do not share a world. An older tab used to win the BroadcastChannel
  // host role and paste a stale hero over a fresh click, death, or respawn.
  let lastInput = 0;

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
  let guildMode: "desk" | "roster" = "roster";
  let guildSig = "";
  let draftName = "";
  let draftTag = "";
  let pickedKind: GuildKind = "Warband";
  let pickedCrest: CrestId = "ash";
  let repaths = 0;
  let stuckFor = 0;
  let lastSpeed = 0;
  let lastLogs = "";
  const pvpLines: string[] = [];
  let lastPvp = "";
  let chatTab: "say" | "pvp" | "guild" = "say";
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
  };
  const cam = { x: 0, z: 0 };
  const ground = createGround();
  {
    const spawned = localPlayer();
    if (spawned) {
      cam.x = (spawned.x - spawned.z) * (TW / 2);
      cam.z = (spawned.x + spawned.z) * (TH / 2);
    }
  }
  const notes: string[] = [];
  const floaters: Array<{
    x: number;
    z: number;
    text: string;
    born: number;
    color: string;
    lift: number;
    size: number;
    life: number;
  }> = [];
  let dead = false;
  let raf = 0;
  let lastFrame = performance.now();
  let lastSend = 0;

  function placeFloater(
    x: number,
    z: number,
    text: string,
    color: string,
    lift: number,
    size: number,
    life: number,
  ) {
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
    placeFloater(
      p?.x ?? 0,
      p?.z ?? 0,
      text,
      xp ? "#7CFF4A" : color,
      xp ? 168 : lift,
      xp ? 26 : 15,
      xp ? 2600 : 1700,
    );
  }

  function floatAt(x: number, z: number, text: string, color: string, lift = 78) {
    placeFloater(x, z, text, color, lift, 15, 1700);
  }

  const seenHp = new Map<string, number>();
  function puffDamage(id: string, x: number, z: number, hp: number, color: string) {
    const prev = seenHp.get(id);
    if (prev != null && hp < prev - 0.4)
      floatAt(x, z, `-${Math.max(1, Math.round(prev - hp))}`, color);
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

  function overlayMine(snap: PublicState): PublicState {
    const mine = localPlayer();
    const players = snap.players ?? [];
    if (!mine) return { ...snap, players };
    if (players.some((p) => p.id === myId)) {
      return {
        ...snap,
        players: players.map((p) =>
          p.id === myId ? { ...p, x: mine.x, z: mine.z, rotation: mine.rotation } : p,
        ),
      };
    }
    if (players.some((p) => p.username === mine.username)) return { ...snap, players };
    return { ...snap, players: [...players, { ...mine }] };
  }

  function serverView(): PublicState {
    const newer = snaps[snaps.length - 1];
    if (!newer) return overlayMine({ players: [], monsters: [], graves: [], logs: [] });
    const older = snaps.length > 1 ? snaps[0] : undefined;
    const alpha = older ? snapAlpha(older.at, newer.at, performance.now()) : 1;
    return overlayMine({
      ...newer.state,
      players: interpolateXZ(older?.state.players, newer.state.players ?? [], alpha, myId),
      monsters: interpolateXZ(older?.state.monsters, newer.state.monsters ?? [], alpha),
    });
  }

  function view(): PublicState {
    return serverView();
  }

  function me() {
    return view().players.find((p) => p.id === myId) ?? localPlayer();
  }

  let serverBound = false;
  let placed = false;
  /** Last position the server has actually confirmed. */
  let authX = 0;
  let authZ = 0;
  let haveAuth = false;
  /** Desired velocity this frame. Facing follows this, not a reconciliation yank. */
  let wishX = 0;
  let wishZ = 0;
  let faceHold = 0;
  const SEND_CAP = MOVE * 0.49;

  function claimServerId(nextId: string) {
    if (!nextId || nextId === myId) {
      serverBound = true;
      return;
    }
    const prev = world.players.get(myId);
    const prevId = myId;
    myId = nextId;
    serverBound = true;
    if (!prev || world.players.get(nextId)) {
      if (prev && prevId !== nextId) world.leave(prevId);
      return;
    }
    world.leave(prevId);
    world.join({
      id: nextId,
      username: prev.username,
      race: prev.race,
      baseClass: prev.baseClass,
      prestigeClass: prev.prestigeClass || undefined,
      level: prev.level,
      xp: prev.xp,
      gold: prev.gold,
      x: prev.x,
      z: prev.z,
      hp: prev.hp,
      inventory: prev.inventory,
      equipment: prev.equipment,
      trainPoints: prev.trainPoints,
      skills: prev.skills,
      hotbar: prev.hotbar,
      shroudUntil: prev.shroudUntil,
      attunedGates: prev.attunedGates,
      deathSettled: prev.hp <= 0 && prev.graveDropped,
    });
    const moved = world.players.get(nextId);
    if (!moved) return;
    moved.x = prev.x;
    moved.z = prev.z;
    moved.rotation = prev.rotation;
  }

  function adoptServerHero(mine: PublicState["players"][number]) {
    let local = world.players.get(myId);
    if (!local) {
      world.join({
        id: myId,
        username: mine.username,
        race: mine.race as Race,
        baseClass: mine.baseClass as BaseClass,
        prestigeClass: (mine.prestigeClass || "") as JoinInput["prestigeClass"],
        level: mine.level,
        xp: mine.xp,
        gold: mine.gold,
        x: mine.x,
        z: mine.z,
        hp: mine.maxHp,
        inventory: mine.inventory,
        equipment: mine.equipment,
        trainPoints: mine.trainPoints,
        skills: mine.skills,
        hotbar: mine.hotbar,
        shroudUntil: mine.shroudUntil,
        attunedGates: mine.attunedGates,
      });
      local = world.players.get(myId);
      if (!local) return;
    }
    authX = mine.x;
    authZ = mine.z;
    haveAuth = true;
    const gap = Math.hypot(local.x - mine.x, local.z - mine.z);
    const spawnedOnFire = (!placed || onCampfire(local.x, local.z)) && onCampfire(mine.x, mine.z);
    if (spawnedOnFire) {
      const clear = offCampfire(mine.x, mine.z);
      local.x = clear.x;
      local.z = clear.z;
      faceHold = performance.now() + 200;
    } else if (!placed || gap > 8) {
      local.x = mine.x;
      local.z = mine.z;
      local.rotation = mine.rotation;
      faceHold = performance.now() + 200;
    } else if (gap > 0.08) {
      const errX = mine.x - local.x;
      const errZ = mine.z - local.z;
      const speed = Math.hypot(wishX, wishZ);
      let fixX = 0;
      let fixZ = 0;
      if (speed > 0.2) {
        const ux = wishX / speed;
        const uz = wishZ / speed;
        const along = errX * ux + errZ * uz;
        const sideX = errX - along * ux;
        const sideZ = errZ - along * uz;
        const ahead = -Math.min(0, along);
        const budget = speed * 0.6 + 0.45;
        if (ahead > budget) {
          const excess = ahead - budget;
          fixX -= ux * excess * 0.5;
          fixZ -= uz * excess * 0.5;
        } else if (along > 0.2) {
          fixX += ux * along * 0.45;
          fixZ += uz * along * 0.45;
        }
        fixX += sideX * 0.5;
        fixZ += sideZ * 0.5;
      } else if (!(onCampfire(mine.x, mine.z) && !onCampfire(local.x, local.z))) {
        fixX = errX * 0.35;
        fixZ = errZ * 0.35;
      }
      if (fixX || fixZ) {
        faceHold = performance.now() + 120;
        local.x += fixX;
        local.z += fixZ;
      }
    }
    placed = true;
    if (spawnedOnFire) pushMove(true);
    local.hp = mine.hp;
    local.maxHp = mine.maxHp;
    local.mana = mine.mana;
    local.maxMana = mine.maxMana;
    local.stamina = mine.stamina;
    local.maxStamina = mine.maxStamina;
    local.gold = mine.gold;
    local.xp = mine.xp;
    local.level = mine.level;
    local.inventory = { ...mine.inventory };
    local.equipment = { ...mine.equipment };
    local.trainPoints = mine.trainPoints;
    local.skills = { ...(mine.skills ?? {}) };
    local.hotbar = [...(mine.hotbar ?? [])];
    local.nextSwing = mine.nextSwing;
    local.cooldowns = { ...(mine.cooldowns ?? {}) };
    local.graveDropped = mine.graveDropped;
    local.shroudUntil = mine.shroudUntil;
    local.guardUntil = mine.guardUntil;
    local.wallUntil = mine.wallUntil;
    local.stealthUntil = mine.stealthUntil;
    local.prestigeClass = mine.prestigeClass as typeof local.prestigeClass;
    local.username = mine.username;
  }

  function takeSnap(state: PublicState) {
    lastHeard = performance.now();
    snaps.push({ at: lastHeard, state });
    if (snaps.length > 2) snaps.shift();
    const mine = myId ? state.players.find((p) => p.id === myId) : undefined;
    if (mine) adoptServerHero(mine);
  }

  function present(
    intent: Intent,
    result: { ok?: boolean; reason?: string } | void | null,
  ) {
    if (result && "ok" in result && result.reason) {
      if (result.ok === false && result.reason === "Nothing in reach.") {
        const live = localPlayer();
        if (live) live.nextSwing = Date.now() + 1500;
        note(result.reason);
      } else if (result.ok === false) note(result.reason);
      else if (result.reason.startsWith("+")) floatText(result.reason, "#b6e38a"); else if (!result.reason.includes("hits for") && result.reason !== "Missed.")
        floatText(result.reason);
    }
    if (
      intent.op === "buy" ||
      intent.op === "sell" ||
      intent.op === "use" ||
      intent.op === "equip" ||
      intent.op === "unequip" ||
      intent.op === "train" ||
      intent.op === "promote"
    ) {
      bagSig = "";
      shopSig = "";
      trainSig = "";
      paintBag();
      paintShop();
      paintTrain();
    }
    if (
      result &&
      "ok" in result &&
      result.ok &&
      (intent.op === "buy" ||
        intent.op === "sell" ||
        intent.op === "use" ||
        intent.op === "equip" ||
        intent.op === "unequip" ||
        intent.op === "train" ||
        intent.op === "promote" ||
        intent.op === "loot" ||
        intent.op === "travel" ||
        intent.op === "respawn" ||
        intent.op === "setLevel" ||
        intent.op === "setHp")
    ) {
      commitPurse();
    }
  }

  function send(intent: Intent) {
    const wire = toServerIntent(intent);
    if (!wire || !remoteSession) return { ok: false };
    const seq = ++intentSeq;
    if (!remoteSession.send({ t: "intent", seq, intent: wire })) return { ok: false };
    sentIntents.set(seq, intent);
    return { ok: false };
  }

  function pushMove(force = false) {
    const p = localPlayer();
    if (!p || !serverBound || !placed || !myId || !haveAuth) return;
    const now = performance.now();
    if (!force && now - lastSend < 70) return;
    let x = p.x;
    let z = p.z;
    const dist = Math.hypot(x - authX, z - authZ);
    if (dist > SEND_CAP) {
      x = authX + ((x - authX) / dist) * SEND_CAP;
      z = authZ + ((z - authZ) / dist) * SEND_CAP;
    }
    lastSend = now;
    send({ op: "move", id: myId, x, z, rotation: p.rotation });
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

  function depthOf(x: number, z: number) {
    return worldToScreen(x, z).y;
  }

  function screenToWorld(sx: number, sy: number) {
    return isoScreenToWorld(sx, sy, cam.x, cam.z, viewW, viewH);
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
      actor = {
        x,
        z,
        facing: 0,
        attackUntil: 0,
        castUntil: 0,
        blockAt: 0,
        blockUntil: 0,
        wasBlocking: false,
        walkMs: 0,
        moving: false,
        phase: 0,
        stamp: 0,
      };
      actors.set(id, actor);
      return actor;
    }
    const dx = x - actor.x;
    const dz = z - actor.z;
    actor.moving = Math.hypot(dx, dz) > 0.02;
    const nowFace = performance.now();
    const wish = Math.hypot(wishX, wishZ);
    if (id === myId && nowFace < faceHold) {
      // A reconciliation step must not flip the sprite.
    } else if (id === myId && wish > 0.2) {
      const sx = wishX - wishZ;
      const sy = wishX + wishZ;
      actor.facing = Math.abs(sy) >= Math.abs(sx) ? (sy > 0 ? 0 : 3) : sx > 0 ? 2 : 1;
    } else if (actor.moving) {
      const sx = dx - dz;
      const sy = dx + dz;
      actor.facing = Math.abs(sy) >= Math.abs(sx) ? (sy > 0 ? 0 : 3) : sx > 0 ? 2 : 1;
    }
    if (id === myId && nowFace >= faceHold && wish <= 0.2) {
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

  function drawClassMark(
    kind: string,
    x: number,
    z: number,
    facing: number,
    phase: number,
    casting: boolean,
  ) {
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

  type WeaponDef = {
    file: string;
    pivotX: number;
    pivotY: number;
    baseAngle: number;
    slot?: string;
    facings?: Record<string, { file: string; pivotX: number; pivotY: number }>;
  };
  let weaponBook: Record<string, WeaponDef> = {};
  const weaponImages: Record<string, HTMLImageElement | HTMLCanvasElement> = {};

  function loadWeaponFile(file: string) {
    if (weaponImages[file]) return;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const g = canvas.getContext("2d");
      if (!g || !canvas.width) {
        weaponImages[file] = img;
        return;
      }
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, canvas.width, canvas.height);
      const px = data.data;
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] < 24) px[i] = 0;
        else px[i] = 255;
      }
      g.putImageData(data, 0, 0);
      weaponImages[file] = canvas;
    };
    img.src = `/sprites/weapons/${file}?v=1`;
  }

  const WEAPON_KEY_BY_ITEM: Record<string, string> = {
    "iron-sword": "iron_sword",
    dagger: "dagger",
    mace: "mace",
    "oak-staff": "oak_staff",
    oak_staff: "oak_staff",
    staff: "oak_staff",
    "round-shield": "round_shield",
    round_shield: "round_shield",
    shield: "round_shield",
  };

  type HandAnchor = {
    x: number;
    y: number;
    angle: number;
    behind: boolean;
    scale: number;
  };
  function emptyAnchors(): Record<HumanAnim, { main: HandAnchor[]; off: HandAnchor[] }> {
    return {
      idle: { main: [], off: [] },
      walk: { main: [], off: [] },
      atk1h: { main: [], off: [] },
      atk2h: { main: [], off: [] },
      block: { main: [], off: [] },
      cast1h: { main: [], off: [] },
    };
  }
  const rigAnchors: Record<RigRace, Record<HumanAnim, { main: HandAnchor[]; off: HandAnchor[] }>> = {
    human: emptyAnchors(),
    elf: emptyAnchors(),
    minotaur: emptyAnchors(),
    marshwarden: emptyAnchors(),
  };

  function loadWeaponRig() {
    for (const file of [
      "iron_sword.png",
      "dagger.png",
      "mace.png",
      "oak_staff.png",
      "round_shield.png",
      "round_shield-S.png",
      "round_shield-W.png",
      "round_shield-E.png",
      "round_shield-N.png",
    ])
      loadWeaponFile(file);
    void Promise.all(
      RIG_RACES.flatMap((race) =>
        HUMAN_ANIMS.map(async (anim) => {
          const data = (await fetch(`/sprites/anim/${race}-anchors-${anim}.json`).then((r) => r.json())) as {
            frameDurationsMs?: number[];
            mainHand?: HandAnchor[];
            offHand?: HandAnchor[];
          };
          if (Array.isArray(data.frameDurationsMs) && data.frameDurationsMs.length >= 4)
            rigDur[race][anim] = data.frameDurationsMs.slice(0, 4);
          rigAnchors[race][anim] = {
            main: Array.isArray(data.mainHand) ? data.mainHand : [],
            off: Array.isArray(data.offHand) ? data.offHand : [],
          };
        }),
      ),
    )
      .then(async () => {
        const book = (await fetch("/sprites/weapons/weapons.json").then((r) => r.json())) as Record<string, unknown>;
        const next: Record<string, WeaponDef> = {};
        for (const [key, value] of Object.entries(book ?? {})) {
          if (key.startsWith("_") || !value || typeof value !== "object") continue;
          next[key] = value as WeaponDef;
        }
        weaponBook = next;
      })
      .catch(() => undefined);
  }
  loadWeaponRig();

  function anchorAt(list: HandAnchor[], frame: number, race: RigRace): HandAnchor {
    const metrics = RIG_METRICS[race];
    return (
      list[frame] ??
      list[0] ?? { x: metrics.torsoX, y: metrics.feetY - 60, angle: -90, behind: false, scale: 0.72 }
    );
  }

  function clothKey(race: RigRace, anim: HumanAnim, frame: number) {
    if (race !== "human" && race !== "elf") return "";
    return `${race}-chest-cloth-${anim}-${frame}`;
  }

  function twoHanded(itemId: string) {
    return itemId === "oak-staff" || itemId === "oak_staff" || itemId === "staff";
  }

  function isShield(itemId: string) {
    const key = WEAPON_KEY_BY_ITEM[itemId];
    const def = key ? weaponBook[key] : undefined;
    if (def) return def.slot === "offhand";
    return itemId === "round-shield" || itemId === "shield";
  }

  function heldWeapon(itemId: string) {
    const key = WEAPON_KEY_BY_ITEM[itemId];
    const def = key ? weaponBook[key] : undefined;
    if (!def || def.slot === "offhand") return null;
    const img = weaponImages[def.file];
    if (!img) return null;
    return def;
  }

  function heldShield(itemId: string, facingFile?: string) {
    const key = WEAPON_KEY_BY_ITEM[itemId];
    const def = key ? weaponBook[key] : undefined;
    if (!def || def.slot !== "offhand") return null;
    const face = facingFile ? def.facings?.[facingFile] : undefined;
    const file = face?.file ?? def.file;
    const img = weaponImages[file];
    if (!img) return null;
    return {
      file,
      pivotX: face?.pivotX ?? def.pivotX,
      pivotY: face?.pivotY ?? def.pivotY,
      baseAngle: def.baseAngle ?? 0,
    };
  }

  function weaponRead(file: string) {
    if (file.startsWith("dagger")) return 1.45;
    if (file.startsWith("mace")) return 1.65;
    if (file.startsWith("oak_staff")) return 1.45;
    return 1;
  }

  function drawHeld(
    file: string,
    anchor: HandAnchor,
    pivotX: number,
    pivotY: number,
    baseAngle: number,
    originX: number,
    originY: number,
    drawScale: number,
    filter: string,
  ) {
    const img = weaponImages[file];
    if (!img) return;
    const read = weaponRead(file);
    const sc = (anchor.scale || 0.72) * drawScale * read;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = read > 1;
    ctx.filter = filter === "none" ? "none" : filter;
    ctx.translate(originX + anchor.x * drawScale, originY + anchor.y * drawScale);
    ctx.rotate(((anchor.angle - baseAngle) * Math.PI) / 180);
    ctx.scale(sc, sc);
    if (read > 1) {
      const ink = Math.max(1.1, 1.6 / sc);
      ctx.save();
      ctx.filter = "brightness(0)";
      ctx.globalAlpha = 0.95;
      ctx.drawImage(img, -pivotX + ink, -pivotY);
      ctx.drawImage(img, -pivotX - ink, -pivotY);
      ctx.drawImage(img, -pivotX, -pivotY + ink);
      ctx.drawImage(img, -pivotX, -pivotY - ink);
      ctx.restore();
      ctx.filter = "none";
    }
    ctx.drawImage(img, -pivotX, -pivotY);
    ctx.restore();
  }

  function drawRig(
    race: RigRace,
    anim: HumanAnim,
    frame: number,
    x: number,
    z: number,
    cell: number,
    lift: number,
    filter: string,
    equipment: Record<string, string> | undefined,
    facingFile: string,
  ) {
    const hands = rigAnchors[race][anim];
    const main = anchorAt(hands.main, frame, race);
    const off = anchorAt(hands.off, frame, race);
    const weapon = heldWeapon(equipment?.weapon ?? "");
    const shield = anim === "atk2h" ? null : heldShield(equipment?.offhand ?? "", facingFile);
    const metrics = RIG_METRICS[race];
    const foot = worldToScreen(x, z);
    const drawScale = cell / metrics.frame;
    // (torsoX, feetY) is the hip/sole in source pixels. The 16px bias puts
    // the frame bottom where the 180px rigs already stand, and the pad under
    // the feet (frame - feetY) is 6px on every race, so soles share a line.
    const footDrop = (metrics.frame - metrics.feetY) * drawScale;
    const originX = foot.x - metrics.torsoX * drawScale;
    const originY = foot.y - metrics.feetY * drawScale + (16 - footDrop) - lift;
    const props: Array<{ file: string; anchor: HandAnchor; pivotX: number; pivotY: number; baseAngle: number }> = [];
    if (weapon) props.push({ file: weapon.file, anchor: main, pivotX: weapon.pivotX, pivotY: weapon.pivotY, baseAngle: weapon.baseAngle });
    if (shield) props.push({ file: shield.file, anchor: off, pivotX: shield.pivotX, pivotY: shield.pivotY, baseAngle: shield.baseAngle });
    for (const prop of props) {
      if (!prop.anchor.behind) continue;
      drawHeld(prop.file, prop.anchor, prop.pivotX, prop.pivotY, prop.baseAngle, originX, originY, drawScale, "none");
    }
    const baseKey = `${race}-base-${anim}-${frame}`;
    if (!drawRigFrame(baseKey, originX, originY, cell, filter)) return false;
    const chest = clothKey(race, anim, frame);
    if (chest) drawRigFrame(chest, originX, originY, cell, filter);
    for (const prop of props) {
      if (prop.anchor.behind) continue;
      drawHeld(prop.file, prop.anchor, prop.pivotX, prop.pivotY, prop.baseAngle, originX, originY, drawScale, "none");
    }
    return true;
  }

  function drawRigFrame(key: string, originX: number, originY: number, cell: number, filter: string) {
    const img = frames[key];
    if (!img) return false;
    const dh = cell * (img.height / img.width);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.filter = filter;
    ctx.drawImage(img, originX, originY, cell, dh);
    ctx.restore();
    return true;
  }

  function asRig(race: string): RigRace | null {
    if (race === "human" || race === "elf" || race === "minotaur" || race === "marshwarden") return race;
    return null;
  }

  function rigCell(race: RigRace) {
    if (race === "elf") return ELF_CELL;
    if (race === "minotaur") return MINOTAUR_CELL;
    if (race === "marshwarden") return MARSHWARDEN_CELL;
    return HUMAN_CELL;
  }

  function drawHero(
    race: string,
    id: string,
    x: number,
    z: number,
    cls?: string,
    gear?: Record<string, string>,
  ) {
    const drawn = race;
    const actor = trackActor(id, x, z);
    const now = performance.now();
    const dt = actor.stamp ? Math.min(0.05, (now - actor.stamp) / 1000) : 0;
    actor.stamp = now;
    const moving = actor.moving || (id === myId && lastSpeed > 0.2);
    actor.moving = moving;
    if (moving) {
      const rate = id === myId ? Math.max(0.45, Math.min(1.4, lastSpeed / MOVE)) : 1;
      actor.phase += dt * 3.25 * rate;
    }
    const kind = classKind(cls);
    const filter = classFilter[kind];
    const rig = asRig(drawn);
    const cell = rig ? rigCell(rig) : 112;
    const lift = moving ? Math.abs(Math.sin(actor.phase * Math.PI)) * 5 : Math.sin(now / 420) * 1.2;
    const casting = now < actor.castUntil;
    const attacking = now < actor.attackUntil && !casting;
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
    const worn = gear ?? world.players.get(id)?.equipment;
    if (rig) {
      const weaponId = worn?.weapon ?? "";
      const swing = twoHanded(weaponId) ? "atk2h" : "atk1h";
      const guarding = isShield(worn?.offhand ?? "") && (world.players.get(id)?.guardUntil ?? 0) > Date.now();
      const blocking = guarding || (id === myId && now < actor.blockUntil);
      if (blocking && !actor.wasBlocking) actor.blockAt = now;
      actor.wasBlocking = blocking;
      let anim: HumanAnim = "idle";
      if (attacking) anim = swing;
      else if (casting) anim = "cast1h";
      else if (blocking) anim = "block";
      else if (moving) anim = "walk";
      const rate = id === myId ? Math.max(0.45, Math.min(1.4, lastSpeed / MOVE)) : 1;
      if (anim === "walk") actor.walkMs += dt * 1000 * (moving ? rate : 1);
      const elapsed =
        anim === "walk"
          ? actor.walkMs
          : anim === "idle"
            ? now
            : anim === "block"
              ? now - actor.blockAt
              : anim === "cast1h"
                ? rigMs(rig, "cast1h") - (actor.castUntil - now)
                : rigMs(rig, swing) - (actor.attackUntil - now);
      const step = rigStep(rig, anim, elapsed, anim === "atk1h" || anim === "atk2h" || anim === "block" || anim === "cast1h");
      const frame = actor.facing * 4 + step;
      if (!drawRig(rig, anim, frame, x, z, cell, lift, filter, worn, FACE_FILE[actor.facing] ?? "S"))
        drawSprite(drawn, x, z, drawn === "minotaur" ? 0.2 : 0.18);
    } else if (attacking) {
      const t = 1 - (actor.attackUntil - now) / SWING_MS;
      const frame = Math.min(3, Math.floor(Math.max(0, t) * 4));
      if (!drawFrame(`${drawn}-atk-${frame}`, x, z, cell, lift, filter))
        drawSprite(drawn, x, z, drawn === "minotaur" ? 0.2 : 0.18);
    } else {
      const col = moving ? Math.floor(actor.phase) % 4 : 1;
      const row = actor.facing * 4;
      const frame = row + col;
      if (!drawFrame(`${drawn}-walk-${frame}`, x, z, cell, lift, filter))
        drawSprite(drawn, x, z, drawn === "minotaur" ? 0.2 : 0.18);
    }
    if (cls) drawClassMark(kind, x, z, actor.facing, actor.phase, casting);
    if (casting) {
      const span = rig ? rigMs(rig, "cast1h") : 900;
      drawCast(x, z, 1 - (actor.castUntil - now) / span);
    }
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

  function zoneRecord(x: number, z: number) {
    const town = townNear(x, z);
    if (town?.zone) {
      const declared = ZONES.find((zone) => zone.id === town.zone);
      if (declared) return declared;
    }
    return zoneAt(x, z);
  }

  function hud() {
    const p = me();
    if (!p) return;
    const pools = poolsFor(p);
    const maxHp = pools.maxHp;
    const maxMana = pools.maxMana;
    const maxStamina = pools.maxStamina;
    const hp =
      p.maxHp === maxHp
        ? p.hp
        : p.hp >= p.maxHp - 0.5 || p.maxHp === 100
          ? maxHp
          : Math.min(p.hp, maxHp);
    const mana =
      p.maxMana === maxMana
        ? p.mana
        : p.mana >= p.maxMana - 0.5 || p.maxMana === 50
          ? maxMana
          : Math.min(p.mana, maxMana);
    const stamina =
      p.maxStamina === maxStamina
        ? (p.stamina ?? 0)
        : (p.stamina ?? 0) >= p.maxStamina - 0.5 || p.maxStamina === 50
          ? maxStamina
          : Math.min(p.stamina ?? 0, maxStamina);
    const hpPct = Math.max(0, (hp / maxHp) * 100);
    const mpPct = Math.max(0, (mana / maxMana) * 100);
    const spPct = Math.max(0, (stamina / (maxStamina || 1)) * 100);
    const need = xpNeed(p.level);
    const xpPct = p.level >= 25 ? 100 : Math.max(0, Math.min(100, (p.xp / need) * 100));
    const xpLabel = p.level >= 25 ? `XP ${p.xp}` : `XP ${p.xp}/${need}`;
    const zone = zoneRecord(p.x, p.z);
    const town = townNear(p.x, p.z);
    const pvp = zone?.pvp ? " · PvP area" : "";
    const where = showDebugHud ? ` · ${Math.round(p.x)},${Math.round(p.z)}` : "";
    const zoneLabel =
      town && zone
        ? `${town.name} · ${zone.name} · Lv ${zone.levels[0]}–${zone.levels[1]}${pvp}${where}`
        : town
          ? `${town.name}${pvp}${where}`
          : zone
            ? `${zone.name} · Lv ${zone.levels[0]}–${zone.levels[1]}${pvp}${where}`
            : (islandAt(p.x, p.z)?.name ?? "The Reach");
    statsEl.innerHTML =
      `<b>${p.username}</b> ${p.race} ${p.prestigeClass || p.baseClass} · Lv ${p.level}` +
      `<div class="zone-line">${zoneLabel}</div>` +
      `<div class="online-line">Players online: ${playersOnline}</div>` +
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
        `<div class="sheet-note">${escapeHtml(bindText(p.username))}</div>` +
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
    const bar =
      p.hotbar?.length === 8 ? p.hotbar : defaultHotbar(p.baseClass, p.prestigeClass, p.level);
    root.querySelectorAll<HTMLButtonElement>("#hotbar button").forEach((btn, i) => {
      const id = bar[i] || "";
      const power = id ? powerById(id) : null;
      const name = btn.querySelector(".nm");
      if (name) name.textContent = power ? power.label : "—";
      const until = id ? (p.cooldowns?.[id] ?? 0) : 0;
      const left = Math.max(0, until - Date.now());
      const cd = btn.querySelector<HTMLElement>(".cd");
      if (cd)
        cd.style.height =
          power && left > 0 ? `${Math.min(100, (left / power.cooldown) * 100)}%` : "0%";
    });
    if (seenGold >= 0 && p.gold > seenGold) floatText(`+${p.gold - seenGold} gold`, "#e6c56a", 132);
    seenGold = p.gold;
    paintShop();
    const ready = p.level >= 10 && !p.prestigeClass && !!nearestTrainer(p.x, p.z, 8);
    promoteBtn.hidden = !ready;
    if (ready) promoteBtn.textContent = `Promote to ${PRESTIGE_OF[p.baseClass]}`;
    deathEl.hidden = p.hp > 0;
    const homeTown = p.race === "Marshwarden" ? "Fenhollow" : "Caldrenmoor";
    const bound = bindSpot();
    const respawnWhere = bound ? bound.name : homeTown;
    respawnBtn.textContent = bound ? `Respawn at ${respawnWhere}` : `Respawn in ${homeTown}`;
    if (p.hp <= 0) {
      if (!notedDeath) {
        notedDeath = true;
        lastInput = Date.now();
        dirty = true;
        persist();
      }
      const stone = [...(view().graves ?? [])].reverse().find((g) => g.owner === p.username);
      deathHint.textContent = stone
        ? `A tombstone holds ${stone.gold} gold. A tenth of your XP is already gone. Respawn at ${respawnWhere} under Grave Chill for 60s. Spells stay sealed; melee still works.`
        : `Respawn at ${respawnWhere} under Grave Chill. Spells stay sealed; melee still works.`;
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
    if (guildMode === "desk" && !guildPanel.hidden && !nearestRegistrar(p.x, p.z, 8))
      setOpen(guildPanel, false);
    paintTarget();
    paintGuild();
    paintGuildChat();
    paintGuildToast();
    watchGuildSnap();
    paintPlotPrompt();
    watchBind();
    const plotNow = CITY_PLOTS.map((plot) => `${plot.id}:${guildAtPlot(plot.id)?.tag ?? ""}`).join("|");
    if (plotNow !== plotSig) {
      plotSig = plotNow;
      if (!mapOverlay.hidden) drawWorldMap();
    }
    watchPurse();
    const state = view();
    const lines = [...state.logs, ...notes];
    const graveKey = JSON.stringify(state.graves ?? []);
    if (graveKey !== graveSig) {
      graveSig = graveKey;
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
      const circuitId =
        gate?.circuits.find((id) => CIRCUITS.some((row) => row.id === id)) ?? "hearth";
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
    g.font = "11px Georgia";
    for (const plot of CITY_PLOTS) {
      const pt = to(plot.x, plot.z);
      const owner = guildAtPlot(plot.id);
      g.fillStyle = owner ? "#e2b15a" : "#9fd0ff";
      g.fillRect(pt.x - 4, pt.y - 4, 8, 8);
      g.fillStyle = "#f4fbff";
      g.fillText(owner ? `City plot ([${owner.tag}])` : "City plot (free)", pt.x, pt.y - 8);
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

  function currentTarget() {
    const p = me();
    if (!p || selected?.kind !== "mob") return null;
    const monsters = view().monsters.filter((m) => m.hp > 0);
    const pin = monsters.find((m) => m.id === selected?.id);
    if (!pin) return null;
    if (Math.hypot(pin.x - p.x, pin.z - p.z) < 18) return pin;
    return pin;
  }

  function clearTarget() {
    selected = null;
    pinnedId = null;
    chaseId = null;
    pvpId = null;
  }

  function nearbyHostiles() {
    const p = me();
    if (!p) return [] as Array<{ kind: "mob" | "player"; id: string; d: number }>;
    const rows: Array<{ kind: "mob" | "player"; id: string; d: number }> = [];
    for (const m of view().monsters) {
      if (m.hp <= 0) continue;
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d <= 18) rows.push({ kind: "mob", id: m.id, d });
    }
    const hostilePlayers = pvpOpen(p.x, p.z);
    for (const pl of view().players) {
      if (!hostilePlayers || pl.id === myId || pl.hp <= 0) continue;
      if (!pvpOpen(pl.x, pl.z)) continue;
      const d = Math.hypot(pl.x - p.x, pl.z - p.z);
      if (d <= 18) rows.push({ kind: "player", id: pl.id, d });
    }
    rows.sort((a, b) => a.d - b.d || a.id.localeCompare(b.id));
    return rows;
  }

  function cycleTarget() {
    const rows = nearbyHostiles();
    if (!rows.length) return;
    const at = rows.findIndex((row) => selected && row.kind === selected.kind && row.id === selected.id);
    const next = rows[(at + 1) % rows.length];
    if (next.kind === "mob") {
      selected = { kind: "mob", id: next.id };
      pinnedId = next.id;
      pvpId = null;
      if (chaseId) {
        dest = null;
        path = [];
      }
      chaseId = null;
    } else {
      selected = { kind: "player", id: next.id };
      pinnedId = null;
      chaseId = null;
      pvpId = null;
    }
  }

  function livingMonster(id: string | null) {
    if (!id) return null;
    return view().monsters.find((m) => m.id === id && m.hp > 0) ?? null;
  }

  function standBeside(nx: number, nz: number, px: number, pz: number) {
    let best: { x: number; z: number } | null = null;
    let bestScore = Infinity;
    for (let ring = 1.6; ring <= 3.2; ring += 0.35) {
      for (let i = 0; i < 16; i++) {
        const ang = (i / 16) * Math.PI * 2;
        const x = Math.round(nx + Math.cos(ang) * ring);
        const z = Math.round(nz + Math.sin(ang) * ring);
        if (blocked(x, z) || underHall(x, z)) continue;
        const fromNpc = Math.hypot(x - nx, z - nz);
        if (fromNpc < 1.35 || fromNpc > 3.4) continue;
        const score = Math.hypot(x - px, z - pz) + fromNpc * 0.2;
        if (score < bestScore) {
          bestScore = score;
          best = { x, z };
        }
      }
    }
    return best ?? nearestOpen(nx + 2.2, nz, 6);
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
    const moving =
      keys.has("KeyW") ||
      keys.has("KeyA") ||
      keys.has("KeyS") ||
      keys.has("KeyD") ||
      keys.has("ArrowUp") ||
      keys.has("ArrowDown") ||
      keys.has("ArrowLeft") ||
      keys.has("ArrowRight") ||
      stickActive;
    if (keys.has("Space")) {
      if (selected?.kind === "player") tryEngagePlayer(false);
      else {
        const aimed = currentTarget();
        if (aimed) {
          pinnedId = aimed.id;
          chaseId = aimed.id;
        }
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
        const spot = ranged
          ? rangedStand(chase.x, chase.z, p.x, p.z)
          : adjacentStand(chase.x, chase.z, p.x, p.z);
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
    const foe = chase;
    if (!foe) return;
    const dist = Math.hypot(foe.x - p.x, foe.z - p.z);
    if (ranged && dist <= 8 && p.mana >= 10 && Date.now() >= (p.cooldowns?.fireball ?? 0)) {
      pinnedId = foe.id;
      act("fireball");
      return;
    }
    if (
      dist <= (powerById("attack")?.range ?? 7.6) &&
      Date.now() >= Math.max(p.nextSwing || 0, p.cooldowns?.attack ?? 0)
    ) {
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

  function drawFx(
    name: string,
    frame: number,
    cols: number,
    rows: number,
    x: number,
    z: number,
    size: number,
    lift: number,
  ) {
    const img = fx[name];
    if (!img) return;
    const cw = img.width / cols;
    const ch = img.height / rows;
    const col = frame % cols;
    const row = Math.floor(frame / cols) % rows;
    const p = worldToScreen(x, z);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      img,
      col * cw,
      row * ch,
      cw,
      ch,
      p.x - size / 2,
      p.y - size * 0.72 - lift,
      size,
      size,
    );
    ctx.restore();
  }

  function integrate(dt: number) {
    const p = localPlayer();
    if (!p || p.hp <= 0 || !mapOverlay.hidden) {
      lastSpeed = 0;
      wishX = 0;
      wishZ = 0;
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
      const v = walkVelocity(ix, iz);
      vx = v.x;
      vz = v.z;
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
          send({ op: "loot", id: myId, graveId });
        }
      }
      if (dest) {
        let aim = dest;
        if (clearLine(p.x, p.z, dest.x, dest.z)) {
          path = [];
        } else if (path.length) {
          while (path.length > 1) {
            const wx = path[0].x - p.x;
            const wz = path[0].z - p.z;
            const tx = dest.x - p.x;
            const tz = dest.z - p.z;
            if (wx * tx + wz * tz >= 0) break;
            path.shift();
          }
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
        if (
          Math.hypot(aim.x - dest.x, aim.z - dest.z) >
          Math.hypot(p.x - dest.x, p.z - dest.z) + 1.25
        ) {
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
          const v = walkVelocity(dx, dz);
          vx = v.x;
          vz = v.z;
        }
      }
    }
    wishX = vx;
    wishZ = vz;
    const next = resolveMove(p.x, p.z, p.x + vx * dt, p.z + vz * dt);
    const nx = next.x;
    const nz = next.z;
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
      if (haveAuth && Math.hypot(p.x - authX, p.z - authZ) > 0.2) pushMove();
      return;
    }
    stuckFor = 0;
    repaths = 0;
    lastSpeed = stuck ? 0 : Math.hypot(vx, vz);
    if (stuck) {
      if (haveAuth && Math.hypot(p.x - authX, p.z - authZ) > 0.2) pushMove();
      return;
    }
    if (nx !== p.x || nz !== p.z) dirty = true;
    p.x = nx;
    p.z = nz;
    p.rotation = Math.atan2(vx, vz);
    pushMove();
  }

  function frame(now: number) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    if (linkGate?.hidden !== false) integrate(dt);
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
    // Baked chunks. Picking still uses the diamond in iso.ts, not this image.
    ground.draw(ctx, { camX: cam.x, camZ: cam.z, viewW, viewH, minX, maxX, minZ, maxZ });
    const state = view();
    for (const m of state.monsters) puffDamage(m.id, m.x, m.z, m.hp, "#ffe08a");
    for (const pl of state.players) puffDamage(pl.id, pl.x, pl.z, pl.hp, "#ff6b5a");
    const drawables: Array<{ key: number; draw: () => void }> = [];
    for (const hall of HALLS) {
      drawables.push({
        key: depthOf(hall.x, hall.z),
        draw: () => {
          shadowAt(hall.x, hall.z, 16);
          drawSprite("hall", hall.x, hall.z, hall.scale);
        },
      });
    }
    for (const npc of NPCS) {
      drawables.push({
        key: depthOf(npc.x, npc.z),
        draw: () => {
          const p = worldToScreen(npc.x, npc.z);
          ctx.save();
          ctx.translate(p.x, p.y + 4);
          ctx.scale(1, 0.42);
          const vendor = npc.role === "vendor" || npc.role === "smith";
          const trainer = npc.role === "trainer";
          const registrar = npc.role === "registrar";
          ctx.beginPath();
          ctx.arc(0, 0, vendor || trainer || registrar ? 40 : 22, 0, Math.PI * 2);
          ctx.strokeStyle = vendor
            ? "#39ff6a"
            : trainer
              ? "#7ecbff"
              : registrar
                ? "#e2b15a"
                : "rgba(240, 210, 120, .9)";
          ctx.lineWidth = vendor || trainer || registrar ? 8 : 3;
          ctx.stroke();
          if (vendor || trainer || registrar) {
            ctx.beginPath();
            ctx.arc(0, 0, 28, 0, Math.PI * 2);
            ctx.strokeStyle = trainer ? "#f4fbff" : registrar ? "#fff6d0" : "#f4fff6";
            ctx.lineWidth = 3;
            ctx.stroke();
          }
          ctx.restore();
          shadowAt(npc.x, npc.z, 12);
          const held =
            npc.name === "Marta" ? { weapon: "dagger", offhand: "round-shield" } : undefined;
          drawHero(npc.race, npc.id, npc.x, npc.z, undefined, held);
          if (selected?.kind === "npc" && selected.id === npc.id) markTarget(npc.x, npc.z);
          const tag = npc.role === "smith"
            ? "SMITH"
            : vendor
              ? "VENDOR"
              : trainer
                ? "TRAINER"
                : registrar
                  ? "REGISTRAR"
                  : "WAYFARER";
          const tagColor = vendor
            ? "#39ff6a"
            : trainer
              ? "#7ecbff"
              : registrar
                ? "#e2b15a"
                : "#f0e2b0";
          ctx.fillStyle = "rgba(8,10,8,.82)";
          ctx.fillRect(p.x - 62, p.y - 148, 124, 34);
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
        key: depthOf(x, z),
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
        key: depthOf(x, z),
      });
    }
    for (const plot of CITY_PLOTS) {
      drawables.push({
        key: depthOf(plot.x, plot.z) - 0.15,
        draw: () => drawCityPlot(plot),
      });
    }
    const aimedId = selected?.kind === "mob" ? selected.id : null;
    const myLevel = me()?.level ?? 1;
    for (const m of state.monsters) {
      if (m.hp <= 0) continue;
      drawables.push({
        key: depthOf(m.x, m.z),
        draw: () => {
          shadowAt(m.x, m.z, 14);
          if (!drawSprite(m.type.toLowerCase(), m.x, m.z, mobByType(m.type).scale || 0.18))
            drawFallback(m.type, m.x, m.z);
          if (aimedId === m.id) markTarget(m.x, m.z);
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
          ctx.fillStyle = conFor(m.level, myLevel).color;
          ctx.fillText(mobLabel(m.type), pt.x, barY - 16);
          ctx.font = "12px Georgia";
          ctx.fillStyle = "#fff6d8";
          ctx.fillText(`HP ${Math.ceil(m.hp)}/${m.maxHp}`, pt.x, barY - 3);
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
          key: depthOf(x, z) + 0.2,
          draw: () => drawFx("fireball", Math.floor(nowDraw / 70) % 4, 2, 2, x, z, 72, 28),
        });
      } else {
        const frame = Math.min(3, Math.floor((age - 380) / 80));
        drawables.push({
          key: depthOf(b.x1, b.z1) + 0.3,
          draw: () => drawFx("impact", frame, 2, 2, b.x1, b.z1, 96, 16),
        });
      }
    }
    const heroes = state.players.filter((pl) => pl.hp > 0);
    for (const pl of heroes) {
      drawables.push({
        key: depthOf(pl.x, pl.z),
        draw: () => {
          const race = (pl.race || "human").toLowerCase();
          shadowAt(pl.x, pl.z, 14);
          drawHero(race, pl.id, pl.x, pl.z, pl.prestigeClass || pl.baseClass);
          const pt = worldToScreen(pl.x, pl.z);
          ctx.fillStyle = "#e6c56a";
          ctx.font = "12px Georgia";
          ctx.textAlign = "center";
          const lift = nameLift(race);
          drawOverhead(
            pt.x,
            pt.y,
            pl.username,
            pl.prestigeClass || pl.baseClass,
            lift,
            pl.id === myId ? "#f0e2b0" : "#ddd",
            pl.guildTag ?? "",
          );
          if (selected?.kind === "player" && selected.id === pl.id) markTarget(pl.x, pl.z);
        },
      });
    }
    drawables.sort((a, b) => a.key - b.key);
    for (const d of drawables) d.draw();
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
    const g = ctx.createRadialGradient(
      viewW / 2,
      viewH / 2,
      viewH * 0.3,
      viewW / 2,
      viewH / 2,
      viewH * 0.72,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(6,10,8,.55)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, viewW, viewH);
    hud();
    if (!mapOverlay.hidden) drawWorldMap();
  }

  let dirty = false;
  let notedDeath = false;
  let purse = "";

  function purseSig(p: NonNullable<ReturnType<typeof localPlayer>>) {
    return [
      p.gold,
      p.xp,
      p.level,
      p.trainPoints ?? 0,
      JSON.stringify(p.inventory ?? {}),
      JSON.stringify(p.equipment ?? {}),
      JSON.stringify(p.skills ?? {}),
    ].join("|");
  }

  function touchInput() {
    lastInput = Date.now();
    dirty = true;
  }

  function commitPurse() {
    touchInput();
    persist();
    const p = localPlayer();
    if (p) purse = purseSig(p);
  }

  function watchPurse() {
    const p = localPlayer();
    if (!p) return;
    const next = purseSig(p);
    if (purse === "" || next === purse) {
      purse = next;
      return;
    }
    commitPurse();
  }

  function persist() {}

  function myName() {
    return me()?.username ?? profile.username;
  }

  function inMyParty(id: string) {
    return !!view().party?.members.some((member) => member.id === id);
  }

  function otherPlayers() {
    return view().players.filter((pl) => pl.id !== myId && pl.hp > 0);
  }

  function groupRoster() {
    const party = view().party;
    if (!party) return [];
    const players = view().players;
    return party.members.map((member) => {
      const pl = players.find((row) => row.id === member.id) ?? (member.id === myId ? me() : undefined);
      return {
        id: member.id,
        name: member.name,
        level: pl?.level ?? 1,
        hp: member.hp,
        maxHp: Math.max(1, member.maxHp),
      };
    });
  }

  function paintGroup() {
    const invite = view().pendingInvite;
    if (inviteToast && inviteText) {
      if (!invite) inviteToast.hidden = true;
      else {
        inviteText.textContent = `${invite.fromName} invites you.`;
        inviteToast.hidden = false;
      }
    }
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

  function findPlayer(name: string) {
    const want = name.trim().toLowerCase();
    if (!want) return null;
    return otherPlayers().find((pl) => pl.username.toLowerCase() === want) ?? null;
  }

  function inviteNamed(name: string) {
    const pl = findPlayer(name);
    if (!pl) {
      note("No one nearby by that name.");
      return;
    }
    if (inMyParty(pl.id)) {
      note(`${pl.username} is already in the group.`);
      return;
    }
    send({ op: "partyInvite", toName: pl.username });
  }

  function acceptInvite() {
    const invite = view().pendingInvite;
    if (!invite) return;
    send({ op: "partyAccept", fromId: invite.fromId });
  }

  function declineInvite() {
    const invite = view().pendingInvite;
    if (!invite) return;
    send({ op: "partyDecline", fromId: invite.fromId });
  }

  function leaveGroup() {
    if (!view().party) return;
    send({ op: "partyLeave" });
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
    if (!pvpOpen(p.x, p.z) || !pvpOpen(peer.x, peer.z)) {
      pvpId = null;
      note("This is a haven. No fighting here.");
      return "haven";
    }
    if (inMyParty(peer.id)) {
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
    pvpId = peer.id;
    p.stamina = Math.max(0, p.stamina - cost);
    const cd = now + (power?.cooldown ?? 2400);
    p.nextSwing = cd;
    if (!p.cooldowns) p.cooldowns = {};
    p.cooldowns.attack = cd;
    const actor = actors.get(myId);
    if (actor) {
      const rig = asRig((p.race || "").toLowerCase());
      const swing = rig && twoHanded(p.equipment?.weapon ?? "") ? "atk2h" : "atk1h";
      actor.attackUntil = performance.now() + (rig ? rigMs(rig, swing) : SWING_MS);
    }
    if (Math.random() * 100 >= hitChance(p)) {
      floatAt(peer.x, peer.z, "Miss", "#f0e2b0", 96);
      return "miss";
    }
    const dmg = Math.max(1, trainedDamage(p));
    floatAt(peer.x, peer.z, `-${dmg}`, "#ffb4a8", 110);
    return "hit";
  }

  function nearestPeer() {
    const p = me();
    if (!p) return null;
    let best: GroupPeer | null = null;
    let bestD = 40;
    for (const pl of otherPlayers()) {
      const d = Math.hypot(pl.x - p.x, pl.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = asPeer(pl);
      }
    }
    return best;
  }

  function asPeer(pl: { id: string; username?: string; name?: string; level: number; hp: number; maxHp: number; x: number; z: number; race?: string }): GroupPeer {
    return {
      id: pl.id,
      name: pl.username || pl.name || "Hero",
      level: pl.level,
      hp: pl.hp,
      maxHp: pl.maxHp,
      x: pl.x,
      z: pl.z,
      race: pl.race || "human",
    };
  }

  function tryEngagePlayer(announce: boolean) {
    const p = localPlayer();
    if (!p || selected?.kind !== "player") return;
    const pl = view().players.find((row) => row.id === selected?.id && row.hp > 0);
    if (!pl) return;
    const peer = asPeer(pl);
    const haven = !pvpOpen(p.x, p.z) || !pvpOpen(peer.x, peer.z);
    const grouped = inMyParty(peer.id);
    if (haven || grouped) {
      pvpId = null;
      if (announce) {
        if (grouped && !haven) note("You cannot strike a group member.");
        else note("This is a haven. No fighting here.");
      }
      return;
    }
    pvpId = peer.id;
    pressPvp();
  }

  function pressPvp() {
    const p = localPlayer();
    if (!p || p.hp <= 0) {
      pvpId = null;
      return;
    }
    const pl = view().players.find((row) => row.id === pvpId && row.hp > 0);
    if (!pl) {
      pvpId = null;
      return;
    }
    const peer = asPeer(pl);
    if (!pvpOpen(p.x, p.z) || !pvpOpen(peer.x, peer.z) || inMyParty(peer.id)) {
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

  function playerAt(sx: number, sy: number) {
    let best: PublicState["players"][number] | null = null;
    let bestD = 1e9;
    for (const pl of view().players) {
      if (pl.id === myId || pl.hp <= 0) continue;
      if (!spriteHit(sx, sy, pl.x, pl.z, 150)) continue;
      const sp = worldToScreen(pl.x, pl.z);
      const d = Math.hypot(sx - sp.x, sy - sp.y);
      if (d < bestD) {
        bestD = d;
        best = pl;
      }
    }
    return best;
  }

  function peerAt(sx: number, sy: number) {
    let best: GroupPeer | null = null;
    let bestD = 48;
    for (const pl of otherPlayers()) {
      const sp = worldToScreen(pl.x, pl.z);
      const above = sp.y - sy;
      if (Math.abs(sx - sp.x) > 36 || above < -6 || above > 130) continue;
      const d = Math.hypot(sx - sp.x, sy - sp.y);
      if (d < bestD) {
        bestD = d;
        best = asPeer(pl);
      }
    }
    return best;
  }

  function showCtx(clientX: number, clientY: number, peer: GroupPeer | null) {
    if (!ctxMenu) return;
    const items: Array<{ act: string; label: string; name: string }> = [];
    if (peer && !inMyParty(peer.id))
      items.push({ act: "invite", label: `Invite ${peer.name}`, name: peer.name });
    if (view().party) items.push({ act: "leave", label: "Leave group", name: "" });
    if (!items.length) {
      ctxMenu.hidden = true;
      return;
    }
    const rect = root.getBoundingClientRect();
    ctxMenu.style.left = `${Math.round(clientX - rect.left)}px`;
    ctxMenu.style.top = `${Math.round(clientY - rect.top)}px`;
    ctxMenu.innerHTML = items
      .map(
        (item) =>
          `<button type="button" data-act="${item.act}" data-name="${escapeHtml(item.name)}">${escapeHtml(item.label)}</button>`,
      )
      .join("");
    ctxMenu.hidden = false;
  }

  function onContextMenu(e: MouseEvent) {
    if (!(e.target instanceof Node) || !root.contains(e.target)) return;
    e.preventDefault();
    if (!mapOverlay.hidden) return;
    const hit = readClick(e);
    const mob = mobAt(hit.sx, hit.sy, { x: hit.x, z: hit.z });
    if (mob) {
      if (ctxMenu) ctxMenu.hidden = true;
      engageMob(mob);
      return;
    }
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

  function drawOverhead(
    x: number,
    y: number,
    name: string,
    sub: string,
    lift: number,
    nameColor: string,
    tag = "",
  ) {
    ctx.textAlign = "center";
    if (tag) {
      ctx.font = "bold 12px Georgia";
      ctx.fillStyle = "#e2b15a";
      ctx.fillText(`[${tag}]`, x, y - lift - 16);
    }
    if (sub) {
      ctx.font = "12px Georgia";
      ctx.fillStyle = "#e6c56a";
      ctx.fillText(sub, x, y - lift);
    }
    ctx.font = "13px Georgia";
    ctx.fillStyle = nameColor;
    ctx.fillText(name, x, y - (sub ? lift - 16 : lift));
  }

  function nameLift(race: string) {
    if (race === "minotaur") return 188;
    if (race === "elf") return 160;
    if (race === "marshwarden") return 158;
    if (race === "human") return 145;
    return 136;
  }

  function plateName(name: string, tag = "") {
    return tag ? `[${tag}] ${name}` : name;
  }

  function paintTarget() {
    if (!targetFrame) return;
    const self = me();
    const hide = () => {
      if (!targetFrame.hidden) {
        targetFrame.hidden = true;
        targetFrame.innerHTML = "";
      }
    };
    if (!self || !selected) {
      hide();
      return;
    }
    let name = "";
    let sub = "";
    let hp = 0;
    let maxHp = 0;
    let mana: number | null = null;
    let maxMana = 0;
    let plateTag = "";
    if (selected.kind === "mob") {
      const mob = view().monsters.find((m) => m.id === selected?.id && m.hp > 0);
      if (!mob) {
        clearTarget();
        hide();
        return;
      }
      name = mobLabel(mob.type);
      sub = `Lv ${mob.level} · ${mob.type}`;
      hp = mob.hp;
      maxHp = mob.maxHp;
    } else if (selected.kind === "player") {
      const pl = view().players.find((row) => row.id === selected?.id && row.hp > 0);
      if (!pl) {
        clearTarget();
        hide();
        return;
      }
      name = pl.username;
      plateTag = pl.guildTag ?? "";
      sub = `Lv ${pl.level} · ${pl.race} ${pl.prestigeClass || pl.baseClass}`;
      hp = pl.hp;
      maxHp = pl.maxHp;
      mana = pl.mana;
      maxMana = pl.maxMana;
    } else {
      const npc = NPCS.find((row) => row.id === selected?.id);
      if (!npc) {
        clearTarget();
        hide();
        return;
      }
      const role =
        npc.role === "smith"
          ? "Smith"
          : npc.role === "vendor"
            ? "Vendor"
            : npc.role === "trainer"
              ? "Trainer"
              : npc.role === "registrar"
                ? "Registrar"
                : "Wayfarer";
      name = npc.name;
      sub = role;
    }
    const bars =
      maxHp > 0
        ? `<div class="bar hp"><i style="width:${Math.max(0, Math.min(100, (hp / maxHp) * 100))}%"></i><span>HP ${Math.ceil(hp)}/${Math.ceil(maxHp)}</span></div>` +
          (mana != null
            ? `<div class="bar mp"><i style="width:${Math.max(0, Math.min(100, (mana / Math.max(1, maxMana)) * 100))}%"></i><span>MP ${Math.ceil(mana)}/${Math.ceil(maxMana)}</span></div>`
            : "")
        : "";
    const html =
      `<button type="button" id="targetClear" class="target-x" aria-label="Clear target">×</button>` +
      `<b>${escapeHtml(plateName(name, plateTag))}</b>` +
      `<div class="target-sub">${escapeHtml(sub)}</div>` +
      bars;
    targetFrame.hidden = false;
    if (targetFrame.innerHTML !== html) targetFrame.innerHTML = html;
  }

  function myGuild() {
    return view().guild ?? null;
  }

  function myCharter() {
    return view().charter === true;
  }

  function paintGuild() {
    if (guildPanel.hidden) return;
    const p = me();
    if (!p) return;
    const guild = myGuild();
    const charter = myCharter();
    const sig = `${guildMode}|${charter ? 1 : 0}|${p.gold}|${pickedKind}|${pickedCrest}|${guild ? JSON.stringify(guild) : ""}`;
    if (sig === guildSig) return;
    guildSig = sig;
    if (guildTitle) guildTitle.textContent = guildMode === "desk" ? "Registrar" : "Guild";
    if (guild) {
      guildBody.innerHTML = rosterHtml(guild);
      return;
    }
    if (guildMode === "roster") {
      const line = charter
        ? `<p>Your charter is unspent. Speak to a Registrar in Caldrenmoor or Fenhollow.</p>`
        : `<p>A charter costs ${CHARTER_GOLD} gold. Speak to the Registrar in Caldrenmoor or Fenhollow.</p>`;
      guildBody.innerHTML = `<p>You belong to no guild.</p>${line}`;
      return;
    }
    if (!charter) {
      guildBody.innerHTML =
        `<p class="guild-warn">A charter costs ${CHARTER_GOLD} gold. You have ${p.gold}.</p>` +
        `<button type="button" data-act="charter">Buy charter — ${CHARTER_GOLD}g</button>`;
      return;
    }
    const kinds = GUILD_KINDS.map(
      (kind) =>
        `<button type="button" data-act="kind" data-kind="${kind}" class="${kind === pickedKind ? "on" : ""}">${kind}</button>`,
    ).join("");
    const crests = CRESTS.map(
      (crest) =>
        `<button type="button" data-act="crest" data-crest="${crest.id}" class="${crest.id === pickedCrest ? "on" : ""}"><i class="crest crest-${crest.id}"></i>${crest.label}</button>`,
    ).join("");
    guildBody.innerHTML =
      `<p>Your charter is sealed. Name the guild.</p>` +
      `<label>Name<input data-field="name" maxlength="24" autocomplete="off" value="${escapeHtml(draftName)}" /></label>` +
      `<label>Tag<input data-field="tag" maxlength="4" autocomplete="off" value="${escapeHtml(draftTag)}" /></label>` +
      `<div class="guild-picks">${kinds}</div>` +
      `<div class="guild-picks">${crests}</div>` +
      `<button type="button" data-act="found">Found guild</button>`;
  }

  function openRegistrar() {
    guildMode = "desk";
    guildSig = "";
    setOpen(guildPanel, true);
    paintGuild();
  }

  function openRoster() {
    guildMode = "roster";
    guildSig = "";
    setOpen(guildPanel, true);
    paintGuild();
  }

  function captureDraft() {
    const name = guildBody.querySelector<HTMLInputElement>("[data-field=name]");
    const tag = guildBody.querySelector<HTMLInputElement>("[data-field=tag]");
    if (name) draftName = name.value;
    if (tag) draftTag = tag.value;
  }

  function buyCharter() {
    send({ op: "buyCharter" });
    guildSig = "";
  }

  function foundFromDesk() {
    captureDraft();
    send({
      op: "foundGuild",
      name: draftName,
      tag: draftTag,
      kind: pickedKind,
      crest: pickedCrest,
    });
    guildSig = "";
  }

  let seenGuild = "";
  let seenRank = "";
  let guildChatSig = "";
  let plotSig = "";
  let seenBind = "";

  function rosterHtml(guild: NonNullable<ReturnType<typeof myGuild>>) {
    const mine = myName().toLowerCase();
    const rows = (guild.members ?? [])
      .map((member) => {
        const buttons: string[] = [];
        const self = member.name.toLowerCase() === mine;
        if (!self && guild.rank === "Leader" && member.rank === "Member") {
          buttons.push(`<button type="button" data-act="promote" data-who="${escapeHtml(member.name)}">Promote</button>`);
        }
        if (!self && guild.rank === "Leader" && member.rank === "Officer") {
          buttons.push(`<button type="button" data-act="demote" data-who="${escapeHtml(member.name)}">Demote</button>`);
        }
        if (!self && member.rank !== "Leader") {
          if (guild.rank === "Leader" || (guild.rank === "Officer" && member.rank === "Member")) {
            buttons.push(`<button type="button" data-act="kick" data-who="${escapeHtml(member.name)}">Kick</button>`);
          }
        }
        return (
          `<li><b>${escapeHtml(member.name)}</b> · ${escapeHtml(member.rank)} · ${member.online ? "online" : "offline"}` +
          buttons.join("") +
          `</li>`
        );
      })
      .join("");
    return (
      `<p><i class="crest crest-${guild.crest}"></i><b>${escapeHtml(guild.name)}</b></p>` +
      `<p>[${escapeHtml(guild.tag)}] · ${escapeHtml(guild.kind)}</p>` +
      `<p>You are ${escapeHtml(guild.rank)}.</p>` +
      `<ul class="guild-roster">${rows}</ul>` +
      `<button type="button" data-act="leave">Leave guild</button>`
    );
  }

  function paintGuildToast() {
    const invite = view().pendingGuildInvite ?? null;
    if (!guildToast) return;
    if (!invite) {
      guildToast.hidden = true;
      return;
    }
    if (guildToastText) {
      guildToastText.textContent = `${invite.fromName} invites you to [${invite.tag}] ${invite.guildName}.`;
    }
    guildToast.hidden = false;
  }

  let guildNoted = false;

  function watchGuildSnap() {
    if (snaps.length === 0) return;
    const guild = view().guild ?? null;
    const afterId = guild?.id ?? "";
    const afterRank = guild?.rank ?? "";
    if (!guildNoted) {
      guildNoted = true;
      seenGuild = afterId;
      seenRank = afterRank;
      return;
    }
    if (seenGuild && !afterId) note("You were removed from the guild. Your tag is cleared.");
    else if (seenRank && afterRank && seenRank !== afterRank) note(`You are now ${afterRank}.`);
    seenGuild = afterId;
    seenRank = afterRank;
  }

  function paintGuildChat() {
    if (!guildBox) return;
    const guild = view().guild ?? null;
    if (!guild) {
      if (guildChatSig !== "none") {
        guildBox.innerHTML = `<div>You are not in a guild.</div>`;
        guildChatSig = "none";
      }
      return;
    }
    const lines = guild.chat ?? [];
    const sig = lines.map((line) => `${line.at}|${line.from}|${line.text}`).join("\n");
    if (sig === guildChatSig) return;
    guildChatSig = sig;
    guildBox.innerHTML = lines.length
      ? lines
          .map(
            (line) =>
              `<div>[${escapeHtml(guild.tag)}] ${escapeHtml(line.from)}: ${escapeHtml(line.text)}</div>`,
          )
          .join("")
      : `<div>Guild chat is quiet. /g message</div>`;
    guildBox.scrollTop = guildBox.scrollHeight;
  }

  function sayGuild(text: string) {
    if (!view().guild) {
      note("You are not in a guild.");
      return;
    }
    send({ op: "chat", id: myId, msg: text, channel: "guild" });
    showChatTab("guild");
    chat.classList.add("open");
  }

  function rankMember(act: "promote" | "demote" | "kick", who: string) {
    if (act === "promote") send({ op: "guildPromote", userName: who });
    else if (act === "demote") send({ op: "guildDemote", userName: who });
    else send({ op: "guildKick", userName: who });
    guildSig = "";
  }

  function inviteGuild(raw: string) {
    const pl = findPlayer(raw);
    if (!pl) {
      note("No one nearby by that name.");
      return;
    }
    send({ op: "guildInvite", toName: pl.username });
  }

  function acceptGuild() {
    const invite = view().pendingGuildInvite;
    if (!invite) return;
    send({ op: "guildAccept", guildId: invite.guildId });
    guildSig = "";
  }

  function declineGuild() {
    const invite = view().pendingGuildInvite;
    if (!invite) return;
    send({ op: "guildDecline", guildId: invite.guildId });
  }

  function leaveGuild() {
    if (!view().guild) return;
    send({ op: "guildLeave" });
    guildSig = "";
  }

  function onGuildStorage(e: StorageEvent) {
    if (e.key && e.key !== GUILD_KEY) return;
    invalidateGuilds();
  }

  function onGuildClick(e: Event) {
    if (blockPanelClicks) return;
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn || !guildBody.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    pendingMove = null;
    consumeClick = true;
    captureDraft();
    const act = btn.dataset.act;
    if (act === "charter") buyCharter();
    else if (act === "leave") leaveGuild();
    else if (act === "promote" || act === "demote" || act === "kick") {
      const who = btn.dataset.who || "";
      if (who) rankMember(act, who);
    } else if (
      act === "kind" &&
      btn.dataset.kind &&
      GUILD_KINDS.includes(btn.dataset.kind as GuildKind)
    ) {
      pickedKind = btn.dataset.kind as GuildKind;
      guildSig = "";
    } else if (
      act === "crest" &&
      btn.dataset.crest &&
      CRESTS.some((crest) => crest.id === btn.dataset.crest)
    ) {
      pickedCrest = btn.dataset.crest as CrestId;
      guildSig = "";
    } else if (act === "found") foundFromDesk();
    paintGuild();
  }

  function onGuildClose(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    pendingMove = null;
    consumeClick = true;
    setOpen(guildPanel, false);
  }

  function onGuildButton(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    pendingMove = null;
    consumeClick = true;
    if (!guildPanel.hidden && guildMode === "roster") setOpen(guildPanel, false);
    else openRoster();
  }

  function homeBindName(race?: string) {
    return race === "Marshwarden" ? "Fenhollow" : "Caldrenmoor";
  }

  function bindText(username: string) {
    const guild = guildOf(username);
    if (guild?.cornerstone) return `Bound to [${guild.tag}] Cornerstone`;
    const race = me()?.username === username ? me()?.race : profile.race;
    return `Bound to ${homeBindName(race)}`;
  }

  function bindSpot() {
    const guild = guildOf(myName());
    const stone = guild?.cornerstone;
    if (!guild || !stone) return undefined;
    return { x: stone.x, z: stone.z, name: `[${guild.tag}] Cornerstone` };
  }

  function watchBind() {
    const text = bindText(myName());
    if (bindLine) bindLine.textContent = text;
    if (text === seenBind) return;
    const first = seenBind === "";
    seenBind = text;
    if (first && !text.includes("Cornerstone")) return;
    note(text);
  }

  function plotUnder(x: number, z: number, range = 3.2) {
    let best: (typeof CITY_PLOTS)[number] | null = null;
    let bestD = range;
    for (const plot of CITY_PLOTS) {
      const d = Math.hypot(plot.x - x, plot.z - z);
      if (d < bestD) {
        best = plot;
        bestD = d;
      }
    }
    return best;
  }

  function plotAtScreen(sx: number, sy: number) {
    let best: (typeof CITY_PLOTS)[number] | null = null;
    let bestD = 1e9;
    for (const plot of CITY_PLOTS) {
      const sp = worldToScreen(plot.x, plot.z);
      const dx = Math.abs(sx - sp.x);
      const above = sp.y - sy;
      const near = Math.hypot(sx - sp.x, sy - sp.y);
      const onMark = dx <= 78 && above >= -18 && above <= 108;
      if (near > 54 && !onMark) continue;
      const d = onMark ? Math.min(near, 20) : near;
      if (d < bestD) {
        best = plot;
        bestD = d;
      }
    }
    return best;
  }

  function drawCityPlot(plot: (typeof CITY_PLOTS)[number]) {
    const owner = guildAtPlot(plot.id);
    const p = worldToScreen(plot.x, plot.z);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.textAlign = "center";
    if (!owner) {
      ctx.strokeStyle = "#9fd0ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 0, 22, 11, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(8,10,8,.75)";
      ctx.fillRect(-46, -36, 92, 16);
      ctx.font = "12px Georgia";
      ctx.fillStyle = "#f4fbff";
      ctx.fillText("City plot", 0, -24);
    } else {
      ctx.fillStyle = "#5c4e34";
      ctx.fillRect(-10, -48, 20, 48);
      ctx.fillStyle = "#c4b08a";
      ctx.fillRect(-16, -56, 32, 12);
      ctx.fillStyle = "#e2b15a";
      ctx.beginPath();
      ctx.moveTo(0, -78);
      ctx.lineTo(8, -58);
      ctx.lineTo(-8, -58);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(8,10,8,.82)";
      ctx.fillRect(-78, -98, 156, 18);
      ctx.font = "12px Georgia";
      ctx.fillStyle = "#f4fbff";
      ctx.fillText(`[${owner.tag}] Cornerstone`, 0, -85);
    }
    ctx.restore();
  }

  function paintPlotPrompt() {
    if (!plotPrompt || !plotPromptText || !plotPromptBtn) return;
    const p = me();
    const plot = p && p.hp > 0 ? plotUnder(p.x, p.z) : null;
    if (!p || !plot) {
      plotPrompt.hidden = true;
      return;
    }
    plotPrompt.hidden = false;
    const owner = guildAtPlot(plot.id);
    const mine = guildOf(p.username);
    const leader = memberRank(p.username) === "Leader";
    if (!owner) {
      plotPromptText.textContent = `${plot.zone} city plot. Free.`;
      plotPromptBtn.hidden = false;
      plotPromptBtn.textContent = `Plant Cornerstone — ${CORNERSTONE_GOLD}g`;
      plotPromptBtn.dataset.act = "plant";
      plotPromptBtn.dataset.plot = plot.id;
      return;
    }
    if (mine && owner.id === mine.id && leader) {
      plotPromptText.textContent = `[${owner.tag}] Cornerstone.`;
      plotPromptBtn.hidden = false;
      plotPromptBtn.textContent = "Remove Cornerstone";
      plotPromptBtn.dataset.act = "remove";
      delete plotPromptBtn.dataset.plot;
      return;
    }
    plotPromptBtn.hidden = true;
    plotPromptText.textContent =
      mine && owner.id === mine.id
        ? `[${owner.tag}] Cornerstone.`
        : `City plot taken by [${owner.tag}].`;
  }

  function tryPlant(plotId: string) {
    const p = localPlayer();
    if (!p || p.hp <= 0) return;
    const plot = CITY_PLOTS.find((row) => row.id === plotId);
    if (!plot) {
      note("There is no city plot there.");
      return;
    }
    if (Math.hypot(plot.x - p.x, plot.z - p.z) > 3.2) {
      note("Stand on the city plot.");
      return;
    }
    const guild = guildOf(p.username);
    if (!guild) {
      note("You are not in a guild.");
      return;
    }
    if (memberRank(p.username) !== "Leader") {
      note("Only the Leader can plant a Cornerstone.");
      return;
    }
    if (guild.cornerstone) {
      note("Your guild already has a Cornerstone.");
      return;
    }
    const taken = guildAtPlot(plot.id);
    if (taken) {
      note(`That plot is taken by [${taken.tag}].`);
      return;
    }
    if (p.gold < CORNERSTONE_GOLD) {
      note(`Not enough gold. A Cornerstone costs ${CORNERSTONE_GOLD} gold.`);
      return;
    }
    p.gold -= CORNERSTONE_GOLD;
    const result = plantCornerstone(p.username, plot.id);
    if (!result.ok) {
      p.gold += CORNERSTONE_GOLD;
      note(result.reason);
      return;
    }
    commitPurse();
    note(`[${result.guild.tag}] plants a Cornerstone on the ${plot.zone} plot.`);
    guildSig = "";
  }

  function tryRemove() {
    const result = removeCornerstone(myName());
    if (!result.ok) {
      note(result.reason);
      return;
    }
    note("The Cornerstone is gone. The plot is free. No gold is returned.");
    guildSig = "";
  }

  function onPlotPrompt(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    pendingMove = null;
    consumeClick = true;
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.dataset.act === "remove") tryRemove();
    else if (btn.dataset.plot) tryPlant(btn.dataset.plot);
  }

  function handleSlash(text: string) {
    const body = text.slice(1).trim();
    const gap = body.indexOf(" ");
    const cmd = (gap < 0 ? body : body.slice(0, gap)).toLowerCase();
    const arg = gap < 0 ? "" : body.slice(gap + 1).trim();
    if (cmd === "invite" && arg) inviteNamed(arg);
    else if (cmd === "leave") leaveGroup();
    else if (cmd === "accept") acceptInvite();
    else if (cmd === "ginvite" && arg) inviteGuild(arg);
    else if (cmd === "gleave") leaveGuild();
    else if (cmd === "gaccept") acceptGuild();
    else if (cmd === "gdecline") declineGuild();
    else if (cmd === "g" || cmd === "gsay") {
      if (!arg) note("Usage: /g message");
      else sayGuild(arg);
    } else if (cmd === "gpromote" && arg) rankMember("promote", arg);
    else if (cmd === "gdemote" && arg) rankMember("demote", arg);
    else if (cmd === "gkick" && arg) rankMember("kick", arg);
    else if (cmd === "cornerstone") {
      const p = me();
      const plot = p ? plotUnder(p.x, p.z) : null;
      if (!plot) note("Stand on a free city plot.");
      else tryPlant(plot.id);
    } else note("Unknown command.");
  }

  function moveCode(e: KeyboardEvent): string | null {
    const known = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"];
    if (known.includes(e.code)) return e.code;
    const map: Record<string, string> = {
      w: "KeyW",
      a: "KeyA",
      s: "KeyS",
      d: "KeyD",
      arrowup: "ArrowUp",
      arrowdown: "ArrowDown",
      arrowleft: "ArrowLeft",
      arrowright: "ArrowRight",
    };
    if (e.key === " ") return "Space";
    return map[e.key.toLowerCase()] ?? null;
  }

  function onKeyDown(e: KeyboardEvent) {
    touchInput();
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === "Escape") {
      if (typing) {
        (e.target as HTMLElement).blur();
        canvas.focus({ preventScroll: true });
        e.preventDefault();
        return;
      }
      if (closeTopPanel()) {
        e.preventDefault();
        return;
      }
      if (selected) {
        clearTarget();
        e.preventDefault();
        return;
      }
    }
    if (typing) return;
    if (e.key === "Tab" || e.code === "Tab") {
      e.preventDefault();
      cycleTarget();
      return;
    }
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
    if (!e.repeat && (e.code === "KeyG" || e.key === "g" || e.key === "G")) {
      e.preventDefault();
      if (!guildPanel.hidden && guildMode === "roster") setOpen(guildPanel, false);
      else openRoster();
      return;
    }
    if (e.code === "KeyI" || e.key === "i" || e.key === "I") {
      e.preventDefault();
      const open = bag.hidden;
      setOpen(bag, open);
      if (open) {
        bagSig = "";
        paintBag();
      }
      return;
    }
    if (!e.repeat && (e.code === "Backquote" || e.key === "`")) {
      e.preventDefault();
      if (clickDebugToggle) clickDebugToggle.checked = !clickDebugToggle.checked;
      paintClickDebug();
      return;
    }
    const move = moveCode(e);
    if (move) {
      e.preventDefault();
      keys.add(move);
      if (move === "Space" && !e.repeat && selected?.kind === "player") tryEngagePlayer(true);
      return;
    }
    keys.add(e.code);
  }
  function onKeyUp(e: KeyboardEvent) {
    const move = moveCode(e);
    if (move) keys.delete(move);
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
    const on = clickDebugToggle ? clickDebugToggle.checked : false;
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
    const hit = tileAtScreen(sx, sy, cam.x, cam.z, viewW, viewH, roughX, roughZ);
    if (!hit) return null;
    if (!blocked(hit.x, hit.z)) return hit;
    let best: { x: number; z: number } | null = null;
    let bestD = 1.65;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const x = hit.x + dx;
      const z = hit.z + dz;
      if (blocked(x, z)) continue;
      const d = diamondDistance(sx, sy, worldToScreen(x, z));
      if (d < bestD) {
        bestD = d;
        best = { x, z };
      }
    }
    return best;
  }

  function goTo(x: number, z: number, talk: string | null, keepChase = false, quiet = false) {
    const p = localPlayer();
    dest = { x, z };
    talkNpc = talk;
    if (!keepChase) chaseId = null;
    repaths = 0;
    path = p ? routeTo(p.x, p.z, x, z) : [];
    if (showDebugHud && !quiet) floatAt(x, z, `walk → (${Math.round(x)},${Math.round(z)})`, "#d7c28a", 70);
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
    if (above >= 108 && above <= 156 && dx <= 66) return true;
    if (above >= -12 && above <= 112 && dx <= 44) return true;
    return false;
  }
  let lastMobId: string | null = null;
  let lastMobAt = 0;
  function mobAt(sx: number, sy: number, w: { x: number; z: number }) {
    for (const m of view().monsters) {
      if (m.hp <= 0) continue;
      if (spriteHit(sx, sy, m.x, m.z, 96)) return m.id;
    }
    let picked: string | null = null;
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
    return picked;
  }
  function engageMob(id: string) {
    const p = localPlayer();
    if (!p || p.hp <= 0) return;
    pinnedId = id;
    selected = { kind: "mob", id };
    chaseId = id;
    pvpId = null;
    const m = view().monsters.find((mon) => mon.id === id && mon.hp > 0);
    if (!m) return;
    const mage = p.baseClass === "Mage" || p.prestigeClass === "Wizard";
    const dist = Math.hypot(m.x - p.x, m.z - p.z);
    const inRange = mage ? dist <= 7.2 : dist <= 2.65;
    if (!inRange) {
      const spot = mage ? rangedStand(m.x, m.z, p.x, p.z) : adjacentStand(m.x, m.z, p.x, p.z);
      goTo(spot.x, spot.z, null, true);
    } else {
      dest = null;
      path = [];
    }
  }
  let pendingMove: { x: number; z: number } | null = null;
  let consumeClick = false;
  function onPointer(e: PointerEvent) {
    canvas.focus({ preventScroll: true });
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
        send({ op: "loot", id: myId, graveId: pickedGrave.id });
      } else {
        talkNpc = null;
        goTo(pickedGrave.x, pickedGrave.z, null);
        lootGrave = pickedGrave.id;
      }
      return;
    }
    let pickedNpc: (typeof NPCS)[number] | null = null;
    let npcBest = 1e9;
    for (const npc of NPCS) {
      if (!npcHit(sx, sy, npc.x, npc.z)) continue;
      const sp = worldToScreen(npc.x, npc.z);
      const d = Math.hypot(sx - sp.x, sy - (sp.y - 64));
      if (d < npcBest) {
        npcBest = d;
        pickedNpc = npc;
      }
    }
    if (pickedNpc) {
      const dist = Math.hypot(pickedNpc.x - p.x, pickedNpc.z - p.z);
      chaseId = null;
      pvpId = null;
      pinnedId = null;
      selected = { kind: "npc", id: pickedNpc.id };
      pendingMove = null;
      consumeClick = true;
      rememberClick(e, hit, pickedNpc);
      if (dist <= 3.6) {
        dest = null;
        path = [];
        talkNpc = null;
        openNpc(pickedNpc.id);
      } else {
        const spot = standBeside(pickedNpc.x, pickedNpc.z, p.x, p.z);
        goTo(spot.x, spot.z, pickedNpc.id, false, true);
      }
      return;
    }
    const clicked = playerAt(sx, sy);
    const peer = clicked ? null : peerAt(sx, sy);
    if (clicked || peer) {
      selected = { kind: "player", id: (clicked ?? peer)!.id };
      pinnedId = null;
      chaseId = null;
      pvpId = null;
      lootGrave = null;
      dest = null;
      path = [];
      pendingMove = null;
      consumeClick = true;
      rememberClick(e, hit, clicked ?? peer!);
      return;
    }
    const picked = mobAt(sx, sy, w);
    if (picked) {
      const attack = e.detail >= 2 || (lastMobId === picked && performance.now() - lastMobAt < 350);
      lastMobId = picked;
      lastMobAt = performance.now();
      pinnedId = picked;
      selected = { kind: "mob", id: picked };
      pvpId = null;
      pendingMove = null;
      consumeClick = true;
      if (!attack) {
        if (chaseId) {
          dest = null;
          path = [];
        }
        chaseId = null;
        return;
      }
      engageMob(picked);
      return;
    }
    const plot = plotAtScreen(sx, sy);
    if (plot) {
      pinnedId = null;
      chaseId = null;
      pvpId = null;
      lootGrave = null;
      pendingMove = null;
      consumeClick = true;
      rememberClick(e, hit, plot);
      const dist = Math.hypot(plot.x - p.x, plot.z - p.z);
      if (dist <= 3.2) {
        dest = null;
        path = [];
        talkNpc = null;
        const owner = guildAtPlot(plot.id);
        const mine = guildOf(p.username);
        if (owner && mine && owner.id === mine.id) {
          if (memberRank(p.username) === "Leader") tryRemove();
          else note("Only the Leader can remove the Cornerstone.");
        } else if (owner) note(`City plot taken by [${owner.tag}].`);
        else tryPlant(plot.id);
      } else goTo(plot.x, plot.z, null);
      return;
    }
    pinnedId = null;
    selected = null;
    chaseId = null;
    pvpId = null;
    lootGrave = null;
    const tile = pickTile(sx, sy, w.x, w.z);
    if (!tile) {
      pendingMove = null;
      consumeClick = true;
      return;
    }
    rememberClick(e, hit, tile);
    pendingMove = { x: tile.x, z: tile.z };
  }

  function onWorldUp(e: PointerEvent) {
    const onCanvas = e.target === canvas;
    if (consumeClick || !onCanvas) {
      consumeClick = false;
      pendingMove = null;
      return;
    }
    const move = pendingMove;
    pendingMove = null;
    if (!move || e.button !== 0) return;
    const top = document.elementFromPoint(e.clientX, e.clientY);
    if (top && top !== canvas && !canvas.contains(top)) return;
    goTo(move.x, move.z, null);
  }

  function onRootPointerDown(e: PointerEvent) {
    const target = e.target;
    if (target === canvas || (target instanceof Node && canvas.contains(target))) return;
    pendingMove = null;
    consumeClick = true;
  }

  function onTravelPointerDown() {
    pendingMove = null;
    consumeClick = true;
  }

  function openNpc(id: string) {
    const npc = NPCS.find((n) => n.id === id);
    if (!npc) return;
    const p = me();
    if (!p || Math.hypot(npc.x - p.x, npc.z - p.z) > 8) return;
    if (npc.role === "vendor" || npc.role === "smith") openShop(npc);
    else if (npc.role === "trainer") openTrain(npc);
    else if (npc.role === "registrar") openRegistrar();
    else openTravel(npc.city);
  }

  function openTrain(npc: (typeof NPCS)[number]) {
    const p = me();
    if (!p || npc.role !== "trainer" || Math.hypot(npc.x - p.x, npc.z - p.z) > 8) return;
    if (trainTitle) trainTitle.textContent = npc.name;
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
      const effect =
        skill.affects === "hit" ? `hit ${hitChance(p)}%` : `damage ${trainedDamage(p)}`;
      return `<button type="button" data-train="${skill.id}">${skill.name} ${cur}% — 1 pt, ${skill.gold}g (${effect})</button>`;
    }).join("");
  }

  function openShop(npc: (typeof NPCS)[number]) {
    const p = me();
    if (!p || (npc.role !== "vendor" && npc.role !== "smith")) return;
    if (Math.hypot(npc.x - p.x, npc.z - p.z) > 8) return;
    if (shopTitle) shopTitle.textContent = npc.name;
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
            const use =
              item?.kind === "consumable"
                ? `<button type="button" data-use="${id}">Use</button>`
                : "";
            const equip = item?.slot
              ? `<button type="button" data-equip="${id}">Equip</button>`
              : "";
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
    send({ op: "travel", id: myId, cityId });
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
    pendingMove = null;
    consumeClick = true;
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
    const place = bindSpot();
    send({ op: "respawn", id: myId, place: place ?? undefined });
    persist();
  }

  function onTravelClose(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    pendingMove = null;
    setOpen(travelPanel, false);
  }

  function act(skill: string) {
    if ((skill === "attack" || skill === "stab") && selected?.kind === "player") {
      tryEngagePlayer(true);
      return;
    }
    const power = powerById(skill);
    const selfCast =
      !power ||
      power.range <= 0 ||
      power.kind === "buff" ||
      power.kind === "stealth" ||
      (power.kind === "heal" && power.id !== "succor");
    const range = power && power.range > 0 ? power.range : 3.8;
    const pinned = pinnedId ? view().monsters.find((m) => m.id === pinnedId && m.hp > 0) : null;
    const p = me();
    const pinOk = pinned && p && Math.hypot(pinned.x - p.x, pinned.z - p.z) <= range;
    let targetId = selfCast ? null : pinOk ? pinned.id : nearestId(range);
    if (skill === "succor" && p) {
      const shrouded = view().players.find(
        (pl) =>
          pl.hp > 0 &&
          (pl.shroudUntil ?? 0) > Date.now() &&
          Math.hypot(pl.x - p.x, pl.z - p.z) <= 8,
      );
      targetId = shrouded?.id ?? p.id;
    }
    const actor = actors.get(myId) ?? {
      x: 0,
      z: 0,
      facing: 0,
      attackUntil: 0,
      castUntil: 0,
      blockAt: 0,
      blockUntil: 0,
      wasBlocking: false,
      walkMs: 0,
      moving: false,
      phase: 0,
      stamp: 0,
    };
    const now = performance.now();
    const rig = asRig((p?.race || "").toLowerCase());
    const swing = twoHanded(p?.equipment?.weapon ?? "") ? "atk2h" : "atk1h";
    if (power && power.mana > 0) {
      actor.castUntil = now + (rig ? rigMs(rig, "cast1h") : 900);
      actor.attackUntil = now;
    } else if (skill === "shield") {
      actor.blockAt = now;
      actor.blockUntil = now + 8000;
      actor.wasBlocking = true;
      actor.attackUntil = now;
    } else {
      actor.attackUntil = now + (rig ? rigMs(rig, swing) : SWING_MS);
    }
    actors.set(myId, actor);
    if (
      power &&
      power.mana > 0 &&
      power.kind !== "heal" &&
      power.kind !== "buff" &&
      targetId &&
      p
    ) {
      const m = view().monsters.find((mon) => mon.id === targetId);
      if (m) bolts.push({ x0: p.x, z0: p.z, x1: m.x, z1: m.z, born: performance.now() });
    }
    if (skill === "attack") send({ op: "attack", id: myId, targetId });
    else send({ op: "skill", id: myId, skill, targetId });
  }

  function pressSlot(index: number) {
    const p = me();
    const bar =
      p?.hotbar?.length === 8
        ? p.hotbar
        : defaultHotbar(p?.baseClass || "Fighter", p?.prestigeClass || "", p?.level || 1);
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
  function onShopPointerDown(e: PointerEvent) {
    // Capture on the overlay, before the click can reach the map.
    e.stopPropagation();
    pendingMove = null;
    consumeClick = true;
    const raw = e.target;
    const el = raw instanceof Element ? raw : raw instanceof Node ? raw.parentElement : null;
    const btn = (el?.closest("button[data-buy], button[data-sell]") ?? null) as HTMLButtonElement | null;
    if (!btn || !shop.contains(btn)) return;
    e.preventDefault();
    const buyId = btn.dataset.buy;
    const sellId = btn.dataset.sell;
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
    consumeClick = true;
    send({ op: "spawn", id: myId });
  }

  function showChatTab(tab: "say" | "pvp" | "guild") {
    chatTab = tab;
    root.querySelector("#chatTabSay")?.classList.toggle("on", tab === "say");
    root.querySelector("#chatTabPvp")?.classList.toggle("on", tab === "pvp");
    root.querySelector("#chatTabGuild")?.classList.toggle("on", tab === "guild");
    messages.hidden = tab !== "say";
    if (pvpBox) pvpBox.hidden = tab !== "pvp";
    if (guildBox) guildBox.hidden = tab !== "guild";
    if (tab === "guild") paintGuildChat();
  }

  function onChatTab(e: Event) {
    e.preventDefault();
    const id = (e.currentTarget as HTMLElement).id;
    showChatTab(id === "chatTabPvp" ? "pvp" : id === "chatTabGuild" ? "guild" : "say");
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
  function onDebugGold(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    pendingMove = null;
    consumeClick = true;
    const p = localPlayer();
    if (!p || p.hp <= 0) return;
    p.gold += 200;
    commitPurse();
    note("Debug: +200 gold.");
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
    e.stopPropagation();
    pendingMove = null;
    consumeClick = true;
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
    if (chatTab === "guild") {
      sayGuild(text);
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
  shop.addEventListener("pointerdown", onShopPointerDown, true);
  shopClose.addEventListener("pointerup", onShopClose);
  trainList.addEventListener("pointerup", onTrainClick);
  trainClose.addEventListener("pointerup", onTrainClose);
  root.querySelector("#trainPromote")?.addEventListener("pointerup", onPromote);
  root.querySelector("#debugLevelBtn")?.addEventListener("pointerup", onDebugLevel);
  root.querySelector("#debugHudLevelBtn")?.addEventListener("pointerup", onDebugHudLevel);
  root.querySelector("#debugGoldBtn")?.addEventListener("pointerup", onDebugGold);
  plotPromptBtn?.addEventListener("pointerup", onPlotPrompt);
  root.querySelector("#inviteAccept")?.addEventListener("pointerup", acceptInvite);
  root.querySelector("#inviteDecline")?.addEventListener("pointerup", declineInvite);
  ctxMenu?.addEventListener("pointerup", onCtxClick);
  root.querySelector("#debugPlusBtn")?.addEventListener("pointerup", onDebugPlus);
  root.querySelector("#debugHpBtn")?.addEventListener("pointerup", onDebugHp);
  root.querySelector("#debugKillBtn")?.addEventListener("pointerup", onDebugKill);
  root.querySelector("#debugKillHudBtn")?.addEventListener("pointerup", onDebugKill);
  clickDebugToggle?.addEventListener("change", paintClickDebug);
  paintClickDebug();
  showChatTab("say");
  root.querySelector("#chatToggle")!.addEventListener("pointerup", onChatToggle);
  root.querySelector("#chatTabSay")?.addEventListener("pointerup", onChatTab);
  root.querySelector("#chatTabPvp")?.addEventListener("pointerup", onChatTab);
  root.querySelector("#chatTabGuild")?.addEventListener("pointerup", onChatTab);
  root.querySelector("#debugSpawnBtn")?.addEventListener("pointerup", onSpawnMob);
  root.querySelector("#guildBtn")?.addEventListener("pointerup", onGuildButton);
  root.querySelector("#guildClose")?.addEventListener("pointerup", onGuildClose);
  root.querySelector("#guildAccept")?.addEventListener("pointerup", acceptGuild);
  root.querySelector("#guildDecline")?.addEventListener("pointerup", declineGuild);
  guildBody.addEventListener("pointerup", onGuildClick);
  guildBody.addEventListener("input", captureDraft);
  mapBtn.addEventListener("pointerup", onMap);
  mapClose.addEventListener("pointerup", onMapClose);
  talkBtn.addEventListener("pointerup", onTalk);
  travelButtons.addEventListener("pointerup", onTravelClick);
  travelPanel.addEventListener("pointerdown", onTravelPointerDown, true);
  travelClose.addEventListener("pointerup", onTravelClose);
  respawnBtn.addEventListener("pointerup", onRespawn);
  canvas.tabIndex = 0;
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
  targetFrame?.addEventListener("pointerdown", (e) => {
    const btn = (e.target as HTMLElement).closest("#targetClear");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    pendingMove = null;
    consumeClick = true;
    clearTarget();
  });
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", resize);
  root.addEventListener("contextmenu", onContextMenu);

  seenGuild = guildOf(profile.username)?.id ?? "";
  seenRank = memberRank(profile.username) ?? "";
  window.addEventListener("storage", onGuildStorage);

  const stepTimer = window.setInterval(() => {
    watchPurse();
  }, 400);

  function onLeave() {
    watchPurse();
  }
  window.addEventListener("pagehide", onLeave);

  window.__controlsTest = {
    getYaw: () => localPlayer()?.rotation ?? 0,
    getSpeed: () => lastSpeed,
    getPos: () => {
      const p = localPlayer();
      return {
        x: p?.x ?? 0,
        z: p?.z ?? 0,
        hp: p?.hp ?? 0,
        mana: p?.mana ?? 0,
        gold: p?.gold ?? 0,
        xp: p?.xp ?? 0,
        level: p?.level ?? 1,
      };
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
      view()
        .monsters.filter((m) => m.hp > 0)
        .map((m) => ({ id: m.id, type: m.type, level: m.level, hp: m.hp, x: m.x, z: m.z })),
    npcs: () =>
      NPCS.map((n) => ({ id: n.id, name: n.name, role: n.role, city: n.city, x: n.x, z: n.z })),
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
    groupMembers: () =>
      groupRoster().map((row) => ({
        id: row.id,
        name: row.name,
        level: row.level,
        hp: row.hp,
        maxHp: row.maxHp,
      })),
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

  const netStatus = root.querySelector<HTMLElement>("#netStatus");
  const linkGate = root.querySelector<HTMLElement>("#linkGate");
  const linkGateText = root.querySelector<HTMLElement>("#linkGateText");
  const linkRetry = root.querySelector<HTMLButtonElement>("#linkGateRetry");
  function setNetStatus(line: string | null) {
    if (!netStatus) return;
    if (!line) {
      netStatus.hidden = true;
      netStatus.textContent = "";
      return;
    }
    netStatus.hidden = false;
    netStatus.textContent = line;
  }

  function showLink(gate: LinkGate) {
    if (gate === "sign-in") {
      profile.onSignOut?.();
      return;
    }
    if (!linkGate || !linkGateText) return;
    if (worldMayStart(gate)) {
      linkGate.hidden = true;
      if (!(document.activeElement instanceof HTMLInputElement) && !(document.activeElement instanceof HTMLTextAreaElement))
        canvas.focus({ preventScroll: true });
      return;
    }
    linkGate.hidden = false;
    if (gate === "connecting") {
      linkGateText.textContent = "Connecting…";
      if (linkRetry) linkRetry.hidden = true;
      return;
    }
    linkGateText.textContent = gate === "elsewhere" ? "Signed in elsewhere" : "Server unavailable";
    if (linkRetry) linkRetry.hidden = false;
  }

  function startLink() {
    showLink("connecting");
    remoteSession?.close();
    remoteSession = connectRemote({
      url: SERVER,
      choice: {
        username: profile.username,
        race: profile.race,
        baseClass: profile.baseClass,
        slot: profile.slot,
        create: profile.create,
      },
      onSnap: (state, online) => {
        if (typeof online === "number" && online >= 0) playersOnline = online;
        takeSnap(state);
      },
      onWelcome: (playerId) => {
        claimServerId(playerId);
        const latest = snaps[snaps.length - 1]?.state.players?.find((p) => p.id === playerId);
        if (latest) adoptServerHero(latest);
        setNetStatus("Online");
      },
      onError: (reason) => {
        if (reason === "name_taken" || reason === "bad_create") profile.onCreateError?.(reason);
      },
      onAck: (seq, result) => {
        const intent = sentIntents.get(seq);
        sentIntents.delete(seq);
        if (intent?.op === "move") {
          if (result.ok === false) {
            const server = snaps[snaps.length - 1]?.state.players?.find((p) => p.id === myId);
            const local = localPlayer();
            if (server) {
              authX = server.x;
              authZ = server.z;
              haveAuth = true;
            }
            // "Too fast" means the prediction ran ahead of an accepted step.
            // The next packet is clamped. Snapping here is what made WASD stutter.
            if (result.reason !== "Too fast" && server && local) {
              if (!(onCampfire(server.x, server.z) && !onCampfire(local.x, local.z))) {
                local.x = server.x;
                local.z = server.z;
                faceHold = performance.now() + 180;
              }
            }
          }
          return;
        }
        if (!intent) {
          if (result.reason) note(result.reason);
          return;
        }
        present(intent, result);
      },
      onStatus: setNetStatus,
      onLink: showLink,
    });
  }

  linkRetry?.addEventListener("click", startLink);
  startLink();

  resize();
  raf = requestAnimationFrame(frame);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    remoteSession?.close();
    remoteSession = null;
    linkRetry?.removeEventListener("click", startLink);
    const slot = isleSlot();
    if (slot.dispose === dispose) slot.dispose = undefined;
    dead = true;
    cancelAnimationFrame(raf);
    window.clearInterval(stepTimer);
    onLeave();
    window.removeEventListener("storage", onGuildStorage);
    hotbarButtons.forEach((btn) => btn.removeEventListener("pointerup", onHotbar));
    promoteBtn.removeEventListener("pointerup", onPromote);
    root.querySelector("#trainPromote")?.removeEventListener("pointerup", onPromote);
    root.querySelector("#chatToggle")?.removeEventListener("pointerup", onChatToggle);
    root.querySelector("#chatTabSay")?.removeEventListener("pointerup", onChatTab);
    root.querySelector("#chatTabPvp")?.removeEventListener("pointerup", onChatTab);
    root.querySelector("#chatTabGuild")?.removeEventListener("pointerup", onChatTab);
    root.querySelector("#debugSpawnBtn")?.removeEventListener("pointerup", onSpawnMob);
    root.querySelector("#guildBtn")?.removeEventListener("pointerup", onGuildButton);
    root.querySelector("#guildClose")?.removeEventListener("pointerup", onGuildClose);
    root.querySelector("#guildAccept")?.removeEventListener("pointerup", acceptGuild);
    root.querySelector("#guildDecline")?.removeEventListener("pointerup", declineGuild);
    guildBody.removeEventListener("pointerup", onGuildClick);
    guildBody.removeEventListener("input", captureDraft);
    root.querySelector("#debugLevelBtn")?.removeEventListener("pointerup", onDebugLevel);
    root.querySelector("#debugHudLevelBtn")?.removeEventListener("pointerup", onDebugHudLevel);
    root.querySelector("#debugGoldBtn")?.removeEventListener("pointerup", onDebugGold);
    plotPromptBtn?.removeEventListener("pointerup", onPlotPrompt);
    root.querySelector("#inviteAccept")?.removeEventListener("pointerup", acceptInvite);
    root.querySelector("#inviteDecline")?.removeEventListener("pointerup", declineInvite);
    ctxMenu?.removeEventListener("pointerup", onCtxClick);
    root.querySelector("#debugPlusBtn")?.removeEventListener("pointerup", onDebugPlus);
    root.querySelector("#debugHpBtn")?.removeEventListener("pointerup", onDebugHp);
    root.querySelector("#debugKillBtn")?.removeEventListener("pointerup", onDebugKill);
    root.querySelector("#debugKillHudBtn")?.removeEventListener("pointerup", onDebugKill);
    clickDebugToggle?.removeEventListener("change", paintClickDebug);
    mapBtn.removeEventListener("pointerup", onMap);
    mapClose.removeEventListener("pointerup", onMapClose);
    sheetBtn.removeEventListener("pointerup", onSheet);
    sheetClose.removeEventListener("pointerup", onSheetClose);
    bagBtn.removeEventListener("pointerup", onBagToggle);
    bagClose.removeEventListener("pointerup", onBagClose);
    bag.removeEventListener("pointerup", onBagClick);
    shop.removeEventListener("pointerdown", onShopPointerDown, true);
    shopClose.removeEventListener("pointerup", onShopClose);
    trainList.removeEventListener("pointerup", onTrainClick);
    trainClose.removeEventListener("pointerup", onTrainClose);
    talkBtn.removeEventListener("pointerup", onTalk);
    travelButtons.removeEventListener("pointerup", onTravelClick);
    travelPanel.removeEventListener("pointerdown", onTravelPointerDown, true);
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
