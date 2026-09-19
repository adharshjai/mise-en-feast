-- =============================================================================
-- Pantry — Supabase schema
-- =============================================================================
--
-- HOW TO RUN
--   1. Supabase dashboard -> your project -> SQL Editor -> "New query".
--   2. Paste this whole file and press "Run" (Cmd/Ctrl+Enter). It is idempotent:
--      running it again is safe.
--   3. Project Settings -> API: copy the Project URL and the anon key into
--      web/shared/config.js.
--
-- EMAIL + PASSWORD / MAGIC LINK
--   Authentication -> Providers -> Email is on by default. Magic links and
--   sign-up confirmations use the redirect URLs below, so add them first.
--
-- GOOGLE SIGN-IN
--   1. Google Cloud Console -> APIs & Services -> Credentials -> Create
--      credentials -> OAuth client ID (Web application). Under "Authorized
--      redirect URIs" add   https://<your-project-ref>.supabase.co/auth/v1/callback
--      (the exact value is shown in the Supabase Google provider panel).
--   2. Supabase dashboard -> Authentication -> Providers -> Google -> enable,
--      paste the Client ID and Client Secret, save.
--   3. Authentication -> URL Configuration:
--        Site URL:       http://localhost:4173
--        Redirect URLs:  http://localhost:4173/app/
--                        http://localhost:4173/login/
--      The login page sends users to http://localhost:4173/app/ after Google,
--      magic-link and confirmation redirects; it must be on this list or
--      Supabase falls back to the Site URL. Add your production origin the
--      same way when you deploy.
--
-- SECURITY MODEL
--   Every table has Row Level Security enabled and four policies that compare
--   user_id with auth.uid(). The browser only ever holds the anon key; it can
--   see and change nothing but the signed-in user's own rows.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- pantry_items: one row per thing in the pantry.
-- Column <- app field:  raw_text<-raw, quantity_label<-qty, initial_servings<-initial,
--   deducted_servings<-deducted, purchase_date<-purchase, expiry_date<-expiry,
--   daily_burn_rate<-burn. item_type is 'continuous' when burn > 0, else 'event'.
--   The app only reads rows whose status is not 'gone'.
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
-- receipts: one row per scanned receipt (the image itself lives in Storage).
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
-- recipes: one row is written whenever a recipe is generated for a user.
-- steps / ingredients are jsonb arrays; uses_expiring_item_id points at the
-- pantry item the recipe was built around (cleared if that item is deleted).
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
-- cook_log: one row each time the user says "I made it".
-- recipe_id is text so it can hold either the slug of a built-in dish
-- ('pasta', 'risotto', ...) or the uuid of a row in recipes.
-- items_deducted: [{ id, name, servings }] — what was taken out of the pantry.
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
-- app_state: the small per-user deck state that isn't an item.
-- skipped / cooked / chosen are jsonb arrays of dish ids.
-- -----------------------------------------------------------------------------
create table if not exists public.app_state (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  skipped     jsonb not null default '[]'::jsonb,
  cooked      jsonb not null default '[]'::jsonb,
  chosen      jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

-- =============================================================================
-- Row Level Security
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

-- Anonymous (signed-out) requests get nothing: there are no policies for the anon role.
