import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { CharacterRecord } from "../../src/shared/persist/store";

export interface CharacterDb {
  load(userId: string): Promise<CharacterRecord | null>;
  save(userId: string, save: CharacterRecord): Promise<void>;
}

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Array<{ save?: unknown }> }>;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations/game");

const SAVE_SQL = `insert into characters (user_id, save)
values ($1, $2::jsonb)
on conflict (user_id) do update set save = excluded.save, updated_at = now()`;

export function memoryCharacters(): CharacterDb {
  const rows = new Map<string, CharacterRecord>();
  return {
    async load(userId) {
      const save = rows.get(userId);
      return save ? structuredClone(save) : null;
    },
    async save(userId, save) {
      rows.set(userId, structuredClone(save));
    },
  };
}

export function characterStore(query: Query): CharacterDb {
  return {
    async load(userId) {
      const result = await query("select save from characters where user_id = $1", [userId]);
      const raw = result.rows[0]?.save;
      if (raw == null) return null;
      const save = typeof raw === "string" ? (JSON.parse(raw) as CharacterRecord) : (raw as CharacterRecord);
      return save;
    },
    async save(userId, save) {
      await query(SAVE_SQL, [userId, JSON.stringify(save)]);
    },
  };
}

function sslFor(databaseUrl: string): pg.ConnectionConfig["ssl"] {
  if (/localhost|127\.0\.0\.1/.test(databaseUrl)) return undefined;
  return { rejectUnauthorized: false };
}

/** Apply migrations/game and return a store. Caller closes the pool on shutdown. */
export async function openGameDb(databaseUrl: string): Promise<CharacterDb & { close(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, ssl: sslFor(databaseUrl) });
  const client = await pool.connect();
  try {
    await client.query(
      "create table if not exists _game_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const applied = new Set(
      (await client.query<{ name: string }>("select name from _game_migrations")).rows.map((row) => row.name),
    );
    const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
    for (const name of files) {
      if (applied.has(name)) continue;
      const text = await readFile(join(migrationsDir, name), "utf8");
      await client.query("begin");
      try {
        await client.query(text);
        await client.query("insert into _game_migrations (name) values ($1)", [name]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      }
    }
  } finally {
    client.release();
  }
  const store = characterStore((text, params) => pool.query(text, params));
  return {
    load: (userId) => store.load(userId),
    save: (userId, save) => store.save(userId, save),
    close: () => pool.end(),
  };
}
