/* mise en feast — FastAPI client (receipt scan, recipes, chat, weekly plan, dish photo → recipe,
   generated dish images). Base URL comes from window.PANTRY_CONFIG.apiBaseUrl (see shared/config.js). */

const cfg = () => (typeof window !== 'undefined' && window.PANTRY_CONFIG) || {};

export const apiConfigured = () => {
  const base = cfg().apiBaseUrl;
  return typeof base === 'string' && base.trim().length > 0;
};

const LOCAL_API = 'http://localhost:8000';   // uvicorn, when the page itself comes from a plain static server

function baseUrl() {
  const base = (cfg().apiBaseUrl || '').trim().replace(/\/$/, '');
  // '/api' means "same origin" (the Vercel Python function). A python http.server on
  // localhost has no /api, so fall back to the local backend there. (`location` is
  // guarded because the Node test harness imports this module with no page.)
  const host = typeof location !== 'undefined' ? location.hostname : '';
  if (base.startsWith('/') && /^(localhost|127\.0\.0\.1)$/.test(host)) return LOCAL_API;
  return base;
}

async function readError(res) {
  try {
    const data = await res.json();
    if (data && data.detail) return typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
  } catch { /* ignore */ }
  return res.statusText || `HTTP ${res.status}`;
}

/** Tag an Error so callers can branch on `err.code` instead of parsing messages. */
function withCode(err, code, extra = {}) {
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/** POST /scan — FormData with a receipt image or PDF. */
export async function scanReceipt(file) {
  if (!apiConfigured()) throw new Error('API base URL is not set in shared/config.js');
  const body = new FormData();
  body.append('file', file, file.name || 'receipt.jpg');
  const res = await fetch(`${baseUrl()}/scan`, { method: 'POST', body });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/**
 * POST /recipes — body: { items, count?, max_missing?, request?, prefs? }.
 * `items` should match the backend PantryItem shape; `opts.prefs` is the v2
 * preferences object from shared/store.js (allergies and diet are hard rules
 * server-side, the rest are soft), `opts.request` its plain-English summary.
 */
export async function fetchRecipes(items, opts = {}) {
  if (!apiConfigured()) throw new Error('API base URL is not set in shared/config.js');
  const res = await fetch(`${baseUrl()}/recipes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items,
      count: opts.count ?? 6,
      max_missing: opts.maxMissing ?? 2,
      request: opts.request ?? null,
      prefs: opts.prefs ?? null,
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/**
 * POST /meal-plan — a week of breakfast / lunch / dinner cooked from the pantry.
 * body: { items, prefs, days, start?, request }.
 *   items    the aggregated PantryItem array (same as fetchRecipes)
 *   prefs    the v2 preferences object (or null)
 *   days     1..14 (default 7; clamped here so a bad value cannot 422)
 *   start    'YYYY-MM-DD' first day; omitted when null so the server picks today
 *   request  plain-English wishes for the week (or null)
 * Resolves to { start, days: [{ date, meals: { breakfast, lunch, dinner } }] } where each
 * meal is a step-less recipe (the chat suggestion shape: title, cook_minutes, servings,
 * difficulty, ingredients[{ name, amount, matched_name, servings_used, staple, have }],
 * missing_count, coverage, urgency_days, uses_expiring, description?, steps: []) or null.
 * Fetch steps with recipeDetail() when a meal is opened.
 */
export async function fetchMealPlan(items, { prefs = null, days = 7, start = null, request = null } = {}) {
  if (!apiConfigured()) throw new Error('API base URL is not set in shared/config.js');
  const body = { items, prefs, days: Math.min(14, Math.max(1, Math.round(Number(days)) || 7)), request };
  if (start) body.start = start;
  const res = await fetch(`${baseUrl()}/meal-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/**
 * POST /chat — the in-app assistant (Claude via Bedrock, with controlled pantry tools).
 * body: { messages, pantry, prefs, recent_meals, shopping }.
 *   messages    [{ role: 'user'|'assistant', content }]  the turn history
 *   pantry      the aggregated PantryItem array (same as fetchRecipes)
 *   prefs       the v2 preferences object
 *   recentMeals [{ title, cooked_at? }]  newest first (optional)
 *   shopping    [{ name, quantity: number|null, unit, done }]  the shopping list (optional)
 * Resolves to { reply, actions, recipes }. Each action is one the client applies:
 *   { type: 'update_preference',     field, value }
 *   { type: 'mark_food_gone',        id, name, key }
 *   { type: 'record_checkin',        id, name, key, percent }
 *   { type: 'add_pantry_items',      items: [{ name, quantity: number|null, unit, expires_in_days: number|null }] }
 *   { type: 'add_shopping_items',    items: [{ name, quantity: number|null, unit, note }] }
 *   { type: 'remove_shopping_items', names: string[] }   (only names that matched a `shopping` row)
 * Units in actions are already canonical ('g', 'kg', 'ml', 'l', 'pcs', 'pack' or '').
 * `recipes` are step-less suggestion cards; fetch steps with recipeDetail() when opened.
 */
export async function chat(messages, { pantry = [], prefs = null, recentMeals = [], shopping = [] } = {}) {
  if (!apiConfigured()) throw new Error('API base URL is not set in shared/config.js');
  const res = await fetch(`${baseUrl()}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, pantry, prefs, recent_meals: recentMeals, shopping }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/**
 * POST /recipe-detail — write the cooking steps for one dish on demand.
 * The chatbot returns step-less recipe cards fast; call this when the user opens one.
 * body: { title, servings, ingredients: string[], request? }.  Resolves to { steps: string[] }.
 */
export async function recipeDetail({ title, servings = 2, ingredients = [], request = null } = {}) {
  if (!apiConfigured()) throw new Error('API base URL is not set in shared/config.js');
  const res = await fetch(`${baseUrl()}/recipe-detail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, servings, ingredients, request }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/**
 * GET /dish-image — the URL of a generated photo for a dish (image/jpeg, cached for a
 * year by the server). This only builds the URL; shared/dish-images.js fetches and
 * caches the bytes. `ingredients` is capped to the first 8 names so the query stays
 * within the backend's 400-char limit. Returns '' when the API is not configured.
 */
export function dishImageUrl({ title, ingredients = [], seed = 0 } = {}) {
  if (!apiConfigured()) return '';
  const names = (Array.isArray(ingredients) ? ingredients : []).slice(0, 8).map(n => String(n ?? '').trim()).filter(Boolean);
  return `${baseUrl()}/dish-image?title=${encodeURIComponent(String(title ?? ''))}`
    + `&ingredients=${encodeURIComponent(names.join(','))}`
    + `&seed=${encodeURIComponent(String(Number(seed) || 0))}`;
}

/**
 * POST /identify — FormData with a photo of a dish (jpeg/png/webp/heic).
 * Resolves to the backend's identified-dish shape:
 *   { title, confidence (0..1), description, cuisine, cook_minutes, servings,
 *     difficulty ('easy'|'medium'|'hard'), ingredients: [{ name, amount, staple }],
 *     steps: string[], tags: { vegetarian, vegan, contains: allergenKey[] } }
 * Rejects with an Error carrying a `code` so the app can decide what to show:
 *   'unconfigured'     apiBaseUrl is empty (demo build) — use the sample
 *   'unreachable'      the request never got an HTTP answer (offline, CORS, DNS) — use the sample
 *   'not_implemented'  the endpoint answered 501 (an older backend) — use the sample
 *   'http'             any other non-2xx (400 bad file, 502 model failure); `status` is set
 * Passing the original file is fine; the backend downscales what it sends to the model.
 */
export async function identifyDish(file) {
  if (!apiConfigured()) throw withCode(new Error('API base URL is not set in shared/config.js'), 'unconfigured');
  const body = new FormData();
  body.append('file', file, (file && file.name) || 'dish.jpg');
  let res;
  try {
    res = await fetch(`${baseUrl()}/identify`, { method: 'POST', body });
  } catch (err) {
    throw withCode(new Error('Could not reach the recipe backend', { cause: err }), 'unreachable');
  }
  if (res.status === 501) throw withCode(new Error(await readError(res)), 'not_implemented', { status: 501 });
  if (!res.ok) throw withCode(new Error(await readError(res)), 'http', { status: res.status });
  return res.json();
}

/** GET /health — returns null when the API is unreachable. */
export async function healthCheck() {
  if (!apiConfigured()) return null;
  try {
    const res = await fetch(`${baseUrl()}/health`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
