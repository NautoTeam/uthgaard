import http from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createAuthority } from "../../src/server/authority";
import { BASE_CLASSES, CREATABLE_RACES } from "../../src/shared/content/catalog";
import { ClientMsg, type ServerMsg } from "../../src/shared/net/protocol";
import { applyIntent } from "./dispatch";

const HELLO_MS = 5000;
const TICK_MS = 50;

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

/**
 * Authoritative game server. One world, a 20 Hz tick, and a WebSocket per hero.
 * Identity is a temporary `hello` name until piece 2 swaps in a token.
 */
export function startServer(opts: {
  port: number;
  now?: () => number;
  rand?: () => number;
}): GameServer {
  const now = opts.now ?? Date.now;
  const rand = opts.rand;
  const authority = createAuthority({ now, rand });
  let tick = 0;
  let dropped = 0;
  let seq = 0;
  let closed = false;
  const helloTimers = new Set<ReturnType<typeof setTimeout>>();

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

  wss.on("connection", (socket) => {
    let playerId: string | null = null;
    const helloTimer = setTimeout(() => {
      helloTimers.delete(helloTimer);
      if (!playerId && socket.readyState === WebSocket.OPEN) socket.close(4401, "hello required");
    }, HELLO_MS);
    helloTimers.add(helloTimer);

    const forget = () => {
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      if (playerId) {
        authority.world.leave(playerId);
        playerId = null;
      }
    };

    socket.on("error", () => {
      dropped++;
    });

    socket.on("close", () => {
      forget();
    });

    socket.on("message", (data) => {
      try {
        const parsed = ClientMsg.safeParse(JSON.parse(rawText(data)));
        if (!parsed.success) {
          dropped++;
          return;
        }
        if (parsed.data.t === "hello") {
          if (playerId) return;
          clearTimeout(helloTimer);
          helloTimers.delete(helloTimer);
          playerId = "p" + ++seq;
          authority.world.join({
            id: playerId,
            username: parsed.data.name,
            race: CREATABLE_RACES[0] ?? "Human",
            baseClass: BASE_CLASSES[0] ?? "Fighter",
          });
          send(socket, { t: "welcome", playerId });
          return;
        }
        if (!playerId) return;
        const result = applyIntent(authority.world, playerId, parsed.data.intent);
        send(socket, { t: "ack", seq: parsed.data.seq, result });
      } catch {
        dropped++;
      }
    });
  });

  const timer = setInterval(() => {
    tick++;
    authority.step(now());
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
        httpServer.close(() => resolve());
      });
    },
  };
}
