-- Run this once in your Supabase project's SQL Editor (left sidebar -> SQL Editor -> New query).
-- It creates the three tables the app needs, and makes them readable/writable by anyone
-- holding the project's public "anon" key (the same trust model the app already used).

create table if not exists competitions_index (
  id text primary key default 'singleton',
  list jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists comp_state (
  comp_id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists heat_data (
  comp_id text not null,
  heat_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (comp_id, heat_id)
);

alter table competitions_index enable row level security;
alter table comp_state enable row level security;
alter table heat_data enable row level security;

-- Public read/write policies. Anyone with the site link can read and write competition
-- data -- the same "shared link = shared trust" model the in-chat prototype used, plus the
-- app's own admin password gate on the Admin screen. If you later want real per-person
-- accounts, this is the layer to replace with Supabase Auth + per-row ownership checks.
create policy "public read index" on competitions_index for select using (true);
create policy "public write index" on competitions_index for insert with check (true);
create policy "public update index" on competitions_index for update using (true);

create policy "public read state" on comp_state for select using (true);
create policy "public write state" on comp_state for insert with check (true);
create policy "public update state" on comp_state for update using (true);

create policy "public read heat" on heat_data for select using (true);
create policy "public write heat" on heat_data for insert with check (true);
create policy "public update heat" on heat_data for update using (true);

-- Turn on realtime push so judges/spotters see updates instantly instead of polling.
alter publication supabase_realtime add table competitions_index;
alter publication supabase_realtime add table comp_state;
alter publication supabase_realtime add table heat_data;
