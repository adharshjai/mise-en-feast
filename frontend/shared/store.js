/* Pantry — storage layer (ES module).
   One API, two backends: Supabase when the project is configured and the user is
   signed in, localStorage otherwise. Nothing in here throws; failures are logged
   with console.warn and the function resolves to null / does nothing.

   Item shape used by the app (ms epochs, plain numbers):
     { id, name, key, qty, raw, initial, purchase, expiry, burn, deducted }

   State shape:
     { pantry: Item[], skipped: string[], cooked: string[], chosen: string[] }

   Cooking preferences (see loadPrefs / savePrefs) live in the auth user's metadata
   when signed in, so they need no table, and in localStorage otherwise. Version 2:
     { version: 2, onboarded, household: { adults, kids }, allergies[], diet[],
       cuisines[], maxMinutes, skill, equipment[], avoid, shopping }
   The allowed values are the exported lists below; normalizePrefs() migrates the
   old v1 shape { diet[], household: number, maxMinutes, avoid }. */

import { configured, getClient, getSession, getUser } from './supabase.js';

export const LOCAL_KEY = 'pantry.state.v1';
export const PREFS_KEY = 'pantry.prefs.v1';
const DEBOUNCE_MS = 400;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------- helpers ---------- */

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // RFC 4122 v4 fallback for very old browsers
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const num = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const str = v => (v == null ? '' : String(v));
const toIso = ms => new Date(num(ms, Date.now())).toISOString();
const fromIso = (iso, fallback) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : fallback; };
const list = v => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v[Symbol.iterator] === 'function') return Array.from(v, String);   // a Set from the app
  return [];
};

/** Normalise whatever the app or storage hands us into the Item shape. */
function normalizeItem(it) {
  if (!it || typeof it !== 'object') return null;
  const purchase = num(it.purchase, Date.now());
  return {
    id: UUID_RE.test(str(it.id)) ? str(it.id).toLowerCase() : newId(),
    name: str(it.name),
    key: str(it.key || it.name).toLowerCase(),
    qty: str(it.qty),
    raw: str(it.raw),
    variant: str(it.variant || ''),
    initial: num(it.initial, 1),
    purchase,
    expiry: num(it.expiry, purchase + 7 * 86400000),
    burn: num(it.burn, 0),
    deducted: num(it.deducted, 0),
  };
}

function normalizeState(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    pantry: Array.isArray(s.pantry) ? s.pantry.map(normalizeItem).filter(Boolean) : [],
    skipped: list(s.skipped),
    cooked: list(s.cooked),
    chosen: list(s.chosen),
  };
}

/* ---------- Supabase row mapping ---------- */

function toRow(it, userId) {
  return {
    id: it.id,
    user_id: userId,
    name: it.name,
    key: it.key,
    raw_text: it.raw,
    quantity_label: it.qty,
    initial_servings: it.initial,
    deducted_servings: it.deducted,
    purchase_date: toIso(it.purchase),
    expiry_date: toIso(it.expiry),
    daily_burn_rate: it.burn,
    item_type: it.burn > 0 ? 'continuous' : 'event',
    status: 'active',
  };
}

function fromRow(r) {
  const purchase = fromIso(r.purchase_date, Date.now());
  return {
    id: str(r.id),
    name: str(r.name),
    key: str(r.key),
    qty: str(r.quantity_label),
    raw: str(r.raw_text),
    initial: num(r.initial_servings, 1),
    purchase,
    expiry: fromIso(r.expiry_date, purchase + 7 * 86400000),
    burn: num(r.daily_burn_rate, 0),
    deducted: num(r.deducted_servings, 0),
  };
}

/* ---------- localStorage ---------- */

function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    return normalizeState(JSON.parse(raw));
  } catch (err) {
    console.warn('[pantry] could not read local state', err);
    return null;
  }
}

function writeLocal(state) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[pantry] could not write local state', err);
  }
}

/** Remove the local copy (e.g. after signing out or migrating to an account). */
export function clearLocal() {
  try { localStorage.removeItem(LOCAL_KEY); } catch (err) { console.warn('[pantry] could not clear local state', err); }
}

/* ---------- who are we saving as? ---------- */

async function signedInUser() {
  if (!configured) return null;
  const session = await getSession();
  return session && session.user ? session.user : null;
}

/* ---------- load ---------- */

// Ids we know exist server-side for the current user; lets saveState delete
// rows that were removed locally without ever wiping rows it has not seen.
let knownIds = new Set();

/** Resolve to the saved state or null when nothing has been saved yet. */
export async function loadState() {
  try {
    const user = await signedInUser();
    if (!user) return readLocal();

    const client = await getClient();
    const [items, meta] = await Promise.all([
      client.from('pantry_items').select('*').eq('user_id', user.id).neq('status', 'gone').order('created_at', { ascending: true }),
      client.from('app_state').select('skipped, cooked, chosen').eq('user_id', user.id).maybeSingle(),
    ]);
    if (items.error) throw items.error;
    if (meta.error) throw meta.error;

    const rows = items.data || [];
    knownIds = new Set(rows.map(r => str(r.id)));
    if (rows.length === 0 && !meta.data) return null;   // brand-new account: nothing saved yet

    return normalizeState({
      pantry: rows.map(fromRow),
      skipped: meta.data ? meta.data.skipped : [],
      cooked: meta.data ? meta.data.cooked : [],
      chosen: meta.data ? meta.data.chosen : [],
    });
  } catch (err) {
    console.warn('[pantry] loadState failed', err);
    return null;
  }
}

/* ---------- save (debounced) ---------- */

let pending = null;      // latest state reference handed to saveState
let timer = null;
let inflight = Promise.resolve();

async function persist(state) {
  const user = await signedInUser();
  if (!user) { writeLocal(state); return; }

  const client = await getClient();
  const rows = state.pantry.map(it => toRow(it, user.id));
  const currentIds = new Set(rows.map(r => r.id));

  if (rows.length) {
    const { error } = await client.from('pantry_items').upsert(rows, { onConflict: 'id' });
    if (error) throw error;
  }
  const gone = [...knownIds].filter(id => !currentIds.has(id));
  if (gone.length) {
    const { error } = await client.from('pantry_items').delete().eq('user_id', user.id).in('id', gone);
    if (error) throw error;
  }
  knownIds = currentIds;

  const { error } = await client.from('app_state').upsert({
    user_id: user.id,
    skipped: state.skipped,
    cooked: state.cooked,
    chosen: state.chosen,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  const state = pending;
  pending = null;
  if (!state) return;
  // Serialise saves so a slow request can't be overtaken by a later one.
  inflight = inflight
    .then(() => persist(state))
    .catch(err => console.warn('[pantry] saveState failed', err));
}

/** Queue a save of the given state (~400ms debounce; latest call wins). Never throws. */
export function saveState(state) {
  try {
    const snapshot = normalizeState(state);
    if (!snapshot) return;
    // Keep the app's ids in sync with what we store, so a later save matches by id.
    if (Array.isArray(state.pantry)) {
      state.pantry.forEach((it, i) => { if (it && typeof it === 'object' && snapshot.pantry[i] && it.id !== snapshot.pantry[i].id) it.id = snapshot.pantry[i].id; });
    }
    pending = snapshot;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  } catch (err) {
    console.warn('[pantry] saveState failed', err);
  }
}

// Don't lose the last edit when the tab closes mid-debounce.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    try { flush(); } catch (err) { console.warn('[pantry] flush on pagehide failed', err); }
    try { flushPrefs(); } catch (err) { console.warn('[pantry] prefs flush on pagehide failed', err); }
  });
}

/* ---------- cooking preferences ----------
   Signed in: kept in the auth user's metadata (user_metadata.pantry_prefs), which
   needs no schema change and travels with the account. Always mirrored to
   localStorage so demo mode and an offline reload see the same answers. */

/* Allowed values. Each entry is { id, label }: ids are what gets stored and sent
   to the backend, labels are what the UI shows. */
const options = xs => Object.freeze(xs.map(([id, label]) => Object.freeze({ id, label })));

export const ALLERGENS = options([
  ['peanuts', 'Peanuts'], ['tree-nuts', 'Tree nuts'], ['dairy', 'Dairy'], ['eggs', 'Eggs'],
  ['gluten', 'Gluten'], ['shellfish', 'Shellfish'], ['fish', 'Fish'], ['soy', 'Soy'], ['sesame', 'Sesame'],
]);
export const DIETS = options([
  ['vegetarian', 'Vegetarian'], ['vegan', 'Vegan'], ['pescatarian', 'Pescatarian'], ['halal', 'Halal'], ['kosher', 'Kosher'],
]);
export const CUISINES = options([
  ['italian', 'Italian'], ['mexican', 'Mexican'], ['indian', 'Indian'], ['chinese', 'Chinese'],
  ['japanese', 'Japanese'], ['thai', 'Thai'], ['mediterranean', 'Mediterranean'], ['american', 'American'],
  ['middle-eastern', 'Middle Eastern'], ['korean', 'Korean'], ['french', 'French'], ['latin', 'Latin American'],
]);
export const EQUIPMENT = options([
  ['oven', 'Oven'], ['stovetop', 'Stovetop'], ['microwave', 'Microwave'], ['air-fryer', 'Air fryer'],
  ['blender', 'Blender'], ['slow-cooker', 'Slow cooker'], ['grill', 'Grill'],
]);
export const SKILLS = options([
  ['beginner', 'Beginner'], ['comfortable', 'Comfortable'], ['confident', 'Confident'],
]);
export const SHOPPING = options([
  ['weekly', 'Once a week'], ['twice-weekly', 'Twice a week'], ['whenever', 'Whenever it runs out'],
]);
/** Allowed maxMinutes values; 0 means "any". */
export const TIME_LIMITS = Object.freeze([0, 20, 30, 45, 60]);
export const HOUSEHOLD_LIMITS = Object.freeze({
  adults: Object.freeze({ min: 1, max: 8 }),
  kids: Object.freeze({ min: 0, max: 6 }),
});

export const DEFAULT_PREFS = Object.freeze({
  version: 2,
  onboarded: false,
  household: Object.freeze({ adults: 2, kids: 0 }),
  allergies: Object.freeze([]),
  diet: Object.freeze([]),
  cuisines: Object.freeze([]),
  maxMinutes: 0,
  skill: 'comfortable',
  equipment: Object.freeze(['oven', 'stovetop', 'microwave']),
  avoid: '',
  shopping: 'weekly',
});

// v1 kept these under "diet"; in v2 they are allergies.
const LEGACY_DIET_TO_ALLERGY = { 'gluten-free': 'gluten', 'dairy-free': 'dairy' };

const lc = s => str(s).trim().toLowerCase();
const hasId = (opts, id) => opts.some(o => o.id === id);
const labelOf = (opts, id) => { const o = opts.find(x => x.id === id); return o ? o.label : id; };
const clampInt = (v, min, max, fallback) => Math.min(max, Math.max(min, Math.round(num(v, fallback))));
/** Ids from `v` that exist in `opts`, deduplicated and in the list's own order. */
const pick = (v, opts) => { const want = new Set(list(v).map(lc)); return opts.map(o => o.id).filter(id => want.has(id)); };
const one = (v, opts, fallback) => { const id = lc(v); return hasId(opts, id) ? id : fallback; };
/** Snap any number of minutes onto TIME_LIMITS (nearest; ties go shorter). */
function snapMinutes(v) {
  const n = Math.max(0, num(v, 0));
  if (n === 0) return 0;
  return TIME_LIMITS.slice(1).reduce((best, t) => (Math.abs(t - n) < Math.abs(best - n) ? t : best), TIME_LIMITS[TIME_LIMITS.length - 1]);
}

/** Coerce anything into a complete v2 prefs object (always a fresh copy).
    Every field is checked against the allowed lists and numbers are clamped;
    unknown values fall back to DEFAULT_PREFS. A v1 object ({ household: number })
    is migrated: the number becomes household.adults and, since v1 never asked
    about allergies or cuisines, `onboarded` comes back false. */
export function normalizePrefs(p) {
  const src = p && typeof p === 'object' ? p : {};
  const d = DEFAULT_PREFS;
  const legacy = typeof src.household === 'number' ||
    (src.version == null && (src.household == null || typeof src.household !== 'object') && src.allergies === undefined && src.onboarded === undefined);

  const hh = src.household && typeof src.household === 'object' ? src.household : {};
  const adults = clampInt(legacy ? src.household : hh.adults, HOUSEHOLD_LIMITS.adults.min, HOUSEHOLD_LIMITS.adults.max, d.household.adults);
  const kids = clampInt(hh.kids, HOUSEHOLD_LIMITS.kids.min, HOUSEHOLD_LIMITS.kids.max, d.household.kids);

  const rawDiet = list(src.diet).map(lc);
  const allergies = pick([...list(src.allergies), ...rawDiet.map(x => LEGACY_DIET_TO_ALLERGY[x]).filter(Boolean)], ALLERGENS);
  const avoid = str(src.avoid).split(',').map(s => s.trim()).filter(Boolean).join(', ').slice(0, 200);

  return {
    version: 2,
    onboarded: legacy ? false : Boolean(src.onboarded),
    household: { adults, kids },
    allergies,
    diet: pick(rawDiet, DIETS),
    cuisines: pick(src.cuisines, CUISINES),
    maxMinutes: snapMinutes(src.maxMinutes),
    skill: one(src.skill, SKILLS, d.skill),
    equipment: src.equipment == null ? [...d.equipment] : pick(src.equipment, EQUIPMENT),
    avoid,
    shopping: one(src.shopping, SHOPPING, d.shopping),
  };
}

/** How many servings a recipe should make for this household (kids count half). */
export function servingsTarget(prefs) {
  const { adults, kids } = normalizePrefs(prefs).household;
  return Math.max(1, Math.ceil(adults + 0.5 * kids));
}

/** Multiplier for the pantry's daily burn rates, which were estimated for a
    two-person household. Apply at read time, never to the stored rates. */
export function householdScale(prefs) {
  const { adults, kids } = normalizePrefs(prefs).household;
  return Math.min(3, Math.max(0.5, (adults + 0.5 * kids) / 2));
}

function readLocalPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? normalizePrefs(JSON.parse(raw)) : null;
  } catch (err) {
    console.warn('[pantry] could not read local prefs', err);
    return null;
  }
}

function writeLocalPrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (err) { console.warn('[pantry] could not write local prefs', err); }
}

/** Drop the browser's copy of the preferences (on sign-out, so the next account on this
    machine does not inherit someone else's allergies). */
export function clearLocalPrefs() {
  try { localStorage.removeItem(PREFS_KEY); } catch (err) { console.warn('[pantry] could not clear local prefs', err); }
}

/** Resolve to the saved preferences: the account's when signed in, else this
    browser's, else the defaults. Never rejects. */
export async function loadPrefs() {
  try {
    if (configured) {
      const user = await getUser();
      if (user) {
        const remote = user.user_metadata && user.user_metadata.pantry_prefs;
        if (remote && typeof remote === 'object') return normalizePrefs(remote);
        // An account with nothing saved yet: start from whatever this browser chose in
        // demo mode, but ask once per account so the answers land in the account.
        return normalizePrefs({ ...(readLocalPrefs() || DEFAULT_PREFS), onboarded: false });
      }
    }
    return readLocalPrefs() || normalizePrefs(DEFAULT_PREFS);
  } catch (err) {
    console.warn('[pantry] loadPrefs failed', err);
    return readLocalPrefs() || normalizePrefs(DEFAULT_PREFS);
  }
}

let prefsPending = null;
let prefsTimer = null;
let prefsInflight = Promise.resolve();

async function persistPrefs(prefs) {
  const user = await signedInUser();
  if (!user) return;
  const client = await getClient();
  const { error } = await client.auth.updateUser({ data: { pantry_prefs: prefs } });
  if (error) throw error;
}

function flushPrefs() {
  if (prefsTimer) { clearTimeout(prefsTimer); prefsTimer = null; }
  const prefs = prefsPending;
  prefsPending = null;
  if (!prefs) return;
  prefsInflight = prefsInflight
    .then(() => persistPrefs(prefs))
    .catch(err => console.warn('[pantry] savePrefs failed', err));
}

/** Queue a save of the preferences (~400ms debounce; latest call wins). The local
    copy is written straight away. Never throws. */
export function savePrefs(prefs) {
  try {
    const snapshot = normalizePrefs(prefs);
    writeLocalPrefs(snapshot);
    prefsPending = snapshot;
    if (prefsTimer) clearTimeout(prefsTimer);
    prefsTimer = setTimeout(flushPrefs, DEBOUNCE_MS);
  } catch (err) {
    console.warn('[pantry] savePrefs failed', err);
  }
}

const joinAnd = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

/** One short plain-English line for the recipe model, e.g.
    "allergic to peanuts and dairy; vegetarian; likes Italian and Thai food;
    cooking for 2 adults and 1 kid (3 servings); under 30 minutes; avoid cilantro".
    Empty when everything is still at its default. The structured prefs go to the
    backend as well; this is the human-readable fallback and the profile summary. */
export function prefsToRequest(prefs) {
  const p = normalizePrefs(prefs);
  const d = DEFAULT_PREFS;
  const parts = [];
  if (p.allergies.length) parts.push(`allergic to ${joinAnd(p.allergies.map(id => labelOf(ALLERGENS, id).toLowerCase()))}`);
  if (p.diet.length) parts.push(joinAnd(p.diet.map(id => labelOf(DIETS, id).toLowerCase())));
  if (p.cuisines.length) parts.push(`likes ${joinAnd(p.cuisines.map(id => labelOf(CUISINES, id)))} food`);
  const { adults, kids } = p.household;
  if (kids > 0) parts.push(`cooking for ${plural(adults, 'adult')} and ${plural(kids, 'kid')} (${servingsTarget(p)} servings)`);
  else if (adults !== d.household.adults) parts.push(`cooking for ${adults}`);
  if (p.maxMinutes > 0) parts.push(`under ${p.maxMinutes} minutes`);
  if (p.skill === 'beginner') parts.push('beginner cook, keep it simple');
  else if (p.skill === 'confident') parts.push('confident cook, happy with involved recipes');
  if (!sameSet(p.equipment, d.equipment)) {
    parts.push(p.equipment.length ? `equipment: ${joinAnd(p.equipment.map(id => labelOf(EQUIPMENT, id).toLowerCase()))} only` : 'no cooking equipment');
  }
  if (p.avoid) parts.push(`avoid ${p.avoid}`);
  return parts.join('; ');
}

/* ---------- allergen matching ----------
   Substring keywords, lower-case. Used to flag pantry items and recipe
   ingredients that clash with a saved allergy; the backend applies the same
   rule when it writes recipes, this is the client-side safety net. */

export const ALLERGEN_KEYWORDS = Object.freeze({
  'peanuts': Object.freeze(['peanut']),
  'tree-nuts': Object.freeze(['almond', 'walnut', 'cashew', 'pecan', 'pistachio', 'hazelnut', 'macadamia']),
  'dairy': Object.freeze(['milk', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt', 'parmesan', 'feta', 'mozzarella', 'ghee']),
  'eggs': Object.freeze(['egg']),
  'gluten': Object.freeze(['wheat', 'flour', 'pasta', 'spaghetti', 'noodle', 'bread', 'couscous', 'barley', 'bulgur', 'seitan', 'soy sauce']),
  'shellfish': Object.freeze(['shrimp', 'prawn', 'crab', 'lobster', 'clam', 'mussel', 'oyster', 'scallop']),
  'fish': Object.freeze(['fish', 'salmon', 'tuna', 'cod', 'anchov', 'sardine', 'trout', 'tilapia']),
  'soy': Object.freeze(['soy', 'tofu', 'edamame', 'tempeh', 'miso']),
  'sesame': Object.freeze(['sesame', 'tahini']),
});

// Phrases that contain a keyword but not the allergen. "peanut butter" keeps its
// peanut; only the dairy word goes. Applied before matching.
const FALSE_FRIENDS = [
  [/\b(coconut|almond|oat|soy|rice|cashew|peanut|hazelnut|macadamia|cocoa|shea|nut|plant)[ -]+(milk|cream|creamer|butter|yogurt|yoghurt|cheese)\b/g, '$1 '],
  [/\beggplant/g, 'aubergine'],
  [/\bbutternut/g, 'squash'],
  [/\bcream of tartar\b/g, 'tartar'],
];

/** Which of the given allergy keys appear in any of the ingredient / item names.
    Returns the matched keys in ALLERGENS order ([] when nothing clashes). */
export function ingredientHits(names, allergies) {
  const keys = pick(allergies, ALLERGENS);
  if (!keys.length) return [];
  const text = list(names).map(n => FALSE_FRIENDS.reduce((s, [re, to]) => s.replace(re, to), lc(n))).filter(Boolean);
  if (!text.length) return [];
  return keys.filter(key => ALLERGEN_KEYWORDS[key].some(kw => text.some(t => t.includes(kw))));
}

/* ---------- logs (signed-in only) ---------- */

/** Record a cooked dish. No-op in demo mode. */
export async function logCook({ recipeId, title, items } = {}) {
  try {
    const user = await signedInUser();
    if (!user) return;
    const client = await getClient();
    const { error } = await client.from('cook_log').insert({
      user_id: user.id,
      recipe_id: recipeId == null ? null : String(recipeId),
      title: str(title),
      cooked_at: new Date().toISOString(),
      items_deducted: Array.isArray(items) ? items : [],
    });
    if (error) throw error;
  } catch (err) {
    console.warn('[pantry] logCook failed', err);
  }
}

/** Record a scanned receipt. No-op in demo mode. */
export async function logReceipt({ store, total, scannedAt, itemCount } = {}) {
  try {
    const user = await signedInUser();
    if (!user) return;
    const client = await getClient();
    const { error } = await client.from('receipts').insert({
      user_id: user.id,
      store_name: store == null ? null : String(store),
      total: total == null || !Number.isFinite(Number(total)) ? null : Number(total),
      scanned_at: toIso(scannedAt == null ? Date.now() : scannedAt),
      item_count: itemCount == null ? null : Math.max(0, Math.round(num(itemCount, 0))),
    });
    if (error) throw error;
  } catch (err) {
    console.warn('[pantry] logReceipt failed', err);
  }
}
