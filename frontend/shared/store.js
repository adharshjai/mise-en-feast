/* Pantry — storage layer (ES module).
   One API, two backends: Supabase when the project is configured and the user is
   signed in, localStorage otherwise. Nothing in here throws; failures are logged
   with console.warn and the function resolves to null / does nothing.

   Item shape used by the app (ms epochs, plain numbers):
     { id, name, key, qty, raw, initial, purchase, expiry, burn, deducted }

   State shape:
     { pantry: Item[], skipped: string[], cooked: string[], chosen: string[] } */

import { configured, getClient, getSession } from './supabase.js';

export const LOCAL_KEY = 'pantry.state.v1';
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
  window.addEventListener('pagehide', () => { try { flush(); } catch (err) { console.warn('[pantry] flush on pagehide failed', err); } });
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
