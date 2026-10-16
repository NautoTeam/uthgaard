/**
 * Seamless ground, phase 1.
 *
 * Chunks are baked a few scanlines at a time into a half-resolution canvas
 * and blitted instead of filling every diamond. Colour still comes from
 * tileFill / the terrain mask, so the Reach's layout does not move.
 * Click picking stays on the diamond math in iso.ts.
 *
 * Phase 2 plugs in through setTerrainArt(): a tileable texture per kind
 * and a decal list. Those replace the procedural grain at bake time.
 * invalidate() drops a chunk so dynamic ground (a Cornerstone, a scorch)
 * can rebake later. Nothing calls it yet — phase 1 ground is static.
 */
import { CITIES, LAND, onRoad, tileFill } from "./geo";
import { CAMPS } from "./types";
import { BOUNDS, LAKES, TERRAIN_PALETTE, WORLD_CITIES } from "../shared/content/world";
import { terrainAt } from "../shared/sim/mask";

export const GROUND_CHUNK = 32;
/** Screen pixels per baked sample. The blit scales this back up. */
const STEP = 2;
/** Extra screen pixels so adjacent chunks overlap and camera subpixels don't crack. */
const PAD = 4;
/** Tiles of extra coverage past the chunk edge. Same colour on both sides, so the overlap is invisible. */
const BLEED = 0.5;
const WARP = 0.36;
const FRAME_BAKE_MS = 7;
/** How many unfinished chunks a frame may advance. The time cap usually stops it at one. */
const MAX_SLICES = 3;
const LRU_CAP = 12;
const REACH_R2 = 156 * 156;
const NOISE_N = 256;

const SAND_R = 0x9a;
const SAND_G = 0x8a;
const SAND_B = 0x5e;
const FOAM_R = 225;
const FOAM_G = 235;
const FOAM_B = 230;

export interface GroundDecal {
  image: CanvasImageSource;
  /** 0–1 chance a tile scatters this decal. */
  rate: number;
  /** Draw size in screen pixels. */
  size: number;
}

export interface TerrainArt {
  /** Tileable colour. Sampled in world space when the chunk bakes. */
  texture?: CanvasImageSource;
  /** World tiles across one repeat of `texture`. Default 4. */
  repeat?: number;
  /** 0–1, how far the texture replaces the procedural colour. Default 1. */
  strength?: number;
  decals?: GroundDecal[];
}

export interface CornerSample {
  r: number;
  g: number;
  b: number;
  /** Terrain id a phase-2 texture keys off. */
  kind: string;
  water: number;
  deep: number;
}

export interface GroundView {
  camX: number;
  camZ: number;
  viewW: number;
  viewH: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface GroundCost {
  /** Diamond fills the old loop would have issued this frame. */
  diamonds: number;
  /** Cached chunk canvases drawn this frame. */
  blits: number;
  /** Chunks that finished baking this frame. */
  baked: number;
  /** Milliseconds spent inside the baker this frame. 0 once the view is cached. */
  bakeMs: number;
  /** Visible chunks that are not ready yet. */
  pending: number;
}

export function chunkCoords(tileX: number, tileZ: number): { cx: number; cz: number } {
  return {
    cx: Math.floor(tileX / GROUND_CHUNK),
    cz: Math.floor(tileZ / GROUND_CHUNK),
  };
}

const hexCache = new Map<string, [number, number, number]>();
function rgbOf(hex: string): [number, number, number] {
  let hit = hexCache.get(hex);
  if (!hit) {
    const n = Number.parseInt(hex.slice(1), 16);
    hit = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    hexCache.set(hex, hit);
  }
  return hit;
}

const PALETTE_RGB: Record<string, [[number, number, number], [number, number, number]]> = {};
for (const [name, pair] of Object.entries(TERRAIN_PALETTE)) {
  PALETTE_RGB[name] = [rgbOf(pair[0]), rgbOf(pair[1])];
}

const VARIANCE: Record<string, number> = {
  meadow: 0.3,
  forest: 0.34,
  moor: 0.26,
  highland: 0.22,
  scrub: 0.26,
  marsh: 0.28,
  bog: 0.3,
  snow: 0.12,
  taiga: 0.24,
  ice: 0.1,
  desert: 0.18,
  saltflat: 0.1,
  barrow: 0.16,
  ash: 0.2,
  lava: 0.22,
  hub: 0.08,
  beach: 0.16,
  water: 0.16,
  deep: 0.12,
  lake: 0.16,
  road: 0.08,
  stone: 0.07,
  camp: 0.1,
  plaza: 0.07,
};

const NO_DECAL = new Set(["road", "stone", "camp", "plaza", "water", "deep", "lake"]);

const kindIndex = new Map<string, number>();
const kindName: string[] = [];
function kindId(name: string): number {
  let id = kindIndex.get(name);
  if (id === undefined) {
    id = kindName.length;
    kindName.push(name);
    kindIndex.set(name, id);
  }
  return id;
}

function inLake(x: number, z: number): boolean {
  for (let i = 0; i < LAKES.length; i++) {
    const lake = LAKES[i];
    const dx = x - lake.x;
    const dz = z - lake.z;
    if (dx * dx + dz * dz < lake.r * lake.r) return true;
  }
  return false;
}

function nearCity(x: number, z: number): boolean {
  for (let i = 0; i < CITIES.length; i++) {
    const city = CITIES[i];
    const dx = x - city.x;
    const dz = z - city.z;
    if (dx * dx + dz * dz < 6.4 * 6.4) return true;
  }
  return false;
}

function nearCamp(x: number, z: number): boolean {
  for (let i = 0; i < CAMPS.length; i++) {
    const camp = CAMPS[i];
    const dx = x - camp.cx;
    const dz = z - camp.cz;
    if (dx * dx + dz * dz < 3.4 * 3.4) return true;
  }
  return false;
}

/** Integer tile colour and kind. Matches tileFill inside the Reach and the mask palette outside. */
export function sampleCorner(x: number, z: number): CornerSample {
  const ix = x | 0;
  const iz = z | 0;
  if (ix * ix + iz * iz <= REACH_R2) {
    const [r, g, b] = rgbOf(tileFill(ix, iz));
    const d = Math.hypot(ix, iz);
    let kind = "meadow";
    if (d > LAND + 5) kind = "deep";
    else if (d > LAND) kind = "water";
    else if (inLake(ix, iz)) kind = "lake";
    else if (nearCity(ix, iz)) kind = "stone";
    else if (onRoad(ix, iz)) kind = "road";
    else if (nearCamp(ix, iz)) kind = "camp";
    else if (d > LAND - 12) kind = "beach";
    const water = kind === "deep" || kind === "water" || kind === "lake" ? 1 : 0;
    return { r, g, b, kind, water, deep: kind === "deep" ? 1 : 0 };
  }
  const name = terrainAt(ix, iz);
  if (name === "plaza") {
    let best = WORLD_CITIES[0];
    let bestD = 1e9;
    for (const city of WORLD_CITIES) {
      const dd = Math.hypot(city.x - ix, city.z - iz);
      if (dd < bestD) {
        best = city;
        bestD = dd;
      }
    }
    const [r, g, b] = rgbOf((ix * 3 + iz) % 5 === 0 ? best.stoneAlt : best.stone);
    return { r, g, b, kind: "stone", water: 0, deep: 0 };
  }
  if (name === "road") {
    const [r, g, b] = rgbOf((ix + iz) & 1 ? "#7a6848" : "#6a563c");
    return { r, g, b, kind: "road", water: 0, deep: 0 };
  }
  if (name === "camp") {
    const [r, g, b] = rgbOf("#5a4032");
    return { r, g, b, kind: "camp", water: 0, deep: 0 };
  }
  if (name === "lake") {
    const [r, g, b] = rgbOf((ix + iz) & 1 ? "#1d5c68" : "#184e58");
    return { r, g, b, kind: "lake", water: 1, deep: 0 };
  }
  const known = PALETTE_RGB[name];
  const pair = known ?? PALETTE_RGB.deep;
  const [r, g, b] = pair[(ix + iz) & 1];
  const kind = known ? name : "deep";
  const water = kind === "water" || kind === "deep" || kind === "lake" ? 1 : 0;
  return { r, g, b, kind, water, deep: kind === "deep" ? 1 : 0 };
}

function hashUnit(x: number, z: number, salt = 0): number {
  let n = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(salt, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** ±5%, seeded per tile. Blurred across the chunk so the tint has no diamond edge. */
function tileTint(x: number, z: number): number {
  return (hashUnit(x, z, 3) - 0.5) * 0.1;
}

let noiseA: Float32Array | null = null;
let noiseB: Float32Array | null = null;
let noiseC: Float32Array | null = null;

function valueNoise(lat: Float32Array, latN: number, u: number, v: number): number {
  let x = u % latN;
  if (x < 0) x += latN;
  let y = v % latN;
  if (y < 0) y += latN;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x1 = (x0 + 1) % latN;
  const y1 = (y0 + 1) % latN;
  const i00 = y0 * latN + x0;
  const i10 = y0 * latN + x1;
  const i01 = y1 * latN + x0;
  const i11 = y1 * latN + x1;
  return (
    lat[i00] * (1 - sx) * (1 - sy) +
    lat[i10] * sx * (1 - sy) +
    lat[i01] * (1 - sx) * sy +
    lat[i11] * sx * sy
  );
}

function makeNoise(seed: number): Float32Array {
  const latN = 64;
  const lat = new Float32Array(latN * latN);
  let s = seed >>> 0;
  for (let i = 0; i < lat.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    lat[i] = (s >>> 8) / 16777216;
  }
  const out = new Float32Array(NOISE_N * NOISE_N);
  for (let y = 0; y < NOISE_N; y++) {
    for (let x = 0; x < NOISE_N; x++) {
      let amp = 1;
      let tot = 0;
      let sum = 0;
      let freq = 2;
      for (let o = 0; o < 4; o++) {
        const u = (x * freq * latN) / NOISE_N;
        const v = (y * freq * latN) / NOISE_N;
        sum += amp * valueNoise(lat, latN, u, v);
        tot += amp;
        amp *= 0.5;
        freq *= 2;
      }
      out[y * NOISE_N + x] = sum / tot;
    }
  }
  return out;
}

function ensureNoise(): void {
  if (noiseA) return;
  noiseA = makeNoise(21);
  noiseB = makeNoise(33);
  noiseC = makeNoise(55);
}

function sampleNoise(field: Float32Array, u: number, v: number): number {
  const n = NOISE_N;
  let x = u % n;
  if (x < 0) x += n;
  let y = v % n;
  if (y < 0) y += n;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x1 = (x0 + 1) & 255;
  const y1 = (y0 + 1) & 255;
  const i00 = y0 * n + x0;
  const i10 = y0 * n + x1;
  const i01 = y1 * n + x0;
  const i11 = y1 * n + x1;
  return (
    field[i00] * (1 - sx) * (1 - sy) +
    field[i10] * sx * (1 - sy) +
    field[i01] * (1 - sx) * sy +
    field[i11] * sx * sy
  );
}

interface ChunkMetrics {
  cx: number;
  cz: number;
  wx0: number;
  wz0: number;
  wx1: number;
  wz1: number;
  originX: number;
  originY: number;
  screenW: number;
  screenH: number;
  srcW: number;
  srcH: number;
}

function chunkMetrics(cx: number, cz: number): ChunkMetrics {
  const wx0 = cx * GROUND_CHUNK - 0.5;
  const wz0 = cz * GROUND_CHUNK - 0.5;
  const wx1 = wx0 + GROUND_CHUNK;
  const wz1 = wz0 + GROUND_CHUNK;
  const originX = (wx0 - wz1) * 24 - PAD;
  const originY = (wx0 + wz0) * 12 - PAD;
  const screenW = GROUND_CHUNK * 48 + PAD * 2;
  const screenH = GROUND_CHUNK * 24 + PAD * 2;
  return {
    cx,
    cz,
    wx0,
    wz0,
    wx1,
    wz1,
    originX,
    originY,
    screenW,
    screenH,
    srcW: screenW / STEP,
    srcH: screenH / STEP,
  };
}

interface TexEntry {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  strength: number;
  repeat: number;
}

interface ChunkWork extends ChunkMetrics {
  key: string;
  ix0: number;
  iz0: number;
  gw: number;
  gh: number;
  cr: Uint8Array;
  cg: Uint8Array;
  cb: Uint8Array;
  water: Uint8Array;
  deep: Uint8Array;
  tint: Float32Array;
  variance: Float32Array;
  kinds: Uint8Array;
  pixels: Uint8ClampedArray | null;
  row: number;
  canvas: HTMLCanvasElement | null;
  ready: boolean;
}

function blurTint(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? src : out;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : x;
        const x1 = x + 1 < w ? x + 1 : x;
        tmp[row + x] = (from[row + x0] + from[row + x] + from[row + x1]) / 3;
      }
    }
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : y;
      const y1 = y + 1 < h ? y + 1 : y;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        out[row + x] = (tmp[y0 * w + x] + tmp[row + x] + tmp[y1 * w + x]) / 3;
      }
    }
  }
  return out;
}

function buildChunk(
  cx: number,
  cz: number,
  cornerOf: (x: number, z: number) => CornerSample,
): ChunkWork {
  const metrics = chunkMetrics(cx, cz);
  const margin = 2;
  const ix0 = Math.floor(metrics.wx0 - margin);
  const iz0 = Math.floor(metrics.wz0 - margin);
  const ix1 = Math.ceil(metrics.wx1 + margin);
  const iz1 = Math.ceil(metrics.wz1 + margin);
  const gw = ix1 - ix0 + 1;
  const gh = iz1 - iz0 + 1;
  const cr = new Uint8Array(gw * gh);
  const cg = new Uint8Array(gw * gh);
  const cb = new Uint8Array(gw * gh);
  const water = new Uint8Array(gw * gh);
  const deep = new Uint8Array(gw * gh);
  const tintSrc = new Float32Array(gw * gh);
  const variance = new Float32Array(gw * gh);
  const kinds = new Uint8Array(gw * gh);
  for (let z = iz0; z <= iz1; z++) {
    for (let x = ix0; x <= ix1; x++) {
      const sample = cornerOf(x, z);
      const at = (z - iz0) * gw + (x - ix0);
      cr[at] = sample.r;
      cg[at] = sample.g;
      cb[at] = sample.b;
      water[at] = sample.water ? 255 : 0;
      deep[at] = sample.deep ? 255 : 0;
      tintSrc[at] = tileTint(x, z);
      variance[at] = VARIANCE[sample.kind] ?? 0.22;
      kinds[at] = kindId(sample.kind);
    }
  }
  return {
    ...metrics,
    key: `${cx},${cz}`,
    ix0,
    iz0,
    gw,
    gh,
    cr,
    cg,
    cb,
    water,
    deep,
    tint: blurTint(tintSrc, gw, gh),
    variance,
    kinds,
    pixels: new Uint8ClampedArray(metrics.srcW * metrics.srcH * 4),
    row: 0,
    canvas: null,
    ready: false,
  };
}

function sampleTex(tex: TexEntry, wx: number, wz: number): [number, number, number] {
  const u = wx / tex.repeat;
  const v = wz / tex.repeat;
  let x = (u - Math.floor(u)) * tex.w;
  let y = (v - Math.floor(v)) * tex.h;
  if (x < 0) x += tex.w;
  if (y < 0) y += tex.h;
  const x0 = Math.min(tex.w - 1, x | 0);
  const y0 = Math.min(tex.h - 1, y | 0);
  const i = (y0 * tex.w + x0) * 4;
  return [tex.data[i], tex.data[i + 1], tex.data[i + 2]];
}

function shadeRows(
  chunk: ChunkWork,
  y0: number,
  y1: number,
  art: Array<TexEntry | undefined> | null,
): void {
  ensureNoise();
  const fieldA = noiseA as Float32Array;
  const fieldB = noiseB as Float32Array;
  const fieldC = noiseC as Float32Array;
  const {
    pixels,
    srcW,
    originX,
    originY,
    wx0,
    wz0,
    wx1,
    wz1,
    ix0,
    iz0,
    gw,
    gh,
    cr,
    cg,
    cb,
    water: waterG,
    deep: deepG,
    tint,
    variance,
    kinds,
  } = chunk;
  if (!pixels) return;
  const xHi = wx1 + BLEED;
  const zHi = wz1 + BLEED;
  const xLo = wx0 - BLEED;
  const zLo = wz0 - BLEED;
  const gwMax = gw - 2;
  const ghMax = gh - 2;
  const useArt = art !== null;
  for (let py = y0; py < y1; py++) {
    const baseY = originY + (py + 0.5) * STEP;
    const row = py * srcW;
    for (let px = 0; px < srcW; px++) {
      const baseX = originX + (px + 0.5) * STEP;
      const wx = (baseX / 24 + baseY / 12) * 0.5;
      const wz = (baseY / 12 - baseX / 24) * 0.5;
      if (wx < xLo || wx >= xHi || wz < zLo || wz >= zHi) continue;
      const w1 = sampleNoise(fieldA, wx * 1.15 + 8, wz * 1.15) - 0.5;
      const w2 = sampleNoise(fieldB, wx * 1.15 + 40, wz * 1.15 + 11) - 0.5;
      const ux = wx + w1 * WARP;
      const uz = wz + w2 * WARP;
      const ix = Math.floor(ux);
      const iz = Math.floor(uz);
      let fx = ux - ix;
      let fz = uz - iz;
      fx = fx * fx * (3 - 2 * fx);
      fz = fz * fz * (3 - 2 * fz);
      let gx = ix - ix0;
      let gz = iz - iz0;
      if (gx < 0) gx = 0;
      else if (gx > gwMax) gx = gwMax;
      if (gz < 0) gz = 0;
      else if (gz > ghMax) gz = ghMax;
      const i00 = gz * gw + gx;
      const i10 = i00 + 1;
      const i01 = i00 + gw;
      const i11 = i01 + 1;
      const wa = (1 - fx) * (1 - fz);
      const wb = fx * (1 - fz);
      const wc = (1 - fx) * fz;
      const wd = fx * fz;
      const sa = wa;
      const sb = wb;
      const sc = wc;
      const sd = wd;
      const inv = 1 / (sa + sb + sc + sd);
      let r = (cr[i00] * sa + cr[i10] * sb + cr[i01] * sc + cr[i11] * sd) * inv;
      let g = (cg[i00] * sa + cg[i10] * sb + cg[i01] * sc + cg[i11] * sd) * inv;
      let b = (cb[i00] * sa + cb[i10] * sb + cb[i01] * sc + cb[i11] * sd) * inv;
      const wat =
        (waterG[i00] * sa + waterG[i10] * sb + waterG[i01] * sc + waterG[i11] * sd) *
        inv *
        (1 / 255);
      const deep =
        (deepG[i00] * sa + deepG[i10] * sb + deepG[i01] * sc + deepG[i11] * sd) * inv * (1 / 255);
      const vary =
        (variance[i00] * sa + variance[i10] * sb + variance[i01] * sc + variance[i11] * sd) * inv;
      const tintV = tint[i00] * wa + tint[i10] * wb + tint[i01] * wc + tint[i11] * wd;
      let n = sampleNoise(fieldC, wx * 14, wz * 14);
      if (vary > 0.22) n = n * 0.6 + 0.4 * sampleNoise(fieldC, wx * 20, wz * 5);
      const grain = 1 + vary * (n - 0.5) * 2;
      r *= grain;
      g *= grain;
      b *= grain;
      if (useArt && art) {
        let topI = i00;
        let topW = sa;
        if (sb > topW) {
          topI = i10;
          topW = sb;
        }
        if (sc > topW) {
          topI = i01;
          topW = sc;
        }
        if (sd > topW) {
          topI = i11;
          topW = sd;
        }
        const tex = art[kinds[topI]];
        if (tex) {
          const share = tex.strength * topW * inv;
          const [tr, tg, tb] = sampleTex(tex, wx, wz);
          r = r * (1 - share) + tr * share;
          g = g * (1 - share) + tg * share;
          b = b * (1 - share) + tb * share;
        }
      }
      const tintMul = 1 + tintV;
      r *= tintMul;
      g *= tintMul;
      b *= tintMul;
      if (wat > 0.04 && wat < 0.96) {
        const sd0 = (wat - 0.26) / 0.16;
        const sand = Math.exp(-sd0 * sd0);
        const fd = (wat - 0.5) / 0.16;
        const foam = Math.exp(-fd * fd) * (0.55 + 0.45 * n);
        const ks = sand * 0.84;
        r = r * (1 - ks) + SAND_R * ks;
        g = g * (1 - ks) + SAND_G * ks;
        b = b * (1 - ks) + SAND_B * ks;
        const kf = foam * 0.8;
        r = r * (1 - kf) + FOAM_R * kf;
        g = g * (1 - kf) + FOAM_G * kf;
        b = b * (1 - kf) + FOAM_B * kf;
      }
      let dark = Math.max(0, wat - 0.6) * 0.35 + deep * 0.16;
      if (dark > 0.55) dark = 0.55;
      const light = 0.93 + 0.08 * Math.sin(-(wx + wz) * 0.02) + 0.06 * w1;
      const shade = (1 - dark) * light;
      r *= shade;
      g *= shade;
      b *= shade;
      const at = (row + px) * 4;
      pixels[at] = r < 0 ? 0 : r > 255 ? 255 : r | 0;
      pixels[at + 1] = g < 0 ? 0 : g > 255 ? 255 : g | 0;
      pixels[at + 2] = b < 0 ? 0 : b > 255 ? 255 : b | 0;
      pixels[at + 3] = 255;
    }
  }
}

export interface BakedChunkImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  screenW: number;
  screenH: number;
  originX: number;
  originY: number;
}

/** Bake one chunk to completion. Used by tests and the frame slicer. */
export function bakeChunkImage(cx: number, cz: number): BakedChunkImage {
  const chunk = buildChunk(cx, cz, sampleCorner);
  shadeRows(chunk, 0, chunk.srcH, null);
  return {
    data: chunk.pixels as Uint8ClampedArray,
    width: chunk.srcW,
    height: chunk.srcH,
    screenW: chunk.screenW,
    screenH: chunk.screenH,
    originX: chunk.originX,
    originY: chunk.originY,
  };
}

function snapshotTexture(
  image: CanvasImageSource,
  strength: number,
  repeat: number,
): TexEntry | null {
  const w = "width" in image ? Number(image.width) : 0;
  const h = "height" in image ? Number(image.height) : 0;
  if (!w || !h || typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.drawImage(image, 0, 0, w, h);
  return { data: g.getImageData(0, 0, w, h).data, w, h, strength, repeat };
}

interface DecalDraw {
  image: CanvasImageSource;
  rate: number;
  size: number;
  salt: number;
}

function paintDecals(
  ctx: CanvasRenderingContext2D,
  chunk: ChunkWork,
  decals: Map<number, DecalDraw[]>,
): void {
  if (decals.size === 0) return;
  const { wx0, wz0, wx1, wz1, originX, originY } = chunk;
  const x0 = Math.floor(wx0 + 0.5);
  const x1 = Math.floor(wx1 + 0.5);
  const z0 = Math.floor(wz0 + 0.5);
  const z1 = Math.floor(wz1 + 0.5);
  for (let z = z0; z < z1; z++) {
    for (let x = x0; x < x1; x++) {
      const sample = sampleCorner(x, z);
      if (NO_DECAL.has(sample.kind)) continue;
      const list = decals.get(kindId(sample.kind));
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const decal = list[i];
        if (hashUnit(x, z, decal.salt) > decal.rate) continue;
        const jx = (hashUnit(x, z, decal.salt + 5) - 0.5) * 0.6;
        const jz = (hashUnit(x, z, decal.salt + 9) - 0.5) * 0.6;
        const wx = x + jx;
        const wz = z + jz;
        const baseX = (wx - wz) * 24;
        const baseY = (wx + wz) * 12;
        const px = (baseX - originX) / STEP;
        const py = (baseY - originY) / STEP;
        const size = Math.max(1, decal.size / STEP);
        ctx.drawImage(decal.image, px - size / 2, py - size / 2, size, size);
      }
    }
  }
}

function rectHits(metrics: ChunkMetrics, view: GroundView): boolean {
  const sx = metrics.originX + view.viewW / 2 - view.camX;
  const sy = metrics.originY + view.viewH / 2 - 20 - view.camZ;
  return (
    sx < view.viewW + 8 &&
    sx + metrics.screenW > -8 &&
    sy < view.viewH + 8 &&
    sy + metrics.screenH > -8
  );
}

export interface GroundRenderer {
  draw(ctx: CanvasRenderingContext2D, view: GroundView): GroundCost;
  setTerrainArt(kind: string, art: TerrainArt | null): void;
  invalidate(cx?: number, cz?: number): void;
  cost(): GroundCost;
}

export function createGround(): GroundRenderer {
  ensureNoise();
  const cache = new Map<string, ChunkWork>();
  const order: string[] = [];
  const corners = new Map<number, CornerSample>();
  const textures: Array<TexEntry | undefined> = [];
  const decals = new Map<number, DecalDraw[]>();
  let artOn = false;
  let decalSalt = 1;
  let last: GroundCost = { diamonds: 0, blits: 0, baked: 0, bakeMs: 0, pending: 0 };

  function cornerOf(x: number, z: number): CornerSample {
    const key = (x + 1024) * 4096 + (z + 1024);
    let hit = corners.get(key);
    if (!hit) {
      hit = sampleCorner(x, z);
      corners.set(key, hit);
    }
    return hit;
  }

  function dropKey(key: string): void {
    cache.delete(key);
    const at = order.indexOf(key);
    if (at >= 0) order.splice(at, 1);
  }

  function touch(key: string): void {
    const at = order.indexOf(key);
    if (at >= 0) order.splice(at, 1);
    order.push(key);
  }

  function finish(chunk: ChunkWork): void {
    if (typeof document === "undefined" || !chunk.pixels) {
      chunk.ready = true;
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = chunk.srcW;
    canvas.height = chunk.srcH;
    const g = canvas.getContext("2d");
    if (!g) return;
    const image = g.createImageData(chunk.srcW, chunk.srcH);
    image.data.set(chunk.pixels);
    g.putImageData(image, 0, 0);
    if (decals.size > 0) paintDecals(g, chunk, decals);
    chunk.canvas = canvas;
    chunk.pixels = null;
    chunk.ready = true;
  }

  function advance(chunk: ChunkWork, budget: number): void {
    const t0 = performance.now();
    const art = artOn ? textures : null;
    while (chunk.row < chunk.srcH && performance.now() - t0 < budget) {
      const end = Math.min(chunk.srcH, chunk.row + 16);
      shadeRows(chunk, chunk.row, end, art);
      chunk.row = end;
    }
    if (chunk.row >= chunk.srcH) finish(chunk);
  }

  function visible(view: GroundView): Array<{ key: string; cx: number; cz: number; dist: number }> {
    const x0 = Math.max(BOUNDS.minX, Math.floor(view.minX) - 1);
    const x1 = Math.min(BOUNDS.maxX, Math.ceil(view.maxX) + 1);
    const z0 = Math.max(BOUNDS.minZ, Math.floor(view.minZ) - 1);
    const z1 = Math.min(BOUNDS.maxZ, Math.ceil(view.maxZ) + 1);
    const list: Array<{ key: string; cx: number; cz: number; dist: number }> = [];
    if (x1 < x0 || z1 < z0) return list;
    const midX = (view.minX + view.maxX) * 0.5;
    const midZ = (view.minZ + view.maxZ) * 0.5;
    const c0 = Math.floor(x0 / GROUND_CHUNK);
    const c1 = Math.floor(x1 / GROUND_CHUNK);
    const d0 = Math.floor(z0 / GROUND_CHUNK);
    const d1 = Math.floor(z1 / GROUND_CHUNK);
    for (let cz = d0; cz <= d1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const metrics = chunkMetrics(cx, cz);
        if (!rectHits(metrics, view)) continue;
        const dx = (cx + 0.5) * GROUND_CHUNK - midX;
        const dz = (cz + 0.5) * GROUND_CHUNK - midZ;
        list.push({ key: `${cx},${cz}`, cx, cz, dist: dx * dx + dz * dz });
      }
    }
    list.sort((a, b) => a.dist - b.dist);
    return list;
  }

  function evict(keep: Set<string>): void {
    let i = 0;
    while (cache.size > LRU_CAP && i < order.length) {
      const key = order[i];
      if (keep.has(key)) {
        i++;
        continue;
      }
      dropKey(key);
    }
  }

  return {
    draw(ctx, view) {
      const x0 = Math.max(BOUNDS.minX, Math.floor(view.minX) - 1);
      const x1 = Math.min(BOUNDS.maxX, Math.ceil(view.maxX) + 1);
      const z0 = Math.max(BOUNDS.minZ, Math.floor(view.minZ) - 1);
      const z1 = Math.min(BOUNDS.maxZ, Math.ceil(view.maxZ) + 1);
      const diamonds = Math.max(0, x1 - x0 + 1) * Math.max(0, z1 - z0 + 1);
      const want = visible(view);
      const keep = new Set<string>();
      let spent = 0;
      let slices = 0;
      let baked = 0;
      let pending = 0;
      for (let i = 0; i < want.length; i++) {
        const item = want[i];
        keep.add(item.key);
        let chunk = cache.get(item.key);
        if (!chunk) {
          if (spent >= FRAME_BAKE_MS || slices >= MAX_SLICES) {
            pending++;
            continue;
          }
          const t0 = performance.now();
          chunk = buildChunk(item.cx, item.cz, cornerOf);
          cache.set(item.key, chunk);
          spent += performance.now() - t0;
          slices++;
        }
        touch(item.key);
        if (!chunk.ready) {
          if (spent < FRAME_BAKE_MS && slices < MAX_SLICES) {
            const t0 = performance.now();
            advance(chunk, FRAME_BAKE_MS - spent);
            spent += performance.now() - t0;
            slices++;
            if (chunk.ready) baked++;
          }
          if (!chunk.ready) pending++;
        }
      }
      ctx.imageSmoothingEnabled = false;
      let blits = 0;
      for (let i = want.length - 1; i >= 0; i--) {
        const chunk = cache.get(want[i].key);
        if (!chunk?.ready || !chunk.canvas) continue;
        const sx = chunk.originX + view.viewW / 2 - view.camX;
        const sy = chunk.originY + view.viewH / 2 - 20 - view.camZ;
        ctx.drawImage(chunk.canvas, sx, sy, chunk.screenW, chunk.screenH);
        blits++;
      }
      evict(keep);
      last = { diamonds, blits, baked, bakeMs: spent, pending };
      return last;
    },
    setTerrainArt(kind, art) {
      const id = kindId(kind);
      if (!art) {
        textures[id] = undefined;
        decals.delete(id);
      } else {
        textures[id] = art.texture
          ? (snapshotTexture(art.texture, art.strength ?? 1, art.repeat ?? 4) ?? undefined)
          : undefined;
        if (art.decals && art.decals.length > 0 && !NO_DECAL.has(kind)) {
          decals.set(
            id,
            art.decals.map((decal) => ({
              image: decal.image,
              rate: decal.rate,
              size: decal.size,
              salt: decalSalt++,
            })),
          );
        } else {
          decals.delete(id);
        }
      }
      artOn = textures.some((tex) => tex !== undefined);
      cache.clear();
      order.length = 0;
    },
    invalidate(cx, cz) {
      if (cx === undefined || cz === undefined) {
        cache.clear();
        order.length = 0;
        corners.clear();
        return;
      }
      dropKey(`${cx},${cz}`);
      const x0 = cx * GROUND_CHUNK - 3;
      const z0 = cz * GROUND_CHUNK - 3;
      for (let z = z0; z < z0 + GROUND_CHUNK + 6; z++) {
        for (let x = x0; x < x0 + GROUND_CHUNK + 6; x++)
          corners.delete((x + 1024) * 4096 + (z + 1024));
      }
    },
    cost() {
      return last;
    },
  };
}
