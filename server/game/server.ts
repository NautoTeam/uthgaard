import { createHash } from "node:crypto";
import http from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createAuthority } from "./authority";
import { verifyGameToken } from "../../src/shared/net/token";
import { ClientMsg, type ServerMsg } from "../../src/shared/net/protocol";
import type { World } from "../../src/shared/sim/world";
import { zoneAt } from "../../src/shared/sim/mask";
import type { GameDb, StoredGuild } from "./db";
import { applyIntent } from "./dispatch";
import { createGuildBook, foundGuild } from "./guilds";
import { joinInputFor, recordFromPlayer, validateCreate } from "./persist";
import { seen } from "./replay";

const HELLO_MS = 5000;
const CREATE_MS = 120_000;
const TICK_MS = 50;
const SAVE_MS = 30_000;
const INTENT_RATE = 30;
const INTENT_BURST = 60;
const ABUSE_WINDOW_MS = 10_000;

const KNOWN_OPS = new Set([
  "move",
  "attack",
  "skill",
  "travel",
  "buy",
  "sell",
  "useItem",
  "equip",
  "unequip",
  "train",
  "promote",
  "chat",
  "respawn",
  "loot",
  "partyInvite",
  "partyAccept",
  "partyDecline",
  "partyLeave",
  "buyCharter",
  "foundGuild",
]);

/** A well-formed intent envelope whose op is not in the protocol. Schema failures of real ops stay malformed. */
function unknownIntent(raw: unknown): { seq: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as { t?: unknown; seq?: unknown; intent?: { op?: unknown } };
  if (msg.t !== "intent" || !msg.intent || typeof msg.intent !== "object") return null;
  const op = msg.intent.op;
  if (typeof op !== "string" || !op || op.length > 32 || KNOWN_OPS.has(op)) return null;
  const seq = typeof msg.seq === "number" && Number.isInteger(msg.seq) && msg.seq >= 0 ? msg.seq : 0;
  return { seq };
}

/** Empty allow-list permits every origin outside production and none inside it. */
export function originAllowed(origin: string | undefined, allowed: string | undefined, nodeEnv: string | undefined): boolean {
  const list = String(allowed ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (list.length === 0) return nodeEnv !== "production";
  if (!origin) return false;
  return list.includes(origin);
}

let originWarningLogged = false;
function warnIfOriginsUnset() {
  if (originWarningLogged || process.env.NODE_ENV !== "production") return;
  const list = String(process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (list.length > 0) return;
  originWarningLogged = true;
  console.warn("ALLOWED_ORIGINS is unset; refusing every WebSocket origin");
}

function sameZone(
  viewer: { id: string; x: number; z: number },
  other: { id: string; x: number; z: number },
) {
  if (other.id === viewer.id) return true;
  const here = zoneAt(viewer.x, viewer.z)?.id ?? "";
  const there = zoneAt(other.x, other.z)?.id ?? "";
  if (here && there) return here === there;
  return Math.hypot(viewer.x - other.x, viewer.z - other.z) <= 48;
}

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

/** Short, non-reversible tag for a user id in logs. */
export function userTag(userId: string | null | undefined): string {
  if (!userId) return "-";
  return createHash("sha256").update(userId).digest("hex").slice(0, 10);
}

function logNet(event: string, userId: string | null | undefined, detail = "") {
  if (process.env.NODE_ENV === "test") return;
  console.log(`net ${event} user=${userTag(userId)}${detail ? ` ${detail}` : ""}`);
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
  slot: number;
  savedHash: string;
  alive: boolean;
  saveChain: Promise<void>;
  tokens: number;
  bucketAt: number;
  drops: number[];
  bads: number[];
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
  /** Test override. Production reads ALLOWED_ORIGINS. */
  allowedOrigins?: string;
  nodeEnv?: string;
}): GameServer {
  const now = opts.now ?? Date.now;
  const rand = opts.rand;
  const characters = opts.characters;
  const tokenSecret = opts.tokenSecret?.trim() || "";
  const allowedOrigins = opts.allowedOrigins ?? process.env.ALLOWED_ORIGINS;
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  const authority = createAuthority({ now, rand });
  const guilds = createGuildBook();
  warnIfOriginsUnset();
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
    const next = await characters.save(conn.userId, record, conn.rev, conn.slot);
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
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/characters" && (req.method === "GET" || req.method === "DELETE" || req.method === "OPTIONS")) {
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (origin && originAllowed(origin, allowedOrigins, nodeEnv)) {
        headers["access-control-allow-origin"] = origin;
        headers["vary"] = "Origin";
        headers["access-control-allow-headers"] = "authorization, content-type";
        headers["access-control-allow-methods"] = "GET, DELETE, OPTIONS";
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, headers);
        res.end();
        return;
      }
      void (async () => {
        const fail = (status: number, error: string) => {
          const body = JSON.stringify({ error });
          res.writeHead(status, { ...headers, "content-length": Buffer.byteLength(body) });
          res.end(body);
        };
        if (!tokenSecret || !characters) {
          fail(503, "not ready");
          return;
        }
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        const claims = token ? await verifyGameToken(tokenSecret, token) : null;
        if (!claims) {
          fail(401, "bad token");
          return;
        }
        if (req.method === "DELETE") {
          const slot = Number(url.searchParams.get("slot"));
          if (!Number.isInteger(slot) || slot < 0 || slot > 2) {
            fail(400, "bad_slot");
            return;
          }
          await characters.remove(claims.userId, slot);
          const body = JSON.stringify({ ok: true });
          res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) });
          res.end(body);
          return;
        }
        const rows = await characters.list(claims.userId);
        const slots = [0, 1, 2].map((slot) => rows.find((row) => row.slot === slot) ?? null);
        const body = JSON.stringify({ slots });
        res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) });
        res.end(body);
      })().catch((err) => {
        warnSave(err);
        if (!res.headersSent) {
          res.writeHead(500, headers);
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  httpServer.on("clientError", (_err, socket) => {
    socket.destroy();
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: 4096,
    verifyClient: (info, done) => {
      if (originAllowed(info.origin, allowedOrigins, nodeEnv)) {
        done(true);
        return;
      }
      if (nodeEnv === "production") warnIfOriginsUnset();
      done(false, 403, "Forbidden");
    },
  });
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
      const next = await db.save(userId, record, conn.rev, conn.slot);
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
      slot: 0,
      savedHash: "",
      alive: true,
      saveChain: Promise.resolve(),
      tokens: INTENT_BURST,
      bucketAt: Date.now(),
      drops: [],
      bads: [],
    };
    let helloTimer: ReturnType<typeof setTimeout>;
    function armHello(ms: number) {
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      helloTimer = setTimeout(() => {
        helloTimers.delete(helloTimer);
        if (!conn.playerId && socket.readyState === WebSocket.OPEN) socket.close(4401, "hello required");
      }, ms);
      helloTimers.add(helloTimer);
    }
    armHello(HELLO_MS);

    const forget = async () => {
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      if (conn.replaced) return;
      await dropConn(conn);
    };

    socket.on("error", () => {
      dropped++;
    });

    socket.on("close", (code) => {
      if (conn.userId) logNet("close", conn.userId, `code=${code}`);
      conn.dead = true;
      track(forget());
    });

    function reject(reason: "bad token" | "not ready") {
      logNet("reject", conn.userId, `reason=${reason}`);
      conn.dead = true;
      send(socket, { t: "error", reason });
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      socket.close(4401, reason);
    }

    function noteBad() {
      dropped++;
      const t = Date.now();
      conn.bads.push(t);
      conn.bads = conn.bads.filter((ts) => t - ts <= ABUSE_WINDOW_MS);
      if (conn.bads.length >= 20 && !conn.dead) {
        conn.dead = true;
        socket.close(4400, "bad message");
      }
    }

    function noteDrop() {
      const t = Date.now();
      conn.drops.push(t);
      conn.drops = conn.drops.filter((ts) => t - ts <= ABUSE_WINDOW_MS);
      if (conn.drops.length > 100 && !conn.dead) {
        conn.dead = true;
        socket.close(4429, "slow down");
      }
    }

    function allowIntent() {
      const t = Date.now();
      const elapsed = Math.max(0, (t - conn.bucketAt) / 1000);
      conn.tokens = Math.min(INTENT_BURST, conn.tokens + elapsed * INTENT_RATE);
      conn.bucketAt = t;
      if (conn.tokens < 1) return false;
      conn.tokens -= 1;
      return true;
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
      let raw: unknown;
      try {
        raw = JSON.parse(rawText(data));
      } catch {
        noteBad();
        return;
      }
      const parsed = ClientMsg.safeParse(raw);
      if (!parsed.success) {
        const kind = raw && typeof raw === "object" ? (raw as { t?: unknown }).t : undefined;
        if (kind === "hello") {
          logNet("bad_create", null, "stage=parse"); send(socket, { t: "error", reason: "bad_create" });
          return;
        }
        const unknown = unknownIntent(raw);
        if (unknown) {
          send(socket, { t: "ack", seq: unknown.seq, result: { ok: false, reason: "unknown op" } });
          return;
        }
        noteBad();
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
        logNet("hello", claims?.userId, `create=${hello.create ? 1 : 0}`);
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
            logNet("replaced", claims.userId);
            prev.replaced = true;
            await dropConn(prev);
            prev.socket.close(4409, "replaced");
          }
          if (hello.create && !Number.isInteger(hello.create.slot)) {
            logNet("bad_slot", claims.userId);
            send(socket, { t: "error", reason: "bad_slot" });
            return;
          }
          if (hello.create && (hello.create.slot < 0 || hello.create.slot > 2)) {
            logNet("bad_slot", claims.userId);
            send(socket, { t: "error", reason: "bad_slot" });
            return;
          }
          const choice = hello.create ? validateCreate(hello.create) : null;
          if (hello.create && !choice) {
            logNet("bad_create", claims.userId);
            send(socket, { t: "error", reason: "bad_create" });
            return;
          }
          const slot = choice ? choice.slot : hello.slot;
          if (slot == null) {
            logNet("need_create", claims.userId);
            send(socket, { t: "error", reason: "need_create" });
            armHello(CREATE_MS);
            return;
          }
          if (!Number.isInteger(slot) || slot < 0 || slot > 2) {
            logNet("bad_slot", claims.userId);
            send(socket, { t: "error", reason: "bad_slot" });
            return;
          }
          conn.slot = slot;
          const loaded = choice ? null : await characters.load(claims.userId, slot);
          if (conn.replaced || conn.dead) return;
          let input = loaded ? joinInputFor(claims.userId, loaded.save, null) : null;
          let rev = loaded?.rev ?? 0;
          let createdNow = false;
          if (!loaded) {
            if (!choice) {
              logNet("need_create", claims.userId);
              send(socket, { t: "error", reason: "need_create" });
              armHello(CREATE_MS);
              return;
            }
            const occupied = await characters.load(claims.userId, choice.slot);
            if (occupied) {
              logNet("slot_taken", claims.userId);
              send(socket, { t: "error", reason: "slot_taken" });
              return;
            }
            input = joinInputFor(claims.userId, null, choice);
            if (!input) {
              logNet("bad_create", claims.userId);
              send(socket, { t: "error", reason: "bad_create" });
              return;
            }
            const player = authority.world.join(input);
            const record = recordFromPlayer(player);
            let created: Awaited<ReturnType<NonNullable<typeof characters>["create"]>>;
            try {
              created = await characters.create(claims.userId, record.username, record, choice.slot);
            } catch (err) {
              authority.world.leave(player.id);
              warnSave(err);
              logNet("join_failed", claims.userId);
              send(socket, { t: "error", reason: "join_failed" });
              return;
            }
            if (typeof created !== "number") {
              authority.world.leave(player.id);
              logNet(created, claims.userId);
              send(socket, { t: "error", reason: created });
              return;
            }
            rev = created;
            createdNow = true;
            conn.savedHash = JSON.stringify(record);
          }
          if (!input) {
            logNet("need_create", claims.userId);
            send(socket, { t: "error", reason: "need_create" });
            armHello(CREATE_MS);
            return;
          }
          if (conn.dead || conn.replaced) {
            if (createdNow) authority.world.leave(claims.userId);
            return;
          }
          const player = createdNow ? authority.world.players.get(claims.userId) : authority.world.join(input);
          if (!player) return;
          if (guilds.hasUser(player.id)) player.charter = false;
          if (!createdNow) {
            const record = recordFromPlayer(player);
            conn.savedHash = JSON.stringify(record);
          }
          clearTimeout(helloTimer);
          helloTimers.delete(helloTimer);
          conn.userId = claims.userId;
          conn.playerId = player.id;
          conn.rev = rev;
          conn.alive = player.hp > 0;
          byUser.set(claims.userId, conn);
          logNet("welcome", claims.userId, `new=${!loaded} online=${byUser.size}`);
          send(socket, { t: "welcome", playerId: player.id });
        });
        return;
      }
      if (!conn.playerId) return;
      if (!allowIntent()) {
        noteDrop();
        return;
      }
      if (parsed.data.intent.op === "foundGuild") {
        const store = characters;
        const write = store ? (row: StoredGuild) => store.insertGuild(row) : undefined;
        const result = await foundGuild(authority.world, guilds, conn.playerId, parsed.data.intent, write);
        send(socket, { t: "ack", seq: parsed.data.seq, result });
        if (result.ok) void persist(conn, true);
        return;
      }
      const result = applyIntent(authority.world, conn.playerId, parsed.data.intent, guilds);
      send(socket, { t: "ack", seq: parsed.data.seq, result });
      if (result.ok && (parsed.data.intent.op === "respawn" || parsed.data.intent.op === "buyCharter")) {
        if (parsed.data.intent.op === "respawn") conn.alive = true;
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
    const full = authority.snapshot();
    const online = byUser.size;
    const encoded = new Map<string, string>();
    const packet = (ids: string, viewerId: string) => {
      const key = `${viewerId}\n${ids}`;
      const hit = encoded.get(key);
      if (hit) return hit;
      const want = new Set(ids ? ids.split(",") : []);
      const players = (ids ? full.players.filter((p) => want.has(p.id)) : full.players).map((row) => {
        const tag = guilds.tag(row.id);
        return tag ? { ...row, guildTag: tag } : row;
      });
      const social = authority.world.social(viewerId);
      const live = authority.world.players.get(viewerId);
      const msg = JSON.stringify({
        t: "snap",
        tick,
        online,
        state: {
          ...full,
          players,
          party: social.party,
          pendingInvite: social.pendingInvite,
          charter: live?.charter === true,
          guild: guilds.view(viewerId),
        },
      } satisfies ServerMsg);
      encoded.set(key, msg);
      return msg;
    };
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      let viewer: { id: string; x: number; z: number } | undefined;
      for (const conn of byUser.values()) {
        if (conn.socket !== client || !conn.playerId) continue;
        const row = full.players.find((p) => p.id === conn.playerId);
        if (row) viewer = row;
        break;
      }
      // A socket gets world state only after its hero has joined.
      if (!viewer) continue;
      const seen = viewer;
      const ids = full.players
        .filter((p) => sameZone(seen, p))
        .map((p) => p.id)
        .sort()
        .join(",");
      client.send(packet(ids, seen.id));
    }
  }, TICK_MS);

  const ready = (async () => {
    if (characters) guilds.load(await characters.listGuilds());
    return await new Promise<number>((resolve, rejectReady) => {
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
  })();

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
