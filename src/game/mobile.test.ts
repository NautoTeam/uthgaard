import assert from "node:assert/strict";
import { test } from "node:test";
import { DESKTOP_VIEW_H, DESKTOP_VIEW_W, zoomFor } from "./mobile.ts";

test("desktop zoom stays 1", () => {
  assert.equal(zoomFor(false, 1920, 1080), 1);
  assert.equal(zoomFor(false, 390, 844), 1);
  assert.equal(zoomFor(false, 800, 360), 1);
});

test("a phone shows about as many tiles as a 1280×720 desktop", () => {
  const z = zoomFor(true, 844, 390);
  assert.ok(z < 1);
  assert.ok(Math.abs(390 / z - DESKTOP_VIEW_H) < 1e-6);
  assert.ok(844 / z >= DESKTOP_VIEW_W);
  const wide = zoomFor(true, 2000, 1200);
  assert.equal(wide, 1);
});
