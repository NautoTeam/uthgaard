import assert from "node:assert/strict";
import { test } from "node:test";
import { tileFill } from "./geo.ts";
import { bakeChunkImage, chunkCoords, sampleCorner } from "./ground.ts";

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

test("corner colours match tileFill inside the Reach", () => {
  const spots = [
    [0, 0],
    [20, 8],
    [24, 36],
    [74, 64],
    [-62, -46],
    [140, 0],
    [152, 4],
    [154, -2],
    [-40, 30],
    [10, -18],
  ];
  for (const [x, z] of spots) {
    const sample = sampleCorner(x, z);
    const [r, g, b] = rgb(tileFill(x, z));
    assert.deepEqual([sample.r, sample.g, sample.b], [r, g, b], `${x},${z}`);
  }
});

test("water kinds follow the coast, lakes, and deep ring", () => {
  assert.equal(sampleCorner(74, 64).kind, "lake");
  assert.equal(sampleCorner(74, 64).water, 1);
  assert.equal(sampleCorner(74, 64).deep, 0);
  assert.equal(sampleCorner(0, 0).kind, "stone");
  assert.equal(sampleCorner(152, 0).kind, "water");
  assert.equal(sampleCorner(156, 0).water, 1);
  const deep = sampleCorner(0, 154);
  assert.equal(deep.kind === "deep" || deep.kind === "water", true);
  const beach = sampleCorner(142, 0);
  assert.equal(beach.kind, "beach");
  assert.equal(beach.water, 0);
});

test("chunk index is half-open on tile boundaries", () => {
  assert.deepEqual(chunkCoords(0, 0), { cx: 0, cz: 0 });
  assert.deepEqual(chunkCoords(31, 31), { cx: 0, cz: 0 });
  assert.deepEqual(chunkCoords(32, -1), { cx: 1, cz: -1 });
});

test("baked ground keeps the road, the lake, and the shore", () => {
  const at = (
    img: { data: Uint8ClampedArray; width: number; originX: number; originY: number },
    wx: number,
    wz: number,
  ) => {
    const baseX = (wx - wz) * 24;
    const baseY = (wx + wz) * 12;
    const px = Math.round((baseX - img.originX) / 2 - 0.5);
    const py = Math.round((baseY - img.originY) / 2 - 0.5);
    const i = (py * img.width + px) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]] as const;
  };
  const lake = bakeChunkImage(2, 2);
  const center = at(lake, 74, 64);
  assert.equal(center[3], 255);
  assert.ok(center[2] > center[0], `lake pixel ${center.join(",")}`);
  assert.ok(center[0] < 90, `lake should stay dark water, got ${center.join(",")}`);

  const city = bakeChunkImage(0, 0);
  const road = at(city, 5, 8);
  assert.equal(road[3], 255);
  assert.ok(road[0] > road[1] && road[1] > road[2] && road[0] > 80, `road ${road.join(",")}`);

  const coast = bakeChunkImage(4, 0);
  let foam = 0;
  let sand = 0;
  let darkWater = 0;
  for (let i = 0; i < coast.data.length; i += 4) {
    if (coast.data[i + 3] === 0) continue;
    const r = coast.data[i];
    const g = coast.data[i + 1];
    const b = coast.data[i + 2];
    if (r > 140 && g > 150 && b > 140) foam++;
    if (r > 120 && g > 95 && b < 140 && r > b + 20) sand++;
    if (r < 20 && b < 45 && b + 8 >= g) darkWater++;
  }
  assert.ok(foam > 80, `foam pixels ${foam}`);
  assert.ok(sand > 80, `sand pixels ${sand}`);
  assert.ok(darkWater > 30, `deep pixels ${darkWater}`);
});
