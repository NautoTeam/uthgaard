/** Isometric ground projection. Tile is 48×24. Camera offsets are in the same pixels. */

export const TILE_W = 48;
export const TILE_H = 24;

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface WorldPoint {
  x: number;
  z: number;
}

export function worldToScreen(
  x: number,
  z: number,
  camX: number,
  camZ: number,
  viewW: number,
  viewH: number,
): ScreenPoint {
  return {
    x: (x - z) * (TILE_W / 2) + viewW / 2 - camX,
    y: (x + z) * (TILE_H / 2) + viewH / 2 - 20 - camZ,
  };
}

export function screenToWorld(
  sx: number,
  sy: number,
  camX: number,
  camZ: number,
  viewW: number,
  viewH: number,
): WorldPoint {
  const isoX = sx - viewW / 2 + camX;
  const isoY = sy - viewH / 2 + 20 + camZ;
  return {
    x: (isoX / (TILE_W / 2) + isoY / (TILE_H / 2)) / 2,
    z: (isoY / (TILE_H / 2) - isoX / (TILE_W / 2)) / 2,
  };
}

/** Map a pointer into the canvas drawing space (CSS pixels, not the backing store). */
export function pointerToView(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  viewW: number,
  viewH: number,
): ScreenPoint {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  return {
    x: ((clientX - rect.left) / width) * viewW,
    y: ((clientY - rect.top) / height) * viewH,
  };
}

/** Diamond distance from a screen point to a tile center. 1 = on the diamond edge. */
export function diamondDistance(sx: number, sy: number, tile: ScreenPoint): number {
  return Math.abs(sx - tile.x) / (TILE_W / 2) + Math.abs(sy - tile.y) / (TILE_H / 2);
}

export interface ClickResolveInput {
  clientX: number;
  clientY: number;
  /**
   * Present on DOM events. Ignored on purpose: some browsers report offsetX in
   * a smaller space than the canvas we draw, and trusting it walks every click
   * up-left. Tests pass a lying offset to prove the handler does not use it.
   */
  offsetX?: number;
  offsetY?: number;
  rect: { left: number; top: number; width: number; height: number };
  viewW: number;
  viewH: number;
  /** Layout size of the canvas (clientWidth/clientHeight), not the bitmap. */
  clientW: number;
  clientH: number;
  camX: number;
  camZ: number;
  heroX?: number;
  heroZ?: number;
  /** Backing store size. With the scale used to draw, this maps the cursor into that same space. */
  bitmapW?: number;
  bitmapH?: number;
  transformA?: number;
  transformD?: number;
  transformE?: number;
  transformF?: number;
}

export interface ClickResolve {
  sx: number;
  sy: number;
  x: number;
  z: number;
  camX: number;
  camZ: number;
  heroX: number;
  heroZ: number;
}

/**
 * The pointer path the canvas handler uses. Screen position comes from
 * client coordinates and the element box (so a CSS scale still hits the
 * pixel under the cursor). When the backing store and the scale that was
 * actually used to draw are known, the cursor is converted into that same
 * pixel space. A lost device-pixel scale otherwise paints the hero in the
 * top-left quarter, and every click — even one to the right of the sprite —
 * lands west of the math point.
 */
export function resolveClick(input: ClickResolveInput): ClickResolve {
  const heroX = Number.isFinite(input.heroX) ? (input.heroX as number) : 0;
  const heroZ = Number.isFinite(input.heroZ) ? (input.heroZ as number) : 0;
  const heroKnown = Number.isFinite(input.heroX) && Number.isFinite(input.heroZ);
  let width = Math.max(1, input.rect.width);
  let height = Math.max(1, input.rect.height);
  const cw = Math.max(1, input.clientW || input.viewW);
  const ch = Math.max(1, input.clientH || input.viewH);
  // A backing-store-sized box (width ≈ css × dpr) compresses every click
  // into the top-left of the view. The box we want is the CSS box.
  if (width > cw * 1.45 && height > ch * 1.45) {
    width = cw;
    height = ch;
  }
  const bitmapW = input.bitmapW ?? 0;
  const bitmapH = input.bitmapH ?? 0;
  const scaleX = input.transformA ?? 0;
  const scaleY = input.transformD ?? 0;
  let sx: number;
  let sy: number;
  if (bitmapW > 1 && bitmapH > 1 && Math.abs(scaleX) > 0.01 && Math.abs(scaleY) > 0.01) {
    const bx = ((input.clientX - input.rect.left) / width) * bitmapW;
    const by = ((input.clientY - input.rect.top) / height) * bitmapH;
    sx = (bx - (input.transformE ?? 0)) / scaleX;
    sy = (by - (input.transformF ?? 0)) / scaleY;
  } else {
    sx = ((input.clientX - input.rect.left) / width) * input.viewW;
    sy = ((input.clientY - input.rect.top) / height) * input.viewH;
  }
  let x: number;
  let z: number;
  if (heroKnown) {
    const hs = worldToScreen(heroX, heroZ, input.camX, input.camZ, input.viewW, input.viewH);
    const dsx = sx - hs.x;
    const dsy = sy - hs.y;
    x = heroX + (dsx / (TILE_W / 2) + dsy / (TILE_H / 2)) / 2;
    z = heroZ + (dsy / (TILE_H / 2) - dsx / (TILE_W / 2)) / 2;
  } else {
    const abs = screenToWorld(sx, sy, input.camX, input.camZ, input.viewW, input.viewH);
    x = abs.x;
    z = abs.z;
  }
  return { sx, sy, x, z, camX: input.camX, camZ: input.camZ, heroX, heroZ };
}
