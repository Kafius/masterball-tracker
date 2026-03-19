-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: add auth to cutoff_entries
-- Run this in Supabase → SQL Editor → New Query
-- Safe to re-run (uses IF EXISTS / IF NOT EXISTS throughout)
-- ─────────────────────────────────────────────────────────────────────────────

-- ══ PART 1: Add user_id column ════════════════════════════════════════════════
-- Nullable so existing rows (submitted before auth was added) are unaffected.

alter table public.cutoff_entries
  add column if not exists user_id uuid references auth.users(id);

-- ══ PART 2: Replace RLS insert policy ════════════════════════════════════════
-- Drop the old open policy (from the original schema) and replace it with one
-- that requires the user to be signed in and submitting as themselves.

drop policy if exists "Anyone can insert entries" on public.cutoff_entries;

create policy "Authenticated users can insert own rows"
  on public.cutoff_entries
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and points >= 0
    and rank >= 1 and rank <= 10000
    and username is not null
    and length(trim(username)) > 0
    and length(username) <= 64
  );

-- ══ PART 3: Storage — restrict uploads to signed-in users ════════════════════
-- Drop the old open upload policy and require authentication.

drop policy if exists "Anyone can upload screenshots" on storage.objects;

create policy "Authenticated users can upload screenshots"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'screenshots');

-- The existing read policies are unchanged:
--   "Anyone can read entries"   → public leaderboard stays open
--   "Anyone can view screenshots" → screenshot lightbox stays open
