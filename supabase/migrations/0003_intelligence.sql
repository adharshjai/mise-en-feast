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
