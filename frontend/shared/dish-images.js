/* mise en feast — generated photos for the dishes the model writes.

   Built-in dishes ship with a photo under img/ and photo dishes carry the user's own
   picture as a data URL, but every AI, chat or weekly-plan recipe would otherwise show
   a stand-in. This module asks GET /dish-image (api.js → dishImageUrl) for one picture
   per dish and keeps the bytes so a dish is generated at most once per device:

     memory Map (slug → object URL) → IndexedDB (slug → { blob, at }) → network → fallback

   Everything is keyed by dishSlug(name), so the same dish coming back from another deck,
   the chat or the plan reuses the picture. getDishImage never rejects, nothing here
   touches indexedDB/document/URL at import time (Node tests import this file), and a
   browser without IndexedDB (private mode) silently degrades to memory-only. */

import { apiConfigured, dishImageUrl } from './api.js';

const DB_NAME = 'mise-en-feast-images';
const STORE = 'images';
const MAX_INFLIGHT = 3;   // generation takes seconds; more than this just queues at the server
const SLUG_MAX = 80;

/** Cache key for a dish name: lowercase, non-alphanumeric runs → '-', trimmed, ≤80 chars, 'dish' when empty. */
export const dishSlug = name => {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug || 'dish';
};

/** True for dishes the model wrote (ai-, chat-, plan- ids); built-ins keep img/*.jpg and photo dishes their data URL. */
export function needsGeneratedImage(dish) {
  const id = dish && dish.id != null ? String(dish.id) : '';
  return /^(ai|chat|plan)-/.test(id);
}

/* ---- IndexedDB store: slug → { blob, at } ----------------------------------------
   Every call rejects when IndexedDB is missing or refuses to open; callers catch and
   carry on with memory only. A rejected open is cached so we do not keep retrying. */

function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
    req.onblocked = () => reject(new Error('indexedDB open blocked'));
  });
}

function idbStore() {
  let dbPromise = null;
  const db = () => {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('indexedDB unavailable'));
    return dbPromise || (dbPromise = openDb());
  };
  const run = (mode, op) => db().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = op(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB request failed'));
    tx.onabort = () => reject(tx.error || new Error('indexedDB transaction aborted'));
  }));
  return {
    get: slug => run('readonly', s => s.get(slug)),
    put: (slug, value) => run('readwrite', s => s.put(value, slug)),
    clear: () => run('readwrite', s => s.clear()),
  };
}

/* ---- Injection points (tests swap these; production uses the real ones) ---------- */

let overrides = {};
let realStore = null;   // built on first use so importing never touches indexedDB

const currentStore = () => overrides.store || realStore || (realStore = idbStore());
const currentFetch = () => overrides.fetchImpl || (url => fetch(url));   // wrapped: an unbound window.fetch throws in some browsers
const currentCreateObjectURL = () => overrides.createObjectURL
  || ((typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') ? blob => URL.createObjectURL(blob) : null);

/**
 * Test hook: inject { store, fetchImpl, createObjectURL } (each optional; an omitted one
 * falls back to the real implementation). Also resets the session caches and the
 * concurrency gate so every test starts clean.
 *   store           { get(slug) → value|undefined, put(slug, value), clear() } (sync or promise)
 *   fetchImpl       (url) → Response-like { ok, status, blob() }
 *   createObjectURL (blob) → string
 */
export function _configure({ store, fetchImpl, createObjectURL } = {}) {
  overrides = { store, fetchImpl, createObjectURL };
  resetSession();
  active = 0;
  waiting.length = 0;
}

/* ---- Session state ---------------------------------------------------------------- */

const memory = new Map();     // slug → URL ready for <img src>
const inflight = new Map();   // slug → Promise<string|null>, so a dish on two cards fetches once
const failed = new Set();     // slugs that errored this session: shown as fallback, never retried in a loop
let generation = 0;           // bumped on clear so a result from before the clear does not refill the cache

function resetSession() {
  memory.clear();
  inflight.clear();
  failed.clear();
  generation++;
}

// At most MAX_INFLIGHT network fetches at once; the rest wait their turn in order.
let active = 0;
const waiting = [];
function acquire() {
  if (active < MAX_INFLIGHT) { active++; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();                       // the slot passes straight to the next waiter
  else active = Math.max(0, active - 1);
}

async function storeGet(slug) {
  try { return await currentStore().get(slug); } catch { return undefined; }
}
async function storePut(slug, value) {
  try { await currentStore().put(slug, value); } catch { /* private mode / quota: memory-only for this one */ }
}

function toUrl(blob) {
  const make = currentCreateObjectURL();
  if (!make || !blob) return null;
  try { return make(blob) || null; } catch { return null; }
}

function ingredientNames(dish) {
  const list = Array.isArray(dish.names) && dish.names.length
    ? dish.names
    : (Array.isArray(dish.ingredients) ? dish.ingredients.map(i => i && i.name) : []);
  return list.map(n => String(n || '').trim()).filter(Boolean);
}

/** The slow path: IndexedDB, then the network. Resolves to a URL or null; never rejects. */
async function resolveImage(slug, dish) {
  const gen = generation;
  const cached = await storeGet(slug);
  if (cached && cached.blob) {
    const url = toUrl(cached.blob);
    if (url) {
      if (gen === generation) memory.set(slug, url);
      return url;
    }
  }
  if (!apiConfigured()) return null;   // demo build: keep the stand-in, nothing to remember
  const href = dishImageUrl({ title: dish.name, ingredients: ingredientNames(dish) });
  if (!href) return null;
  await acquire();
  try {
    const res = await currentFetch()(href);
    if (!res || !res.ok) throw new Error(`dish-image ${res ? res.status : 'no response'}`);
    const blob = await res.blob();
    if (!blob || blob.size === 0) throw new Error('dish-image returned no bytes');
    // No object URLs (very old browser): point the <img> at the endpoint itself, which is
    // cached for a year by the server, rather than showing nothing.
    const url = toUrl(blob) || href;
    if (gen === generation) {
      memory.set(slug, url);
      await storePut(slug, { blob, at: Date.now() });
    }
    return url;
  } catch {
    failed.add(slug);
    return null;
  } finally {
    release();
  }
}

/**
 * Resolve a dish to an image URL: memory → IndexedDB → network → `fallback`.
 * Always resolves to a string, never rejects. Concurrent calls for the same dish share
 * one lookup; a dish that failed this session comes straight back as `fallback`.
 */
export async function getDishImage(dish, fallback = '') {
  try {
    if (!dish || !dish.name) return fallback;
    const slug = dishSlug(dish.name);
    const hit = memory.get(slug);
    if (hit) return hit;
    if (failed.has(slug)) return fallback;
    let pending = inflight.get(slug);
    if (!pending) {
      pending = resolveImage(slug, dish);
      inflight.set(slug, pending);
      const done = () => { if (inflight.get(slug) === pending) inflight.delete(slug); };
      pending.then(done, done);
    }
    return (await pending) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Upgrade every `img[data-dish-img]` under `root` that is not yet `data-dish-img-done`.
 * Attributes read: data-dish-name (required), data-dish-ings (comma list), data-dish-id;
 * the element's current src is the fallback. The src is only replaced while the element
 * is still connected and its data-dish-img value is unchanged, so a re-rendered card
 * cannot receive another dish's picture. Idempotent: safe to call after every render.
 */
export function applyDishImages(root = typeof document === 'undefined' ? null : document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const imgs = root.querySelectorAll('img[data-dish-img]:not([data-dish-img-done])');
  for (const img of imgs) {
    img.setAttribute('data-dish-img-done', 'pending');
    const slug = img.getAttribute('data-dish-img');
    const dish = {
      id: img.getAttribute('data-dish-id') || '',
      name: img.getAttribute('data-dish-name') || '',
      names: String(img.getAttribute('data-dish-ings') || '').split(',').map(s => s.trim()).filter(Boolean),
      ingredients: [],
    };
    // A card may render with no src at all (nothing wrong is ever shown); the stand-in it
    // would have used travels in data-dish-fallback and is only painted when nothing better comes.
    const fallback = img.getAttribute('data-dish-fallback') || img.src || img.getAttribute('src') || '';
    getDishImage(dish, fallback).then(url => {
      if (img.isConnected === false || img.getAttribute('data-dish-img') !== slug) return;
      const upgraded = Boolean(url) && url !== fallback;
      if (upgraded) img.src = url;
      else if (!img.getAttribute('src') && fallback) img.src = fallback;
      img.setAttribute('data-dish-img-done', upgraded ? 'done' : 'fallback');
    });
  }
}

/** The picture already in memory for a dish, synchronously, or '' — what a card paints
    with on its first render so a cached picture is never preceded by a stand-in. */
export function peekDishImage(dish) {
  if (!dish || !dish.name) return '';
  return memory.get(dishSlug(dish.name)) || '';
}

/**
 * Load pictures into memory ahead of a render. `network: false` reads IndexedDB only (the
 * cached deck at boot: fast, so the first paint is already right); `network: true` also
 * fetches (a fresh deck holds its top cards up to `timeoutMs` so they appear correct rather
 * than corrected). Resolves to how many of `dishes` are ready. Never rejects.
 */
export async function warmDishImages(dishes, { network = false, timeoutMs = 400 } = {}) {
  const list = (Array.isArray(dishes) ? dishes : []).filter(d => d && d.name && needsGeneratedImage(d));
  if (!list.length) return 0;
  const gen = generation;
  const tasks = list.map(async dish => {
    try {
      const slug = dishSlug(dish.name);
      if (memory.has(slug)) return;
      if (network) { await getDishImage(dish, ''); return; }
      const cached = await storeGet(slug);
      if (cached && cached.blob) {
        const url = toUrl(cached.blob);
        if (url && gen === generation) memory.set(slug, url);
      }
    } catch { /* a picture that cannot be warmed arrives the slow way */ }
  });
  await Promise.race([Promise.all(tasks), new Promise(resolve => setTimeout(resolve, Math.max(0, timeoutMs)))]);
  return list.filter(d => memory.has(dishSlug(d.name))).length;
}

/** Start fetching pictures for a whole deck (fire-and-forget; the concurrency gate paces it). */
export function primeDishImages(dishes) {
  for (const dish of Array.isArray(dishes) ? dishes : []) {
    if (needsGeneratedImage(dish)) getDishImage(dish, '');
  }
}

/** Forget every picture (sign-out): memory, failures and the IndexedDB store. */
export async function clearDishImages() {
  resetSession();
  try { await currentStore().clear(); } catch { /* nothing persisted, nothing to drop */ }
}
