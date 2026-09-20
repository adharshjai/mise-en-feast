# mise en feast — database

The database matches the frontend's data layer (`frontend/shared/store.js`) and adds an
intelligence layer (canonical foods + household consumption learning) on top, without
changing the tables the frontend already reads/writes.

## Apply / update

Paste **`frontend/supabase/schema.sql`** (identical to `supabase/schema.sql`) into the
Supabase **SQL Editor** and Run. It's idempotent and safe to re-run. Source of truth is
the modular set in `supabase/migrations/` (`0001_base`, `0002_foods`, `0003_intelligence`);
`schema.sql` is those concatenated.

After applying, put your Project URL + anon key into **`frontend/shared/config.js`** so the
frontend connects (the anon key is safe to ship — RLS protects every row). Keep the same
two values in `.env` for the test script.

## Tables (frontend contract — unchanged)

| table | notes |
|---|---|
| `pantry_items` | one row per item: `initial_servings`, `deducted_servings`, `daily_burn_rate`, `purchase_date`, `expiry_date`, `key`, `status` (`active`/`gone`). Current qty is `initial − burn×daysSince(purchase) − deducted`. |
| `app_state` | per-user deck state (`skipped`/`cooked`/`chosen` jsonb). |
| `receipts` | scanned receipts. |
| `recipes` | generated recipes (jsonb steps/ingredients). |
| `cook_log` | "I made it" log. |

All have RLS: a user only sees rows where `user_id = auth.uid()`. The browser never sends
`user_id` — the column defaults to `auth.uid()`.

## Intelligence layer (additive)

| object | purpose |
|---|---|
| `foods` | canonical food metadata (39 seeded): category, storage, shelf life, default servings/rate, `checkin_style`, `aliases`. Read-only to signed-in users. **Autofill**: query it and match `name`/`aliases` (e.g. "garlic" → the `garlic` row) to fill an item's fields. |
| `consumption_profiles` | learned per-household consumption rate, per item `key` and per food category. |
| `checkin_item(p_item_id, p_style, p_value)` | the "do you still have this?" RPC — see below. |
| `resolve_food(name, food_id)` | helper: map a name/alias to a `foods` row. |

### `checkin_item` — correct inventory **and** learn

```ts
await supabase.rpc("checkin_item", { p_item_id: id, p_style: "percent", p_value: 0.5 }); // 50% left
await supabase.rpc("checkin_item", { p_item_id: id, p_style: "count",   p_value: 4 });   // 4 units left
await supabase.rpc("checkin_item", { p_item_id: id, p_style: "empty" });                  // none left
```

It re-baselines the item so its current quantity equals what the user reported, and folds
the implied consumption rate into `consumption_profiles`, writing the blended learned rate
back into `pantry_items.daily_burn_rate`. So the frontend's existing estimate
(`initial − burn×days − deducted`) automatically gets more accurate over time — no frontend
math changes needed, just call this RPC from the check-in UI.

**Verified:** milk reported at "60% left after 8 days" learns ~0.8 servings/day (vs the 1.0
default) and re-baselines to 9.6 servings. Learning needs ≥1 day elapsed since purchase.

## Autofill (recognizing foods)

`foods.aliases` maps shorthand/typos to canonical foods (`GV MLK 1GAL` / `whole milk` →
`milk`; `grlc` → `garlic`). Frontend flow: on item entry, query `foods`
(`select id,name,default_unit,aliases`), match the typed text against name/aliases, and use
the chosen row to prefill `key`, `quantity_label`, `expiry_date` (purchase + `shelf_life_days`),
`daily_burn_rate`, `item_type`. Unknown foods still work with the frontend's defaults.

## Scripts

- `node scripts/test-db.mjs` — end-to-end smoke test (uses `.env`; signs up throwaway users).
- `DATABASE_URL="postgres://..." node scripts/apply-migrations.mjs` — apply migrations via CLI.
