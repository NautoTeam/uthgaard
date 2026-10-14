import { startServer } from "./server";

const port = Number(process.env.PORT ?? 2567);
const game = startServer({ port });
console.log(`listening :${port}`);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => process.exit(0), 2000);
  force.unref();
  void game.close().then(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
