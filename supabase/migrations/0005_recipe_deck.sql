-- The generated recipe deck, cached per user so it paints instantly on login
-- instead of waiting on two Gemini calls. Additive: existing rows keep working,
-- and the app falls back to localStorage if these columns are not there yet.
begin;

-- One blob replaced wholesale, like skipped/cooked/chosen beside it.
alter table public.app_state add column if not exists deck jsonb not null default '[]'::jsonb;
-- When it was generated, so a deck left sitting for a day can be refreshed.
alter table public.app_state add column if not exists deck_at timestamptz;
-- Fingerprint of the pantry and preferences it was generated from. When this
-- stops matching, the deck no longer reflects the kitchen and is regenerated.
alter table public.app_state add column if not exists deck_signature text;

commit;
