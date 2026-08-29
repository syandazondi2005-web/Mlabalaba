-- Run this once in Supabase → SQL Editor

create table if not exists rooms (
  id text primary key,
  state jsonb not null,
  host_present boolean not null default true,
  guest_present boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Let clients read/write rows without auth (fine for a casual game;
-- tighten this later if you add accounts)
alter table rooms enable row level security;

create policy "anyone can read rooms"
  on rooms for select
  using (true);

create policy "anyone can insert rooms"
  on rooms for insert
  with check (true);

create policy "anyone can update rooms"
  on rooms for update
  using (true);

-- Turn on realtime for this table
alter publication supabase_realtime add table rooms;
