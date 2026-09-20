-- The shopping list and the weekly meal plan, one blob each on app_state beside
-- the deck. Additive: existing rows keep working, and the app falls back to
-- localStorage if these columns are not there yet.
begin;

-- Rows the app adds from a recipe's "You'll need", the kitchen helper, the add
-- form or the weekly plan: [{ id, name, key, qty, note, done, source, dishId, addedAt }].
alter table public.app_state add column if not exists shopping jsonb not null default '[]'::jsonb;
-- The cached week: { start, days: [{ date, meals: { breakfast, lunch, dinner } }], signature, at, source }.
-- Null until the first plan is generated.
alter table public.app_state add column if not exists plan jsonb;
-- When it was generated, so a plan from a past week can be told apart from this one's.
alter table public.app_state add column if not exists plan_at timestamptz;

commit;
