import http from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createAuthority } from "../../src/server/authority";
import { verifyGameToken } from "../../src/shared/net/token";
import { ClientMsg, type ServerMsg } from "../../src/shared/net/protocol";
import type { World } from "../../src/shared/sim/world";
import type { GameDb } from "./db";
import { applyIntent } from "./dispatch";
import { joinInputFor, recordFromPlayer, validateCreate } from "./persist";
import { seen } from "./replay";

const HELLO_MS = 5000;
const TICK_MS = 50;
const SAVE_MS = 30_000;

export interface GameServer {
  close: () => Promise<void>;
  /** Resolves with the bound port. Use `port: 0` to let the OS pick one. */
  ready: Promise<number>;
  readonly dropped: number;
  readonly tick: number;
  readonly world: World;
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
  dead: boolean;
  jti: string | null;
  rev: number;
  savedHash: string;
  alive: boolean;
  saveChain: Promise<void>;
};

/**
 * Authoritative game server. One world, a 20 Hz tick, and a WebSocket per hero.
 * `hello` carries a short-lived game token (`aud=caldrenmoor`), not a display name.
 */
export function startServer(opts: {
  port: number;
  now?: () => number;
  rand?: () => number;
  characters?: GameDb;
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
  let lastSaveAt = now();
  let gravesReady = false;
  const knownGraves = new Set<string>();
  const helloTimers = new Set<ReturnType<typeof setTimeout>>();
  const byUser = new Map<string, Conn>();
  const userLock = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();

  function digest(userId: string) {
    const player = authority.world.players.get(userId);
    return player ? JSON.stringify(recordFromPlayer(player)) : "";
  }

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

  async function writePlayer(conn: Conn, force: boolean) {
    if (!characters || !conn.userId || !conn.playerId) return;
    const player = authority.world.players.get(conn.playerId);
    if (!player) return;
    const record = recordFromPlayer(player);
    const hash = JSON.stringify(record);
    if (!force && hash === conn.savedHash) return;
    const next = await characters.save(conn.userId, record, conn.rev);
    if (next == null) {
      console.error(`stale save ${conn.userId}`);
      return;
    }
    conn.rev = next;
    conn.savedHash = hash;
  }

  function persist(conn: Conn, force: boolean) {
    const run = conn.saveChain.then(() => writePlayer(conn, force));
    conn.saveChain = run.then(
      () => undefined,
      (err) => warnSave(err),
    );
    track(conn.saveChain);
    return run;
  }

  function syncLife(conn: Conn) {
    if (!conn.playerId) return;
    const player = authority.world.players.get(conn.playerId);
    if (!player) return;
    const dead = player.hp <= 0 && player.graveDropped;
    if (conn.alive && dead) {
      conn.alive = false;
      void persist(conn, true);
    } else if (!conn.alive && player.hp > 0) {
      conn.alive = true;
      void persist(conn, true);
    }
  }

  function syncGraves() {
    if (!characters || !gravesReady) return;
    const graves = authority.snapshot().graves;
    const ids = new Set(graves.map((g) => g.id));
    for (const grave of graves) {
      if (knownGraves.has(grave.id)) continue;
      knownGraves.add(grave.id);
      track(characters.putGrave(grave).catch((err) => warnSave(err)));
    }
    for (const id of [...knownGraves]) {
      if (ids.has(id)) continue;
      knownGraves.delete(id);
      track(characters.deleteGrave(id).catch((err) => warnSave(err)));
    }
  }

  void (async () => {
    if (!characters) {
      gravesReady = true;
      return;
    }
    try {
      const list = await characters.listGraves();
      authority.world.adoptGraves(list);
      for (const grave of list) knownGraves.add(grave.id);
    } catch (err) {
      warnSave(err);
    } finally {
      gravesReady = true;
    }
  })();

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
    const db = characters;
    const record = recordFromPlayer(left);
    const run = conn.saveChain.then(async () => {
      const next = await db.save(userId, record, conn.rev);
      if (next == null) {
        console.error(`stale save ${userId}`);
        return;
      }
      conn.rev = next;
      conn.savedHash = JSON.stringify(record);
    });
    conn.saveChain = run.then(
      () => undefined,
      (err) => warnSave(err),
    );
    track(conn.saveChain);
    try {
      await run;
    } catch (err) {
      warnSave(err);
    }
  }

  wss.on("connection", (socket) => {
    const conn: Conn = {
      socket,
      userId: null,
      playerId: null,
      replaced: false,
      dead: false,
      jti: null,
      rev: 0,
      savedHash: "",
      alive: true,
      saveChain: Promise.resolve(),
    };
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
      conn.dead = true;
      track(forget());
    });

    function reject(reason: "bad token" | "not ready") {
      conn.dead = true;
      send(socket, { t: "error", reason });
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      socket.close(4401, reason);
    }

    let chain = Promise.resolve();
    socket.on("message", (data) => {
      chain = chain.then(() => onMessage(data)).catch(() => {
        dropped++;
      });
      track(chain);
    });

    async function onMessage(data: RawData) {
      if (conn.replaced || conn.dead) return;
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
        const hello = parsed.data;
        if (conn.playerId || conn.replaced || conn.dead) return;
        if (!tokenSecret || !characters) {
          reject("not ready");
          return;
        }
        const claims = await verifyGameToken(tokenSecret, hello.token);
        if (conn.replaced || conn.dead) return;
        if (!claims) {
          reject("bad token");
          return;
        }
        if (conn.jti !== claims.jti && seen(claims.jti, claims.exp)) {
          reject("bad token");
          return;
        }
        conn.jti = claims.jti;
        await withUser(claims.userId, async () => {
          if (conn.playerId || conn.replaced || conn.dead || !characters) return;
          const prev = byUser.get(claims.userId);
          if (prev && prev !== conn) {
            prev.replaced = true;
            await dropConn(prev);
            prev.socket.close(4409, "replaced");
          }
          const loaded = await characters.load(claims.userId);
          if (conn.replaced || conn.dead) return;
          let input = loaded ? joinInputFor(claims.userId, loaded.save, null) : null;
          let rev = loaded?.rev ?? 0;
          if (!loaded) {
            const choice = validateCreate(hello.create);
            if (!hello.create) {
              send(socket, { t: "error", reason: "need_create" });
              return;
            }
            if (!choice) {
              send(socket, { t: "error", reason: "bad_create" });
              return;
            }
            input = joinInputFor(claims.userId, null, choice);
            if (!input) {
              send(socket, { t: "error", reason: "bad_create" });
              return;
            }
            const player = authority.world.join(input);
            const record = recordFromPlayer(player);
            let created: Awaited<ReturnType<NonNullable<typeof characters>["create"]>>;
            try {
              created = await characters.create(claims.userId, record.username, record);
            } catch (err) {
              authority.world.leave(player.id);
              throw err;
            }
            if (created === "name_taken") {
              authority.world.leave(player.id);
              send(socket, { t: "error", reason: "name_taken" });
              return;
            }
            rev = created;
            conn.savedHash = JSON.stringify(record);
          }
          if (!input) {
            send(socket, { t: "error", reason: "need_create" });
            return;
          }
          if (conn.dead || conn.replaced) {
            if (!loaded) authority.world.leave(claims.userId);
            return;
          }
          const player = loaded ? authority.world.join(input) : authority.world.players.get(claims.userId);
          if (!player) return;
          if (loaded) conn.savedHash = digest(player.id);
          clearTimeout(helloTimer);
          helloTimers.delete(helloTimer);
          conn.userId = claims.userId;
          conn.playerId = player.id;
          conn.rev = rev;
          conn.alive = player.hp > 0;
          byUser.set(claims.userId, conn);
          send(socket, { t: "welcome", playerId: player.id });
        });
        return;
      }
      if (!conn.playerId) return;
      const result = applyIntent(authority.world, conn.playerId, parsed.data.intent);
      send(socket, { t: "ack", seq: parsed.data.seq, result });
      if (parsed.data.intent.op === "respawn" && result.ok) {
        conn.alive = true;
        void persist(conn, true);
      }
    }
  });

  const timer = setInterval(() => {
    tick++;
    authority.step(now());
    for (const conn of byUser.values()) syncLife(conn);
    syncGraves();
    const at = now();
    if (characters && at - lastSaveAt >= SAVE_MS) {
      lastSaveAt = at;
      for (const conn of byUser.values()) void persist(conn, false);
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

  const ready = new Promise<number>((resolve, rejectReady) => {
    httpServer.once("error", rejectReady);
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
    get world() {
      return authority.world;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const helloTimer of helloTimers) clearTimeout(helloTimer);
      helloTimers.clear();
      const conns = [...byUser.values()];
      await Promise.all(conns.map((conn) => persist(conn, true))).catch((err) => warnSave(err));
      for (const conn of conns) conn.replaced = true;
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      await Promise.all([...pending]);
    },
  };
}
