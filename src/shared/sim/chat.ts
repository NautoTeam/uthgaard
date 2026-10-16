/** Say and guild chat share the same length and pace. */

export const CHAT_MAX = 120;
export const CHAT_WINDOW_MS = 10_000;
export const CHAT_BURST = 4;
export const GUILD_CHAT_KEEP = 50;

/** True when this send fits in the recent window. The returned stamps are what to keep. */
export function allowChat(stamps: number[], now: number): { ok: boolean; stamps: number[] } {
  const kept = stamps.filter((t) => now - t < CHAT_WINDOW_MS);
  if (kept.length >= CHAT_BURST) return { ok: false, stamps: kept };
  return { ok: true, stamps: [...kept, now] };
}
