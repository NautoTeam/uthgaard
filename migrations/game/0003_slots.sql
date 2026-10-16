-- Three character slots per account. Existing rows fill slots in creation order.

alter table characters add column if not exists slot int;

with ranked as (
  select ctid, row_number() over (partition by user_id order by updated_at, name) - 1 as n
  from characters
  where slot is null
)
update characters as c
set slot = ranked.n
from ranked
where c.ctid = ranked.ctid;

alter table characters alter column slot set not null;
alter table characters drop constraint if exists characters_pkey;
alter table characters add constraint characters_pkey primary key (user_id, slot);
alter table characters drop constraint if exists characters_slot_check;
alter table characters add constraint characters_slot_check check (slot >= 0 and slot <= 2);
