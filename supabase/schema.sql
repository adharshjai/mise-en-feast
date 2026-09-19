-- Pantry — full database setup. Paste this whole file into the Supabase SQL Editor and Run.
-- Source of truth: supabase/migrations/000{1,2,3}_*.sql (base tables + foods + intelligence).
-- Matches the frontend data layer (frontend/shared/store.js) and adds the learning layer.


-- ============================ supabase/migrations/0001_base.sql ============================
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


-- ============================ supabase/migrations/0002_foods.sql ============================
-- ===========================================================================
-- Pantry — Canonical foods (reference data for autofill + smart estimates).
-- Shared, read-only to signed-in users. The frontend can query this to power
-- autofill (type "garlic" -> matches the "garlic" row via name/aliases) and to
-- pre-fill shelf life / burn rate / servings when adding an item.
-- ===========================================================================

create table if not exists public.foods (
  id                 text primary key,           -- slug, e.g. 'milk'
  name               text not null,
  category           text not null default 'other',
  storage            text not null default 'pantry' check (storage in ('fridge','freezer','pantry')),
  default_unit       text not null default '1 item',
  default_servings   numeric not null default 1 check (default_servings > 0),
  shelf_life_days    integer not null default 14 check (shelf_life_days >= 0),
  default_daily_rate numeric not null default 0 check (default_daily_rate >= 0),
  item_type          text not null default 'event' check (item_type in ('continuous','event')),
  checkin_style      text not null default 'percent' check (checkin_style in ('percent','count')),
  count_unit         text,
  confidence_decay   numeric not null default 0.05 check (confidence_decay >= 0),
  aliases            text[] not null default '{}',
  created_at         timestamptz not null default now()
);
alter table public.foods enable row level security;
grant select on public.foods to authenticated, anon;
drop policy if exists "foods readable" on public.foods;
create policy "foods readable" on public.foods for select to authenticated using (true);
create index if not exists foods_category_idx on public.foods (category);

-- ===========================================================================
-- Pantry — Migration 2/4: canonical foods seed (generated from food-catalog.ts).
-- Re-run safe: upserts on id.
-- ===========================================================================

INSERT INTO public.foods
  (id, name, category, storage, default_unit, default_servings, shelf_life_days,
   default_daily_rate, item_type, checkin_style, count_unit, confidence_decay, aliases)
VALUES
  ('spinach', 'Baby spinach', 'produce', 'fridge', '5 oz', 4, 6, 0, 'event', 'percent', NULL, 0.06, ARRAY['spinach','spin','org spin','baby spinach','spnch']::text[]),
  ('mushrooms', 'Cremini mushrooms', 'produce', 'fridge', '8 oz', 4, 7, 0, 'event', 'percent', NULL, 0.06, ARRAY['mushrooms','mushroom','mush','mush crm','cremini','shrooms','portobello']::text[]),
  ('tomatoes', 'Roma tomatoes', 'produce', 'fridge', '5 whole', 5, 8, 0, 'event', 'percent', NULL, 0.06, ARRAY['tomatoes','tomato','tom','tom roma','roma','tomatos']::text[]),
  ('garlic', 'Garlic', 'produce', 'pantry', '1 head', 12, 60, 0.3, 'continuous', 'percent', NULL, 0.05, ARRAY['garlic','grlc','garlic clove','garlic cloves','minced garlic','gnc garlic']::text[]),
  ('onion', 'Yellow onion', 'produce', 'pantry', '3 whole', 9, 30, 0.3, 'continuous', 'percent', NULL, 0.05, ARRAY['onion','onions','yellow onion','ynon','red onion']::text[]),
  ('scallions', 'Scallions', 'produce', 'fridge', '1 bunch', 6, 8, 0, 'event', 'percent', NULL, 0.06, ARRAY['scallions','scallion','green onion','green onions','spring onion']::text[]),
  ('lemon', 'Lemon', 'produce', 'fridge', '2 whole', 4, 21, 0.1, 'continuous', 'percent', NULL, 0.05, ARRAY['lemon','lemons','lmn']::text[]),
  ('parsley', 'Parsley', 'produce', 'fridge', '1 bunch', 4, 7, 0, 'event', 'percent', NULL, 0.06, ARRAY['parsley','prsly','flat leaf parsley','italian parsley']::text[]),
  ('basil', 'Basil', 'produce', 'fridge', '1 bunch', 4, 6, 0, 'event', 'percent', NULL, 0.06, ARRAY['basil','bsl','fresh basil']::text[]),
  ('bell-pepper', 'Bell pepper', 'produce', 'fridge', '2 whole', 4, 12, 0, 'event', 'percent', NULL, 0.06, ARRAY['bell pepper','pepper','bell','red pepper','green pepper','capsicum']::text[]),
  ('potato', 'Potatoes', 'produce', 'pantry', '5 whole', 10, 30, 0.4, 'continuous', 'percent', NULL, 0.05, ARRAY['potato','potatoes','russet','pot','yukon']::text[]),
  ('carrot', 'Carrots', 'produce', 'fridge', '1 lb', 8, 21, 0.2, 'continuous', 'percent', NULL, 0.05, ARRAY['carrot','carrots','crrt','baby carrots']::text[]),
  ('avocado', 'Avocado', 'produce', 'fridge', '2 whole', 4, 5, 0, 'event', 'percent', NULL, 0.06, ARRAY['avocado','avo','avos','hass avocado']::text[]),
  ('lime', 'Lime', 'produce', 'fridge', '3 whole', 6, 18, 0.1, 'continuous', 'percent', NULL, 0.05, ARRAY['lime','limes']::text[]),
  ('milk', 'Whole milk', 'dairy-eggs', 'fridge', '1 gal', 16, 10, 1, 'continuous', 'percent', NULL, 0.05, ARRAY['milk','mlk','gv mlk','whole milk','1gal','2% milk','skim milk']::text[]),
  ('eggs', 'Large eggs', 'dairy-eggs', 'fridge', '12 ct', 12, 28, 0.5, 'continuous', 'count', 'eggs', 0.05, ARRAY['eggs','egg','eggs lg','large eggs','dozen eggs','egg 12ct']::text[]),
  ('parmesan', 'Parmesan', 'dairy-eggs', 'fridge', '8 oz', 8, 45, 0.2, 'continuous', 'percent', NULL, 0.05, ARRAY['parmesan','parm','parmigiano','grated parm','pecorino']::text[]),
  ('cheddar', 'Cheddar', 'dairy-eggs', 'fridge', '8 oz', 8, 40, 0.3, 'continuous', 'percent', NULL, 0.05, ARRAY['cheddar','chdr','sharp cheddar','cheese']::text[]),
  ('butter', 'Butter', 'dairy-eggs', 'fridge', '1 lb', 32, 60, 0.5, 'continuous', 'percent', NULL, 0.05, ARRAY['butter','bttr','unsalted butter']::text[]),
  ('yogurt', 'Greek yogurt', 'dairy-eggs', 'fridge', '32 oz', 8, 21, 0.6, 'continuous', 'percent', NULL, 0.05, ARRAY['yogurt','yoghurt','greek yogurt','ygrt']::text[]),
  ('cream', 'Heavy cream', 'dairy-eggs', 'fridge', '16 oz', 8, 14, 0.2, 'continuous', 'percent', NULL, 0.05, ARRAY['cream','heavy cream','hvy crm','whipping cream']::text[]),
  ('chicken', 'Chicken breast', 'meat-seafood', 'fridge', '1 lb', 4, 3, 0, 'event', 'percent', NULL, 0.06, ARRAY['chicken','chkn','chicken breast','chix','boneless chicken']::text[]),
  ('ground-beef', 'Ground beef', 'meat-seafood', 'fridge', '1 lb', 4, 3, 0, 'event', 'percent', NULL, 0.06, ARRAY['ground beef','beef','grnd beef','hamburger','80/20']::text[]),
  ('bacon', 'Bacon', 'meat-seafood', 'fridge', '12 oz', 8, 10, 0.3, 'continuous', 'percent', NULL, 0.05, ARRAY['bacon','bcn','smoked bacon']::text[]),
  ('tofu', 'Firm tofu', 'meat-seafood', 'fridge', '14 oz', 4, 12, 0, 'event', 'percent', NULL, 0.06, ARRAY['tofu','firm tofu','bean curd']::text[]),
  ('pasta', 'Rigatoni', 'grains', 'pantry', '16 oz', 6, 540, 0, 'event', 'percent', NULL, 0.02, ARRAY['pasta','rigatoni','penne','spaghetti','noodles','macaroni']::text[]),
  ('rice', 'Jasmine rice', 'grains', 'pantry', '2 lb', 12, 720, 0.4, 'continuous', 'percent', NULL, 0.02, ARRAY['rice','jasmine rice','white rice','basmati','long grain']::text[]),
  ('tortilla', 'Flour tortillas', 'grains', 'pantry', '10 ct', 10, 21, 0.5, 'continuous', 'percent', NULL, 0.02, ARRAY['tortilla','tortillas','flour tortilla','wraps']::text[]),
  ('oats', 'Rolled oats', 'grains', 'pantry', '18 oz', 12, 540, 0.5, 'continuous', 'percent', NULL, 0.02, ARRAY['oats','oatmeal','rolled oats','old fashioned oats']::text[]),
  ('sourdough', 'Sourdough', 'grains', 'pantry', '1 loaf', 10, 6, 0.8, 'continuous', 'percent', NULL, 0.02, ARRAY['sourdough','srdgh','bread','loaf','boule']::text[]),
  ('black-beans', 'Black beans', 'canned', 'pantry', '15 oz can', 4, 720, 0, 'event', 'percent', NULL, 0.02, ARRAY['black beans','beans','blk beans','canned beans']::text[]),
  ('chickpeas', 'Chickpeas', 'canned', 'pantry', '15 oz can', 4, 720, 0, 'event', 'percent', NULL, 0.02, ARRAY['chickpeas','garbanzo','garbanzo beans','chick peas']::text[]),
  ('canned-tomatoes', 'Crushed tomatoes', 'canned', 'pantry', '28 oz can', 6, 720, 0, 'event', 'percent', NULL, 0.02, ARRAY['crushed tomatoes','canned tomatoes','diced tomatoes','tomato sauce','passata']::text[]),
  ('peas', 'Frozen peas', 'frozen', 'freezer', '16 oz', 8, 240, 0, 'event', 'percent', NULL, 0.02, ARRAY['peas','frozen peas','green peas','sweet peas']::text[]),
  ('olive-oil', 'Olive oil', 'condiments', 'pantry', '500 ml', 60, 540, 0.5, 'continuous', 'percent', NULL, 0.1, ARRAY['olive oil','evoo','extra virgin','oil']::text[]),
  ('soy-sauce', 'Soy sauce', 'condiments', 'pantry', '10 oz', 40, 720, 0.3, 'continuous', 'percent', NULL, 0.1, ARRAY['soy sauce','soy','shoyu','tamari']::text[]),
  ('cumin', 'Ground cumin', 'spices', 'pantry', '2 oz', 40, 720, 0.1, 'continuous', 'percent', NULL, 0.1, ARRAY['cumin','ground cumin','cmn']::text[]),
  ('chili-flakes', 'Chili flakes', 'spices', 'pantry', '2 oz', 40, 720, 0.1, 'continuous', 'percent', NULL, 0.1, ARRAY['chili flakes','red pepper flakes','crushed red pepper','chilli']::text[]),
  ('flour', 'All-purpose flour', 'baking', 'pantry', '5 lb', 40, 365, 0.2, 'continuous', 'percent', NULL, 0.1, ARRAY['flour','ap flour','all purpose flour','flr']::text[])
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  storage = EXCLUDED.storage,
  default_unit = EXCLUDED.default_unit,
  default_servings = EXCLUDED.default_servings,
  shelf_life_days = EXCLUDED.shelf_life_days,
  default_daily_rate = EXCLUDED.default_daily_rate,
  item_type = EXCLUDED.item_type,
  checkin_style = EXCLUDED.checkin_style,
  count_unit = EXCLUDED.count_unit,
  confidence_decay = EXCLUDED.confidence_decay,
  aliases = EXCLUDED.aliases;


-- ============================ supabase/migrations/0003_intelligence.sql ============================
-- ===========================================================================
-- Pantry — Intelligence layer (additive; does not change the frontend contract).
--
--   consumption_profiles : per-household learned consumption rate
--   checkin_item(...)     : "do you still have this?" — corrects the item AND
--                            teaches the model, writing the learned rate back
--                            into pantry_items.daily_burn_rate so the frontend's
--                            existing estimate just gets smarter.
--
-- The frontend opts in by calling supabase.rpc('checkin_item', {...}). Nothing
-- else in the app has to change.
-- ===========================================================================

create table if not exists public.consumption_profiles (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  scope               text not null default 'food' check (scope in ('food','category')),
  key                 text not null,               -- pantry_items.key, or a food category
  learned_daily_rate  numeric not null default 0 check (learned_daily_rate >= 0),
  observation_count   integer not null default 0 check (observation_count >= 0),
  confidence          numeric not null default 0 check (confidence >= 0 and confidence <= 1),
  updated_at          timestamptz not null default now(),
  unique (user_id, scope, key)
);
alter table public.consumption_profiles enable row level security;
grant select, insert, update, delete on public.consumption_profiles to authenticated;
drop policy if exists "profiles own" on public.consumption_profiles;
create policy "profiles own" on public.consumption_profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- resolve a food row from an id, else an exact name/alias match
create or replace function public.resolve_food(p_name text, p_food_id text)
returns public.foods language sql stable set search_path = public as $$
  select * from public.foods
  where (p_food_id is not null and id = p_food_id)
     or (p_food_id is null and (
          lower(name) = lower(btrim(coalesce(p_name,'')))
          or lower(btrim(coalesce(p_name,''))) = any (aliases)
        ))
  order by (id = p_food_id) desc
  limit 1;
$$;

-- fold one observed rate into a profile (confidence-weighted; clamped)
create or replace function public.fold_profile(p_scope text, p_key text, p_observed numeric, p_default numeric)
returns void language plpgsql security invoker set search_path = public as $$
declare
  v_floor numeric := greatest(0, p_default * 0.1);
  v_ceil  numeric := greatest(p_default * 5, p_default + 2, 4);
  v_obs   numeric := least(v_ceil, greatest(v_floor, p_observed));
  v_prev  public.consumption_profiles;
  v_n     integer;
  v_rate  numeric;
begin
  if p_key is null or btrim(p_key) = '' then return; end if;
  select * into v_prev from public.consumption_profiles
    where user_id = auth.uid() and scope = p_scope and key = p_key;
  if found then
    v_n := v_prev.observation_count + 1;
    v_rate := (v_prev.learned_daily_rate * v_prev.observation_count + v_obs) / v_n;
  else
    v_n := 1;
    v_rate := v_obs;
  end if;
  insert into public.consumption_profiles (user_id, scope, key, learned_daily_rate, observation_count, confidence, updated_at)
  values (auth.uid(), p_scope, p_key, round(v_rate,3), v_n, round((v_n::numeric/(v_n+4)),2), now())
  on conflict (user_id, scope, key) do update
    set learned_daily_rate = excluded.learned_daily_rate,
        observation_count = excluded.observation_count,
        confidence = excluded.confidence,
        updated_at = now();
end;
$$;

-- "Do you still have this?" — correct inventory AND learn the household rate.
--   p_style: 'percent' (p_value 0..1 of the original amount)
--          | 'count'   (p_value = units remaining)
--          | 'empty'   (nothing left)
-- Re-baselines the item so its current quantity equals what the user reported,
-- and writes the learned consumption rate back into daily_burn_rate.
create or replace function public.checkin_item(p_item_id uuid, p_style text, p_value numeric default null)
returns void language plpgsql security invoker set search_path = public as $$
declare
  v_item     public.pantry_items;
  v_elapsed  numeric;
  v_prev     numeric;
  v_observed numeric;
  v_food     public.foods;
  v_default  numeric;
  v_prof     public.consumption_profiles;
  v_new_burn numeric;
begin
  select * into v_item from public.pantry_items where id = p_item_id and user_id = auth.uid();
  if not found then return; end if;

  v_prev := v_item.initial_servings;
  v_elapsed := greatest(0, extract(epoch from (now() - v_item.purchase_date)) / 86400.0);

  v_observed := case
    when p_style = 'empty' then 0
    when p_style = 'count' then greatest(0, coalesce(p_value, 0))
    else greatest(0, coalesce(p_value, 0)) * v_prev     -- percent (0..1)
  end;

  v_food := public.resolve_food(v_item.name, null);
  v_default := coalesce(nullif(v_item.daily_burn_rate, 0), v_food.default_daily_rate, 0);

  -- learn (need at least a day of elapsed signal)
  if v_elapsed >= 1 then
    perform public.fold_profile('food', v_item.key, greatest(0, v_prev - v_observed) / v_elapsed, v_default);
    if v_food.category is not null then
      perform public.fold_profile('category', v_food.category, greatest(0, v_prev - v_observed) / v_elapsed, v_default);
    end if;
  end if;

  -- blended learned burn rate to write back
  select * into v_prof from public.consumption_profiles
    where user_id = auth.uid() and scope = 'food' and key = v_item.key;
  if found and v_prof.observation_count > 0 then
    v_new_burn := (v_default * 2.5 + v_prof.learned_daily_rate * v_prof.observation_count) / (2.5 + v_prof.observation_count);
  else
    v_new_burn := v_item.daily_burn_rate;
  end if;

  -- re-baseline: current quantity now equals what the user reported
  update public.pantry_items set
    initial_servings = round(v_observed, 2),
    deducted_servings = 0,
    purchase_date = now(),
    daily_burn_rate = round(v_new_burn, 3),
    status = case when v_observed > 0.05 then 'active' else 'gone' end
  where id = p_item_id;
end;
$$;

grant execute on function
  public.resolve_food(text, text),
  public.fold_profile(text, text, numeric, numeric),
  public.checkin_item(uuid, text, numeric)
to authenticated;

