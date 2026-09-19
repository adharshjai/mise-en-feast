// End-to-end DB smoke test for the frontend's schema + the intelligence layer.
// Signs up a throwaway user and exercises exactly what the frontend does
// (pantry_items / app_state / receipts / cook_log) plus the checkin_item RPC and
// the consumption-learning loop. Reads creds from .env. Usage: node scripts/test-db.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
const pass = "Test123456!";
const email = `pantry_test_${Date.now()}@example.com`;
const ok = (label, error) => console.log(`${error ? "✗" : "✓"} ${label}${error ? " — " + error.message : ""}`);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const main = async () => {
  let { data, error } = await supabase.auth.signUp({ email, password: pass });
  if (error) throw error;
  if (!data.session) {
    ({ data, error } = await supabase.auth.signInWithPassword({ email, password: pass }));
    if (error) throw new Error("sign-in failed (email confirmation on?): " + error.message);
  }
  const uid = data.user.id;
  console.log("signed in as", data.user.email, "\n");

  // 1. foods reference data
  const foods = await supabase.from("foods").select("id", { count: "exact", head: true });
  ok(`foods seeded (${foods.count})`, foods.error);

  // 2. frontend writes a pantry item (backdated 8 days so learning has signal)
  const ins = await supabase.from("pantry_items").insert({
    user_id: uid, name: "Whole milk", key: "milk", raw_text: "GV MLK 1GAL", quantity_label: "1 gal",
    initial_servings: 16, deducted_servings: 0, daily_burn_rate: 1, item_type: "continuous",
    purchase_date: daysAgo(8), expiry_date: new Date(Date.now() + 2 * 86400000).toISOString(), status: "active",
  }).select().single();
  ok("insert pantry_items (as frontend does)", ins.error);
  const itemId = ins.data?.id;

  // model estimate before check-in: 16 - 1/day*8 - 0 = ~8 servings
  console.log(`  model estimate before check-in: ~${16 - 1 * 8} servings`);

  // 3. check-in: user reports 60% left after 8 days (slow consumer)
  const ci = await supabase.rpc("checkin_item", { p_item_id: itemId, p_style: "percent", p_value: 0.6 });
  ok("checkin_item (milk 60%)", ci.error);

  const after = (await supabase.from("pantry_items").select("*").eq("id", itemId)).data?.[0];
  console.log(`  after check-in: initial=${after?.initial_servings}, burn=${after?.daily_burn_rate}/day (was 1.0), deducted=${after?.deducted_servings}`);

  const prof = await supabase.from("consumption_profiles").select("scope,key,learned_daily_rate,observation_count,confidence");
  ok("consumption_profiles written (learning)", prof.error);
  console.table(prof.data ?? []);

  // 4. count-style check-in on a discrete item
  const eggs = await supabase.from("pantry_items").insert({
    user_id: uid, name: "Large eggs", key: "eggs", initial_servings: 12, daily_burn_rate: 0.5,
    item_type: "continuous", purchase_date: daysAgo(4), status: "active",
  }).select().single();
  const ce = await supabase.rpc("checkin_item", { p_item_id: eggs.data.id, p_style: "count", p_value: 5 });
  const eggsAfter = (await supabase.from("pantry_items").select("*").eq("id", eggs.data.id)).data?.[0];
  ok(`checkin_item (eggs count=5 -> initial=${eggsAfter?.initial_servings})`, ce.error);

  // 5. empty check-in flips status to 'gone'
  const cg = await supabase.rpc("checkin_item", { p_item_id: eggs.data.id, p_style: "empty" });
  const eggsGone = (await supabase.from("pantry_items").select("status").eq("id", eggs.data.id)).data?.[0];
  ok(`checkin_item empty -> status=${eggsGone?.status}`, cg.error);

  // 6. app_state, cook_log, receipts (frontend writes)
  const as = await supabase.from("app_state").upsert({ user_id: uid, skipped: ["x"], cooked: [], chosen: [] }, { onConflict: "user_id" });
  ok("app_state upsert", as.error);
  const cl = await supabase.from("cook_log").insert({ user_id: uid, recipe_id: "pasta", title: "Pasta", items_deducted: [] });
  ok("cook_log insert", cl.error);
  const rc = await supabase.from("receipts").insert({ user_id: uid, store_name: "Test Mart", total: 20, item_count: 2 });
  ok("receipts insert", rc.error);

  // 7. RLS: a second user sees nothing
  const other = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
  const oe = `pantry_other_${Date.now()}@example.com`;
  const su = await other.auth.signUp({ email: oe, password: pass });
  if (!su.data.session) await other.auth.signInWithPassword({ email: oe, password: pass });
  const leaked = await other.from("pantry_items").select("*");
  ok(`RLS isolates users (other sees ${leaked.data?.length ?? 0} rows)`, (leaked.data?.length ?? 0) === 0 ? null : new Error("LEAK"));

  // cleanup
  await supabase.from("pantry_items").delete().not("id", "is", null);
  await supabase.from("receipts").delete().not("id", "is", null);
  await supabase.from("cook_log").delete().not("id", "is", null);
  console.log("\nDone.");
};

main().catch((e) => { console.error("\nTEST ERROR:", e.message); process.exit(1); });
