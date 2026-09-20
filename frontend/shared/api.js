/* Pantry — FastAPI client (receipt scan, recipes, dish photo → recipe).
   Base URL comes from window.PANTRY_CONFIG.apiBaseUrl (see shared/config.js). */

const cfg = () => (typeof window !== 'undefined' && window.PANTRY_CONFIG) || {};

export const apiConfigured = () => {
  const base = cfg().apiBaseUrl;
  return typeof base === 'string' && base.trim().length > 0;
};

const LOCAL_API = 'http://localhost:8000';   // uvicorn, when the page itself comes from a plain static server

function baseUrl() {
  const base = (cfg().apiBaseUrl || '').trim().replace(/\/$/, '');
  // '/api' means "same origin" (the Vercel Python function). A python http.server on
  // localhost has no /api, so fall back to the local backend there.
  if (base.startsWith('/') && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return LOCAL_API;
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
