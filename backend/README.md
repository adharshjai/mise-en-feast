# mise en feast backend

FastAPI + Gemini, with Claude on Bedrock for the chat. Reads a receipt photo into
pantry items (with servings, shelf life, burn rate and a brand-agnostic
`group_key` so repeat purchases stack as separate lots), generates dishes from
whatever is in the pantry ranked by what expires first, plans the week, draws a
picture for each dish, runs the in-app assistant and answers "no heavy cream?"
from what the household actually has.

| Endpoint | What it does |
|---|---|
| `POST /scan` | multipart `file` (image or PDF) → parsed, enriched items |
| `POST /recipes` | `{ items, count, max_missing, request, prefs }` → ranked recipes |
| `POST /chat` | `{ messages, pantry, prefs, recent_meals, shopping, focus_recipe }` → `{ reply, actions, recipes }`, see below |
| `POST /recipe-detail` | `{ title, servings, ingredients, request }` → `{ steps }` for one chat/plan card |
| `POST /substitutions` | `{ ingredient, dish_title, dish_ingredients, pantry, prefs }` → `{ substitutions }`, pantry-based first, see below |
| `POST /cook` | subtract a cooked recipe's servings |
| `POST /identify` | multipart `file` (photo of a dish) → its recipe, see below |
| `GET /dish-image` | `?title=&ingredients=&seed=` → JPEG bytes, cached for a year, see below |
| `POST /meal-plan` | `{ items, prefs, days, start, request }` → `{ start, days: [{ date, meals }] }`, see below |
| `GET /health` | `{ ok, model, image_model, key_set, chat: {...} }` |

Gemini runs everything except the chat and the substitutions. `GEMINI_API_KEY` is its only key;
`GEMINI_MODEL` (default `gemini-3.5-flash-lite`) picks the text model,
`GEMINI_IMAGE_MODEL` pins the image model (unset: the first of
`gemini-3.5-flash-image`, `gemini-3-flash-image`, `gemini-2.5-flash-image` that
answers), and `IDENTIFY_STUB=1` makes `/identify` answer without calling
anything. The chat and `/substitutions` need the Bedrock variables in
`bedrock.py`'s docstring.

## Run locally

```sh
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
# put GEMINI_API_KEY in .env (gitignored)
uvicorn main:app --reload --port 8000

# in another terminal
curl -s http://localhost:8000/health
curl -s -F file=@/path/to/a/receipt.jpg http://localhost:8000/scan | python3 -m json.tool
```

Serve the frontend from `frontend/` (`python3 -m http.server 4173`); on localhost
it talks to `http://localhost:8000` automatically.

Any photo of a receipt works for `/scan`; `/docs` gives you a form to try the
endpoints without curl.

## Deployed

`api/index.py` at the repo root mounts this app under `/api` as a Vercel Python
function (`vercel.json` routes `/api/*` to it and bundles `backend/`). Add
`GEMINI_API_KEY` in the Vercel project → Settings → Environment Variables and
redeploy. The frontend's `apiBaseUrl` is `/api`, so no CORS is involved.

## Photo of a dish → recipe

`POST /identify` takes a photo of a plated dish and returns the recipe for it:
one Gemini call with the image and `IDENTIFY_PROMPT`, answered as
`IdentifiedDish`. `IDENTIFY_STUB=1` short-circuits it to a canned sample that
needs no key (see below). The frontend treats an unreachable backend as "not
ready" and shows its own copy of that sample.

### Contract

```
POST /identify   multipart/form-data, field "file" (image/jpeg | png | webp | heic)

200 → {
  title: string,                 // "Shakshuka"
  confidence: number,            // 0..1, how sure the model is about the dish
  description: string,           // one plain sentence about the dish
  cuisine: string,               // "middle-eastern" etc, lowercase, may be ""
  cook_minutes: number,
  servings: number,
  difficulty: "easy" | "medium" | "hard",
  ingredients: [ { name: string, amount: string, staple: boolean } ],
  steps: string[],
  tags: { vegetarian: boolean, vegan: boolean, contains: string[] }
        // contains uses the allergen keys: peanuts, tree-nuts, dairy, eggs,
        // gluten, shellfish, fish, soy, sesame
}
400 → empty upload or a non-image content type
503 → GEMINI_API_KEY not set (same as /scan)
502 → the model call failed (same as /scan and /recipes)
```

Everything lives in `identify.py`:

- `IdentifiedDish` (+ `IdentifiedIngredient`, `IdentifiedTags`) — pydantic models
  that are exactly the 200 shape. Field descriptions are written for the model,
  so the class goes straight in as `response_schema`. Validators tidy up a sloppy
  answer (percent confidence, "Middle Eastern", numbered steps, allergen keys
  the model spelled differently) rather than 502 on it.
- `IDENTIFY_PROMPT` — the full prompt: name the dish, honest confidence, one-line
  description, cuisine key, realistic time and servings, the same difficulty
  rubric as `/recipes`, ingredients with amounts and staple flags, 3–8 imperative
  steps, allergen tags, and what to do with unclear or non-food photos.
- `SAMPLE_IDENTIFIED` — shakshuka, the same sample the frontend ships.
- `finish()` — pure post-processing: adds any allergen the listed ingredients
  trip (same keyword table as `/recipes`) and keeps the vegetarian/vegan flags
  consistent with `contains`.
- `identify(image_bytes, mime_type, client, model)` — the Gemini call, via
  `llm.generate_json`; returns the sample instead when `IDENTIFY_STUB=1`.

It needs `GEMINI_API_KEY`, the same one `/scan` uses, and nothing else. Leave
`IDENTIFY_STUB` unset to get real answers: it only short-circuits when it is
exactly `"1"`.

### Testing it locally

Stubbed (no key needed; every photo comes back as the shakshuka sample):

```sh
cd backend
IDENTIFY_STUB=1 .venv/bin/uvicorn main:app --reload --port 8000

# in another terminal, any image file will do
curl -s -F "file=@../frontend/img/shakshuka.jpg;type=image/jpeg" http://localhost:8000/identify | python3 -m json.tool
```

Without the flag (and with a key in `.env`) the same call goes to Gemini and
comes back with whatever the photo actually shows.

Or without a server at all (FastAPI's `TestClient` needs `httpx`, which is in
the venv):

```sh
IDENTIFY_STUB=1 GEMINI_API_KEY= .venv/bin/python -c "
from fastapi.testclient import TestClient
import main
r = TestClient(main.app).post('/identify', files={'file': ('d.png', b'not really a png', 'image/png')})
print(r.status_code, r.json()['title'])"
# 200 Shakshuka
```

Deployed, the same route is `https://<your-app>.vercel.app/api/identify`.

## The assistant's tools (`POST /chat`)

Claude never touches the database. Every write comes back as a validated
`action` the client applies itself; every read is answered from the request
body. `chat.py` has the full contract. Besides preferences, "gone" and
check-ins, the assistant can now stock the pantry and keep the shopping list:

| Tool | The user says | Action sent to the client |
|---|---|---|
| `add_pantry_items` | "add eggs to my pantry", "I bought 2 lb of chicken thighs" | `{ type: 'add_pantry_items', items: [{ name, quantity, unit, expires_in_days }] }` |
| `add_to_shopping_list` | "put lemons on my shopping list", "I need to buy rice" | `{ type: 'add_shopping_items', items: [{ name, quantity, unit, note }] }` |
| `remove_from_shopping_list` | "take milk off the list" | `{ type: 'remove_shopping_items', names: [...] }` (only names that matched a row in `shopping`) |
| `read_shopping_list` | "what's on my list?" | none (a read) |
| `suggest_substitutions` | "no heavy cream?", "what can I use instead of buttermilk" | none (a read: the swaps go back to Claude, which answers in prose) |

Names are trimmed to 1–60 characters, quantities must be positive, and units are
folded into the six the pantry stores (`g, kg, ml, l, pcs, pack`): `2 lb` becomes
`907.2 g`, `1 dozen` `12 pcs`, a `jar`, `bag` or `bunch` a `pack`, and a unit
nobody recognises becomes `""` with the quantity kept. `expires_in_days` is
1–730 or null. The request's `shopping` field (`[{ name, quantity, unit, done }]`)
is what `read_shopping_list` answers from and what removals are matched against.
`update_preference` also accepts `liked` and `disliked` (complete lists of dish
titles, see below).

### Asking from the recipe popup (`focus_recipe`)

When the chat is opened from a recipe ("Ask a question"), the client sends the
dish along with the turn:

```
focus_recipe: { title: str, servings: int = 2, ingredients: [str] = [],
                steps: [str] = [], missing: [str] = [] } | null
```

`ingredients` are the recipe's lines ("1 cup heavy cream"), `steps` its steps
and `missing` the ingredient names the pantry lacks. `chat.py` appends "The user
is currently looking at this recipe and their questions are about it unless they
say otherwise:" with the title, servings, ingredients, steps and what is missing
to the system prompt for every model call of that turn, so "can I skip the
wine?" or "how long is step 3?" needs no other context, and
`suggest_substitutions` uses that ingredient list unless the model names a
different dish. Tool routing is otherwise unchanged; omit the field (or send
`null`) for a plain turn. Sloppy values never 422: the title is capped at 120
characters, servings clamped to 1..24, lines trimmed and capped (40 ingredients,
20 steps).

### Rated dishes (`prefs.liked` / `prefs.disliked`)

`Prefs` carries two more lists, `liked` and `disliked`: the dish titles the
household rated up and down, newest first as the client writes them. They are
cleaned like the other list fields (trimmed, inner whitespace collapsed, control
characters removed, at most 80 characters each, de-duplicated ignoring case and
punctuation, at most 30 kept) and never cause a 422. Every recipe prompt
(`/recipes`, the chat's `suggest_recipes`, `/meal-plan`, `/substitutions`) gets
"Dishes they rated up (make more like these): …" and "Dishes they rated down (do
not suggest these or close variants): …", and `rank()` drops any dish whose
normalised title equals a disliked one, so a repeat never reaches the deck even
when the model ignores the note. `read_preferences` returns both lists.

## Substitutions (`POST /substitutions`)

```
POST /substitutions  { ingredient: str,                // "heavy cream"
                       dish_title: str = "",           // the dish it is for, when known
                       dish_ingredients: [str] = [],   // the dish's ingredient lines
                       pantry: [PantryItem] = [],      // same shape /recipes takes
                       prefs: Prefs | null }

200 → { substitutions: [ { use: "milk + butter",           // the swap; foods joined with " + "
                           from_pantry: true,              // every food it needs is in the pantry
                           ratio: "¾ cup milk + ¼ cup melted butter per 1 cup heavy cream",
                           note: "will not whip",          // how it changes the dish, "" when it doesn't
                           pantry_names: ["Milk", "Butter"] } ] }  // exact pantry names, for deduction
      pantry-based first, at most 4, [] when nothing sensible stands in
422 → no ingredient
503 → Bedrock is not configured
502 → the model call failed, or answered something that was not the JSON asked for
```

`substitutions.py` asks Claude (the fast model) with a JSON-only prompt: the
ingredient, the dish and its ingredient list, the pantry names (food with
servings left), the household's hard rules and preferences; pantry first,
realistic ratios, a note on what changes, never an allergen. Then Python has
the last word, as `rank()` does for recipes: `finish()` recomputes `from_pantry`
by matching `pantry_names` (or the foods in `use`) against the real pantry rows
with the same normalisation `recipes._match` uses, rewrites `pantry_names` to
the exact pantry spellings, drops any swap that trips `ingredient_hits` /
`diet_conflicts` (or names something they avoid), drops "use the thing you are
out of" and repeats, and sorts pantry-based swaps first. `build_prompt()` and
`finish()` are pure, so the whole pass can be exercised without a model call.
The chat's `suggest_substitutions` tool calls the same `suggest()` with the
request's pantry, prefs and the recipe on screen; the client falls back to
`frontend/shared/substitutions.js` when the API is unconfigured or unreachable.

## Dish pictures (`GET /dish-image`)

```
GET /dish-image?title=Spinach+and+garlic+pasta&ingredients=spinach,garlic,pasta&seed=0

200 → image/jpeg bytes
      Cache-Control: public, max-age=31536000, immutable
      X-Dish-Slug: spinach-and-garlic-pasta
400 → no title, or title over 120 / ingredients over 400 characters
503 → GEMINI_API_KEY not set
502 → the model call failed
```

`images.py` builds one prompt (overhead shot, ceramic plate, wooden table, no
text, the ingredients visible), calls `generate_content` with
`response_modalities=["IMAGE"]`, takes the first inline image part, downsizes it
to 1024 px on the long side with Pillow (JPEG quality 82; without Pillow the
model's bytes go out as-is with their own mime type) and keeps the last 64 in
memory by slug. `seed` asks for a different take on the same title and gets its
own cache slot. The browser caches by URL for a year, so the client's slug is
what decides when a dish gets a new picture.

## Meal plan (`POST /meal-plan`)

```
POST /meal-plan  { items: [PantryItem], prefs: Prefs|null, days: 1..14 (default 7),
                   start: 'YYYY-MM-DD' (default today), request: str|null }

200 → { start: 'YYYY-MM-DD',
        days: [ { date: 'YYYY-MM-DD',
                  meals: { breakfast: Meal|null, lunch: Meal|null, dinner: Meal|null } } ] }
400 → the pantry has no food in it
503 → GEMINI_API_KEY not set
502 → the model call failed
```

`Meal` is the step-less recipe the chat cards use (`title, description,
cook_minutes, servings, difficulty, ingredients[{ name, amount, matched_name,
servings_used, staple, have }], missing_count, coverage, urgency_days,
uses_expiring, steps: []`); fetch steps with `/recipe-detail` when a cell is
opened. `meal_plan.py` asks for the soonest-expiring food in the first days,
15-minute breakfasts, at most three non-pantry ingredients per dish and one
shared shopping basket for the week, with the same hard rules and preferences
as `/recipes`. The week is generated in chunks of four days: the first chunk
fixes the basket, then the rest run in parallel with that basket, the titles
already used and the pantry as the first chunk left it. Every meal is annotated
with `recipes.annotate()`, the non-filtering half of `rank()`, so a plan cell and
a deck card agree on what you own; a meal that trips an allergy or diet rule
comes back `null`.

## Files

- `main.py` — app, receipt parsing (`/scan`), `/cook`, `/health`, and the routes for everything below
- `recipes.py` — recipe generation (ideas, then recipes), `annotate` (have/missing against the pantry) and `rank`
- `recipes_ai.py` — the chat's step-less suggestions and `/recipe-detail` (Claude)
- `substitutions.py` — `/substitutions` and the chat's `suggest_substitutions`: what stands in for an ingredient, pantry first (Claude)
- `chat.py` — the assistant: tools, validation, the actions the client applies
- `meal_plan.py` — `/meal-plan`: the week's meals, chunked, annotated
- `images.py` — `/dish-image`: one image call per dish, model fallback, LRU, downscale
- `identify.py` — photo of a dish → recipe: models, prompt, sample, the call
- `bedrock.py` — the Bedrock Converse client and its environment variables
- `llm.py` — the shared "answer as this pydantic model" Gemini call
- `.env.example` — the variables the app reads (`IDENTIFY_STUB=1` and `GEMINI_IMAGE_MODEL` are the extras)
