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

export interface CharacterSlot {
  slot: number;
  name: string;
  race: string;
  baseClass: string;
  prestigeClass: string;
  level: number;
}

export interface CharacterDb {
  load(userId: string, slot?: number): Promise<LoadedCharacter | null>;
  list(userId: string): Promise<CharacterSlot[]>;
  /** Inserts rev 1. `"name_taken"` / `"slot_taken"` / `"bad_slot"`. */
  create(
    userId: string,
    name: string,
    save: CharacterRecord,
    slot?: number,
  ): Promise<number | "name_taken" | "slot_taken" | "bad_slot">;
  /** Next rev, or null when `expectedRev` is stale. Does not overwrite. */
  save(userId: string, save: CharacterRecord, expectedRev: number, slot?: number): Promise<number | null>;
  remove(userId: string, slot: number): Promise<void>;
}

export interface GraveDb {
  listGraves(): Promise<GraveState[]>;
  putGrave(g: GraveState): Promise<void>;
  deleteGrave(id: string): Promise<void>;
}

export interface StoredGuild {
  id: string;
  userId: string;
  name: string;
  tag: string;
  kind: string;
  crest: string;
  rank: "leader" | "officer" | "member";
  /** Character name. Not its own column; filled from the hero or the characters table. */
  username?: string;
  /** Join order. Milliseconds from the server clock, or the row's joined_at. */
  joinedAt?: number;
}

export type GuildWrite = "ok" | "name_taken" | "tag_taken" | "already";
export type MemberWrite = "ok" | "already" | "missing";

export interface GuildDb {
  listGuilds(): Promise<StoredGuild[]>;
  insertGuild(row: StoredGuild): Promise<GuildWrite>;
  addMember(row: StoredGuild): Promise<MemberWrite>;
  setMemberRank(userId: string, rank: StoredGuild["rank"]): Promise<void>;
  removeMember(userId: string): Promise<void>;
  /** Promote `toId` and drop `fromId` in one statement. */
  handoffLeader(guildId: string, toId: string, fromId: string): Promise<void>;
  deleteGuild(guildId: string): Promise<void>;
}

export type GameDb = CharacterDb & GraveDb & GuildDb;

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations/game");

const CREATE_SQL = `insert into characters (user_id, name, save, rev, slot)
values ($1, $2, $3::jsonb, 1, $4)`;

const SAVE_SQL = `update characters
set save = $2::jsonb, name = $4, rev = rev + 1, updated_at = now()
where user_id = $1 and rev = $3 and slot = $5
returning rev`;

function pgCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) return String((err as { code: unknown }).code);
  return "";
}

function pgConstraint(err: unknown): string {
  if (err && typeof err === "object" && "constraint" in err) return String((err as { constraint: unknown }).constraint);
  return "";
}

function slotOf(slot: number | undefined): number | "bad_slot" {
  const n = slot ?? 0;
  if (!Number.isInteger(n) || n < 0 || n > 2) return "bad_slot";
  return n;
}

function summary(slot: number, name: string, save: CharacterRecord): CharacterSlot {
  return {
    slot,
    name: save.username || name,
    race: save.race,
    baseClass: save.baseClass,
    prestigeClass: save.prestigeClass || "",
    level: save.level,
  };
}

function asSave(raw: unknown): CharacterRecord {
  return typeof raw === "string" ? (JSON.parse(raw) as CharacterRecord) : (raw as CharacterRecord);
}

function asGrave(raw: unknown): GraveState {
  return typeof raw === "string" ? (JSON.parse(raw) as GraveState) : (raw as GraveState);
}

function joinedAtOf(raw: unknown): number {
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw) {
    const n = Date.parse(raw);
    if (Number.isFinite(n)) return n;
  }
  return 0;
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
  const rows = new Map<string, { save: CharacterRecord; rev: number; name: string; slot: number; userId: string }>();
  const graves = new Map<string, GraveState>();
  const guilds: StoredGuild[] = [];
  const keyOf = (userId: string, slot: number) => `${userId}\0${slot}`;
  const nameTaken = (name: string, except?: { userId: string; slot: number }) => {
    const key = name.trim().toLowerCase();
    for (const row of rows.values()) {
      if (except && row.userId === except.userId && row.slot === except.slot) continue;
      if (row.name.trim().toLowerCase() === key) return true;
    }
    return false;
  };
  return {
    async load(userId, slot = 0) {
      const n = slotOf(slot);
      if (n === "bad_slot") return null;
      const row = rows.get(keyOf(userId, n));
      return row ? { save: structuredClone(row.save), rev: row.rev } : null;
    },
    async list(userId) {
      return [...rows.values()]
        .filter((row) => row.userId === userId)
        .sort((a, b) => a.slot - b.slot)
        .map((row) => summary(row.slot, row.name, row.save));
    },
    async create(userId, name, save, slot = 0) {
      const n = slotOf(slot);
      if (n === "bad_slot") return "bad_slot";
      if (rows.has(keyOf(userId, n))) return "slot_taken";
      const owned = [...rows.values()].filter((row) => row.userId === userId).length;
      if (owned >= 3) return "slot_taken";
      if (nameTaken(name)) return "name_taken";
      rows.set(keyOf(userId, n), { save: structuredClone(save), rev: 1, name, slot: n, userId });
      return 1;
    },
    async save(userId, save, expectedRev, slot = 0) {
      const n = slotOf(slot);
      if (n === "bad_slot") return null;
      const row = rows.get(keyOf(userId, n));
      if (!row || row.rev !== expectedRev) return null;
      const name = save.username || row.name;
      if (nameTaken(name, { userId, slot: n })) return null;
      row.rev += 1;
      row.save = structuredClone(save);
      row.name = name;
      return row.rev;
    },
    async remove(userId, slot) {
      const n = slotOf(slot);
      if (n === "bad_slot") return;
      rows.delete(keyOf(userId, n));
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
    async listGuilds() {
      return guilds
        .map((row) => ({ ...row }))
        .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0) || a.userId.localeCompare(b.userId));
    },
    async insertGuild(row) {
      if (guilds.some((guild) => guild.userId === row.userId)) return "already";
      if (guilds.some((guild) => guild.name.toLowerCase() === row.name.toLowerCase())) return "name_taken";
      if (guilds.some((guild) => guild.tag.toLowerCase() === row.tag.toLowerCase())) return "tag_taken";
      guilds.push({ ...row });
      return "ok";
    },
    async addMember(row) {
      if (guilds.some((guild) => guild.userId === row.userId)) return "already";
      const guild = guilds.find((entry) => entry.id === row.id);
      if (!guild) return "missing";
      guilds.push({
        ...guild,
        userId: row.userId,
        rank: row.rank,
        username: row.username,
        joinedAt: row.joinedAt,
      });
      return "ok";
    },
    async setMemberRank(userId, rank) {
      const row = guilds.find((guild) => guild.userId === userId);
      if (row) row.rank = rank;
    },
    async removeMember(userId) {
      const index = guilds.findIndex((guild) => guild.userId === userId);
      if (index >= 0) guilds.splice(index, 1);
    },
    async handoffLeader(guildId, toId, fromId) {
      const heir = guilds.find((guild) => guild.id === guildId && guild.userId === toId);
      if (heir) heir.rank = "leader";
      const index = guilds.findIndex((guild) => guild.id === guildId && guild.userId === fromId);
      if (index >= 0) guilds.splice(index, 1);
    },
    async deleteGuild(guildId) {
      for (let i = guilds.length - 1; i >= 0; i--) {
        if (guilds[i]?.id === guildId) guilds.splice(i, 1);
      }
    },
  };
}

export function characterStore(query: Query): GameDb {
  return {
    async load(userId, slot = 0) {
      const n = slotOf(slot);
      if (n === "bad_slot") return null;
      const result = await query("select save, rev from characters where user_id = $1 and slot = $2", [userId, n]);
      const row = result.rows[0];
      if (!row || row.save == null) return null;
      return { save: asSave(row.save), rev: Number(row.rev ?? 0) };
    },
    async list(userId) {
      const result = await query("select slot, name, save from characters where user_id = $1 order by slot", [userId]);
      return result.rows.map((row) => summary(Number(row.slot), String(row.name ?? ""), asSave(row.save)));
    },
    async create(userId, name, save, slot = 0) {
      const n = slotOf(slot);
      if (n === "bad_slot") return "bad_slot";
      const taken = await query("select 1 from characters where user_id = $1 and slot = $2", [userId, n]);
      if (taken.rows.length) return "slot_taken";
      const owned = await query("select count(*)::int as n from characters where user_id = $1", [userId]);
      if (Number(owned.rows[0]?.n ?? 0) >= 3) return "slot_taken";
      try {
        await query(CREATE_SQL, [userId, name, JSON.stringify(save), n]);
        return 1;
      } catch (err) {
        if (pgCode(err) === "23514") return "bad_slot";
        if (pgCode(err) === "23505") {
          return pgConstraint(err).includes("name") ? "name_taken" : "slot_taken";
        }
        throw err;
      }
    },
    async save(userId, save, expectedRev, slot = 0) {
      const n = slotOf(slot);
      if (n === "bad_slot") return null;
      try {
        const result = await query(SAVE_SQL, [userId, JSON.stringify(save), expectedRev, save.username, n]);
        const rev = result.rows[0]?.rev;
        return rev == null ? null : Number(rev);
      } catch (err) {
        if (pgCode(err) === "23505") return null;
        throw err;
      }
    },
    async remove(userId, slot) {
      const n = slotOf(slot);
      if (n === "bad_slot") return;
      await query("delete from characters where user_id = $1 and slot = $2", [userId, n]);
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
    async listGuilds() {
      const result = await query(
        `select g.id, g.name, g.tag, g.kind, g.crest, m.user_id, m.rank, m.joined_at,
                (select c.name from characters c where c.user_id = m.user_id order by c.updated_at desc limit 1) as username
         from guild_members m
         join guilds g on g.id = m.guild_id
         order by m.joined_at asc, m.user_id asc`,
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        userId: String(row.user_id),
        name: String(row.name),
        tag: String(row.tag),
        kind: String(row.kind),
        crest: String(row.crest),
        rank: (row.rank === "officer" || row.rank === "member" ? row.rank : "leader") as StoredGuild["rank"],
        username: typeof row.username === "string" ? row.username : "",
        joinedAt: joinedAtOf(row.joined_at),
      }));
    },
    async insertGuild(row) {
      const name = await query("select 1 from guilds where lower(name) = lower($1)", [row.name]);
      if (name.rows.length) return "name_taken";
      const tag = await query("select 1 from guilds where lower(tag) = lower($1)", [row.tag]);
      if (tag.rows.length) return "tag_taken";
      const member = await query("select 1 from guild_members where user_id = $1", [row.userId]);
      if (member.rows.length) return "already";
      try {
        await query(
          `with inserted as (
             insert into guilds (id, name, tag, kind, crest) values ($1, $2, $3, $4, $5)
             returning id
           )
           insert into guild_members (guild_id, user_id, rank, joined_at)
           select id, $6, $7, coalesce(to_timestamp($8::double precision / 1000.0), now()) from inserted`,
          [row.id, row.name, row.tag, row.kind, row.crest, row.userId, row.rank, row.joinedAt ?? null],
        );
        return "ok";
      } catch (err) {
        if (pgCode(err) === "23505") {
          const constraint = pgConstraint(err);
          if (constraint.includes("tag")) return "tag_taken";
          if (constraint.includes("name")) return "name_taken";
          return "already";
        }
        throw err;
      }
    },
    async addMember(row) {
      const guild = await query("select 1 from guilds where id = $1", [row.id]);
      if (!guild.rows.length) return "missing";
      const member = await query("select 1 from guild_members where user_id = $1", [row.userId]);
      if (member.rows.length) return "already";
      try {
        await query(
          `insert into guild_members (guild_id, user_id, rank, joined_at)
           values ($1, $2, $3, coalesce(to_timestamp($4::double precision / 1000.0), now()))`,
          [row.id, row.userId, row.rank, row.joinedAt ?? null],
        );
        return "ok";
      } catch (err) {
        if (pgCode(err) === "23505") return "already";
        if (pgCode(err) === "23503") return "missing";
        throw err;
      }
    },
    async setMemberRank(userId, rank) {
      await query("update guild_members set rank = $2 where user_id = $1", [userId, rank]);
    },
    async removeMember(userId) {
      await query("delete from guild_members where user_id = $1", [userId]);
    },
    async handoffLeader(guildId, toId, fromId) {
      await query(
        `with promoted as (
           update guild_members set rank = 'leader' where guild_id = $1 and user_id = $2
         )
         delete from guild_members where guild_id = $1 and user_id = $3`,
        [guildId, toId, fromId],
      );
    },
    async deleteGuild(guildId) {
      await query(
        `with dropped as (
           delete from guild_members where guild_id = $1
         )
         delete from guilds where id = $1`,
        [guildId],
      );
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
