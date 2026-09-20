# mise en feast on Supabase — setup

1. Create a project at https://supabase.com/dashboard (any region, free tier is fine).
2. SQL Editor -> New query -> paste `schema.sql` -> Run. Re-running it is safe.
3. Project Settings -> API: copy the Project URL and the `anon` key into `web/shared/config.js`.
4. Authentication -> URL Configuration: Site URL `http://localhost:4173`; Redirect URLs `http://localhost:4173/app/` and `http://localhost:4173/login/`.
5. Optional Google sign-in: Authentication -> Providers -> Google -> enable, paste the OAuth Client ID/Secret from Google Cloud (its redirect URI is `https://<project-ref>.supabase.co/auth/v1/callback`).
6. Serve the site: `python3 -m http.server 4173 --directory web` from the repo root, then open http://localhost:4173/login/.
7. Sign in (password, magic link or Google); the app reads and writes `pantry_items`, `app_state`, `cook_log` and `receipts` as that user only, thanks to RLS.
8. Leave both config values empty to run in demo mode: the login page offers "Continue in demo mode" and state stays in this browser's localStorage.
