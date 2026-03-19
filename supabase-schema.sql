-- ─────────────────────────────────────────────────────────────────────────────
-- Run this in Supabase → SQL Editor → New Query
-- If you already ran the original schema, just run PART B+E below.
-- If this is a fresh setup, run everything.
-- ─────────────────────────────────────────────────────────────────────────────

-- ══ PART A: Table (skip if already created) ══════════════════════════════════

create table if not exists public.cutoff_entries (
  id            bigint generated always as identity primary key,
  username      text        not null,
  date          date        not null,
  points        integer     not null check (points >= 0),
  rank          integer     not null check (rank >= 1 and rank <= 10000),
  created_at    timestamptz not null default now()
);

alter table public.cutoff_entries enable row level security;

-- ══ PART B: Add screenshot column ════════════════════════════════════════════

alter table public.cutoff_entries
  add column if not exists screenshot_url text;

-- ══ PART C: Row Level Security policies ══════════════════════════════════════

drop policy if exists "Anyone can read entries"   on public.cutoff_entries;
drop policy if exists "Anyone can insert entries" on public.cutoff_entries;

create policy "Anyone can read entries"
  on public.cutoff_entries for select using (true);

create policy "Anyone can insert entries"
  on public.cutoff_entries for insert
  with check (
    points >= 0
    and rank >= 1 and rank <= 10000
    and username is not null
    and length(trim(username)) > 0
    and length(username) <= 64
  );

-- ══ PART D: Realtime ══════════════════════════════════════════════════════════

alter publication supabase_realtime add table public.cutoff_entries;

-- ══ PART E: Storage bucket for screenshots ═══════════════════════════════════

insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', true)
on conflict (id) do nothing;

create policy "Anyone can upload screenshots"
  on storage.objects for insert
  with check (bucket_id = 'screenshots');

create policy "Anyone can view screenshots"
  on storage.objects for select
  using (bucket_id = 'screenshots');
