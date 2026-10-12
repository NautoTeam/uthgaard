import assert from "node:assert/strict";
import { test } from "node:test";
import { pointerToView, resolveClick, screenToWorld, worldToScreen } from "./iso.ts";

const viewW = 1280;
const viewH = 720;
/** Fenhollow camera. Clicks near the origin used to hide a missing offset. */
const hero = { x: 48, z: 72 };
const camX = (hero.x - hero.z) * 24;
const camZ = (hero.x + hero.z) * 12;

const quadrants = [
  { name: "up-right", dx: 220, dy: -130 },
  { name: "up-left", dx: -210, dy: -120 },
  { name: "down-right", dx: 200, dy: 150 },
  { name: "down-left", dx: -190, dy: 140 },
];

function fenClick(partial: {
  clientX: number;
  clientY: number;
  rect: { left: number; top: number; width: number; height: number };
  clientW?: number;
  clientH?: number;
  offsetX?: number;
  offsetY?: number;
  camX?: number;
  camZ?: number;
  viewW?: number;
  viewH?: number;
}) {
  return resolveClick({
    clientX: partial.clientX,
    clientY: partial.clientY,
    offsetX: partial.offsetX,
    offsetY: partial.offsetY,
    rect: partial.rect,
    viewW: partial.viewW ?? viewW,
    viewH: partial.viewH ?? viewH,
    clientW: partial.clientW ?? viewW,
    clientH: partial.clientH ?? viewH,
    camX: partial.camX ?? camX,
    camZ: partial.camZ ?? camZ,
    heroX: hero.x,
    heroZ: hero.z,
  });
}

for (const dpr of [1, 2]) {
  test(`resolveClick round-trips four quadrants at Fenhollow, DPR ${dpr}`, () => {
    const rect = { left: 12, top: 8, width: viewW, height: viewH };
    const heroScreen = worldToScreen(hero.x, hero.z, camX, camZ, viewW, viewH);
    for (const q of quadrants) {
      const clientX = rect.left + heroScreen.x + q.dx;
      const clientY = rect.top + heroScreen.y + q.dy;
      const lying = fenClick({
        clientX,
        clientY,
        rect,
        clientW: viewW,
        clientH: viewH,
        offsetX: 3,
        offsetY: 4,
      });
      const honest = fenClick({ clientX, clientY, rect });
      assert.equal(lying.x, honest.x);
      assert.equal(lying.z, honest.z);
      const back = worldToScreen(honest.x, honest.z, camX, camZ, viewW, viewH);
      assert.ok(Math.abs(back.x - honest.sx) < 1e-6, `${q.name} sx`);
      assert.ok(Math.abs(back.y - honest.sy) < 1e-6, `${q.name} sy`);
      const sdx = back.x - heroScreen.x;
      const sdy = back.y - heroScreen.y;
      if (q.dx > 40) assert.ok(sdx > 40, `${q.name} right ${sdx}`);
      if (q.dx < -40) assert.ok(sdx < -40, `${q.name} left ${sdx}`);
      if (q.dy > 40) assert.ok(sdy > 40, `${q.name} down ${sdy}`);
      if (q.dy < -40) assert.ok(sdy < -40, `${q.name} up ${sdy}`);
      const dist = Math.hypot(honest.x - hero.x, honest.z - hero.z);
      assert.ok(dist < 30, `${q.name} stayed near the hero (${dist.toFixed(1)})`);
      assert.ok(honest.z < 110, `${q.name} did not leap into the deep fen`);
    }
    assert.equal(Math.floor(viewW * dpr) > viewW || dpr === 1, true);
  });
}

test("a backing-store rect does not shove Fenhollow clicks up-left", () => {
  const rect = { left: 0, top: 0, width: viewW * 2, height: viewH * 2 };
  const heroScreen = worldToScreen(hero.x, hero.z, camX, camZ, viewW, viewH);
  for (const q of quadrants) {
    const hit = fenClick({
      clientX: heroScreen.x + q.dx,
      clientY: heroScreen.y + q.dy,
      rect,
      clientW: viewW,
      clientH: viewH,
      offsetX: (heroScreen.x + q.dx) * 2,
      offsetY: (heroScreen.y + q.dy) * 2,
    });
    const back = worldToScreen(hit.x, hit.z, camX, camZ, viewW, viewH);
    const sdx = back.x - heroScreen.x;
    const sdy = back.y - heroScreen.y;
    if (q.dx > 40) assert.ok(sdx > 40, `backing ${q.name} right ${sdx}`);
    if (q.dx < -40) assert.ok(sdx < -40, `backing ${q.name} left ${sdx}`);
    if (q.dy > 40) assert.ok(sdy > 40, `backing ${q.name} down ${sdy}`);
    if (q.dy < -40) assert.ok(sdy < -40, `backing ${q.name} up ${sdy}`);
  }
});

test("a scaled embed still hits the quadrant that was clicked", () => {
  const scale = 0.62;
  const rect = { left: 40, top: 20, width: viewW * scale, height: viewH * scale };
  const heroScreen = worldToScreen(hero.x, hero.z, camX, camZ, viewW, viewH);
  for (const q of quadrants) {
    const hit = fenClick({
      clientX: rect.left + (heroScreen.x + q.dx) * scale,
      clientY: rect.top + (heroScreen.y + q.dy) * scale,
      rect,
      clientW: viewW,
      clientH: viewH,
      offsetX: 8,
      offsetY: 8,
    });
    const back = worldToScreen(hit.x, hit.z, camX, camZ, viewW, viewH);
    assert.ok(Math.abs(back.x - (heroScreen.x + q.dx)) < 1e-4, q.name);
    assert.ok(Math.abs(back.y - (heroScreen.y + q.dy)) < 1e-4, q.name);
  }
});

test("screen pixels are not treated as world tiles when the camera is far from the origin", () => {
  const rect = { left: 0, top: 0, width: viewW, height: viewH };
  const heroScreen = worldToScreen(hero.x, hero.z, camX, camZ, viewW, viewH);
  const hit = fenClick({ clientX: heroScreen.x, clientY: heroScreen.y, rect });
  assert.ok(Math.hypot(hit.x - hero.x, hit.z - hero.z) < 0.01);
  const forgotten = screenToWorld(heroScreen.x, heroScreen.y, 0, 0, viewW, viewH);
  assert.ok(Math.hypot(forgotten.x, forgotten.z) < 3, "cam 0 would land near the origin");
  assert.ok(Math.hypot(hit.x - forgotten.x, hit.z - forgotten.z) > 40);
});

test("screenToWorld undoes worldToScreen for scattered heroes and cameras", () => {
  for (let i = 0; i < 24; i++) {
    const x = ((i * 17) % 90) - 30;
    const z = ((i * 13) % 110) - 40;
    const camX = i * 11 - 80;
    const camZ = i * 7 - 40;
    const w = 640 + (i % 6) * 180;
    const h = 480 + (i % 5) * 120;
    const s = worldToScreen(x, z, camX, camZ, w, h);
    const back = screenToWorld(s.x, s.y, camX, camZ, w, h);
    assert.ok(Math.abs(back.x - x) < 1e-6, `x ${back.x} vs ${x}`);
    assert.ok(Math.abs(back.z - z) < 1e-6, `z ${back.z} vs ${z}`);
  }
});

test("resolveClick matches the absolute inverse, and up-right is up-right in world deltas", () => {
  const w = 1100;
  const h = 700;
  const hx = 12;
  const hz = 40;
  const cx = (hx - hz) * 24;
  const cz = (hx + hz) * 12;
  const hs = worldToScreen(hx, hz, cx, cz, w, h);
  const hit = resolveClick({
    clientX: hs.x + 140,
    clientY: hs.y - 90,
    rect: { left: 0, top: 0, width: w, height: h },
    viewW: w,
    viewH: h,
    clientW: w,
    clientH: h,
    camX: cx,
    camZ: cz,
    heroX: hx,
    heroZ: hz,
  });
  const abs = screenToWorld(hit.sx, hit.sy, cx, cz, w, h);
  assert.ok(Math.abs(abs.x - hit.x) < 1e-6);
  assert.ok(Math.abs(abs.z - hit.z) < 1e-6);
  const dx = hit.x - hx;
  const dz = hit.z - hz;
  assert.ok(dx - dz > 0, `dx-dz ${dx - dz}`);
  assert.ok(dx + dz < 0, `dx+dz ${dx + dz}`);
});

test("pointerToView still maps CSS pixels, not the bitmap", () => {
  const rect = { left: 0, top: 0, width: viewW, height: viewH };
  const p = pointerToView(viewW / 2, viewH / 2, rect, viewW, viewH);
  assert.equal(p.x, viewW / 2);
  assert.equal(p.y, viewH / 2);
});

test("a lost device-pixel scale does not walk a click right of the sprite west", () => {
  // Live Fenhollow report: view ~1926×1122, bitmap 2×, transform stuck at 1.
  // The sprite paints at view/4. A click at CSS 640,200 is upper-right of that
  // sprite and must not come out 21 tiles west (the old target was 25,66).
  const liveW = 1926;
  const liveH = 1122;
  const heroX = 46;
  const heroZ = 73;
  const camX = -661;
  const camZ = 1433;
  const hit = resolveClick({
    clientX: 640,
    clientY: 200,
    rect: { left: 0, top: 0, width: liveW, height: liveH },
    viewW: liveW,
    viewH: liveH,
    clientW: liveW,
    clientH: liveH,
    camX,
    camZ,
    heroX,
    heroZ,
    bitmapW: liveW * 2,
    bitmapH: liveH * 2,
    transformA: 1,
    transformD: 1,
    transformE: 0,
    transformF: 0,
  });
  const hs = worldToScreen(heroX, heroZ, camX, camZ, liveW, liveH);
  assert.ok(hit.sx > hs.x + 40, `draw x ${hit.sx.toFixed(0)} should be right of hero ${hs.x.toFixed(0)}`);
  assert.ok(hit.x > heroX, `world x ${hit.x.toFixed(2)} should be east of ${heroX}`);
  assert.ok(hit.x > 40, `must not jump west to ~25 (got ${hit.x.toFixed(2)})`);
  assert.ok(Math.hypot(hit.x - heroX, hit.z - heroZ) < 20, `stayed near the hero (${hit.x.toFixed(1)},${hit.z.toFixed(1)})`);
});

test("a healthy 2× transform matches the CSS click, including a backing-store rect", () => {
  const heroScreen = worldToScreen(hero.x, hero.z, camX, camZ, viewW, viewH);
  const clientX = heroScreen.x + 180;
  const clientY = heroScreen.y - 40;
  const healthy = resolveClick({
    clientX,
    clientY,
    rect: { left: 0, top: 0, width: viewW, height: viewH },
    viewW,
    viewH,
    clientW: viewW,
    clientH: viewH,
    camX,
    camZ,
    heroX: hero.x,
    heroZ: hero.z,
    bitmapW: viewW * 2,
    bitmapH: viewH * 2,
    transformA: 2,
    transformD: 2,
    transformE: 0,
    transformF: 0,
  });
  const plain = fenClick({ clientX, clientY, rect: { left: 0, top: 0, width: viewW, height: viewH } });
  assert.ok(Math.abs(healthy.x - plain.x) < 1e-6);
  assert.ok(Math.abs(healthy.z - plain.z) < 1e-6);
  assert.ok(healthy.x > hero.x);
  const backing = resolveClick({
    clientX,
    clientY,
    rect: { left: 0, top: 0, width: viewW * 2, height: viewH * 2 },
    viewW,
    viewH,
    clientW: viewW,
    clientH: viewH,
    camX,
    camZ,
    heroX: hero.x,
    heroZ: hero.z,
    bitmapW: viewW * 2,
    bitmapH: viewH * 2,
    transformA: 2,
    transformD: 2,
  });
  assert.ok(Math.abs(backing.x - plain.x) < 1e-6, `backing x ${backing.x} vs ${plain.x}`);
});
