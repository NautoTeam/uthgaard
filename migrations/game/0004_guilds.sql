-- Guilds outlive a server restart. One membership per account.
-- 0003 is character slots, so this file is 0004.

create table if not exists guilds (
  id text primary key,
  name text not null,
  tag text not null,
  kind text not null,
  crest text not null,
  plot_id text,
  created_at timestamptz not null default now()
);

create unique index if not exists guilds_name_lower on guilds (lower(name));
create unique index if not exists guilds_tag_lower on guilds (lower(tag));

create table if not exists guild_members (
  guild_id text not null references guilds (id),
  user_id text not null,
  rank text not null check (rank in ('leader', 'officer', 'member')),
  joined_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);

create unique index if not exists guild_members_user on guild_members (user_id);
