import { openGameDb } from "./db";
import { startServer } from "./server";

const port = Number(process.env.PORT ?? 2567);
const databaseUrl = process.env.DATABASE_URL?.trim() || "";
const tokenSecret = process.env.GAME_TOKEN_SECRET?.trim() || "";
const db = databaseUrl ? await openGameDb(databaseUrl) : null;
const game = startServer({
  port,
  characters: db ?? undefined,
  tokenSecret: tokenSecret || undefined,
});
console.log(`listening :${port}`);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => process.exit(0), 2000);
  force.unref();
  void game.close().then(async () => {
    await db?.close();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
