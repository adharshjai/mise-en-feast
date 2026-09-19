/* Pantry — connection settings.
   Loaded as a classic <script> BEFORE any module that imports shared/supabase.js
   or shared/api.js.

   Supabase (auth + pantry persistence):
     Dashboard → Project Settings → API
       - Project URL  → supabaseUrl
       - anon public  → supabaseAnonKey
     The anon key is safe in the browser; RLS protects every row.
     Leave both empty to run in demo mode (localStorage only).

   FastAPI AI backend (receipt OCR + recipes):
     Run pantry-pal/backend with uvicorn on port 8000, then keep apiBaseUrl below.
     Leave apiBaseUrl empty to use the built-in sample receipt + hardcoded dishes. */
window.PANTRY_CONFIG = {
  supabaseUrl: 'https://kfzgofybljvahvrxdhav.supabase.co',
  supabaseAnonKey: 'sb_publishable_L1BhUCvvzLvweoBm3WMecA_aq6PevHH',

  apiBaseUrl: 'http://localhost:8000',
};
