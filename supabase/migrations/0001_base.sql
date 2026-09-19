-- ===========================================================================
-- Pantry — Base schema (matches the frontend's data layer: frontend/shared/store.js)
--
-- Tables the frontend reads/writes directly:
--   pantry_items, app_state, receipts, recipes, cook_log
-- The intelligence layer (foods, consumption_profiles, learning RPC) is added
-- additively in 0002/0003 and does not change these tables' contract.
-- ===========================================================================

-- One-time cleanup of the earlier experimental "intelligent inventory" objects
-- and any tables whose columns diverged, so this schema is the single source of
-- truth. Safe: there is no production data.
drop view     if exists public.food_inventory cascade;
drop view     if exists public.lot_state cascade;
drop function if exists public.import_receipt cascade;
drop function if exists public.add_manual_item cascade;
drop function if exists public.cook_recipe cascade;
drop function if exists public.checkin_food cascade;
drop function if exists public.remove_food cascade;
drop function if exists public.record_interaction cascade;
drop function if exists public.create_lot cascade;
drop function if exists public.current_pantry_quantity cascade;
drop table    if exists public.inventory_events cascade;
drop table    if exists public.inventory_lots cascade;
drop table    if exists public.receipt_items cascade;
drop table    if exists public.recommendation_interactions cascade;
drop table    if exists public.receipts cascade;   -- recreate to the exact frontend spec
drop table    if exists public.cook_log cascade;   -- recreate to the exact frontend spec

-- -----------------------------------------------------------------------------
-- pantry_items
-- -----------------------------------------------------------------------------
create table if not exists public.pantry_items (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name               text not null,
  key                text not null default '',
  raw_text           text not null default '',
  quantity_label     text not null default '',
  initial_servings   numeric not null default 1,
  deducted_servings  numeric not null default 0,
  purchase_date      timestamptz not null default now(),
  expiry_date        timestamptz,
  daily_burn_rate    numeric not null default 0,
  item_type          text not null default 'event' check (item_type in ('continuous', 'event')),
  status             text not null default 'active' check (status in ('active', 'gone')),
  created_at         timestamptz not null default now()
);
create index if not exists pantry_items_user_idx on public.pantry_items (user_id, status);

-- -----------------------------------------------------------------------------
-- receipts
-- -----------------------------------------------------------------------------
create table if not exists public.receipts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  image_url   text,
  scanned_at  timestamptz not null default now(),
  store_name  text,
  total       numeric,
  item_count  integer,
  created_at  timestamptz not null default now()
);
create index if not exists receipts_user_idx on public.receipts (user_id, scanned_at desc);

-- -----------------------------------------------------------------------------
-- recipes
-- -----------------------------------------------------------------------------
create table if not exists public.recipes (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title                  text not null,
  image_url              text,
  cook_minutes           integer,
  servings               integer,
  steps                  jsonb not null default '[]'::jsonb,
  ingredients            jsonb not null default '[]'::jsonb,
  uses_expiring_item_id  uuid references public.pantry_items (id) on delete set null,
  generated_at           timestamptz not null default now(),
  created_at             timestamptz not null default now()
);
create index if not exists recipes_user_idx on public.recipes (user_id, generated_at desc);

-- -----------------------------------------------------------------------------
-- cook_log
-- -----------------------------------------------------------------------------
create table if not exists public.cook_log (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recipe_id       text,
  title           text,
  cooked_at       timestamptz not null default now(),
  items_deducted  jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists cook_log_user_idx on public.cook_log (user_id, cooked_at desc);

-- -----------------------------------------------------------------------------
-- app_state
-- -----------------------------------------------------------------------------
create table if not exists public.app_state (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  skipped     jsonb not null default '[]'::jsonb,
  cooked      jsonb not null default '[]'::jsonb,
  chosen      jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

-- =============================================================================
-- Row Level Security — each user only sees their own rows
-- =============================================================================
alter table public.pantry_items enable row level security;
alter table public.receipts     enable row level security;
alter table public.recipes      enable row level security;
alter table public.cook_log     enable row level security;
alter table public.app_state    enable row level security;

-- pantry_items
drop policy if exists "pantry_items select own" on public.pantry_items;
drop policy if exists "pantry_items insert own" on public.pantry_items;
drop policy if exists "pantry_items update own" on public.pantry_items;
drop policy if exists "pantry_items delete own" on public.pantry_items;
create policy "pantry_items select own" on public.pantry_items for select to authenticated using (user_id = (select auth.uid()));
create policy "pantry_items insert own" on public.pantry_items for insert to authenticated with check (user_id = (select auth.uid()));
create policy "pantry_items update own" on public.pantry_items for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "pantry_items delete own" on public.pantry_items for delete to authenticated using (user_id = (select auth.uid()));

-- receipts
drop policy if exists "receipts select own" on public.receipts;
drop policy if exists "receipts insert own" on public.receipts;
drop policy if exists "receipts update own" on public.receipts;
drop policy if exists "receipts delete own" on public.receipts;
create policy "receipts select own" on public.receipts for select to authenticated using (user_id = (select auth.uid()));
create policy "receipts insert own" on public.receipts for insert to authenticated with check (user_id = (select auth.uid()));
create policy "receipts update own" on public.receipts for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "receipts delete own" on public.receipts for delete to authenticated using (user_id = (select auth.uid()));

-- recipes
drop policy if exists "recipes select own" on public.recipes;
drop policy if exists "recipes insert own" on public.recipes;
drop policy if exists "recipes update own" on public.recipes;
drop policy if exists "recipes delete own" on public.recipes;
create policy "recipes select own" on public.recipes for select to authenticated using (user_id = (select auth.uid()));
create policy "recipes insert own" on public.recipes for insert to authenticated with check (user_id = (select auth.uid()));
create policy "recipes update own" on public.recipes for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "recipes delete own" on public.recipes for delete to authenticated using (user_id = (select auth.uid()));

-- cook_log
drop policy if exists "cook_log select own" on public.cook_log;
drop policy if exists "cook_log insert own" on public.cook_log;
drop policy if exists "cook_log update own" on public.cook_log;
drop policy if exists "cook_log delete own" on public.cook_log;
create policy "cook_log select own" on public.cook_log for select to authenticated using (user_id = (select auth.uid()));
create policy "cook_log insert own" on public.cook_log for insert to authenticated with check (user_id = (select auth.uid()));
create policy "cook_log update own" on public.cook_log for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "cook_log delete own" on public.cook_log for delete to authenticated using (user_id = (select auth.uid()));

-- app_state
drop policy if exists "app_state select own" on public.app_state;
drop policy if exists "app_state insert own" on public.app_state;
drop policy if exists "app_state update own" on public.app_state;
drop policy if exists "app_state delete own" on public.app_state;
create policy "app_state select own" on public.app_state for select to authenticated using (user_id = (select auth.uid()));
create policy "app_state insert own" on public.app_state for insert to authenticated with check (user_id = (select auth.uid()));
create policy "app_state update own" on public.app_state for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "app_state delete own" on public.app_state for delete to authenticated using (user_id = (select auth.uid()));
