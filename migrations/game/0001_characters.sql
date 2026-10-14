-- One character per Better Auth user. The game server applies this file.
-- The web app's migrator does not descend into this directory.

create table if not exists characters (
  user_id text primary key,
  save jsonb not null,
  updated_at timestamptz not null default now()
);
