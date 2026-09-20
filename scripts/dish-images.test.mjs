import test from 'node:test';
import assert from 'node:assert/strict';
import { dishImageUrl, fetchMealPlan, chat } from '../frontend/shared/api.js';
import {
  dishSlug, needsGeneratedImage, getDishImage, applyDishImages, primeDishImages, clearDishImages, _configure,
} from '../frontend/shared/dish-images.js';

/* ---- helpers ---------------------------------------------------------------------- */

const API = 'https://api.test';
const configureApi = base => { globalThis.window = { PANTRY_CONFIG: { apiBaseUrl: base } }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await tick(); };

const jpeg = () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' });

function fakeStore(seed = {}, { throwing = false } = {}) {
  const map = new Map(Object.entries(seed));
  const calls = { get: [], put: [], clear: 0 };
  const boom = () => { throw new Error('InvalidStateError: private mode'); };
  return {
    map, calls,
    async get(slug) { calls.get.push(slug); if (throwing) boom(); return map.get(slug); },
    async put(slug, value) { calls.put.push([slug, value]); if (throwing) boom(); map.set(slug, value); },
    async clear() { calls.clear++; if (throwing) boom(); map.clear(); },
  };
}

function fakeFetch({ ok = true, status = 200, throws = false } = {}) {
  const fn = async url => {
    fn.calls.push(url);
    if (throws) throw new TypeError('network down');
    return { ok, status, blob: async () => jpeg() };
  };
  fn.calls = [];
  return fn;
}

// A fetch whose responses are released by hand, to observe the concurrency gate.
function gatedFetch() {
  const fn = url => new Promise(resolve => {
    fn.calls.push(url);
    fn.active++;
    fn.peak = Math.max(fn.peak, fn.active);
    fn.pending.push(() => { fn.active--; resolve({ ok: true, status: 200, blob: async () => jpeg() }); });
  });
  fn.calls = []; fn.pending = []; fn.active = 0; fn.peak = 0;
  fn.releaseOne = async () => { fn.pending.shift()(); await settle(); };
  fn.releaseAll = async () => { while (fn.pending.length) await fn.releaseOne(); };
  return fn;
}

let urlCounter = 0;
const objectUrl = () => `blob:test/${++urlCounter}`;

function setup(opts = {}) {
  configureApi(API);
  const store = opts.store || fakeStore(opts.seed, opts.storeOpts);
  const fetchImpl = opts.fetchImpl || fakeFetch(opts.fetchOpts);
  _configure({ store, fetchImpl, createObjectURL: opts.createObjectURL || objectUrl });
  return { store, fetchImpl };
}

const aiDish = (name = 'Tomato soup', extra = {}) => ({
  id: `ai-${dishSlug(name)}-0`, name,
  ingredients: [{ name: 'Tomatoes' }, { name: 'Basil' }],
  ...extra,
});

/* ---- dishSlug ----------------------------------------------------------------------- */

test('dishSlug lowercases, collapses punctuation and trims dashes', () => {
  assert.equal(dishSlug('Spinach & Garlic Pasta'), 'spinach-garlic-pasta');
  assert.equal(dishSlug('  Mushroom soy-noodle stir-fry!  '), 'mushroom-soy-noodle-stir-fry');
  assert.equal(dishSlug('Crème brûlée'), 'cr-me-br-l-e');
  assert.equal(dishSlug('Shakshuka'), 'shakshuka');
});

test('dishSlug falls back to "dish" and caps at 80 characters without a trailing dash', () => {
  assert.equal(dishSlug(''), 'dish');
  assert.equal(dishSlug('   '), 'dish');
  assert.equal(dishSlug('!!!'), 'dish');
  assert.equal(dishSlug(null), 'dish');
  assert.equal(dishSlug(undefined), 'dish');
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const slug = dishSlug(long);
  assert.ok(slug.length <= 80, `slug is ${slug.length} chars`);
  assert.ok(!slug.endsWith('-'));
  // 'word0 word1 ... word12 w' → the cut lands on a separator; it must not linger.
  assert.ok(!dishSlug('a'.repeat(79) + ' b').endsWith('-'));
});

/* ---- needsGeneratedImage ---------------------------------------------------------- */

test('needsGeneratedImage is true only for ai-, chat- and plan- dishes', () => {
  assert.equal(needsGeneratedImage({ id: 'ai-tomato-soup-0', img: '../img/soup.jpg' }), true);
  assert.equal(needsGeneratedImage({ id: 'chat-abc123' }), true);
  assert.equal(needsGeneratedImage({ id: 'plan-abc123' }), true);
  assert.equal(needsGeneratedImage({ id: 'pasta', img: '../img/pasta.jpg' }), false);
  assert.equal(needsGeneratedImage({ id: 'photo-abc', img: 'data:image/jpeg;base64,AAAA' }), false);
  assert.equal(needsGeneratedImage({ id: 'aioli' }), false);   // prefix needs the dash
  assert.equal(needsGeneratedImage({}), false);
  assert.equal(needsGeneratedImage(null), false);
  assert.equal(needsGeneratedImage(undefined), false);
});

/* ---- getDishImage ------------------------------------------------------------------- */

test('getDishImage returns the fallback and touches nothing when the API is not configured', async () => {
  const { store, fetchImpl } = setup();
  configureApi('');
  assert.equal(await getDishImage(aiDish(), '../img/soup.jpg'), '../img/soup.jpg');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(store.calls.put.length, 0);
});

test('getDishImage fetches once, stores { blob, at } and serves the memory copy afterwards', async () => {
  const { store, fetchImpl } = setup();
  const dish = aiDish('Tomato soup', { names: ['Tomatoes', 'Basil', 'Olive oil'] });
  const url = await getDishImage(dish, 'fallback.jpg');
  assert.match(url, /^blob:test\//);
  assert.equal(fetchImpl.calls.length, 1);
  const href = fetchImpl.calls[0];
  assert.ok(href.startsWith(`${API}/dish-image?`), href);
  assert.ok(href.includes('title=Tomato%20soup'), href);
  assert.ok(href.includes('ingredients=Tomatoes%2CBasil%2COlive%20oil'), href);   // names win over ingredients
  assert.deepEqual(store.calls.put.map(([slug]) => slug), ['tomato-soup']);
  const [, value] = store.calls.put[0];
  assert.ok(value.blob instanceof Blob);
  assert.equal(typeof value.at, 'number');
  // Second time: memory, no store read, no fetch.
  const getsBefore = store.calls.get.length;
  assert.equal(await getDishImage(dish, 'fallback.jpg'), url);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(store.calls.get.length, getsBefore);
});

test('getDishImage serves a cached IndexedDB blob without hitting the network', async () => {
  const { store, fetchImpl } = setup({ seed: { 'tomato-soup': { blob: jpeg(), at: 1 } } });
  const url = await getDishImage(aiDish(), 'fallback.jpg');
  assert.match(url, /^blob:test\//);
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(store.calls.get, ['tomato-soup']);
  assert.equal(store.calls.put.length, 0);
  // Memory now, so the store is not read again either.
  assert.equal(await getDishImage(aiDish(), 'fallback.jpg'), url);
  assert.deepEqual(store.calls.get, ['tomato-soup']);
});

test('getDishImage uses dish.ingredients names when dish.names is absent', async () => {
  const { fetchImpl } = setup();
  await getDishImage({ id: 'chat-1', name: 'Greek salad', ingredients: [{ name: 'Cucumber' }, { name: 'Feta' }] }, '');
  assert.ok(fetchImpl.calls[0].includes('ingredients=Cucumber%2CFeta'), fetchImpl.calls[0]);
});

test('a failed fetch resolves to the fallback and is not retried this session', async () => {
  const { fetchImpl } = setup({ fetchOpts: { ok: false, status: 502 } });
  assert.equal(await getDishImage(aiDish(), 'fallback.jpg'), 'fallback.jpg');
  assert.equal(await getDishImage(aiDish(), 'fallback.jpg'), 'fallback.jpg');
  assert.equal(fetchImpl.calls.length, 1);
});

test('a throwing fetch never rejects the caller', async () => {
  const { fetchImpl } = setup({ fetchOpts: { throws: true } });
  await assert.doesNotReject(() => getDishImage(aiDish(), 'fallback.jpg'));
  assert.equal(await getDishImage(aiDish(), 'fallback.jpg'), 'fallback.jpg');
  assert.equal(fetchImpl.calls.length, 1);
});

test('invalid input resolves to the fallback', async () => {
  setup();
  assert.equal(await getDishImage(null, 'fallback.jpg'), 'fallback.jpg');
  assert.equal(await getDishImage({ id: 'ai-x' }, 'fallback.jpg'), 'fallback.jpg');
  assert.equal(await getDishImage(undefined), '');
});

test('a broken store (private mode) degrades to memory-only', async () => {
  const { fetchImpl } = setup({ storeOpts: { throwing: true } });
  const url = await getDishImage(aiDish(), 'fallback.jpg');
  assert.match(url, /^blob:test\//);
  assert.equal(await getDishImage(aiDish(), 'fallback.jpg'), url);
  assert.equal(fetchImpl.calls.length, 1);
  await assert.doesNotReject(() => clearDishImages());
});

test('concurrent calls for the same dish share one fetch', async () => {
  const { fetchImpl } = setup();
  const [a, b, c] = await Promise.all([
    getDishImage(aiDish(), 'x'), getDishImage(aiDish(), 'x'), getDishImage({ ...aiDish(), id: 'chat-9' }, 'x'),
  ]);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('at most three network fetches are in flight; the rest wait their turn', async () => {
  const fetchImpl = gatedFetch();
  setup({ fetchImpl });
  const names = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
  const results = Promise.all(names.map(n => getDishImage(aiDish(n), 'x')));
  await settle();
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(fetchImpl.active, 3);
  await fetchImpl.releaseOne();
  assert.equal(fetchImpl.calls.length, 4);   // the freed slot went to the next in line
  assert.equal(fetchImpl.active, 3);
  await fetchImpl.releaseAll();
  const urls = await results;
  assert.equal(fetchImpl.calls.length, 6);
  assert.equal(fetchImpl.peak, 3);
  assert.equal(new Set(urls).size, 6);
  assert.ok(urls.every(u => u.startsWith('blob:test/')));
});

test('clearDishImages drops the store and the memory copy, so the next call fetches again', async () => {
  const { store, fetchImpl } = setup();
  const first = await getDishImage(aiDish(), 'x');
  await clearDishImages();
  assert.equal(store.calls.clear, 1);
  assert.equal(store.map.size, 0);
  const second = await getDishImage(aiDish(), 'x');
  assert.equal(fetchImpl.calls.length, 2);
  assert.notEqual(first, second);
});

test('clearDishImages also forgets failures, so a dish can be retried after sign-in', async () => {
  const { fetchImpl } = setup({ fetchOpts: { ok: false, status: 503 } });
  assert.equal(await getDishImage(aiDish(), 'x'), 'x');
  await clearDishImages();
  assert.equal(await getDishImage(aiDish(), 'x'), 'x');
  assert.equal(fetchImpl.calls.length, 2);
});

test('without createObjectURL the endpoint URL itself is used', async () => {
  const { fetchImpl } = setup({ createObjectURL: () => null });
  const url = await getDishImage(aiDish(), 'x');
  assert.equal(url, fetchImpl.calls[0]);
});

/* ---- primeDishImages ---------------------------------------------------------------- */

test('primeDishImages warms only generated dishes and never throws', async () => {
  const { fetchImpl } = setup();
  primeDishImages([
    aiDish('Soup'), { id: 'pasta', name: 'Spinach & garlic pasta', img: '../img/pasta.jpg', ingredients: [] },
    { id: 'chat-1', name: 'Fried rice', ingredients: [] }, { id: 'photo-1', name: 'Photo', img: 'data:image/jpeg;base64,AA', ingredients: [] },
  ]);
  primeDishImages(null);
  primeDishImages(undefined);
  await settle();
  assert.deepEqual(fetchImpl.calls.map(u => new URL(u).searchParams.get('title')), ['Soup', 'Fried rice']);
  // Already in memory: the deck render finds them instantly.
  assert.match(await getDishImage(aiDish('Soup'), 'x'), /^blob:test\//);
  assert.equal(fetchImpl.calls.length, 2);
});

/* ---- applyDishImages ---------------------------------------------------------------- */

function fakeImg(attrs, { connected = true } = {}) {
  const map = new Map(Object.entries(attrs));
  return {
    src: attrs.src || '',
    isConnected: connected,
    getAttribute: k => (map.has(k) ? map.get(k) : null),
    setAttribute: (k, v) => map.set(k, String(v)),
    hasAttribute: k => map.has(k),
  };
}
const fakeRoot = imgs => ({
  calls: 0,
  querySelectorAll(selector) {
    this.calls++;
    assert.equal(selector, 'img[data-dish-img]:not([data-dish-img-done])');
    return imgs.filter(i => i.hasAttribute('data-dish-img') && !i.hasAttribute('data-dish-img-done'));
  },
});
const dishAttrs = (name, id, ings = 'Tomatoes,Basil', src = '../img/soup.jpg') => ({
  src, 'data-dish-img': dishSlug(name), 'data-dish-id': id, 'data-dish-name': name, 'data-dish-ings': ings,
});

test('applyDishImages upgrades marked images from their data attributes and is idempotent', async () => {
  const { fetchImpl } = setup();
  const soup = fakeImg(dishAttrs('Tomato soup', 'ai-tomato-soup-0'));
  const plain = fakeImg({ src: '../img/pasta.jpg' });   // built-in card: no data-dish-img, untouched
  const root = fakeRoot([soup, plain]);
  applyDishImages(root);
  assert.equal(soup.getAttribute('data-dish-img-done'), 'pending');
  applyDishImages(root);   // second pass while pending: nothing new starts
  await settle();
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0].includes('title=Tomato%20soup'));
  assert.ok(fetchImpl.calls[0].includes('ingredients=Tomatoes%2CBasil'));
  assert.match(soup.src, /^blob:test\//);
  assert.equal(soup.getAttribute('data-dish-img-done'), 'done');
  assert.equal(plain.src, '../img/pasta.jpg');
  assert.equal(plain.hasAttribute('data-dish-img-done'), false);
  applyDishImages(root);
  await settle();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(root.calls, 3);
});

test('applyDishImages leaves a detached or re-used element alone and keeps the fallback on failure', async () => {
  const { fetchImpl } = setup();
  const detached = fakeImg(dishAttrs('Detached dish', 'chat-1'), { connected: false });
  const reused = fakeImg(dishAttrs('Reused dish', 'chat-2'));
  applyDishImages(fakeRoot([detached, reused]));
  reused.setAttribute('data-dish-img', 'another-dish');   // the card was re-rendered for a different dish
  await settle();
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(detached.src, '../img/soup.jpg');
  assert.equal(reused.src, '../img/soup.jpg');

  const failing = fakeFetch({ ok: false, status: 502 });
  _configure({ store: fakeStore(), fetchImpl: failing, createObjectURL: objectUrl });
  const broken = fakeImg(dishAttrs('Broken dish', 'plan-1'));
  applyDishImages(fakeRoot([broken]));
  await settle();
  assert.equal(broken.src, '../img/soup.jpg');
  assert.equal(broken.getAttribute('data-dish-img-done'), 'fallback');
});

test('applyDishImages is safe with no DOM at all', () => {
  setup();
  assert.doesNotThrow(() => applyDishImages());
  assert.doesNotThrow(() => applyDishImages(null));
  assert.doesNotThrow(() => applyDishImages({}));
});

/* ---- api.js additions (owned with this module) --------------------------------------- */

test('dishImageUrl builds the GET URL, caps ingredients at eight and is empty when unconfigured', () => {
  configureApi(API);
  const url = dishImageUrl({ title: 'Tomato & basil soup', ingredients: ['Tomatoes', 'Basil, fresh'], seed: 7 });
  assert.equal(url, `${API}/dish-image?title=Tomato%20%26%20basil%20soup&ingredients=Tomatoes%2CBasil%2C%20fresh&seed=7`);
  const many = Array.from({ length: 12 }, (_, i) => `ing${i}`);
  const capped = new URL(dishImageUrl({ title: 'Big', ingredients: many }));
  assert.equal(capped.searchParams.get('ingredients'), many.slice(0, 8).join(','));
  assert.equal(capped.searchParams.get('seed'), '0');
  assert.equal(dishImageUrl({ title: 'Plain' }), `${API}/dish-image?title=Plain&ingredients=&seed=0`);
  configureApi('');
  assert.equal(dishImageUrl({ title: 'Tomato soup' }), '');
});

function stubFetch(response) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null, init });
    return typeof response === 'function' ? response() : response;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const jsonResponse = (data, ok = true, status = 200) => ({ ok, status, statusText: ok ? 'OK' : 'Bad Gateway', json: async () => data });

test('fetchMealPlan posts to /meal-plan with the A3 body and omits start when not given', async () => {
  configureApi(API);
  const plan = { start: '2026-09-20', days: [{ date: '2026-09-20', meals: { breakfast: null, lunch: null, dinner: null } }] };
  const stub = stubFetch(jsonResponse(plan));
  try {
    const items = [{ name: 'Eggs', quantity: 6, unit: 'pcs' }];
    assert.deepEqual(await fetchMealPlan(items), plan);
    assert.equal(stub.calls[0].url, `${API}/meal-plan`);
    assert.equal(stub.calls[0].init.method, 'POST');
    assert.deepEqual(stub.calls[0].body, { items, prefs: null, days: 7, request: null });
    assert.equal('start' in stub.calls[0].body, false);
    await fetchMealPlan(items, { prefs: { version: 2 }, days: 3, start: '2026-09-21', request: 'quick dinners' });
    assert.deepEqual(stub.calls[1].body, { items, prefs: { version: 2 }, days: 3, start: '2026-09-21', request: 'quick dinners' });
    await fetchMealPlan(items, { days: 99 });
    assert.equal(stub.calls[2].body.days, 14);   // clamped to the backend's 1..14
  } finally { stub.restore(); }
});

test('fetchMealPlan surfaces the backend detail on failure and refuses when unconfigured', async () => {
  configureApi(API);
  const stub = stubFetch(jsonResponse({ detail: 'model failure' }, false, 502));
  try {
    await assert.rejects(() => fetchMealPlan([]), /model failure/);
  } finally { stub.restore(); }
  configureApi('');
  await assert.rejects(() => fetchMealPlan([]), /API base URL/);
});

test('chat sends the shopping list alongside pantry, prefs and recent meals', async () => {
  configureApi(API);
  const stub = stubFetch(jsonResponse({ reply: 'ok', actions: [], recipes: [] }));
  try {
    const shopping = [{ name: 'Lemons', quantity: 3, unit: 'pcs', done: false }];
    await chat([{ role: 'user', content: 'hi' }], { pantry: [], prefs: null, recentMeals: [], shopping });
    assert.deepEqual(stub.calls[0].body, { messages: [{ role: 'user', content: 'hi' }], pantry: [], prefs: null, recent_meals: [], shopping });
    await chat([]);
    assert.deepEqual(stub.calls[1].body.shopping, []);
  } finally { stub.restore(); }
});
