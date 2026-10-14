import type { PublicState } from "../shared/sim/types";
import { gameHello, type HelloChoice, type HelloImport } from "./net";

export const RENDER_DELAY_MS = 100;

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

/** 0.5s, 1s, 2s, 4s, 8s, scaled by 0.8–1.2. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, Math.max(0, Math.floor(attempt)))];
  return Math.round(base * (0.8 + rand() * 0.4));
}

/** 4409 never reconnects. 4401 refetches once (`tokenFailures` already counted), then asks for sign-in. */
export function reconnectPlan(
  code: number,
  tokenFailures: number,
): { reconnect: boolean; notice: string | null } {
  if (code === 4409) return { reconnect: false, notice: "Signed in elsewhere" };
  if (code === 4401 && tokenFailures >= 1) return { reconnect: false, notice: "sign in again" };
  return { reconnect: true, notice: "Reconnecting…" };
}

export function snapAlpha(olderAt: number, newerAt: number, now: number, delay = RENDER_DELAY_MS): number {
  const span = newerAt - olderAt;
  if (!(span > 0)) return 1;
  return Math.max(0, Math.min(1, (now - delay - olderAt) / span));
}

/** Linear x/z between the last two snaps. `skipId` (the local hero) stays on the newer sample. */
export function interpolateXZ<T extends { id: string; x: number; z: number }>(
  older: readonly T[] | undefined,
  newer: readonly T[],
  alpha: number,
  skipId = "",
): T[] {
  const t = Math.max(0, Math.min(1, alpha));
  return newer.map((row) => {
    if (skipId && row.id === skipId) return row;
    const prev = older?.find((item) => item.id === row.id);
    if (!prev) return row;
    return { ...row, x: prev.x + (row.x - prev.x) * t, z: prev.z + (row.z - prev.z) * t };
  });
}

export interface TokenResponse {
  ok: boolean;
  status: number;
  token?: string;
}

type SocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
};

export interface RemoteHandle {
  send: (body: unknown) => boolean;
  close: () => void;
}

async function defaultFetchToken(): Promise<TokenResponse> {
  const res = await fetch("/api/game/token", { method: "POST", credentials: "include" });
  if (res.status === 401) {
    if (typeof window !== "undefined") window.location.assign("/login");
    return { ok: false, status: 401 };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const body = (await res.json()) as { token?: string };
  if (!body.token) return { ok: false, status: res.status };
  return { ok: true, status: res.status, token: body.token };
}

function defaultOpen(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

/**
 * One signed-in hero on the game server.
 * The first hello carries only the token. `need_create` retries with the
 * creation-screen choice, and an optional one-time local import.
 */
export function connectRemote(opts: {
  url: string;
  choice: HelloChoice;
  onSnap: (state: PublicState) => void;
  onWelcome: (playerId: string) => void;
  onError: (reason: string) => void;
  onAck?: (seq: number, result: { ok: boolean; reason?: string }) => void;
  onStatus?: (line: string | null) => void;
  onNeedCreate?: () => Promise<HelloImport | null>;
  fetchToken?: () => Promise<TokenResponse>;
  openSocket?: (url: string) => SocketLike;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}): RemoteHandle {
  const fetchToken = opts.fetchToken ?? defaultFetchToken;
  const openSocket = opts.openSocket ?? defaultOpen;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rand = opts.rand ?? Math.random;
  let stopped = false;
  let socket: SocketLike | null = null;
  let attempt = 0;
  let tokenFailures = 0;
  let welcomed = false;
  let importPick: HelloImport | null | undefined;
  let importWait: Promise<HelloImport | null> | null = null;

  function pickImport(): Promise<HelloImport | null> {
    if (importPick !== undefined) return Promise.resolve(importPick);
    if (!importWait) {
      importWait = Promise.resolve(opts.onNeedCreate ? opts.onNeedCreate() : null).then((value) => {
        importPick = value ?? null;
        return importPick;
      });
    }
    return importWait;
  }

  async function openOnce(): Promise<number> {
    const tok = await fetchToken();
    if (stopped) return 1000;
    if (!tok.ok || !tok.token) {
      if (tok.status === 401) {
        stopped = true;
        opts.onError("sign in again");
        return 4401;
      }
      return 1006;
    }
    const token = tok.token;
    const sock = openSocket(opts.url);
    socket = sock;
    return await new Promise<number>((resolve) => {
      let settled = false;
      let createSent = false;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        if (socket === sock) socket = null;
        resolve(code || 1006);
      };
      sock.onopen = () => {
        if (stopped) {
          sock.close(1000);
          return;
        }
        sock.send(JSON.stringify(gameHello(token)));
      };
      sock.onmessage = (ev) => {
        let msg: {
          t?: string;
          reason?: string;
          playerId?: string;
          seq?: number;
          result?: { ok: boolean; reason?: string };
          state?: PublicState;
        };
        try {
          msg = JSON.parse(String(ev.data)) as typeof msg;
        } catch {
          return;
        }
        if (msg.t === "welcome" && msg.playerId) {
          welcomed = true;
          attempt = 0;
          tokenFailures = 0;
          opts.onStatus?.(null);
          opts.onWelcome(msg.playerId);
          return;
        }
        if (msg.t === "snap" && msg.state) {
          opts.onSnap(msg.state);
          return;
        }
        if (msg.t === "ack" && typeof msg.seq === "number" && msg.result) {
          opts.onAck?.(msg.seq, msg.result);
          return;
        }
        if (msg.t !== "error") return;
        const reason = msg.reason ?? "";
        if (reason === "need_create") {
          void pickImport().then((imported) => {
            if (stopped || createSent || sock.readyState !== 1) return;
            createSent = true;
            sock.send(JSON.stringify(gameHello(token, opts.choice, imported)));
          });
          return;
        }
        if (reason === "name_taken" || reason === "bad_create") {
          stopped = true;
          opts.onError(reason);
          sock.close(1000);
        }
      };
      sock.onerror = () => undefined;
      sock.onclose = (ev) => finish(ev?.code ?? 1006);
    });
  }

  async function loop() {
    while (!stopped) {
      const code = await openOnce();
      if (stopped) return;
      const plan = reconnectPlan(code, tokenFailures);
      if (code === 4401) tokenFailures += 1;
      if (!plan.reconnect) {
        if (plan.notice) opts.onStatus?.(plan.notice);
        return;
      }
      if (welcomed) opts.onStatus?.(plan.notice);
      await sleep(backoffMs(attempt, rand));
      attempt = Math.min(attempt + 1, BACKOFF_MS.length - 1);
    }
  }

  void loop();

  return {
    send(body: unknown) {
      if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify(body));
      return true;
    },
    close() {
      stopped = true;
      const current = socket;
      socket = null;
      current?.close(1000);
    },
  };
}
