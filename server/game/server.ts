import http from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createAuthority } from "../../src/server/authority";
import { verifyGameToken } from "../../src/shared/net/token";
import { ClientMsg, type ServerMsg } from "../../src/shared/net/protocol";
import type { CharacterDb } from "./db";
import { applyIntent } from "./dispatch";
import { joinInputFor, recordFromPlayer } from "./persist";

const HELLO_MS = 5000;
const TICK_MS = 50;
const SAVE_EVERY = 100;

export interface GameServer {
  close: () => Promise<void>;
  /** Resolves with the bound port. Use `port: 0` to let the OS pick one. */
  ready: Promise<number>;
  readonly dropped: number;
  readonly tick: number;
}

function rawText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function warnSave(err: unknown) {
  const message = err instanceof Error ? err.message : "unknown";
  if (/postgres:\/\//i.test(message)) console.error("character save failed");
  else console.error("character save failed:", message);
}

type Conn = {
  socket: WebSocket;
  userId: string | null;
  playerId: string | null;
  replaced: boolean;
};

/**
 * Authoritative game server. One world, a 20 Hz tick, and a WebSocket per hero.
 * `hello` carries a short-lived game token (`aud=caldrenmoor`), not a display name.
 */
export function startServer(opts: {
  port: number;
  now?: () => number;
  rand?: () => number;
  characters?: CharacterDb;
  tokenSecret?: string;
}): GameServer {
  const now = opts.now ?? Date.now;
  const rand = opts.rand;
  const characters = opts.characters;
  const tokenSecret = opts.tokenSecret?.trim() || "";
  const authority = createAuthority({ now, rand });
  let tick = 0;
  let dropped = 0;
  let closed = false;
  let saving = false;
  const helloTimers = new Set<ReturnType<typeof setTimeout>>();
  const byUser = new Map<string, Conn>();
  const userLock = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();

  async function withUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = userLock.get(userId) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.catch(() => undefined).then(() => gate);
    userLock.set(userId, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (userLock.get(userId) === tail) userLock.delete(userId);
    }
  }

  function track(work: Promise<void>) {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }

  const httpServer = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url?.startsWith("/healthz?"))) {
      const body = JSON.stringify({ ok: true, players: authority.world.players.size, tick });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  httpServer.on("clientError", (_err, socket) => {
    socket.destroy();
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: 4096 });
  wss.on("error", () => {
    dropped++;
  });

  function send(socket: WebSocket, msg: ServerMsg) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(msg));
  }

  async function dropConn(conn: Conn) {
    const userId = conn.userId;
    const playerId = conn.playerId;
    conn.playerId = null;
    if (userId && byUser.get(userId) === conn) byUser.delete(userId);
    if (!playerId) return;
    const left = authority.world.leave(playerId);
    if (!left || !userId || !characters) return;
    try {
      await characters.save(userId, recordFromPlayer(left));
    } catch (err) {
      warnSave(err);
    }
  }

  wss.on("connection", (socket) => {
    const conn: Conn = { socket, userId: null, playerId: null, replaced: false };
    const helloTimer = setTimeout(() => {
      helloTimers.delete(helloTimer);
      if (!conn.playerId && socket.readyState === WebSocket.OPEN) socket.close(4401, "hello required");
    }, HELLO_MS);
    helloTimers.add(helloTimer);

    const forget = async () => {
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      if (conn.replaced) return;
      await dropConn(conn);
    };

    socket.on("error", () => {
      dropped++;
    });

    socket.on("close", () => {
      track(forget());
    });

    let chain = Promise.resolve();
    socket.on("message", (data) => {
      chain = chain.then(() => onMessage(data)).catch(() => {
        dropped++;
      });
      track(chain);
    });

    async function onMessage(data: RawData) {
      if (conn.replaced) return;
      let parsed: ReturnType<typeof ClientMsg.safeParse>;
      try {
        parsed = ClientMsg.safeParse(JSON.parse(rawText(data)));
      } catch {
        dropped++;
        return;
      }
      if (!parsed.success) {
        dropped++;
        return;
      }
      if (parsed.data.t === "hello") {
        if (conn.playerId || conn.replaced) return;
        if (!tokenSecret || !characters) {
          send(socket, { t: "error", reason: "not ready" });
          return;
        }
        const claims = await verifyGameToken(tokenSecret, parsed.data.token);
        if (!claims || conn.replaced) {
          if (!claims) send(socket, { t: "error", reason: "bad token" });
          return;
        }
        await withUser(claims.userId, async () => {
          if (conn.playerId || conn.replaced || !characters) return;
          const prev = byUser.get(claims.userId);
          if (prev && prev !== conn) {
            prev.replaced = true;
            await dropConn(prev);
            prev.socket.close(4409, "replaced");
          }
          clearTimeout(helloTimer);
          helloTimers.delete(helloTimer);
          const saved = await characters.load(claims.userId);
          if (conn.replaced) return;
          const player = authority.world.join(joinInputFor(claims.userId, claims.name, saved));
          conn.userId = claims.userId;
          conn.playerId = player.id;
          byUser.set(claims.userId, conn);
          try {
            await characters.save(claims.userId, recordFromPlayer(player));
          } catch (err) {
            warnSave(err);
          }
          send(socket, { t: "welcome", playerId: player.id });
        });
        return;
      }
      if (!conn.playerId) return;
      const result = applyIntent(authority.world, conn.playerId, parsed.data.intent);
      send(socket, { t: "ack", seq: parsed.data.seq, result });
    }
  });

  const timer = setInterval(() => {
    tick++;
    authority.step(now());
    if (characters && tick % SAVE_EVERY === 0 && !saving) {
      saving = true;
      const jobs: Promise<void>[] = [];
      for (const conn of byUser.values()) {
        if (!conn.userId || !conn.playerId) continue;
        const player = authority.world.players.get(conn.playerId);
        if (!player) continue;
        jobs.push(characters.save(conn.userId, recordFromPlayer(player)));
      }
      track(
        Promise.all(jobs)
          .then(() => undefined)
          .catch((err) => warnSave(err))
          .finally(() => {
            saving = false;
          }),
      );
    }
    if (tick % 2 !== 0) return;
    const msg = JSON.stringify({
      t: "snap",
      tick,
      state: authority.snapshot(),
    } satisfies ServerMsg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }, TICK_MS);

  const ready = new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, () => {
      httpServer.removeAllListeners("error");
      httpServer.on("error", () => {
        dropped++;
      });
      const addr = httpServer.address();
      resolve(typeof addr === "object" && addr ? addr.port : opts.port);
    });
  });

  return {
    ready,
    get dropped() {
      return dropped;
    },
    get tick() {
      return tick;
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      clearInterval(timer);
      for (const helloTimer of helloTimers) clearTimeout(helloTimer);
      helloTimers.clear();
      for (const client of wss.clients) client.terminate();
      wss.close();
      return new Promise((resolve) => {
        httpServer.close(() => {
          setImmediate(() => {
            void Promise.all([...pending]).then(() => resolve());
          });
        });
      });
    },
  };
}
