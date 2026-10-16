import type { PublicState } from "../shared/sim/types";
import { SERVER, gameHello, type HelloChoice } from "./net";

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

/** The world is playable only after welcome. A close never falls back to a local world. */
export type LinkGate = "connecting" | "online" | "unavailable" | "elsewhere" | "sign-in";

export function gateAfterClose(code: number): LinkGate {
  if (code === 4401) return "sign-in";
  if (code === 4409) return "elsewhere";
  return "unavailable";
}

export function worldMayStart(gate: LinkGate): boolean {
  return gate === "online";
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
  if (reason === "slot_taken") return { why: "join", detail: "That character slot is taken." };
  if (reason === "bad_slot") return { why: "join", detail: "Pick a character slot." };
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

function gameHttp(wsUrl: string) {
  return wsUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").replace(/\/$/, "");
}

export interface CharacterSlotView {
  slot: number;
  name: string;
  race: string;
  baseClass: string;
  prestigeClass: string;
  level: number;
}

async function authedGame(path: string, method: "GET" | "DELETE") {
  if (!SERVER) return { ok: false as const, status: 0, reason: "The game server isn't configured." };
  const tok = await defaultFetchToken();
  if (!tok.ok || !tok.token) return { ok: false as const, status: tok.status, reason: tokenReason(tok) };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${gameHttp(SERVER)}${path}`, {
      method,
      headers: { authorization: `Bearer ${tok.token}` },
      signal: ctrl.signal,
    });
    let body: { slots?: Array<CharacterSlotView | null>; error?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = {};
    }
    if (!res.ok) return { ok: false as const, status: res.status, reason: body.error || "The character list failed." };
    return { ok: true as const, status: res.status, slots: body.slots };
  } catch {
    return { ok: false as const, status: 0, reason: "The game server can't be reached." };
  } finally {
    clearTimeout(timer);
  }
}

/** Three frames. Empty slots are null. */
export async function fetchCharacterSlots(): Promise<
  { ok: true; slots: Array<CharacterSlotView | null> } | { ok: false; reason: string }
> {
  const result = await authedGame("/characters", "GET");
  if (!result.ok) return { ok: false, reason: result.reason };
  const slots = [0, 1, 2].map((slot) => result.slots?.find((row) => row && row.slot === slot) ?? null);
  return { ok: true, slots };
}

export async function deleteCharacterSlot(slot: number): Promise<{ ok: boolean; reason?: string }> {
  const result = await authedGame(`/characters?slot=${slot}`, "DELETE");
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true };
}

/**
 * One signed-in hero on the game server.
 * Play sends the slot. Create sends hello.create for that slot.
 * There is no local-save import.
 */
export function connectRemote(opts: {
  url: string;
  choice: HelloChoice;
  onSnap: (state: PublicState, online?: number) => void;
  onWelcome: (playerId: string) => void;
  onError: (reason: string) => void;
  onAck?: (seq: number, result: { ok: boolean; reason?: string }) => void;
  onStatus?: (line: string | null) => void;
  /** Full-screen gate. `online` is the only state that may show the world. */
  onLink?: (gate: LinkGate) => void;
  fetchToken?: () => Promise<TokenResponse>;
  openSocket?: (url: string) => SocketLike;
}): RemoteHandle {
  const fetchToken = opts.fetchToken ?? defaultFetchToken;
  const openSocket = opts.openSocket ?? defaultOpen;
  let stopped = false;
  let socket: SocketLike | null = null;
  let welcomed = false;

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
        opts.onLink?.(failure.why === "signed-out" ? "sign-in" : "unavailable");
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
      const sendCreate = () => {
        if (stopped || createSent || sock.readyState !== 1) return;
        createSent = true;
        sock.send(JSON.stringify(gameHello(token, opts.choice)));
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
          online?: number;
        };
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          return;
        }
        if (msg.t === "welcome" && msg.playerId) {
          welcomed = true;
          clearTimeout(createTimer);
          opts.onStatus?.("Online");
          opts.onLink?.("online");
          opts.onWelcome(msg.playerId);
          return;
        }
        if (msg.t === "snap" && msg.state) {
          opts.onSnap(msg.state, typeof msg.online === "number" ? msg.online : undefined);
          return;
        }
        if (msg.t === "ack" && typeof msg.seq === "number" && msg.result) {
          opts.onAck?.(msg.seq, msg.result);
          return;
        }
        if (msg.t !== "error") return;
        const reason = msg.reason ?? "";
        if (reason === "need_create") {
          if (!opts.choice.create) {
            failJoin("That slot is empty.");
            return;
          }
          if (createSent) {
            failJoin("The server did not accept that hero.");
            return;
          }
          void sendCreate();
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
        if (opts.choice.create) sendCreate();
        else sock.send(JSON.stringify(gameHello(token, { ...opts.choice, create: false })));
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
    opts.onLink?.("connecting");
    if (stopped) return;
    const code = await openOnce();
    if (stopped) return;
    stopped = true;
    opts.onLink?.(gateAfterClose(code));
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
