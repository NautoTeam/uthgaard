import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { CharacterRecord } from "../../src/shared/persist/store";
import type { GraveState } from "../../src/shared/sim/types";

export interface LoadedCharacter {
  save: CharacterRecord;
  rev: number;
}

export interface CharacterDb {
  load(userId: string): Promise<LoadedCharacter | null>;
  /** Inserts rev 1. `"name_taken"` on unique violation (23505). */
  create(userId: string, name: string, save: CharacterRecord): Promise<number | "name_taken">;
  /** Next rev, or null when `expectedRev` is stale. Does not overwrite. */
  save(userId: string, save: CharacterRecord, expectedRev: number): Promise<number | null>;
}

export interface GraveDb {
  listGraves(): Promise<GraveState[]>;
  putGrave(g: GraveState): Promise<void>;
  deleteGrave(id: string): Promise<void>;
}

export type GameDb = CharacterDb & GraveDb;

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations/game");

const CREATE_SQL = `insert into characters (user_id, name, save, rev)
values ($1, $2, $3::jsonb, 1)`;

const SAVE_SQL = `update characters
set save = $2::jsonb, name = $4, rev = rev + 1, updated_at = now()
where user_id = $1 and rev = $3
returning rev`;

function pgCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) return String((err as { code: unknown }).code);
  return "";
}

function asSave(raw: unknown): CharacterRecord {
  return typeof raw === "string" ? (JSON.parse(raw) as CharacterRecord) : (raw as CharacterRecord);
}

function asGrave(raw: unknown): GraveState {
  return typeof raw === "string" ? (JSON.parse(raw) as GraveState) : (raw as GraveState);
}

function sqlStatements(text: string): string[] {
  return text
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.split("\n").some((line) => line.trim() && !line.trim().startsWith("--")));
}

export async function applyGameMigrations(query: Query): Promise<void> {
  await query(
    "create table if not exists _game_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const applied = new Set(
    (await query("select name from _game_migrations")).rows.map((row) => String(row.name)),
  );
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const text = await readFile(join(migrationsDir, name), "utf8");
    await query("begin");
    try {
      for (const statement of sqlStatements(text)) await query(statement);
      await query("insert into _game_migrations (name) values ($1)", [name]);
      await query("commit");
      applied.add(name);
    } catch (err) {
      await query("rollback").catch(() => undefined);
      throw err;
    }
  }
}

export function memoryCharacters(): GameDb {
  const rows = new Map<string, { save: CharacterRecord; rev: number; name: string }>();
  const graves = new Map<string, GraveState>();
  const nameTaken = (name: string, exceptUser?: string) => {
    const key = name.trim().toLowerCase();
    for (const [userId, row] of rows) {
      if (userId !== exceptUser && row.name.trim().toLowerCase() === key) return true;
    }
    return false;
  };
  return {
    async load(userId) {
      const row = rows.get(userId);
      return row ? { save: structuredClone(row.save), rev: row.rev } : null;
    },
    async create(userId, name, save) {
      if (rows.has(userId) || nameTaken(name)) return "name_taken";
      rows.set(userId, { save: structuredClone(save), rev: 1, name });
      return 1;
    },
    async save(userId, save, expectedRev) {
      const row = rows.get(userId);
      if (!row || row.rev !== expectedRev) return null;
      const name = save.username || row.name;
      if (nameTaken(name, userId)) return null;
      row.rev += 1;
      row.save = structuredClone(save);
      row.name = name;
      return row.rev;
    },
    async listGraves() {
      return [...graves.values()].map((g) => ({ ...g, items: { ...g.items } }));
    },
    async putGrave(g) {
      graves.set(g.id, { ...g, items: { ...(g.items ?? {}) } });
    },
    async deleteGrave(id) {
      graves.delete(id);
    },
  };
}

export function characterStore(query: Query): GameDb {
  return {
    async load(userId) {
      const result = await query("select save, rev from characters where user_id = $1", [userId]);
      const row = result.rows[0];
      if (!row || row.save == null) return null;
      return { save: asSave(row.save), rev: Number(row.rev ?? 0) };
    },
    async create(userId, name, save) {
      try {
        await query(CREATE_SQL, [userId, name, JSON.stringify(save)]);
        return 1;
      } catch (err) {
        if (pgCode(err) === "23505") return "name_taken";
        throw err;
      }
    },
    async save(userId, save, expectedRev) {
      try {
        const result = await query(SAVE_SQL, [userId, JSON.stringify(save), expectedRev, save.username]);
        const rev = result.rows[0]?.rev;
        return rev == null ? null : Number(rev);
      } catch (err) {
        if (pgCode(err) === "23505") return null;
        throw err;
      }
    },
    async listGraves() {
      const result = await query("select data from graves");
      return result.rows.map((row) => asGrave(row.data));
    },
    async putGrave(g) {
      await query(
        `insert into graves (id, owner_user_id, data) values ($1, $2, $3::jsonb)
         on conflict (id) do update set data = excluded.data`,
        [g.id, null, JSON.stringify(g)],
      );
    },
    async deleteGrave(id) {
      await query("delete from graves where id = $1", [id]);
    },
  };
}

function sslFor(databaseUrl: string): pg.ConnectionConfig["ssl"] {
  if (/localhost|127\.0\.0\.1/.test(databaseUrl)) return undefined;
  return { rejectUnauthorized: false };
}

/** Apply migrations/game and return a store. Caller closes the pool on shutdown. */
export async function openGameDb(databaseUrl: string): Promise<GameDb & { close(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, ssl: sslFor(databaseUrl) });
  const client = await pool.connect();
  try {
    await applyGameMigrations((text, params) => client.query(text, params));
  } finally {
    client.release();
  }
  const store = characterStore((text, params) => pool.query(text, params));
  return {
    ...store,
    close: () => pool.end(),
  };
}
