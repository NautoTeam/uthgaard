import raw from "./world.json";

/**
 * Phase-1 world data. The live isle still builds only the three Reach cities,
 * their roads, and the six camps. Wardstone, Stiltwick, and the new camps
 * stay in these exports until the land mask is turned on.
 * hash01 matches geo.ts hash so island edges stay stable.
 */

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface IslandDef {
  id: string;
  name: string;
  theme: string;
  shape: "circle" | "blob";
  cx: number;
  cz: number;
  r?: number;
  rx?: number;
  rz?: number;
  rot?: number;
  seed?: number;
  lobes?: Array<[number, number]>;
}

export interface ZoneDef {
  id: string;
  name: string;
  island: string;
  seed: [number, number];
  levels: [number, number];
  pvp: boolean;
  terrain: string;
}

export interface WorldCity {
  id: string;
  name: string;
  x: number;
  z: number;
  race: "human" | "elf" | "minotaur";
  stone: string;
  stoneAlt: string;
  island?: string;
  zone?: string | null;
  kind?: string;
  phase?: number;
}

export interface WorldCamp {
  type: string;
  level: number;
  count: number;
  cx: number;
  cz: number;
  zone?: string;
  phase?: number;
  named?: boolean;
}

export interface GateDef {
  cityId: string;
  circuits: string[];
  hub?: boolean;
}

export interface CircuitDef {
  id: string;
  name: string;
  color: string;
  minLevel: number;
  attune: boolean;
  firstHopFrom?: string;
}

export interface LinkDef {
  from: string;
  to: string;
  circuit: string;
}

interface WorldFile {
  bounds: Bounds;
  phases: { phase1_cap25: string[] };
  islands: IslandDef[];
  zones: ZoneDef[];
  cities: WorldCity[];
  camps: WorldCamp[];
  proposedCamps: WorldCamp[];
  roads: Array<[number, number, number, number]>;
  lakes: Array<{ x: number; z: number; r: number }>;
  gates: GateDef[];
  circuits: CircuitDef[];
  links: LinkDef[];
  terrainPalette: Record<string, [string, string]>;
}

const file = raw as unknown as WorldFile;

const PHASE1_ISLANDS = new Set(file.phases.phase1_cap25);

export const BOUNDS: Bounds = file.bounds;
export const ISLANDS: IslandDef[] = file.islands.filter((row) => PHASE1_ISLANDS.has(row.id));
export const ZONES: ZoneDef[] = file.zones.filter((row) => PHASE1_ISLANDS.has(row.island));
export const WORLD_CITIES: WorldCity[] = file.cities.filter((row) => (row.phase ?? 1) <= 1);
export const LIVE_CITY_IDS = ["uthgaard", "eldenreach", "hornwatch"] as const;
export const LIVE_CITIES: WorldCity[] = LIVE_CITY_IDS.map((id) => {
  const city = WORLD_CITIES.find((row) => row.id === id);
  if (!city) throw new Error(`Missing live city ${id}`);
  return city;
});

const liveIds = new Set<string>(LIVE_CITY_IDS);
function touchesLive(x: number, z: number) {
  return LIVE_CITIES.some((city) => Math.hypot(city.x - x, city.z - z) < 1.5);
}

export const ROADS: Array<[number, number, number, number]> = file.roads.filter(
  ([ax, az, bx, bz]) => touchesLive(ax, az) && touchesLive(bx, bz),
);
export const LAKES = file.lakes.map((lake) => ({ ...lake }));

const phase1Ids = new Set(WORLD_CITIES.map((city) => city.id));
export const GATES: GateDef[] = file.gates.filter((gate) => phase1Ids.has(gate.cityId));
const circuitIds = new Set(GATES.flatMap((gate) => gate.circuits));
export const CIRCUITS: CircuitDef[] = file.circuits.filter((row) => circuitIds.has(row.id) && row.id !== "ember");
export const LINKS: LinkDef[] = file.links.filter(
  (link) => phase1Ids.has(link.from) && phase1Ids.has(link.to) && link.circuit !== "ember",
);

export const LIVE_CAMPS: WorldCamp[] = file.camps.map((camp) => ({
  type: camp.type,
  level: camp.level,
  count: camp.count,
  cx: camp.cx,
  cz: camp.cz,
}));
export const PROPOSED_CAMPS: WorldCamp[] = file.proposedCamps.filter((camp) => (camp.phase ?? 1) <= 1);

export const TERRAIN_PALETTE = file.terrainPalette;

export const WORLD = {
  bounds: BOUNDS,
  islands: ISLANDS,
  zones: ZONES,
  cities: WORLD_CITIES,
  gates: GATES,
  circuits: CIRCUITS,
  links: LINKS,
  camps: LIVE_CAMPS,
  proposedCamps: PROPOSED_CAMPS,
  roads: file.roads,
  lakes: LAKES,
  terrainPalette: TERRAIN_PALETTE,
};

function hash01(e: number) {
  const t = Math.sin(e * 127.1) * 43758.5453;
  return t - Math.floor(t);
}

export function insideIsland(isl: IslandDef, x: number, z: number) {
  if (isl.shape === "circle") return Math.hypot(x - isl.cx, z - isl.cz) <= (isl.r ?? 0);
  const dx = x - isl.cx;
  const dz = z - isl.cz;
  const rot = isl.rot ?? 0;
  const c = Math.cos(-rot);
  const s = Math.sin(-rot);
  const nx = (dx * c - dz * s) / (isl.rx || 1);
  const nz = (dx * s + dz * c) / (isl.rz || 1);
  const d = Math.hypot(nx, nz);
  if (d > 1.6) return false;
  const th = Math.atan2(nz, nx);
  let edge = 1;
  for (const [k, amp] of isl.lobes ?? []) edge += amp * Math.sin(k * th + hash01((isl.seed ?? 0) * 10 + k) * Math.PI * 2);
  return d <= edge;
}

export function islandAt(x: number, z: number) {
  return ISLANDS.find((isl) => insideIsland(isl, x, z)) ?? null;
}

export function zoneAt(x: number, z: number) {
  const isl = islandAt(x, z);
  if (!isl) return null;
  let best: ZoneDef | null = null;
  let bestD = Infinity;
  for (const zone of ZONES) {
    if (zone.island !== isl.id) continue;
    const d = Math.hypot(x - zone.seed[0], z - zone.seed[1]);
    if (d < bestD) {
      best = zone;
      bestD = d;
    }
  }
  return best;
}
