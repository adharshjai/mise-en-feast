# Pantry AI backend

FastAPI + Gemini. Reads a receipt photo into pantry items (with servings, shelf
life, burn rate and a brand-agnostic `group_key` so repeat purchases stack as
separate lots), and generates dishes from whatever is in the pantry, ranked by
what expires first.

| Endpoint | What it does |
|---|---|
| `POST /scan` | multipart `file` (image or PDF) → parsed, enriched items |
| `POST /recipes` | `{ items, count, max_missing, request }` → ranked recipes |
| `POST /cook` | subtract a cooked recipe's servings |
| `POST /identify` | multipart `file` (photo of a dish) → its recipe. **Skeleton**: 501 until wired up, see below |
| `GET /health` | `{ ok, model, key_set }` |

## Run locally

```sh
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # paste your GEMINI_API_KEY
uvicorn main:app --reload --port 8000
```

Serve the frontend from `frontend/` (`python3 -m http.server 4173`); on localhost
it talks to `http://localhost:8000` automatically.

## Deployed

`api/index.py` at the repo root mounts this app under `/api` as a Vercel Python
function (`vercel.json` routes `/api/*` to it and bundles `backend/`). Add
`GEMINI_API_KEY` in the Vercel project → Settings → Environment Variables and
redeploy. The frontend's `apiBaseUrl` is `/api`, so no CORS is involved.

## Photo of a dish → recipe (skeleton)

`POST /identify` takes a photo of a plated dish and returns the recipe for it.
The endpoint, the response model, the prompt and a canned sample are done; the
one thing missing is the Gemini call itself, so today the route answers **501**
(or the sample when stubbed, see below). The frontend treats "unreachable or
501" as "backend not ready" and shows its own copy of the sample.

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
501 → { detail: "identify is not implemented yet" }   // while it is a skeleton
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
- `identify(image_bytes, mime_type, client)` — raises `NotImplementedError`
  until the call is pasted in; returns the sample when `IDENTIFY_STUB=1`.

### Finishing it — three steps

1. **Paste the Gemini call.** In `identify.identify()` uncomment the
   `client.models.generate_content(...)` block (it is modelled on `call_gemini()`
   in `main.py`: image part + `IDENTIFY_PROMPT`, `response_mime_type="application/json"`,
   `response_schema=IdentifiedDish`, then `finish(response.parsed)`) and delete
   the `raise NotImplementedError(...)` under it. `main.py` already builds the
   client with `gemini()` and maps errors, nothing to change there.
2. **Drop the stub flag.** Stop setting `IDENTIFY_STUB=1` wherever you set it
   (`.env`, shell, Vercel). The flag only ever short-circuits when it is exactly
   `"1"`, so leaving it unset is enough.
3. **Add the Vercel env.** `GEMINI_API_KEY` is already there for `/scan`; nothing
   new is needed unless you want a different model, in which case set
   `GEMINI_MODEL` too. Redeploy; the frontend already calls `/api/identify`.

Run the stub test below once more after step 1 with a real key and
`IDENTIFY_STUB` unset to see a real answer.

### Testing the skeleton locally

Stubbed (no key needed; every photo comes back as the shakshuka sample):

```sh
cd backend
IDENTIFY_STUB=1 .venv/bin/uvicorn main:app --reload --port 8000

# in another terminal, any image file will do
curl -s -F "file=@../frontend/img/shakshuka.jpg;type=image/jpeg" http://localhost:8000/identify | python3 -m json.tool
```

Without the flag you get the not-implemented answer:

```sh
.venv/bin/uvicorn main:app --reload --port 8000
curl -s -i -F "file=@../frontend/img/shakshuka.jpg;type=image/jpeg" http://localhost:8000/identify
# HTTP/1.1 501 Not Implemented
# {"detail":"identify is not implemented yet"}
```

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

## Files

- `main.py` — app, receipt parsing (`/scan`), `/cook`, `/health`, and the `/identify` route
- `recipes.py` — recipe generation (`generate`) and ranking (`rank`)
- `identify.py` — photo of a dish → recipe: models, prompt, sample, stub (skeleton, see above)
- `.env.example` — the variables the app reads (`IDENTIFY_STUB=1` is the one extra for the skeleton)
