# Pantry Pal

A pantry that fills itself from grocery receipts and tells you what to cook.

Photograph a receipt. Pantry reads what you bought, estimates how long each item
lasts, and turns what's in your kitchen into dishes you can make tonight —
ordered by what's going bad first. Built for VTHacks14.

## What it does

- **Scan a receipt** — a photo or PDF becomes pantry items, with servings, shelf
  life and a household burn rate. `GV MLK 1GAL` becomes `Milk, 1 gal`.
- **A pantry that runs itself** — quantities fall on their own over time. Nothing
  is logged by hand. When an estimate hits zero the item asks "Still have this?"
  instead of guessing, and buying it again stacks as a new batch rather than
  overwriting the older one's expiry.
- **Swipe to dinner** — generated dishes, sorted by what expires first, with a
  filter for fewest-missing-ingredients. "I made this" subtracts the servings.
- **Kitchen helper** — a chat panel for "what do I buy to make X?"
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
                     pantry-model.js, foods.js, food-catalog.js, supabase.js
  img/               dish photos (credits in img/CREDITS.md)
backend/             FastAPI service (receipt OCR, recipes, dish photo → recipe)
  main.py            app, /scan, /cook, /identify, /health
  recipes.py         recipe generation and ranking
  identify.py        photo of a dish → recipe (skeleton, see below)
  dev/               receipt generator + NVIDIA scan harness
api/index.py         mounts backend/ as a Vercel Python function under /api
supabase/            migrations 0001–0004 + schema.sql (the four concatenated)
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
```

Without a key, `/scan` and `/recipes` return 503 and the app uses its sample
receipt and hardcoded dishes.

## Endpoints

| Endpoint | What it does |
|---|---|
| `POST /scan` | multipart `file` (image or PDF) → parsed, enriched pantry items |
| `POST /recipes` | `{ items, count, max_missing, request }` → ranked recipes |
| `POST /cook` | subtract a cooked recipe's servings |
| `POST /identify` | photo of a dish → its recipe. **Skeleton**: returns 501 until the Gemini call is pasted into `identify.identify()`. Set `IDENTIFY_STUB=1` for a canned response that needs no key |
| `GET /health` | `{ ok, provider, model, key_set }` |

`/scan` can read receipts with an NVIDIA vision model instead of Gemini by
setting `LLM_PROVIDER=nvidia` and `NVIDIA_API_KEY`. `/recipes` and `/identify`
are Gemini only, so keep `GEMINI_API_KEY` set either way. Full provider table in
[backend/README.md](backend/README.md).

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

Tables, RLS and the foods/consumption intelligence layer are documented in
[DATABASE.md](DATABASE.md).

## Tests

```sh
npm install
npm test          # node --test scripts/*.test.mjs
```

Four suites: the pantry model (expiry, allocation, undo), the storage layer, the
Supabase/localStorage merge path, and the migrations run against an in-process
Postgres via PGlite.

## Deploy

Vercel, from the repo root — not from `frontend/`. The root `vercel.json` serves
`frontend/` as the site and runs `backend/` as a Python function under `/api`,
so `apiBaseUrl` is same-origin and no CORS is involved.

- Framework Preset: Other · Build Command: empty · Output Directory: empty
- Add `GEMINI_API_KEY` under Settings → Environment Variables, then redeploy

The "Root Directory = `frontend`" note in `frontend/README.md` predates the
backend and no longer applies.

## Docs

| File | What's in it |
|---|---|
| [frontend/README.md](frontend/README.md) | frontend structure and the pantry model |
| [frontend/DESIGN.md](frontend/DESIGN.md) | palette, type, components, writing style |
| [backend/README.md](backend/README.md) | endpoints, providers, prompt details |
| [DATABASE.md](DATABASE.md) | tables, RLS, foods catalog, consumption learning |
