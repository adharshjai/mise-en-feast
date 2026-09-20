-- Wave 2: prices on lots, ratings, the cooked log and the events log behind the
-- kitchen report. Additive: existing rows keep working, and the app falls back
-- to localStorage if these columns are not there yet.
begin;

-- What the whole lot cost, from the receipt (null when it was added by hand).
alter table public.pantry_items add column if not exists price numeric;

-- 👍 / 👎 after "I made this": { [titleKey]: { title, value: 1|-1, at, dishId } }.
alter table public.app_state add column if not exists ratings jsonb not null default '{}'::jsonb;
-- Every dish cooked, newest first, with a snapshot so "Cook again" works after the
-- deck has moved on: [{ id, title, at, rating, dishId, dish }]. Named cooked_log
-- because app_state.cooked already holds the ids of dishes marked cooked.
alter table public.app_state add column if not exists cooked_log jsonb not null default '[]'::jsonb;
-- What happened to each lot (cooked, checked in, gone, expired), the report's input:
-- [{ type, key, name, servings, value, at, beforeExpiry?, wasted?, dishId?, title? }].
alter table public.app_state add column if not exists events jsonb not null default '[]'::jsonb;

commit;
