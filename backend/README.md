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

## Files

- `main.py` — app, receipt parsing (`/scan`), `/cook`, `/health`
- `recipes.py` — recipe generation (`generate`) and ranking (`rank`)
- `.env.example` — the variables the app reads
