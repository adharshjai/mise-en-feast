# mise en feast - [https://www.nowwere.cooking]

A pantry that fills itself from grocery receipts and tells you what to cook.

Photograph a receipt. mise en feast reads what you bought, estimates how long each item
lasts, and turns what's in your kitchen into dishes you can make tonight —
ordered by what's going bad first. Built for VTHacks14.

## What it does

- **Scan a receipt** — a photo or PDF becomes pantry items, with servings, shelf
  life and a household burn rate. `GV MLK 1GAL` becomes `Milk, 1 gal`.
- **A pantry that runs itself** — quantities fall on their own over time. Nothing
  is logged by hand. When an estimate hits zero the item asks "Still have this?"
  instead of guessing, and buying it again stacks as a new batch rather than
  overwriting the older one's expiry.
- **Swipe to dinner** — generated dishes, sorted by what expires first, on two
  decks: **Curated** is what you can make with only what's here, **Explore** is
  one to three ingredients away. Every recipe is re-checked against the pantry
  at read time, so a scan or a check-in moves dishes between the two. "I made
  this" subtracts the servings; Undo brings the last swipe back.
- **Shopping List** — a fourth tab. A cook swipe on something you're short on,
  the recipe sheet's "Add N to shopping list", the kitchen helper and the weekly
  plan all add to it; the same food merges into one row. Tick things off,
  then "Add bought to pantry" turns them into lots.
- **This week** — the calendar button plans seven days of breakfast, lunch and
  dinner from the pantry, reusing one small basket of extras so a single shop
  covers the week. Cached on the account; regenerates when the kitchen
  changes. Offline it deals the week from the dishes on hand.
- **Units that agree** — every quantity goes through one parser: `1.4 lb`
  becomes `635 g`, `½ cup` becomes `120 ml`, and a lot's servings are read off
  its quantity (24 eggs is 24 servings, 2 lb of rice about 15), not from a
  package default. Recipe amounts scale with the people you cook for.
- **Generated dish photos** — dishes the model writes get a picture from
  `GET /dish-image`, cached in IndexedDB so each one is made once per device.
- **Kitchen helper** — a chat panel that can suggest dishes, mark food gone,
  and change things: "add eggs to my pantry", "put lemons on my shopping
  list", "take milk off the list". Those three also work offline. A mic button
  takes the question by voice where the browser has speech recognition.
- **Ask about this dish** — "Ask a question" on a recipe floats the helper over
  the sheet with that recipe in front of it (`focus_recipe`), so "can I skip the
  wine?" is answered about that dish. Offline it lists the steps and swaps.
- **Cook mode** — "Start cooking" shows one step at a time in big type; every
  "10 to 12 minutes" in a step is a tappable timer (beep, vibrate, a red row
  until dismissed), the ingredients the step mentions sit under it as chips,
  and timers keep running behind a small pill after the overlay closes.
- **Swaps** — "Swap?" beside anything you're missing asks `POST /substitutions`
  (the table in `shared/substitutions.js` stands in offline) and "Use this"
  makes the dish cookable with what you have; "I made this" deducts the swap.
- **Ratings and Cook again** — a thumbs up or down after cooking feeds the
  model's preferences (`liked` / `disliked`), lifts similar dishes and keeps a
  rated-down one off the deck; the Saved sheet's Cooked tab brings any dish back.
- **Kitchen report** — a strip on the Pantry tab and a sheet from the profile
  menu: items used before expiring, meals cooked, an estimated dollar figure
  saved and wasted, four weekly bars, a no-waste streak and "Use these next".
  Figures are estimates from receipt prices and typical costs.
- **Your preferences** — onboarding captures household size, allergies, diet,
  cuisines, time and skill; recipes scale to the number of people and flag
  anything you avoid.
- **Light and dark** — cream/emerald by default, warm dark under the theme
  toggle in the profile menu.

## Layout

```
frontend/            static web app — no framework, no build step
  index.html         landing                    →  /
  login/             sign in / create account   →  /login/
  app/               the app                    →  /app/
  shared/            tokens.css, config.js, store.js, api.js,
                     units.js (quantities → g/ml/pcs, servings per food),
                     ingredients.js (recipe ingredient ↔ pantry matching),
                     dish-images.js (generated photos, IndexedDB cache),
                     timers.js (durations in a step, countdown arithmetic),
                     substitutions.js (offline swap table),
                     report.js (the kitchen report's maths),
                     pantry-model.js, foods.js, food-catalog.js, supabase.js
  img/               dish photos (credits in img/CREDITS.md)
backend/             FastAPI service (receipt OCR, recipes, chat, plan, images)
  main.py            app, /scan, /cook, /identify, /dish-image, /meal-plan, /substitutions, /health
  recipes.py         recipe generation, ranking and annotate()
  recipes_ai.py      step-less suggestions for the chat (Claude on Bedrock)
  chat.py            the kitchen helper and its tools (focus_recipe, suggest_substitutions)
  substitutions.py   POST /substitutions: what to use instead of one ingredient
  meal_plan.py       POST /meal-plan: a week of meals, chunked
  images.py          GET /dish-image: one picture per dish, cached
  identify.py        photo of a dish → recipe
  llm.py             the shared "answer as this pydantic model" Gemini call
api/index.py         mounts backend/ as a Vercel Python function under /api
supabase/            migrations 0001–0007 + schema.sql
scripts/             node --test suites, migration runner, DB smoke test
vercel.json          routes /api/* to the function, everything else to frontend/
```

## Run it

### Frontend only

Everything except AI works without the backend: demo mode keeps state in
localStorage and falls back to built-in dishes.

```sh
cd frontend
python3 -m http.server 4173
```

Open http://localhost:4173/ and click **Try the demo** to skip sign-in.

### With the backend

```sh
cd backend
python3 -m venv .venv && . .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The frontend on localhost points at `http://localhost:8000` automatically. Check
it came up with `curl localhost:8000/health`.

The backend needs a Gemini key. There is no `.env.example` in the repo despite
what `backend/README.md` says, so create `backend/.env` yourself:

```
GEMINI_API_KEY=your_key_here
# optional
GEMINI_MODEL=gemini-2.5-flash          # the text model
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image   # pin the picture model; unset tries 3.5 → 3 → 2.5 flash-image
```

Without a key, `/scan`, `/recipes`, `/meal-plan` and `/dish-image` return 503:
the first-run card says so and points at the Pantry tab (there is no sample
receipt), and the app uses its hardcoded dishes, stand-in photos and a week
dealt from the dishes on hand. The chat and `/substitutions` run on Claude via
Bedrock and need AWS credentials (see `backend/README.md`); without them the
three plain commands, the recipe's steps and the swap table still work offline.

## Endpoints

| Endpoint | What it does |
|---|---|
| `POST /scan` | multipart `file` (image or PDF) → parsed, enriched pantry items |
| `POST /recipes` | `{ items, count, max_missing, request, prefs }` → ranked recipes |
| `POST /cook` | subtract a cooked recipe's servings |
| `POST /identify` | photo of a dish → its recipe. Set `IDENTIFY_STUB=1` for a canned response that needs no key |
| `POST /chat` | `{ messages, pantry, prefs, recent_meals, shopping, focus_recipe? }` → `{ reply, actions, recipes }` |
| `POST /substitutions` | `{ ingredient, dish_title, dish_ingredients, pantry, prefs }` → `{ substitutions: [{ use, from_pantry, ratio, note, pantry_names }] }` |
| `POST /recipe-detail` | steps for one step-less recipe, written on demand |
| `POST /meal-plan` | `{ items, prefs, days, start, request }` → `{ start, days: [{ date, meals }] }` |
| `GET /dish-image` | `?title=&ingredients=&seed=` → JPEG bytes, cached for a year |
| `GET /health` | `{ ok, model, image_model, key_set }` |

Everything except the chat runs on Gemini, so `GEMINI_API_KEY` is the main key
the backend needs. Details in [backend/README.md](backend/README.md).

## Supabase

Sign-in and sync are optional — without them the app runs in demo mode.

1. Create a project at supabase.com and run `supabase/schema.sql` in the SQL
   editor. It's idempotent and safe to re-run.
2. Put the project URL and anon key in
   [frontend/shared/config.js](frontend/shared/config.js). The anon key is meant
   to ship in the browser; row-level security is what protects the data. Never
   put the `service_role` key there.
3. Authentication → URL Configuration: add your site URL and
   `http://localhost:4173/app/` to the redirect allow-list.

An existing project needs the newest migrations: `0006_shopping_plan.sql` (adds
`shopping`, `plan` and `plan_at` to `app_state`) and `0007_wave2.sql` (adds
`price` to `pantry_items` and `ratings`, `cooked_log` and `events` to `app_state`
for the ratings, the cooked log and the kitchen report; the column is
`cooked_log` because `cooked` already holds the ids of dishes marked cooked).
`schema.sql` includes the same columns for a fresh project. Until they run,
those blobs stay in the browser's localStorage and nothing else breaks.

Tables, RLS and the foods/consumption intelligence layer are documented in
[DATABASE.md](DATABASE.md).

## Tests

```sh
npm install
npm test          # node --test scripts/*.test.mjs
```

Suites: the pantry model (expiry, allocation, undo), the units module, the
ingredient matcher, the dish-image cache, the timers, the swap table, the
report's maths, the app itself through the Supabase/localStorage merge harness
(tabs, servings, shopping list, chat actions, the week, cross-verification
against the pantry, ratings, swaps, the events log), the storage layer, and the
migrations run against an in-process Postgres via PGlite.

## Deploy

Vercel, from the repo root — not from `frontend/`. The root `vercel.json` serves
`frontend/` as the site and runs `backend/` as a Python function under `/api`,
so `apiBaseUrl` is same-origin and no CORS is involved.

- Framework Preset: Other · Build Command: empty · Output Directory: empty
- Add `GEMINI_API_KEY` (and, if you want to pin it, `GEMINI_IMAGE_MODEL`) under
  Settings → Environment Variables, then redeploy

The "Root Directory = `frontend`" note in `frontend/README.md` predates the
backend and no longer applies.

## Docs

| File | What's in it |
|---|---|
| [frontend/README.md](frontend/README.md) | frontend structure and the pantry model |
| [frontend/DESIGN.md](frontend/DESIGN.md) | palette, type, components, writing style |
| [backend/README.md](backend/README.md) | endpoints and prompt details |
| [DATABASE.md](DATABASE.md) | tables, RLS, foods catalog, consumption learning |
