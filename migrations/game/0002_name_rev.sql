alter table characters add column if not exists name text;
alter table characters add column if not exists rev int not null default 0;
update characters set name = coalesce(save->>'username', user_id) where name is null;
create unique index if not exists characters_name_lower on characters (lower(name));
create table if not exists graves (
  id text primary key,
  owner_user_id text,
  data jsonb not null,
  created_at timestamptz not null default now()
);
