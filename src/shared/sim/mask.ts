import {
  BOUNDS,
  ISLANDS,
  LAKES,
  LIVE_CAMPS,
  PROPOSED_CAMPS,
  PHASE1_ROADS,
  WORLD_CITIES,
  ZONES,
  insideIsland,
  type ZoneDef,
} from "../content/world";

/**
 * Lazy land mask. Cells outside an island box stay 0 (deep water).
 * Overlay order matches the plan: island, lake, road, plaza, camp dirt.
 * The Reach painter in geo.tileFill still draws the home isle, so this grid
 * does not change those pixels.
 */

const W = BOUNDS.maxX - BOUNDS.minX + 1;
const H = BOUNDS.maxZ - BOUNDS.minZ + 1;

const DEEP = 0;
const WATER = 1;
const BEACH = 2;
const LAKE = 3;
const ROAD = 4;
const PLAZA = 5;
const CAMP = 6;
const BASE = 7;

const TERRAIN_NAME = [
  "deep",
  "water",
  "beach",
  "lake",
  "road",
  "plaza",
  "camp",
  "meadow",
  "forest",
  "moor",
  "highland",
  "scrub",
  "marsh",
  "bog",
  "snow",
  "taiga",
  "ice",
  "desert",
  "saltflat",
  "barrow",
  "ash",
  "lava",
  "hub",
];

const TERRAIN_CODE: Record<string, number> = {};
TERRAIN_NAME.forEach((name, i) => {
  TERRAIN_CODE[name] = i;
});

let land: Uint8Array | null = null;
let terrain: Uint8Array | null = null;
let zoneIx: Uint8Array | null = null;
let buildMs = 0;

function cellIndex(x: number, z: number) {
  return (z - BOUNDS.minZ) * W + (x - BOUNDS.minX);
}

function insideGrid(x: number, z: number) {
  return x >= BOUNDS.minX && x <= BOUNDS.maxX && z >= BOUNDS.minZ && z <= BOUNDS.maxZ;
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function islandBox(index: number) {
  const isl = ISLANDS[index];
  const box = isl.footprint?.bbox;
  if (box) return { minX: box[0], minZ: box[1], maxX: box[2], maxZ: box[3] };
  const rad = Math.ceil(Math.max(isl.r ?? 0, isl.rx ?? 0, isl.rz ?? 0) + 4);
  return {
    minX: Math.floor(isl.cx - rad),
    minZ: Math.floor(isl.cz - rad),
    maxX: Math.ceil(isl.cx + rad),
    maxZ: Math.ceil(isl.cz + rad),
  };
}

function ensure() {
  if (land && terrain && zoneIx) return;
  const started = performance.now();
  land = new Uint8Array(W * H);
  terrain = new Uint8Array(W * H);
  zoneIx = new Uint8Array(W * H);
  const zonesByIsland = new Map<string, Array<{ index: number; sx: number; sz: number; terrain: number }>>();
  ZONES.forEach((zone, index) => {
    const list = zonesByIsland.get(zone.island) ?? [];
    list.push({
      index,
      sx: zone.seed[0],
      sz: zone.seed[1],
      terrain: TERRAIN_CODE[zone.terrain] ?? TERRAIN_CODE.hub,
    });
    zonesByIsland.set(zone.island, list);
  });
  const edges: number[] = [];
  const hubCode = TERRAIN_CODE.hub;
  for (let i = 0; i < ISLANDS.length; i++) {
    const isl = ISLANDS[i];
    const box = islandBox(i);
    const zones = zonesByIsland.get(isl.id) ?? [];
    const x0 = Math.max(BOUNDS.minX, box.minX);
    const x1 = Math.min(BOUNDS.maxX, box.maxX);
    const z0 = Math.max(BOUNDS.minZ, box.minZ);
    const z1 = Math.min(BOUNDS.maxZ, box.maxZ);
    const only = zones.length === 1 ? zones[0] : null;
    const circle = isl.shape === "circle";
    const rad = isl.r ?? 0;
    const inner = rad - 1.5;
    for (let z = z0; z <= z1; z++) {
      const row = (z - BOUNDS.minZ) * W;
      for (let x = x0; x <= x1; x++) {
        if (circle) {
          const dx = x - isl.cx;
          const dz = z - isl.cz;
          const d2 = dx * dx + dz * dz;
          if (d2 > rad * rad) continue;
          const at = row + (x - BOUNDS.minX);
          land[at] = i + 1;
          if (only) {
            zoneIx[at] = only.index + 1;
            terrain[at] = only.terrain;
          } else {
            let best = 0;
            let bestD = Infinity;
            let bestT = hubCode;
            for (let k = 0; k < zones.length; k++) {
              const zone = zones[k];
              const d = (x - zone.sx) * (x - zone.sx) + (z - zone.sz) * (z - zone.sz);
              if (d < bestD) {
                bestD = d;
                best = zone.index + 1;
                bestT = zone.terrain;
              }
            }
            zoneIx[at] = best;
            terrain[at] = bestT;
          }
          if (d2 >= inner * inner) edges.push(at);
          continue;
        }
        if (!insideIsland(isl, x, z)) continue;
        const at = row + (x - BOUNDS.minX);
        land[at] = i + 1;
        if (only) {
          zoneIx[at] = only.index + 1;
          terrain[at] = only.terrain;
        } else {
          let best = 0;
          let bestD = Infinity;
          let bestT = hubCode;
          for (let k = 0; k < zones.length; k++) {
            const zone = zones[k];
            const d = (x - zone.sx) * (x - zone.sx) + (z - zone.sz) * (z - zone.sz);
            if (d < bestD) {
              bestD = d;
              best = zone.index + 1;
              bestT = zone.terrain;
            }
          }
          zoneIx[at] = best;
          terrain[at] = bestT;
        }
      }
    }
  }
  for (const lake of LAKES) {
    const r = Math.ceil(lake.r);
    for (let z = Math.floor(lake.z) - r; z <= Math.ceil(lake.z) + r; z++) {
      for (let x = Math.floor(lake.x) - r; x <= Math.ceil(lake.x) + r; x++) {
        if (!insideGrid(x, z) || Math.hypot(x - lake.x, z - lake.z) >= lake.r) continue;
        const at = cellIndex(x, z);
        if (!land[at]) continue;
        terrain[at] = LAKE;
      }
    }
  }
  for (const [ax, az, bx, bz] of PHASE1_ROADS) {
    const minX = Math.floor(Math.min(ax, bx) - 3);
    const maxX = Math.ceil(Math.max(ax, bx) + 3);
    const minZ = Math.floor(Math.min(az, bz) - 3);
    const maxZ = Math.ceil(Math.max(az, bz) + 3);
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (!insideGrid(x, z) || segDist(x, z, ax, az, bx, bz) >= 1.75) continue;
        const at = cellIndex(x, z);
        if (!land[at]) continue;
        terrain[at] = ROAD;
      }
    }
  }
  for (const city of WORLD_CITIES) {
    const r = 7;
    for (let z = Math.floor(city.z) - r; z <= Math.ceil(city.z) + r; z++) {
      for (let x = Math.floor(city.x) - r; x <= Math.ceil(city.x) + r; x++) {
        if (!insideGrid(x, z) || Math.hypot(x - city.x, z - city.z) >= 6.4) continue;
        const at = cellIndex(x, z);
        if (!land[at]) continue;
        terrain[at] = PLAZA;
      }
    }
  }
  for (const camp of [...LIVE_CAMPS, ...PROPOSED_CAMPS]) {
    const r = 4;
    for (let z = Math.floor(camp.cz) - r; z <= Math.ceil(camp.cz) + r; z++) {
      for (let x = Math.floor(camp.cx) - r; x <= Math.ceil(camp.cx) + r; x++) {
        if (!insideGrid(x, z) || Math.hypot(x - camp.cx, z - camp.cz) >= 3.4) continue;
        const at = cellIndex(x, z);
        if (!land[at]) continue;
        terrain[at] = CAMP;
      }
    }
  }
  const landArr = land;
  const terr = terrain;
  for (let i = 0; i < ISLANDS.length; i++) {
    if (ISLANDS[i].shape === "circle") continue;
    const box = islandBox(i);
    const x0 = Math.max(BOUNDS.minX, box.minX);
    const x1 = Math.min(BOUNDS.maxX, box.maxX);
    const z0 = Math.max(BOUNDS.minZ, box.minZ);
    const z1 = Math.min(BOUNDS.maxZ, box.maxZ);
    for (let z = z0; z <= z1; z++) {
      const row = (z - BOUNDS.minZ) * W;
      for (let x = x0; x <= x1; x++) {
        const at = row + (x - BOUNDS.minX);
        if (landArr[at] === 0) continue;
        if (
          x === x0 ||
          z === z0 ||
          x === x1 ||
          z === z1 ||
          landArr[at - 1] === 0 ||
          landArr[at + 1] === 0 ||
          landArr[at - W] === 0 ||
          landArr[at + W] === 0
        ) {
          edges.push(at);
        }
      }
    }
  }
  const qx = new Int16Array(80000);
  const qz = new Int16Array(80000);
  const qd = new Uint8Array(80000);
  let qh = 0;
  let qt = 0;
  const seen = new Uint8Array(W * H);
  for (let e = 0; e < edges.length; e++) {
    const at = edges[e];
    const x = (at % W) + BOUNDS.minX;
    const z = ((at / W) | 0) + BOUNDS.minZ;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const nz = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < BOUNDS.minX || nx > BOUNDS.maxX || nz < BOUNDS.minZ || nz > BOUNDS.maxZ) continue;
      const ni = (nz - BOUNDS.minZ) * W + (nx - BOUNDS.minX);
      if (landArr[ni] || seen[ni]) continue;
      seen[ni] = 1;
      terr[ni] = WATER;
      qx[qt] = nx;
      qz[qt] = nz;
      qd[qt] = 1;
      qt++;
    }
  }
  while (qh < qt) {
    const x = qx[qh];
    const z = qz[qh];
    const d = qd[qh];
    qh++;
    if (d >= 8) continue;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const nz = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < BOUNDS.minX || nx > BOUNDS.maxX || nz < BOUNDS.minZ || nz > BOUNDS.maxZ) continue;
      const ni = (nz - BOUNDS.minZ) * W + (nx - BOUNDS.minX);
      if (landArr[ni] || seen[ni]) continue;
      seen[ni] = 1;
      terr[ni] = WATER;
      qx[qt] = nx;
      qz[qt] = nz;
      qd[qt] = d + 1;
      qt++;
    }
  }
  qh = 0;
  qt = 0;
  seen.fill(0);
  for (let e = 0; e < edges.length; e++) {
    const at = edges[e];
    if (terr[at] >= BASE) terr[at] = BEACH;
    seen[at] = 1;
    qx[qt] = (at % W) + BOUNDS.minX;
    qz[qt] = ((at / W) | 0) + BOUNDS.minZ;
    qd[qt] = 0;
    qt++;
  }
  while (qh < qt) {
    const x = qx[qh];
    const z = qz[qh];
    const d = qd[qh];
    qh++;
    if (d >= 2) continue;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const nz = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < BOUNDS.minX || nx > BOUNDS.maxX || nz < BOUNDS.minZ || nz > BOUNDS.maxZ) continue;
      const ni = (nz - BOUNDS.minZ) * W + (nx - BOUNDS.minX);
      if (!landArr[ni] || seen[ni] || terr[ni] < BASE) continue;
      seen[ni] = 1;
      terr[ni] = BEACH;
      qx[qt] = nx;
      qz[qt] = nz;
      qd[qt] = d + 1;
      qt++;
    }
  }
  buildMs = performance.now() - started;
}

export function isLand(x: number, z: number) {
  ensure();
  const ix = Math.round(x);
  const iz = Math.round(z);
  if (!insideGrid(ix, iz) || !land) return false;
  return land[cellIndex(ix, iz)] !== 0;
}

export function terrainAt(x: number, z: number) {
  ensure();
  const ix = Math.round(x);
  const iz = Math.round(z);
  if (!insideGrid(ix, iz) || !terrain) return "deep";
  return TERRAIN_NAME[terrain[cellIndex(ix, iz)]] ?? "deep";
}

export function zoneAt(x: number, z: number): ZoneDef | null {
  ensure();
  const ix = Math.round(x);
  const iz = Math.round(z);
  if (!insideGrid(ix, iz) || !zoneIx) return null;
  const id = zoneIx[cellIndex(ix, iz)];
  return id ? ZONES[id - 1] ?? null : null;
}

export function maskBuildMs() {
  ensure();
  return buildMs;
}
