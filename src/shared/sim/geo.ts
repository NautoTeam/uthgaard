import { CAMPS, clampCoord } from "./types";

export const LAND = 150;
export const WORLD_EDGE = 168;

export interface CityDef {
  id: string;
  name: string;
  x: number;
  z: number;
  race: "human" | "elf" | "minotaur";
  stone: string;
  stoneAlt: string;
}

export const CITIES: CityDef[] = [
  { id: "uthgaard", name: "Uthgaard", x: 0, z: 0, race: "human", stone: "#7a6546", stoneAlt: "#6d5a3e" },
  { id: "eldenreach", name: "Eldenreach", x: 118, z: -28, race: "elf", stone: "#6d8660", stoneAlt: "#5c7454" },
  { id: "hornwatch", name: "Hornwatch", x: -86, z: 102, race: "minotaur", stone: "#6e5646", stoneAlt: "#5c4638" },
];

export const ROADS: Array<[number, number, number, number]> = [
  [0, 0, 118, -28],
  [0, 0, -86, 102],
  [118, -28, -86, 102],
];

export const LAKES = [
  { x: 74, z: 64, r: 11 },
  { x: -62, z: -46, r: 9 },
  { x: 28, z: -68, r: 7 },
];

export interface Hall {
  x: number;
  z: number;
  scale: number;
}

export interface NpcDef {
  id: string;
  name: string;
  city: string;
  x: number;
  z: number;
  race: "human" | "elf" | "minotaur";
}

export const HALLS: Hall[] = [];
export const TREES: Array<[number, number]> = [];
export const FIRES: Array<[number, number]> = [];
export const NPCS: NpcDef[] = [];
export const SOLIDS: Array<{ x: number; z: number; r: number }> = [];

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

export function onRoad(x: number, z: number, width = 1.75) {
  return ROADS.some(([ax, az, bx, bz]) => segDist(x, z, ax, az, bx, bz) < width);
}

function inLake(x: number, z: number, pad = 0) {
  return LAKES.some((lake) => Math.hypot(x - lake.x, z - lake.z) < lake.r + pad);
}

function hash(n: number) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

for (const city of CITIES) {
  const angles: number[] = [];
  for (const [ax, az, bx, bz] of ROADS) {
    const atStart = Math.hypot(ax - city.x, az - city.z) < 1;
    const atEnd = Math.hypot(bx - city.x, bz - city.z) < 1;
    if (!atStart && !atEnd) continue;
    const dx = atStart ? bx - ax : ax - bx;
    const dz = atStart ? bz - az : az - bz;
    angles.push(Math.atan2(dz, dx));
  }
  angles.sort((a, b) => a - b);
  const gaps: Array<{ mid: number; span: number }> = [];
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i];
    const b = angles[(i + 1) % angles.length] + (i + 1 === angles.length ? Math.PI * 2 : 0);
    gaps.push({ mid: (a + b) / 2, span: b - a });
  }
  gaps.sort((a, b) => b.span - a.span);
  const hallAngles = [gaps[0].mid - gaps[0].span * 0.28, gaps[0].mid + gaps[0].span * 0.28, gaps[1].mid];
  const big = city.race === "minotaur" ? 0.05 : 0;
  const hallDist = 11.4;
  hallAngles.forEach((a, i) => {
    let x = city.x + Math.cos(a) * hallDist;
    let z = city.z + Math.sin(a) * hallDist;
    for (let n = 0; n < 14 && onRoad(x, z, 5.2); n++) {
      let nearX = x;
      let nearZ = z;
      let nearD = 99;
      for (const [ax, az, bx, bz] of ROADS) {
        const d = segDist(x, z, ax, az, bx, bz);
        if (d < nearD) {
          nearD = d;
          const dx = bx - ax;
          const dz = bz - az;
          const len2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
          nearX = ax + t * dx;
          nearZ = az + t * dz;
        }
      }
      const len = nearD || 1;
      x += ((x - nearX) / len) * 1.5;
      z += ((z - nearZ) / len) * 1.5;
    }
    HALLS.push({
      x,
      z,
      scale: (i === 0 ? 0.38 : i === 1 ? 0.32 : 0.3) + big,
    });
  });
  FIRES.push(
    [city.x + Math.cos(gaps[0].mid + 0.85) * 8.2, city.z + Math.sin(gaps[0].mid + 0.85) * 8.2],
    [city.x + Math.cos(gaps[1].mid - 0.85) * 8.2, city.z + Math.sin(gaps[1].mid - 0.85) * 8.2],
  );
  const npcA = gaps[0].mid;
  NPCS.push({
    id: `wayfarer-${city.id}`,
    name: "Wayfarer",
    city: city.id,
    x: city.x + Math.cos(npcA) * 4.6,
    z: city.z + Math.sin(npcA) * 4.6,
    race: city.race,
  });
  const ring = city.race === "elf" ? 14 : 10;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2 + 0.35;
    const rad = city.race === "elf" ? 16 : 15.5;
    const x = city.x + Math.cos(a) * rad;
    const z = city.z + Math.sin(a) * rad;
    if (onRoad(x, z, 2.8)) continue;
    if (HALLS.some((h) => Math.hypot(h.x - x, h.z - z) < 4.2)) continue;
    TREES.push([x, z]);
  }
}

for (let i = 0; i < 96; i++) {
  const x = (hash(i + 3) * 2 - 1) * 138;
  const z = (hash(i + 90) * 2 - 1) * 138;
  if (Math.hypot(x, z) > LAND - 10) continue;
  if (CITIES.some((c) => Math.hypot(x - c.x, z - c.z) < 14)) continue;
  if (onRoad(x, z, 2.8)) continue;
  if (inLake(x, z, 2)) continue;
  if (CAMPS.some((c) => Math.hypot(x - c.cx, z - c.cz) < 5)) continue;
  TREES.push([Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
}

for (const hall of HALLS) {
  const w = 494 * hall.scale;
  const h = 420 * hall.scale;
  for (let sy = -(h - 36); sy <= 2; sy += 16) {
    for (let sx = -w * 0.36; sx <= w * 0.36; sx += 18) {
      const dx = (sx / 24 + sy / 12) / 2;
      const dz = (sy / 12 - sx / 24) / 2;
      const x = hall.x + dx;
      const z = hall.z + dz;
      if (onRoad(x, z, 1.25)) continue;
      if (CITIES.some((c) => Math.hypot(c.x - x, c.z - z) < 3.5)) continue;
      if (NPCS.some((n) => Math.hypot(n.x - x, n.z - z) < 2.5)) continue;
      SOLIDS.push({ x, z, r: 0.95 });
    }
  }
}
for (const [x, z] of TREES) SOLIDS.push({ x, z, r: 0.85 });
for (const [x, z] of FIRES) SOLIDS.push({ x, z, r: 0.7 });

export function blocked(x: number, z: number) {
  if (Math.hypot(x, z) > LAND) return true;
  if (inLake(x, z)) return true;
  for (const s of SOLIDS) {
    const dx = x - s.x;
    const dz = z - s.z;
    if (dx * dx + dz * dz < s.r * s.r) return true;
  }
  return false;
}

export function resolveMove(x: number, z: number, nx: number, nz: number) {
  nx = clampCoord(nx);
  nz = clampCoord(nz);
  if (!blocked(nx, nz)) return { x: nx, z: nz };
  if (!blocked(nx, z)) return { x: nx, z };
  if (!blocked(x, nz)) return { x, z: nz };
  return { x, z };
}

export function nearestOpen(x: number, z: number) {
  if (!blocked(x, z)) return { x, z };
  for (let r = 0.6; r <= 10; r += 0.6) {
    for (let a = 0; a < 12; a++) {
      const nx = x + Math.cos((a / 12) * Math.PI * 2) * r;
      const nz = z + Math.sin((a / 12) * Math.PI * 2) * r;
      if (!blocked(nx, nz)) return { x: nx, z: nz };
    }
  }
  return { x: 0, z: 0 };
}

/** Pixel gap between two footprints in the isometric view (tile is 48×24). */
export function screenGap(x1: number, z1: number, x2: number, z2: number) {
  const dx = x1 - x2;
  const dz = z1 - z2;
  return Math.hypot((dx - dz) * 24, (dx + dz) * 12);
}

export function underHall(x: number, z: number) {
  for (const hall of HALLS) {
    const dx = x - hall.x;
    const dz = z - hall.z;
    const sx = (dx - dz) * 24;
    const sy = (dx + dz) * 12;
    const w = 494 * hall.scale;
    const h = 420 * hall.scale;
    if (Math.abs(sx) <= w * 0.42 && sy <= 6 && sy >= -(h - 22)) return true;
  }
  return false;
}

export function arrivalAt(x: number, z: number) {
  const npc = NPCS.find((n) => Math.hypot(n.x - x, n.z - z) < 14);
  const nx = npc ? npc.x - x : 0;
  const nz = npc ? npc.z - z : 1;
  let best: { x: number; z: number } | null = null;
  let bestScore = -999;
  for (let r = 2.2; r <= 3.6; r += 0.35) {
    for (let a = 0; a < 20; a++) {
      const ang = (a / 20) * Math.PI * 2;
      const spot = nearestOpen(x + Math.cos(ang) * r, z + Math.sin(ang) * r);
      const far = Math.hypot(spot.x - x, spot.z - z);
      if (far < 1.8 || far > 4.4) continue;
      if (blocked(spot.x, spot.z) || underHall(spot.x, spot.z)) continue;
      if (FIRES.some(([fx, fz]) => Math.hypot(spot.x - fx, spot.z - fz) < 3.4)) continue;
      if (NPCS.some((n) => Math.hypot(spot.x - n.x, spot.z - n.z) < 3.6)) continue;
      const away = -((spot.x - x) * nx + (spot.z - z) * nz);
      const down = spot.x - x + (spot.z - z);
      const score = away * 1.4 + down;
      if (score > bestScore) {
        bestScore = score;
        best = spot;
      }
    }
  }
  return best ?? nearestOpen(x + 2.8, z + 2.8);
}

export function clearLine(x0: number, z0: number, x1: number, z1: number) {
  const dist = Math.hypot(x1 - x0, z1 - z0);
  const steps = Math.max(1, Math.ceil(dist / 0.4));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (blocked(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false;
  }
  return true;
}

function openTile(x: number, z: number) {
  const tx = Math.round(x);
  const tz = Math.round(z);
  if (!blocked(tx, tz)) return { x: tx, z: tz };
  for (let r = 1; r <= 5; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (!blocked(tx + dx, tz + dz)) return { x: tx + dx, z: tz + dz };
      }
    }
  }
  return { x: tx, z: tz };
}

export function routeTo(x0: number, z0: number, x1: number, z1: number) {
  const start = openTile(x0, z0);
  const goal = openTile(x1, z1);
  if (start.x === goal.x && start.z === goal.z) return [] as Array<{ x: number; z: number }>;
  const xMin = Math.max(-166, Math.min(start.x, goal.x) - 16);
  const xMax = Math.min(166, Math.max(start.x, goal.x) + 16);
  const zMin = Math.max(-166, Math.min(start.z, goal.z) - 16);
  const zMax = Math.min(166, Math.max(start.z, goal.z) + 16);
  const key = (x: number, z: number) => `${x},${z}`;
  const h = (x: number, z: number) => Math.abs(x - goal.x) + Math.abs(z - goal.z);
  const gScore = new Map<string, number>();
  const prev = new Map<string, string>();
  const open: Array<{ x: number; z: number; g: number; f: number }> = [];
  const closed = new Set<string>();
  gScore.set(key(start.x, start.z), 0);
  open.push({ x: start.x, z: start.z, g: 0, f: h(start.x, start.z) });
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let guard = 0;
  while (open.length && guard++ < 6000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = key(cur.x, cur.z);
    if (closed.has(ck)) continue;
    closed.add(ck);
    if (cur.x === goal.x && cur.z === goal.z) {
      const path: Array<{ x: number; z: number }> = [];
      let p = ck;
      while (prev.has(p)) {
        const [px, pz] = p.split(",").map(Number);
        path.push({ x: px, z: pz });
        p = prev.get(p)!;
      }
      path.reverse();
      return path;
    }
    for (const [dx, dz] of dirs) {
      const nx = cur.x + dx;
      const nz = cur.z + dz;
      if (nx < xMin || nx > xMax || nz < zMin || nz > zMax) continue;
      if (blocked(nx, nz)) continue;
      const nk = key(nx, nz);
      const ng = cur.g + 1;
      if (ng >= (gScore.get(nk) ?? 1e9)) continue;
      gScore.set(nk, ng);
      prev.set(nk, ck);
      open.push({ x: nx, z: nz, g: ng, f: ng + h(nx, nz) });
    }
  }
  return [] as Array<{ x: number; z: number }>;
}

export function cityAt(id: string) {
  return CITIES.find((c) => c.id === id);
}

export function nearestWayfarer(x: number, z: number, range = 3.8) {
  let best: NpcDef | null = null;
  let bestD = range;
  for (const npc of NPCS) {
    const d = Math.hypot(npc.x - x, npc.z - z);
    if (d < bestD) {
      bestD = d;
      best = npc;
    }
  }
  return best;
}

export function tileFill(x: number, z: number) {
  const d = Math.hypot(x, z);
  if (d > LAND + 5) return (x + z) & 1 ? "#0c2c32" : "#0a2428";
  if (d > LAND) return (x + z) & 1 ? "#164850" : "#123e46";
  if (inLake(x, z)) return (x + z) & 1 ? "#1d5c68" : "#184e58";
  for (const city of CITIES) {
    if (Math.hypot(x - city.x, z - city.z) < 6.4) return (x * 3 + z) % 5 === 0 ? city.stoneAlt : city.stone;
  }
  if (onRoad(x, z)) return (x + z) & 1 ? "#7a6848" : "#6a563c";
  for (const camp of CAMPS) {
    if (Math.hypot(x - camp.cx, z - camp.cz) < 3.4) return "#5a4032";
  }
  const n = Math.abs(x * 13 + z * 7) % 5;
  if (d > LAND - 12) return n ? "#1e3830" : "#18322c";
  return n === 0 ? "#3e5a34" : n === 1 ? "#46683c" : "#35522e";
}
