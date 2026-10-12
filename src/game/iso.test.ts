import assert from "node:assert/strict";
import { test } from "node:test";
import { pointerToView, screenToWorld, worldToScreen } from "./iso.ts";

const viewW = 1280;
const viewH = 720;
/** Non-zero camera, in isometric pixels, not world tiles. */
const camX = 312.4;
const camZ = -148.75;

const quadrants = [
  { name: "up-right", fx: 0.78, fy: 0.22 },
  { name: "up-left", fx: 0.18, fy: 0.2 },
  { name: "down-right", fx: 0.82, fy: 0.78 },
  { name: "down-left", fx: 0.16, fy: 0.74 },
];

for (const dpr of [1, 2]) {
  test(`worldToScreen → screenToWorld round-trips four quadrants at DPR ${dpr}`, () => {
    // The backing store is view × dpr. Pointers stay in CSS pixels, so the
    // rect is the CSS box — never the backing-store size.
    const rect = { left: 24, top: 16, width: viewW, height: viewH };
    const backingW = Math.floor(viewW * dpr);
    const backingH = Math.floor(viewH * dpr);
    if (dpr !== 1) assert.notEqual(backingW, rect.width);
    assert.ok(backingH >= viewH);
    assert.equal(backingW / dpr, viewW);

    const heroScreen = { x: viewW / 2, y: viewH / 2 - 20 };
    const hero = screenToWorld(heroScreen.x, heroScreen.y, camX, camZ, viewW, viewH);

    for (const q of quadrants) {
      const clientX = rect.left + viewW * q.fx;
      const clientY = rect.top + viewH * q.fy;
      const screen = pointerToView(clientX, clientY, rect, viewW, viewH);
      const world = screenToWorld(screen.x, screen.y, camX, camZ, viewW, viewH);
      const back = worldToScreen(world.x, world.z, camX, camZ, viewW, viewH);
      assert.ok(Math.abs(back.x - screen.x) < 1e-6, `${q.name} sx`);
      assert.ok(Math.abs(back.y - screen.y) < 1e-6, `${q.name} sy`);

      const dx = screen.x - heroScreen.x;
      const dy = screen.y - heroScreen.y;
      const moved = worldToScreen(world.x, world.z, camX, camZ, viewW, viewH);
      const heroBack = worldToScreen(hero.x, hero.z, camX, camZ, viewW, viewH);
      const sdx = moved.x - heroBack.x;
      const sdy = moved.y - heroBack.y;
      // A click must not collapse into the up-left of the hero.
      if (dx > 40) assert.ok(sdx > 20, `${q.name} should be right of the hero, got ${sdx}`);
      if (dx < -40) assert.ok(sdx < -20, `${q.name} should be left of the hero, got ${sdx}`);
      if (dy > 40) assert.ok(sdy > 20, `${q.name} should be below the hero, got ${sdy}`);
      if (dy < -40) assert.ok(sdy < -20, `${q.name} should be above the hero, got ${sdy}`);
    }
  });
}

test("a backing-store-sized rect would shove every click up-left", () => {
  const dpr = 2;
  const css = { left: 0, top: 0, width: viewW, height: viewH };
  const wrong = { left: 0, top: 0, width: viewW * dpr, height: viewH * dpr };
  const heroScreen = { x: viewW / 2, y: viewH / 2 - 20 };
  let wrongUpLeft = 0;
  for (const q of quadrants) {
    const clientX = viewW * q.fx;
    const clientY = viewH * q.fy;
    const good = pointerToView(clientX, clientY, css, viewW, viewH);
    const bad = pointerToView(clientX, clientY, wrong, viewW, viewH);
    const goodW = screenToWorld(good.x, good.y, camX, camZ, viewW, viewH);
    const badW = screenToWorld(bad.x, bad.y, camX, camZ, viewW, viewH);
    const goodS = worldToScreen(goodW.x, goodW.z, camX, camZ, viewW, viewH);
    const badS = worldToScreen(badW.x, badW.z, camX, camZ, viewW, viewH);
    assert.ok(Math.abs(goodS.x - clientX) < 1e-6);
    if (badS.x < heroScreen.x - 30 && badS.y < heroScreen.y - 30) wrongUpLeft++;
  }
  assert.equal(wrongUpLeft, 4);
});
