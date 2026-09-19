-- Additive upgrade: preserve existing pantry rows, receipts and cook history.
begin;

alter table public.pantry_items add column if not exists variety text not null default 'Regular';
alter table public.pantry_items add column if not exists quantity_unit text not null default 'servings';
alter table public.pantry_items add column if not exists food_id text;
alter table public.app_state add column if not exists shopping jsonb not null default '[]'::jsonb;
alter table public.cook_log add column if not exists undone_at timestamptz;

insert into public.foods (id, name, category, storage, default_unit, default_servings,
  shelf_life_days, default_daily_rate, item_type, checkin_style, count_unit, aliases)
values ('bananas', 'Bananas', 'produce', 'pantry', '6 bananas', 6, 5, 0, 'event', 'count',
  'bananas', array['banana','bananas','organic bananas','regular bananas'])
on conflict (id) do nothing;

-- A save is one transaction: inventory, deck, shopping, receipts and cook history
-- cannot become partially saved. Stable UUIDs make retries idempotent.
create or replace function public.save_pantry_state(p_state jsonb, p_deleted_ids uuid[] default '{}')
returns void language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in to save your pantry'; end if;
  if jsonb_typeof(p_state->'pantry') is distinct from 'array'
     or jsonb_typeof(p_state->'shopping') is distinct from 'array' then
    raise exception 'Invalid pantry state';
  end if;

  insert into public.pantry_items (id, user_id, name, key, raw_text, quantity_label,
    initial_servings, deducted_servings, purchase_date, expiry_date, daily_burn_rate,
    item_type, status, variety, quantity_unit, food_id)
  select r.id, auth.uid(), r.name, r.key, r.raw_text, r.quantity_label,
    r.initial_servings, r.deducted_servings, r.purchase_date, r.expiry_date,
    r.daily_burn_rate, r.item_type, 'active', r.variety, r.quantity_unit, r.food_id
  from jsonb_to_recordset(p_state->'pantry') as r(id uuid, name text, key text,
    raw_text text, quantity_label text, initial_servings numeric, deducted_servings numeric,
    purchase_date timestamptz, expiry_date timestamptz, daily_burn_rate numeric,
    item_type text, variety text, quantity_unit text, food_id text)
  on conflict (id) do update set name=excluded.name, key=excluded.key,
    raw_text=excluded.raw_text, quantity_label=excluded.quantity_label,
    initial_servings=excluded.initial_servings, deducted_servings=excluded.deducted_servings,
    purchase_date=excluded.purchase_date, expiry_date=excluded.expiry_date,
    daily_burn_rate=excluded.daily_burn_rate, item_type=excluded.item_type,
    status=excluded.status, variety=excluded.variety, quantity_unit=excluded.quantity_unit,
    food_id=excluded.food_id;

  delete from public.pantry_items where user_id=auth.uid() and id=any(p_deleted_ids);
  insert into public.app_state (user_id, skipped, cooked, chosen, shopping, updated_at)
  values (auth.uid(), p_state->'skipped', p_state->'cooked', p_state->'chosen', p_state->'shopping', now())
  on conflict (user_id) do update set skipped=excluded.skipped, cooked=excluded.cooked,
    chosen=excluded.chosen, shopping=excluded.shopping, updated_at=now();

  insert into public.cook_log (id,user_id,recipe_id,title,cooked_at,items_deducted,undone_at)
  select r.id,auth.uid(),r.recipe_id,r.title,r.cooked_at,r.items_deducted,r.undone_at
  from jsonb_to_recordset(coalesce(p_state->'cookLogs','[]'))
    as r(id uuid,recipe_id text,title text,cooked_at timestamptz,items_deducted jsonb,undone_at timestamptz)
  on conflict (id) do update set undone_at=excluded.undone_at;

  insert into public.receipts (id,user_id,store_name,total,scanned_at,item_count)
  select r.id,auth.uid(),r.store_name,r.total,r.scanned_at,r.item_count
  from jsonb_to_recordset(coalesce(p_state->'receipts','[]'))
    as r(id uuid,store_name text,total numeric,scanned_at timestamptz,item_count integer)
  on conflict (id) do nothing;
end;
$$;
revoke all on function public.save_pantry_state(jsonb,uuid[]) from public, anon;
grant execute on function public.save_pantry_state(jsonb,uuid[]) to authenticated;

-- Correct a single batch, without moving its expiration date. Known recipe
-- deductions are excluded from the learned passive consumption rate.
create or replace function public.checkin_item(p_item_id uuid, p_style text, p_value numeric default null)
returns void language plpgsql security invoker set search_path = public as $$
declare
  v_item public.pantry_items;
  v_food public.foods;
  v_prof public.consumption_profiles;
  v_elapsed numeric;
  v_observed numeric;
  v_default numeric;
  v_new_burn numeric;
begin
  if p_style not in ('percent','count','empty') or p_style is null then raise exception 'Invalid check-in style'; end if;
  if p_style <> 'empty' and (p_value is null or p_value < 0 or (p_style='percent' and p_value>1)) then
    raise exception 'Invalid remaining amount';
  end if;
  select * into v_item from public.pantry_items where id=p_item_id and user_id=auth.uid() for update;
  if not found then raise exception 'Batch not found'; end if;
  v_elapsed := greatest(0,extract(epoch from (now()-v_item.purchase_date))/86400.0);
  v_observed := case p_style when 'empty' then 0 when 'count' then p_value else p_value*v_item.initial_servings end;
  v_food := public.resolve_food(v_item.key,v_item.food_id);
  v_default := coalesce(nullif(v_item.daily_burn_rate,0),v_food.default_daily_rate,0);
  if v_elapsed>=1 then
    perform public.fold_profile('food',v_item.key,greatest(0,v_item.initial_servings-v_item.deducted_servings-v_observed)/v_elapsed,v_default);
    if v_food.category is not null then
      perform public.fold_profile('category',v_food.category,greatest(0,v_item.initial_servings-v_item.deducted_servings-v_observed)/v_elapsed,v_default);
    end if;
  end if;
  select * into v_prof from public.consumption_profiles where user_id=auth.uid() and scope='food' and key=v_item.key;
  v_new_burn := v_item.daily_burn_rate;
  if found and v_prof.observation_count>0 then
    v_new_burn := (v_default*2.5+v_prof.learned_daily_rate*v_prof.observation_count)/(2.5+v_prof.observation_count);
  end if;
  update public.pantry_items set initial_servings=round(v_observed,2),deducted_servings=0,
    purchase_date=now(),daily_burn_rate=round(v_new_burn,3),
    status=case when v_observed>0.05 then 'active' else 'gone' end
  where id=p_item_id and user_id=auth.uid();
end;
$$;
revoke all on function public.checkin_item(uuid,text,numeric) from public, anon;
grant execute on function public.checkin_item(uuid,text,numeric) to authenticated;
commit;
