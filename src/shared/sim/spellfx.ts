import { powerById } from "../content/catalog";

/** Default cast1h releases on the third frame (260+200). */
export const CAST_RELEASE_MS = 460;
/** Venom's cloud stays on the ground after the nick. */
export const POISON_LINGER_MS = 4000;
/** Ground rings read larger on a Marshwarden. */
export const MARSH_FX_SCALE = 1.3;

export type SpellKind = "heal" | "shield" | "holy-smite" | "frost" | "lightning" | "poison";

export interface SpellFxEvent {
  id: number;
  kind: SpellKind;
  casterId: string;
  targetId: string;
  x: number;
  z: number;
  x1: number;
  z1: number;
  at: number;
  /** How long a looping effect stays after the cast releases. 0 is one cycle or one shot. */
  linger: number;
  race: string;
  /** Mana spells wait for cast1h. A rogue nick does not. */
  cast: boolean;
}

export interface SpellFrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a sheet.json says about playback. Frames stay in animation order. */
export interface SpellSheet {
  fps: number;
  loop: boolean;
  anchorX: number;
  anchorY: number;
  /** Ground-center anchors sit on the feet. Centered anchors do not. */
  ground: boolean;
  additive: boolean;
  /** Art faces screen east and must rotate onto the travel angle. */
  rotate: boolean;
  frames: SpellFrameRect[];
}

type PowerLike = { id: string; kind: string; classes: string[] };

function isHealer(classes: string[]) {
  return classes.some((c) => c === "Healer" || c === "Priest");
}

function isMage(classes: string[]) {
  return classes.some((c) => c === "Mage" || c === "Wizard");
}

function isRogue(classes: string[]) {
  return classes.some((c) => c === "Rogue" || c === "Scout");
}

/** Which painted effect a power plays, or null when the swing has no spell art. */
export function visualFor(power: PowerLike): SpellKind | null {
  if (power.id === "attack") return null;
  if (isHealer(power.classes) && power.kind === "heal") return "heal";
  if (isHealer(power.classes) && power.kind === "buff") return "shield";
  if (isHealer(power.classes) && (power.kind === "damage" || power.kind === "snare")) return "holy-smite";
  if (isMage(power.classes) && power.kind === "snare") return "frost";
  if (power.id === "bolt") return "lightning";
  if (isRogue(power.classes) && power.id === "venom") return "poison";
  return null;
}

export function spellVisual(powerId: string): SpellKind | null {
  const power = powerById(powerId);
  if (!power) return null;
  return visualFor(power);
}

export function spellSheetName(kind: SpellKind): { main: string; impact?: string } {
  if (kind === "frost") return { main: "frost-bolt", impact: "frost-impact" };
  if (kind === "poison") return { main: "poison-cloud" };
  return { main: kind };
}

export function groundFxScale(race: string) {
  return race.toLowerCase() === "marshwarden" ? MARSH_FX_SCALE : 1;
}

/** Frame index from the sheet clock. A finished one-shot is null. */
export function spellFrame(frameCount: number, fps: number, loop: boolean, elapsedMs: number): number | null {
  if (frameCount <= 0 || fps <= 0 || elapsedMs < 0) return null;
  const index = Math.floor(elapsedMs / (1000 / fps));
  if (loop) return index % frameCount;
  if (index >= frameCount) return null;
  return index;
}

export function parseSpellSheet(raw: unknown): SpellSheet | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as {
    frames?: Record<string, { frame?: { x?: number; y?: number; w?: number; h?: number } }>;
    animations?: Record<string, string[]>;
    meta?: { fps?: number; loop?: boolean; anchor?: string; blend?: string };
  };
  const meta = data.meta;
  const fps = meta?.fps;
  if (!meta || typeof fps !== "number" || !(fps > 0)) return null;
  const framesIn = data.frames ?? {};
  const listed = data.animations ? Object.values(data.animations)[0] : undefined;
  const names =
    listed && listed.length
      ? listed
      : Object.keys(framesIn).sort((a, b) => {
          const na = Number(a.match(/(\d+)/)?.[1] ?? 0);
          const nb = Number(b.match(/(\d+)/)?.[1] ?? 0);
          return na - nb;
        });
  const frames: SpellFrameRect[] = [];
  for (const name of names) {
    const cell = framesIn[name]?.frame;
    if (!cell || typeof cell.x !== "number" || typeof cell.w !== "number") continue;
    frames.push({ x: cell.x, y: cell.y ?? 0, w: cell.w, h: cell.h ?? cell.w });
  }
  if (!frames.length) return null;
  const anchor = String(meta.anchor ?? "");
  const match = /\((\d+)\s*,\s*(\d+)\)/.exec(anchor);
  const anchorX = match ? Number(match[1]) : 128;
  const anchorY = match ? Number(match[2]) : 128;
  return {
    fps,
    loop: meta.loop === true,
    anchorX,
    anchorY,
    ground: anchorY >= 160,
    additive: /additive/i.test(String(meta.blend ?? "")),
    rotate: /rotate|faces east/i.test(anchor),
    frames,
  };
}
