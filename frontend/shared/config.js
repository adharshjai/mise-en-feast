/* mise en feast — connection settings.
   Loaded as a classic <script> BEFORE any module that imports shared/supabase.js
   or shared/api.js.

   Supabase (auth + pantry persistence):
     Dashboard → Project Settings → API
       - Project URL  → supabaseUrl
       - anon public  → supabaseAnonKey
     The anon key is safe in the browser; RLS protects every row.
     Leave both empty to run in demo mode (localStorage only).

   FastAPI AI backend (receipt OCR + recipes):
     Deployed: the FastAPI app runs as a Vercel function under /api (see api/index.py),
     so '/api' is same-origin. Locally: run backend/ with uvicorn on port 8000; a relative
     apiBaseUrl on localhost automatically points there.
     Leave apiBaseUrl empty to use the built-in sample receipt + hardcoded dishes. */
window.PANTRY_CONFIG = {
  supabaseUrl: 'https://kfzgofybljvahvrxdhav.supabase.co',
  supabaseAnonKey: 'sb_publishable_L1BhUCvvzLvweoBm3WMecA_aq6PevHH',

  apiBaseUrl: '/api',   // same origin on Vercel; on localhost the frontend talks to http://localhost:8000 instead
};
