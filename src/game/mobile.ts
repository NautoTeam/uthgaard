/** Phone layout. Desktop (fine pointer, or a large touch screen) stays at zoom 1. */

export const DESKTOP_VIEW_W = 1280;
export const DESKTOP_VIEW_H = 720;

/** Short side at or under this is a phone, not a tablet. */
export const PHONE_SHORT_SIDE = 540;

export function zoomFor(phone: boolean, viewW: number, viewH: number): number {
  if (!phone) return 1;
  const w = Math.max(1, viewW);
  const h = Math.max(1, viewH);
  const z = Math.min(w / DESKTOP_VIEW_W, h / DESKTOP_VIEW_H);
  return Math.max(0.42, Math.min(1, z));
}

export function isCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

export function isPhone(): boolean {
  if (!isCoarsePointer() || typeof window === "undefined") return false;
  return Math.min(window.innerWidth, window.innerHeight) <= PHONE_SHORT_SIDE;
}

export function cameraZoom(viewW: number, viewH: number): number {
  return zoomFor(isPhone(), viewW, viewH);
}

let lockFailed = false;

/** True when landscape lock is missing or the browser rejected it. */
export function orientationLockFailed(): boolean {
  return lockFailed;
}

/**
 * Fullscreen and landscape, from the Play / Create hero click.
 * Must run before the first await so the browser still treats it as a gesture.
 */
export function armHandheldPlay(): void {
  if (!isCoarsePointer() || typeof document === "undefined") return;
  const el = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => void | Promise<void>;
  };
  try {
    const pending = el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.();
    if (pending && typeof (pending as Promise<void>).then === "function") {
      void (pending as Promise<void>).catch(() => undefined);
    }
  } catch {
    /* the browser refused fullscreen */
  }
  const orientation = typeof screen === "undefined" ? undefined : screen.orientation;
  const lock = (
    orientation as (ScreenOrientation & { lock?: (orientation: string) => Promise<void> }) | undefined
  )?.lock?.bind(orientation);
  if (!lock) {
    lockFailed = true;
    return;
  }
  try {
    void lock("landscape").then(
      () => {
        lockFailed = false;
      },
      () => {
        lockFailed = true;
      },
    );
  } catch {
    lockFailed = true;
  }
}
