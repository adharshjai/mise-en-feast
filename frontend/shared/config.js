/* Pantry — Supabase connection settings.
   Loaded as a classic <script> BEFORE any module that imports shared/supabase.js.

   Where to find both values:
     Supabase dashboard -> your project -> Project Settings -> API
       - "Project URL"            -> supabaseUrl   (looks like https://abcdefghijklmnop.supabase.co)
       - "Project API keys: anon" -> supabaseAnonKey

   The anon key is safe to ship in a browser. It only identifies the project; every
   table in supabase/schema.sql has Row Level Security enabled, so a request can only
   read or write rows whose user_id matches the signed-in user. Never put the
   service_role key here.

   Leave both empty to run Pantry in demo mode (state lives in localStorage). */
window.PANTRY_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
};
