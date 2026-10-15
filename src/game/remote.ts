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
  error?: string;
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const headers = new Headers();
    const bearer = previewBearer();
    if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
    const res = await fetch("/api/game/token", {
      method: "POST",
      credentials: "include",
      headers,
      signal: ctrl.signal,
    });
    if (res.status === 401) return { ok: false, status: 401 };
    let body: { token?: string; error?: string } = {};
    try {
      body = (await res.json()) as { token?: string; error?: string };
    } catch {
      body = {};
    }
    if (!res.ok || !body.token) return { ok: false, status: res.status, error: body.error };
    return { ok: true, status: res.status, token: body.token };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function previewBearer(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem("grok-auth.bearer-token");
  } catch {
    return null;
  }
}

function tokenReason(tok: TokenResponse): string {
  if (tok.status === 401) return "You're not signed in.";
  if (tok.status === 503) return "The game token is not ready.";
  const line = tok.error?.replace(/\s+/g, " ").trim();
  if (line && line.length <= 90) return line;
  return "The token request failed.";
}

/** Token, then a socket that closes as soon as it opens. No hello, so nothing is created. */
export function probeGameLink(url: string): Promise<{ online: boolean; reason: string }> {
  if (!url || typeof WebSocket === "undefined") return Promise.resolve({ online: false, reason: "" });
  return defaultFetchToken().then(async (tok) => {
    if (!tok.ok || !tok.token) return { online: false, reason: tokenReason(tok) };
    const opened = await new Promise<boolean>((resolve) => {
      let done = false;
      let sock: WebSocket | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          sock?.close();
        } catch {
          /* already closed */
        }
        resolve(ok);
      };
      sock = new WebSocket(url);
      timer = setTimeout(() => finish(false), 8000);
      sock.onopen = () => finish(true);
      sock.onerror = () => finish(false);
      sock.onclose = () => finish(false);
    });
    if (!opened) return { online: false, reason: "The game server can't be reached." };
    return { online: true, reason: "" };
  });
}

function messageText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as Uint8Array);
  return null;
}

function joinFailure(reason: string): { why: "signed-out" | "unreachable" | "join"; detail: string } {
  if (reason === "name_taken") return { why: "join", detail: "That name is taken." };
  if (reason === "bad_create") return { why: "join", detail: "That hero cannot be created." };
  if (reason === "join_failed") return { why: "join", detail: "The hero could not be saved." };
  if (reason === "bad token") return { why: "signed-out", detail: "The game token was rejected." };
  if (reason === "not ready") return { why: "unreachable", detail: "The game server is not ready." };
  const line = reason.replace(/\s+/g, " ").trim();
  return { why: "join", detail: line ? line.slice(0, 90) : "The hero could not join." };
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
  /** First connection failed, or the hero was never welcomed. */
  onOffline?: (why: "signed-out" | "unreachable" | "join", detail?: string) => void;
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
      if (tok.status === 401) return 4401;
      return 1006;
    }
    const token = tok.token;
    const sock = openSocket(opts.url);
    socket = sock;
    return await new Promise<number>((resolve) => {
      let settled = false;
      let opened = false;
      let createSent = false;
      let openTimer: ReturnType<typeof setTimeout> | undefined;
      let createTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        clearTimeout(createTimer);
        if (socket === sock) socket = null;
        resolve(code || 1006);
      };
      const failJoin = (reason: string) => {
        if (stopped || welcomed || settled) return;
        const failure = joinFailure(reason);
        stopped = true;
        opts.onError(reason);
        opts.onOffline?.(failure.why, failure.detail);
        try {
          sock.close(1000);
        } catch {
          /* already closed */
        }
        finish(1000);
      };
      openTimer = setTimeout(() => {
        if (opened || settled) return;
        try {
          sock.close();
        } catch {
          /* already closed */
        }
        finish(1006);
      }, 8000);
      const sendCreate = (imported: HelloImport | null) => {
        if (stopped || createSent || sock.readyState !== 1) return;
        createSent = true;
        sock.send(JSON.stringify(gameHello(token, opts.choice, imported)));
        clearTimeout(createTimer);
        createTimer = setTimeout(() => failJoin("The hero did not join."), 8000);
      };
      const handleRaw = (raw: string) => {
        if (settled) return;
        let msg: {
          t?: string;
          reason?: string;
          playerId?: string;
          seq?: number;
          result?: { ok: boolean; reason?: string };
          state?: PublicState;
        };
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          return;
        }
        if (msg.t === "welcome" && msg.playerId) {
          welcomed = true;
          attempt = 0;
          tokenFailures = 0;
          clearTimeout(createTimer);
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
          if (createSent) {
            failJoin("The server did not accept that hero.");
            return;
          }
          void pickImport().then((imported) => sendCreate(imported));
          return;
        }
        if (!welcomed) failJoin(reason || "The hero could not join.");
      };
      sock.onopen = () => {
        opened = true;
        clearTimeout(openTimer);
        if (stopped) {
          sock.close(1000);
          return;
        }
        sock.send(JSON.stringify(gameHello(token)));
      };
      sock.onmessage = (ev) => {
        const data = ev.data;
        if (typeof Blob !== "undefined" && data instanceof Blob) {
          void data.text().then((raw) => handleRaw(raw));
          return;
        }
        const raw = messageText(data);
        if (raw != null) handleRaw(raw);
      };
      sock.onerror = () => undefined;
      sock.onclose = (ev) => finish(ev?.code ?? 1006);
    });
  }

  async function loop() {
    while (!stopped) {
      const code = await openOnce();
      if (stopped) return;
      if (!welcomed) {
        stopped = true;
        opts.onOffline?.(code === 4401 ? "signed-out" : "unreachable");
        return;
      }
      const plan = reconnectPlan(code, tokenFailures);
      if (code === 4401) tokenFailures += 1;
      if (!plan.reconnect) {
        if (plan.notice === "sign in again") {
          stopped = true;
          opts.onOffline?.("signed-out");
          return;
        }
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
