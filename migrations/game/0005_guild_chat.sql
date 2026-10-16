-- Last 50 guild lines per guild. 0004 is the guild tables.

create table if not exists guild_chat (
  id bigserial primary key,
  guild_id text not null,
  from_name text not null,
  text text not null,
  "at" timestamptz not null default now()
);

create index if not exists guild_chat_guild_id on guild_chat (guild_id, id desc);
