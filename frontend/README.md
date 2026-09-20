# mise en feast — frontend

A pantry that fills itself from grocery receipts and tells you what to cook.
This folder is the hand-built web frontend: a landing page, a login page and
the app itself. Plain HTML, CSS and JavaScript — no framework, no build step.

```
frontend/
  index.html          landing page            →  /
  landing.css
  login/              sign in / create account →  /login/
  app/                the app                 →  /app/
    index.html
    app.js            deck, scan, pantry, Made It — all state lives here
    styles.css
  shared/
    tokens.css        colours, type, glass materials, controls (used by every page)
    config.js         ← put your Supabase URL + anon key here
    supabase.js       auth helpers (lazy-loads supabase-js from a CDN)
    store.js          persistence: Supabase when signed in, localStorage otherwise
  img/                dish photos (Unsplash, see img/CREDITS.md)
  supabase/
    schema.sql        tables + row-level security for a fresh Supabase project
    README.md         setup notes
  vercel.json         clean URLs + trailing slashes so relative paths work
```

## Run it locally

Any static server works. From this folder:

```sh
python3 -m http.server 4173
```

Then open http://localhost:4173/. "Try the demo" on the landing page opens the
app with `?demo`, which skips sign-in and keeps state in this browser's
localStorage. Without Supabase configured the login page offers the same
"Continue in demo mode" route.

## Connect Supabase

1. Create a project at supabase.com and run `supabase/schema.sql` in the SQL
   editor.
2. Copy the project URL and the anon (public) key from Project Settings → API
   into `shared/config.js`. The anon key is safe to ship in a browser; row-level
   security is what protects the data.
3. Authentication → URL Configuration: add your site URL and
   `https://<your-domain>/app/` (and `http://localhost:4173/app/` for local
   work) to the redirect allow-list. Enable Google under Providers if you want
   the "Continue with Google" button to work.

## Deploy on Vercel

The site is static, so the Vercel project needs no build command:

- Root Directory: `frontend`
- Framework Preset: Other
- Build Command: (empty) · Output Directory: (empty)

From this folder with the Vercel CLI: `vercel --prod`.

## How the pantry model works

Quantities are never stored as a running number. Each item keeps what it was
at purchase, when it was bought, its expiry estimate, a household burn rate
(servings per day) and what cooking has taken out. The current amount is
computed on every read, so nothing has to tick in the background. When an
estimate hits zero the item asks "Still have this?" instead of guessing, and
buying it again merges into the same row and resets the estimate.
