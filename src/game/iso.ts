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
