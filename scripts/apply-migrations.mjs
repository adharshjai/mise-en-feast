// Apply all SQL migrations in supabase/migrations (filename order) to $DATABASE_URL.
// Usage: DATABASE_URL="postgresql://..." node scripts/apply-migrations.mjs
// (Requires `npm i -D pg`. Alternatively paste supabase/schema.sql into the SQL Editor.)
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "supabase", "migrations");
const url = process.env.DATABASE_URL;
if (!url) { console.error("Set DATABASE_URL to your Supabase connection string."); process.exit(1); }

const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const run = async () => {
  await client.connect();
  for (const file of files) {
    process.stdout.write(`Applying ${file} ... `);
    await client.query(readFileSync(join(dir, file), "utf8"));
    console.log("ok");
  }
  await client.end();
  console.log("\nAll migrations applied.");
};
run().catch(async (err) => { console.error("\nFAILED:", err.message); try { await client.end(); } catch {} process.exit(1); });
