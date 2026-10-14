/** Used game-token ids. `seen` is true when this jti was already accepted. */
const used = new Map<string, number>();
const CAP = 50_000;

function prune(nowSec: number) {
  for (const [id, exp] of used) {
    if (exp <= nowSec) used.delete(id);
  }
}

/** True if `jti` is already in use and not yet expired. Records it otherwise. */
export function seen(jti: string, expSec: number): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  const prev = used.get(jti);
  if (prev != null && prev > nowSec) return true;
  prune(nowSec);
  if (!(expSec > nowSec)) return false;
  while (used.size >= CAP) {
    const oldest = used.keys().next().value;
    if (oldest === undefined) break;
    used.delete(oldest);
  }
  used.set(jti, expSec);
  return false;
}
