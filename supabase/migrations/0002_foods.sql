-- ===========================================================================
-- mise en feast — Canonical foods (reference data for autofill + smart estimates).
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
-- mise en feast — Migration 2/4: canonical foods seed (generated from food-catalog.ts).
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
