/* =========================================================================
   Pantry — interactive prototype
   Receipt in, pantry out, dinner on screen. Everything is derived at read
   time: current quantity = initial − burn rate × days − what cooking used.
   Runs as an ES module so it can share the auth and storage layers.
   ========================================================================= */

import { requireAuth, signOut, configured, onAuthChange } from '../shared/supabase.js';
import {
  loadState, saveState, logCook, logReceipt, clearLocal, clearLocalPrefs,
  loadPrefs, savePrefs, prefsToRequest, normalizePrefs, servingsTarget, householdScale, ingredientHits,
  DEFAULT_PREFS, ALLERGENS, DIETS, CUISINES, EQUIPMENT, SKILLS, SHOPPING, TIME_LIMITS, HOUSEHOLD_LIMITS,
} from '../shared/store.js';
import { scanReceipt, fetchRecipes, apiConfigured } from '../shared/api.js';

const DAY = 86400000;
const THRESHOLD = 120;          // px of drag that commits a swipe
const OUT = 0.5;                // servings at or below this count as "out"
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const uid = () => crypto.randomUUID();   // rows are keyed by uuid in storage too
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(r => setTimeout(r, reduceMotion ? 0 : ms));

const svg = (path, size = 20, sw = 2.2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICON = {
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>', 22),
  xBig: svg('<path d="M6 6l12 12M18 6L6 18"/>', 44, 2.6),
  xSm: svg('<path d="M6 6l12 12M18 6L6 18"/>', 16, 2.4),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 26, 2.8),
  checkBig: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 44, 3),
  checkSm: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 12, 3),
  checkMd: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 16, 3),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', 16),
  upload: svg('<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>', 30, 2),
  chevron: svg('<path d="M9 6l6 6-6 6"/>', 16),
  trash: svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>', 16, 2),
  person: svg('<circle cx="12" cy="8" r="4"/><path d="M4 20.5c0-3.6 3.6-6 8-6s8 2.4 8 6"/>', 20),
  personBig: svg('<circle cx="12" cy="8" r="4"/><path d="M4 20.5c0-3.6 3.6-6 8-6s8 2.4 8 6"/>', 24, 2),
  minus: svg('<path d="M5 12h14"/>', 16, 2.4),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 16, 2.4),
};

/* ---------- reference data: shelf life and household burn rate ---------- */
// shelf = days until it goes bad, burn = servings a household uses per day
// (0 = only recipes touch it), servings = what one purchase holds.
const CATALOG = {
  'spinach':        { shelf: 5,   burn: 0.35, servings: 4 },
  'spring mix':     { shelf: 4,   burn: 0.5,  servings: 4 },
  'milk':           { shelf: 7,   burn: 1.0,  servings: 8 },
  'eggs':           { shelf: 21,  burn: 0.6,  servings: 12 },
  'chicken thighs': { shelf: 1.5, burn: 0,    servings: 3 },
  'garlic':         { shelf: 60,  burn: 0.15, servings: 10 },
  'spaghetti':      { shelf: 365, burn: 0,    servings: 4 },
  'tomatoes':       { shelf: 5,   burn: 0.3,  servings: 6 },
  'basil':          { shelf: 3,   burn: 0,    servings: 3 },
  'jasmine rice':   { shelf: 365, burn: 0,    servings: 8 },
  'parmesan':       { shelf: 21,  burn: 0.2,  servings: 8 },
  'cucumber':       { shelf: 6,   burn: 0.3,  servings: 2 },
  'olive oil':      { shelf: 365, burn: 0.15, servings: 40 },
  'chili flakes':   { shelf: 365, burn: 0.02, servings: 30 },
  'onion':          { shelf: 21,  burn: 0.2,  servings: 4 },
  'red onion':      { shelf: 21,  burn: 0.1,  servings: 3 },
  'mushrooms':      { shelf: 5,   burn: 0,    servings: 3 },
  'arborio rice':   { shelf: 365, burn: 0,    servings: 6 },
  'stock':          { shelf: 5,   burn: 0,    servings: 4 },
  'soy sauce':      { shelf: 365, burn: 0.05, servings: 40 },
  'cream':          { shelf: 7,   burn: 0.3,  servings: 6 },
  'olives':         { shelf: 30,  burn: 0.1,  servings: 8 },
  'cumin':          { shelf: 365, burn: 0.02, servings: 40 },
  'paprika':        { shelf: 365, burn: 0.02, servings: 40 },
  'feta':           { shelf: 14,  burn: 0.2,  servings: 6 },
  'scallions':      { shelf: 7,   burn: 0.2,  servings: 4 },
  'white wine':     { shelf: 5,   burn: 0.5,  servings: 5 },
};
const DEFAULT_CAT = { shelf: 7, burn: 0.3, servings: 4 };
const catalog = key => CATALOG[key] || DEFAULT_CAT;

const ing = (name, key, need, amt) => ({ name, key, need, amt });
// tags: what the dish is, for the preference filter. `contains` lists allergen keys
// (see ALLERGENS in store.js); generated dishes have no tags and are checked by ingredient name.
const tags = (diet, cuisine, contains = [], extra = {}) => ({
  vegetarian: diet === 'vegetarian' || diet === 'vegan', vegan: diet === 'vegan', pescatarian: diet !== 'meat', cuisine, contains, ...extra,
});
const DISHES = [
  {
    id: 'pasta', name: 'Spinach & garlic pasta', img: '../img/pasta.jpg', time: '20 min', servings: 2, difficulty: 'Easy',
    tags: tags('vegetarian', 'italian', ['gluten', 'dairy']),
    ingredients: [ing('Spinach', 'spinach', 2, '5 oz'), ing('Garlic', 'garlic', 2, '2 cloves'), ing('Spaghetti', 'spaghetti', 2, '8 oz'), ing('Parmesan', 'parmesan', 1, '1 oz'), ing('Olive oil', 'olive oil', 1, '3 tbsp'), ing('Chili flakes', 'chili flakes', 1, 'a pinch')],
    steps: [
      'Bring a big pot of salted water to the boil and cook the spaghetti until just short of done.',
      'Meanwhile warm the olive oil over low heat with the sliced garlic and chili flakes until the garlic turns pale gold.',
      'Add the spinach in handfuls and let it collapse into the oil.',
      'Lift the pasta straight into the pan with a splash of its water and toss until glossy.',
      'Finish with parmesan and a crack of pepper.',
    ],
  },
  {
    id: 'friedrice', name: 'Chicken fried rice', img: '../img/friedrice.jpg', time: '25 min', servings: 3, difficulty: 'Easy',
    tags: tags('meat', 'chinese', ['eggs', 'gluten', 'soy']),
    ingredients: [ing('Chicken thighs', 'chicken thighs', 3, '1 lb'), ing('Jasmine rice', 'jasmine rice', 3, '3 cups, cooked'), ing('Eggs', 'eggs', 2, '2'), ing('Garlic', 'garlic', 2, '2 cloves'), ing('Soy sauce', 'soy sauce', 1, '2 tbsp'), ing('Scallions', 'scallions', 1, '2')],
    steps: [
      'Cut the chicken into small pieces and season with salt.',
      'Sear in a very hot pan until browned, then push to one side.',
      'Scramble the eggs in the empty half of the pan.',
      'Add the cold rice and garlic, press it flat and let it crisp before stirring.',
      'Splash in soy sauce, toss, and top with scallions if you have them.',
    ],
  },
  {
    id: 'shakshuka', name: 'Shakshuka', img: '../img/shakshuka.jpg', time: '30 min', servings: 2, difficulty: 'Easy',
    tags: tags('vegetarian', 'middle-eastern', ['eggs', 'dairy']),
    ingredients: [ing('Eggs', 'eggs', 4, '4'), ing('Tomatoes', 'tomatoes', 4, '4 roma'), ing('Onion', 'onion', 1, '1'), ing('Garlic', 'garlic', 2, '2 cloves'), ing('Cumin', 'cumin', 1, '1 tsp'), ing('Paprika', 'paprika', 1, '1 tsp'), ing('Olive oil', 'olive oil', 1, '2 tbsp'), ing('Feta', 'feta', 1, '2 oz')],
    steps: [
      'Warm the olive oil in a wide pan over medium heat. Soften the onion, about 6 minutes.',
      'Add the garlic, cumin and paprika. Cook until fragrant, about a minute.',
      'Add the tomatoes, crush them with a spoon and simmer until thick, 10 to 12 minutes.',
      'Make four wells in the sauce and crack an egg into each.',
      'Cover and cook until the whites set but the yolks stay soft, 5 to 7 minutes.',
      'Finish with feta if you have it. Serve from the pan with bread.',
    ],
  },
  {
    id: 'soup', name: 'Tomato basil soup', img: '../img/soup.jpg', time: '35 min', servings: 4, difficulty: 'Easy',
    tags: tags('vegetarian', 'italian', ['dairy']),
    ingredients: [ing('Tomatoes', 'tomatoes', 6, '6 roma'), ing('Basil', 'basil', 2, '1 bunch'), ing('Onion', 'onion', 1, '1'), ing('Garlic', 'garlic', 2, '2 cloves'), ing('Olive oil', 'olive oil', 1, '2 tbsp'), ing('Cream', 'cream', 2, '½ cup')],
    steps: [
      'Soften the onion and garlic in olive oil over medium heat, about 8 minutes.',
      'Add the tomatoes and a cup of water. Simmer 20 minutes until they fall apart.',
      'Blend until smooth, then stir in the cream.',
      'Tear in the basil off the heat and season well.',
    ],
  },
  {
    id: 'salad', name: 'Greek salad', img: '../img/salad.jpg', time: '15 min', servings: 2, difficulty: 'No cook',
    tags: tags('vegetarian', 'mediterranean', ['dairy']),
    ingredients: [ing('Cucumber', 'cucumber', 1, '1'), ing('Tomatoes', 'tomatoes', 3, '3 roma'), ing('Red onion', 'red onion', 1, '½'), ing('Olives', 'olives', 1, 'a handful'), ing('Feta', 'feta', 2, '4 oz'), ing('Olive oil', 'olive oil', 1, '3 tbsp')],
    steps: [
      'Chop the cucumber and tomatoes into chunks and slice the red onion thin.',
      'Toss with olives, a good pour of olive oil and a pinch of salt.',
      'Crumble feta over the top if you have it. Best after ten minutes.',
    ],
  },
  {
    id: 'risotto', name: 'Mushroom risotto', img: '../img/risotto.jpg', time: '45 min', servings: 3, difficulty: 'Medium',
    tags: tags('vegetarian', 'italian', ['dairy'], { alcohol: true }),   // the wine: not for a halal table
    ingredients: [ing('Arborio rice', 'arborio rice', 3, '1½ cups'), ing('Mushrooms', 'mushrooms', 3, '8 oz'), ing('Parmesan', 'parmesan', 2, '2 oz'), ing('Onion', 'onion', 1, '1'), ing('Stock', 'stock', 4, '1 qt'), ing('White wine', 'white wine', 1, '½ cup')],
    steps: [
      'Warm the stock in a small pan and keep it hot.',
      'Brown the mushrooms in oil, then set aside. Soften the onion in the same pan.',
      'Add the rice and stir for a minute. Splash in white wine and let it cook off.',
      'Add stock a ladle at a time, stirring, until the rice is creamy, about 18 minutes.',
      'Fold in the mushrooms and parmesan. Rest for two minutes before serving.',
    ],
  },
];
const DISH_IMAGES = DISHES.map(d => d.img);
// Until recipes come with their own photos, pick the stock shot that fits the dish best.
const PHOTO_RULES = [
  ['pasta', /pasta|spaghetti|noodle|linguine|penne|fettuccine|orzo|lasagna|mac/],
  ['friedrice', /fried rice|rice bowl|stir[- ]?fry|pilaf|biryani|rice/],
  ['shakshuka', /shakshuka|egg|frittata|omelet|omelette|tomato/],
  ['soup', /soup|stew|chili|broth|curry|ramen|dal|chowder/],
  ['salad', /salad|slaw|greens|cucumber|tabbouleh/],
  ['risotto', /risotto|mushroom|creamy|polenta|porridge|oat/],
];
function pickPhoto(recipe, index) {
  const title = String(recipe.title || '').toLowerCase();
  const all = `${title} ${(recipe.ingredients || []).map(i => i.name).join(' ')}`.toLowerCase();
  for (const [file, re] of PHOTO_RULES) if (re.test(title)) return `../img/${file}.jpg`;
  for (const [file, re] of PHOTO_RULES) if (re.test(all)) return `../img/${file}.jpg`;
  return DISH_IMAGES[index % DISH_IMAGES.length];
}
/** Live Gemini recipes when the API is up; null falls back to hardcoded DISHES. */
let liveDishes = null;
let recipeRefreshToken = 0;

const dishById = id => (liveDishes || DISHES).find(d => d.id === id);
const activeDishes = () => liveDishes || DISHES;

const SAMPLE_RECEIPT = {
  store: 'Whole Foods Market', date: 'Sep 19', total: 64.18,
  lines: [
    { raw: 'ORG SPINACH 5OZ', name: 'Spinach', key: 'spinach', qty: '5 oz', price: 3.49 },
    { raw: 'GV MLK 1GAL', name: 'Milk', key: 'milk', qty: '1 gal', price: 3.98 },
    { raw: 'EGGS LG DZ', name: 'Eggs', key: 'eggs', qty: '12', price: 4.29 },
    { raw: 'CHKN THIGH 1.4LB', name: 'Chicken thighs', key: 'chicken thighs', qty: '1.4 lb', price: 8.12 },
    { raw: 'GARLIC', name: 'Garlic', key: 'garlic', qty: '1 head', price: 0.89 },
    { raw: 'SPAGHETTI 1LB', name: 'Spaghetti', key: 'spaghetti', qty: '1 lb', price: 1.99 },
    { raw: 'ROMA TOM 6', name: 'Tomatoes, roma', key: 'tomatoes', qty: '6', price: 3.24 },
    { raw: 'BASIL BNCH', name: 'Basil', key: 'basil', qty: '1 bunch', price: 2.49 },
    { raw: 'JASMINE RICE 2LB', name: 'Jasmine rice', key: 'jasmine rice', qty: '2 lb', price: 4.99 },
    { raw: 'PARM REG 8OZ', name: 'Parmesan', key: 'parmesan', qty: '8 oz', price: 6.99 },
    { raw: 'CUCUMBER 2', name: 'Cucumber', key: 'cucumber', qty: '2', price: 1.58 },
    { raw: 'SPRNG MX ORG 5OZ', name: 'Spring mix', key: 'spring mix', qty: '5 oz', price: 4.49, low: true },
    { raw: 'PAPER TWL 6PK', name: 'Paper towels', price: 9.99, nonFood: true },
    { raw: 'AA BATT 8PK', name: 'AA batteries', price: 7.65, nonFood: true },
  ],
};

/** Metadata for the receipt currently in the review sheet. */
let lastReceipt = {
  store: SAMPLE_RECEIPT.store,
  date: SAMPLE_RECEIPT.date,
  total: SAMPLE_RECEIPT.total,
};

function keyForName(name) {
  const n = String(name || '').toLowerCase().trim();
  if (!n) return 'item';
  if (CATALOG[n]) return n;
  const base = n.split(',')[0].trim();
  if (CATALOG[base]) return base;
  for (const k of Object.keys(CATALOG)) {
    if (n.includes(k) || k.includes(base)) return k;
  }
  return base.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() || 'item';
}

function qtyLabel(item) {
  if (item.unit && item.quantity != null) return `${item.quantity} ${item.unit}`.trim();
  if (item.quantity != null) return String(item.quantity);
  return '';
}

function formatReceiptDate(iso) {
  if (!iso) return new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const d = new Date(iso + (iso.length <= 10 ? 'T12:00:00' : ''));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Map a /scan item into a review-row + pantry seed fields. */
function lineFromScanItem(item) {
  const key = keyForName(item.group_key || item.name);
  const purchaseMs = item.purchase_date ? Date.parse(item.purchase_date) : Date.now();
  const expiryMs = item.expiration_date ? Date.parse(item.expiration_date) : purchaseMs + catalog(key).shelf * DAY;
  return {
    id: uid(),
    raw: item.raw_text || item.name,
    name: item.name,
    key,
    variant: item.variant || '',
    qty: qtyLabel(item),
    price: Number(item.price) || 0,
    nonFood: item.is_food === false,
    low: false,
    dropped: false,
    initial: Number(item.initial_servings || item.servings) || catalog(key).servings,
    burn: Number(item.daily_burn_rate) || (item.burn_pattern === 'event' ? 0 : catalog(key).burn),
    purchase: Number.isFinite(purchaseMs) ? purchaseMs : Date.now(),
    expiry: Number.isFinite(expiryMs) ? expiryMs : Date.now() + catalog(key).shelf * DAY,
  };
}

function slugify(title) {
  return String(title || 'dish').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dish';
}

function dishFromApi(recipe, index) {
  const id = `ai-${slugify(recipe.title)}-${index}`;
  return {
    id,
    name: recipe.title,
    img: pickPhoto(recipe, index),
    time: `${recipe.cook_minutes || 20} min`,
    servings: recipe.servings || 2,
    difficulty: (recipe.difficulty || 'easy').replace(/^\w/, c => c.toUpperCase()),
    ingredients: (recipe.ingredients || [])
      .filter(ing => !ing.staple)
      .map(ing => ({
        name: ing.name,
        key: keyForName(ing.matched_name || ing.name),
        need: Math.max(0.5, Number(ing.servings_used) || 1),
        amt: ing.amount || '',
      })),
    // every ingredient name, staples included, for the allergy and dislike checks
    names: (recipe.ingredients || []).map(ing => String(ing.name || '')).filter(Boolean),
    steps: Array.isArray(recipe.steps) ? recipe.steps : [],
  };
}

function pantryForApi() {
  // One aggregated row per food key so Gemini matches stacks, not individual lots.
  const byKey = new Map();
  for (const it of state.pantry) {
    if (needsCheckin(it)) continue;
    const qty = current(it);
    if (qty <= 0) continue;
    const prev = byKey.get(it.key);
    const dl = Math.max(0, Math.round(daysLeft(it)));
    if (!prev) {
      byKey.set(it.key, {
        id: it.id,
        name: it.name,
        category: 'other',
        quantity_servings: qty,
        days_left: dl,
        deadline_reason: 'spoils',
        is_food: true,
      });
    } else {
      prev.quantity_servings += qty;
      prev.days_left = Math.min(prev.days_left, dl);
      if (it.name.length < prev.name.length) prev.name = it.name;
    }
  }
  return [...byKey.values()];
}

async function refreshRecipes() {
  if (!apiConfigured() || !state.pantry.length) {
    liveDishes = null;
    renderAll({ enter: true });
    return [];
  }
  const token = ++recipeRefreshToken;
  // The structured prefs are the contract (allergies and diet are hard rules server-side);
  // the plain-English line is the fallback the model reads — '' when all default.
  const prefs = state.prefs;
  const request = prefsToRequest(prefs);
  try {
    let data = await fetchRecipes(pantryForApi(), { count: 6, maxMissing: 2, request, prefs });
    if (token !== recipeRefreshToken) return liveDishes || [];
    let list = (data.recipes || []).map(dishFromApi);
    // Soften the filter once if nothing made the cut
    if (!list.length) {
      data = await fetchRecipes(pantryForApi(), { count: 6, maxMissing: 4, request, prefs });
      if (token !== recipeRefreshToken) return liveDishes || [];
      list = (data.recipes || []).map(dishFromApi);
    }
    liveDishes = list.length ? list : null;
    const ids = new Set((liveDishes || DISHES).map(d => d.id));
    for (const set of [state.skipped, state.cooked, state.chosen]) {
      for (const id of [...set]) if (!ids.has(id)) set.delete(id);
    }
    renderAll({ enter: true });
    return liveDishes || [];
  } catch (err) {
    console.warn('[pantry] recipe refresh failed', err);
    if (token === recipeRefreshToken) {
      liveDishes = null;
      renderAll({ enter: true });
    }
    return [];
  }
}

/* ---------- the pantry model ---------- */
function mk(name, key, qty, daysAgo, raw = '') {
  const c = catalog(key);
  const purchase = Date.now() - daysAgo * DAY;
  return { id: uid(), name, key, qty, raw, initial: c.servings, purchase, expiry: purchase + c.shelf * DAY, burn: c.burn, deducted: 0 };
}
function seedPantry() {
  return [
    mk('Spinach', 'spinach', '5 oz', 2.6),
    mk('Garlic', 'garlic', '1 head', 52),
    mk('Spaghetti', 'spaghetti', '1 lb', 12),
    mk('Parmesan', 'parmesan', '8 oz', 5),
    mk('Olive oil', 'olive oil', '500 ml', 210),
    mk('Chili flakes', 'chili flakes', '1 jar', 60),
    mk('Onion', 'onion', '3', 6),
    mk('Red onion', 'red onion', '2', 6),
    mk('Mushrooms', 'mushrooms', '8 oz', 2),
    mk('Arborio rice', 'arborio rice', '1 lb', 30),
    mk('Stock', 'stock', '1 qt', 1),
    mk('Soy sauce', 'soy sauce', '1 bottle', 90),
    mk('Cream', 'cream', '1 pint', 3),
    mk('Olives', 'olives', '1 jar', 12),
    mk('Cucumber', 'cucumber', '1', 1),
    mk('Cumin', 'cumin', '1 jar', 120),
    mk('Paprika', 'paprika', '1 jar', 120),
    mk('Milk', 'milk', '1 gal', 9),
  ];
}
// Each purchase is its own lot. Same group_key stacks in the panel with separate
// expiry dates — never merge and overwrite an older banana's use-by.
function addLot(name, key, qty, raw = '', extras = null) {
  const c = catalog(key);
  const initial = extras && extras.initial != null ? extras.initial : c.servings;
  const burn = extras && extras.burn != null ? extras.burn : c.burn;
  const purchase = extras && extras.purchase != null ? extras.purchase : Date.now();
  const expiry = extras && extras.expiry != null ? extras.expiry : purchase + c.shelf * DAY;
  const it = {
    id: uid(),
    name,
    key,
    qty: qty || '',
    raw,
    variant: (extras && extras.variant) || '',
    initial,
    purchase,
    expiry,
    burn,
    deducted: 0,
  };
  state.pantry.push(it);
  return { item: it, merged: false };
}
// Hand-add still uses this name; always stacks as a new lot.
const upsert = (name, key, qty, raw = '', extras = null) => addLot(name, key, qty, raw, extras);

// Burn rates were estimated for a two-person household; the stored rate stays as is and
// the household multiplier is applied here, at read time.
const burnRate = it => it.burn * householdScale(state.prefs);
const current = it => Math.max(0, it.initial - burnRate(it) * ((Date.now() - it.purchase) / DAY) - it.deducted);
const daysLeft = it => (it.expiry - Date.now()) / DAY;
const needsCheckin = it => current(it) <= OUT;
const lotsFor = key => state.pantry.filter(it => it.key === key).sort((a, b) => a.expiry - b.expiry);
const available = key => lotsFor(key).filter(it => !needsCheckin(it)).reduce((s, it) => s + current(it), 0);
/** Soonest-expiring lot that still has stock (FEFO). */
const findItem = key => lotsFor(key).find(it => !needsCheckin(it) && current(it) > 0) || null;

function deductServings(key, need) {
  let left = need;
  const used = [];
  for (const item of lotsFor(key)) {
    if (left <= 0) break;
    const have = current(item);
    if (have <= 0) continue;
    const take = Math.min(have, left);
    item.deducted += take;
    left -= take;
    used.push({ id: item.id, key, name: item.name, servings: take });
  }
  return used;
}

function timeLabel(dl) {
  if (dl < 0) return 'past its date';
  if (dl < 1) return 'expires today';
  if (dl < 2) return 'expires tomorrow';
  if (dl <= 7) return `expires in ${Math.round(dl)} days`;
  if (dl <= 21) { const w = Math.round(dl / 7); return w <= 1 ? 'about a week' : `about ${w} weeks`; }
  if (dl <= 300) { const m = Math.round(dl / 30); return m <= 1 ? 'about a month' : `about ${m} months`; }
  return 'about a year';
}
function shortDays(dl) {
  if (dl < 1) return 'use today';
  if (dl < 2) return 'use by tomorrow';
  return `${Math.floor(dl)} days left`;
}
const levelForDays = dl => (dl <= 2 ? 'red' : dl <= 5 ? 'yellow' : 'green');

// The freshness bar does one of two jobs: time until it spoils, or amount left.
// Show whichever is more urgent and say which one it is.
function freshness(it) {
  const cur = current(it);
  const pct = it.initial > 0 ? clamp(cur / it.initial, 0, 1) : 0;
  const dl = daysLeft(it);
  const shelfDays = Math.max(1, (it.expiry - it.purchase) / DAY);   // never divide by zero on a same-day expiry
  const tLevel = levelForDays(dl);
  const aLevel = pct <= 0.12 ? 'red' : pct <= 0.3 ? 'yellow' : 'green';
  const rank = { red: 0, yellow: 1, green: 2 };
  if (it.burn > 0 && rank[aLevel] < rank[tLevel]) {
    return { level: aLevel, pct, mode: 'amount', label: `about ${Math.round(pct * 100)}% left`, urgency: pct };
  }
  return { level: tLevel, pct: clamp(dl / shelfDays, 0, 1), mode: 'time', label: timeLabel(dl), urgency: dl / 30 };
}

/* ---------- dishes against the preferences ---------- */
// Hard rules only: an allergy the dish contains, or a diet it breaks. Tagged (hardcoded)
// dishes are judged by their tags; every dish is also checked by ingredient name as a
// safety net, since a generated recipe arrives without tags.
function passesPrefs(dish) {
  const p = state.prefs;
  const t = dish.tags;
  if (t) {
    if ((t.contains || []).some(k => p.allergies.includes(k))) return false;
    if (p.diet.includes('vegan') && !t.vegan) return false;
    if (p.diet.includes('vegetarian') && !(t.vegetarian || t.vegan)) return false;
    if (p.diet.includes('pescatarian') && !(t.vegetarian || t.vegan || t.pescatarian)) return false;
    if (p.diet.includes('halal') && t.alcohol) return false;
  }
  if (p.allergies.length && ingredientHits(dishNames(dish), p.allergies).length) return false;
  return true;
}
// Generated dishes keep every ingredient name (staples included) for these checks; hardcoded ones list them all anyway.
const dishNames = dish => dish.names || dish.ingredients.map(i => i.name);
// Dislikes are soft: the dish stays, with a warning chip naming what it has.
function avoidHits(dish) {
  const terms = String(state.prefs.avoid || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!terms.length) return [];
  const names = dishNames(dish).map(n => String(n).toLowerCase());
  return terms.filter(t => { const stem = t.length > 3 ? t.replace(/(es|s)$/, '') : t; return names.some(n => n.includes(stem)); });
}
// Soft preferences break ties in the deck order: a cuisine they picked, a time they can spare.
const dishMinutes = d => parseInt(d.time, 10) || 0;
function prefFit(dish) {
  const p = state.prefs;
  let fit = 0;
  if (dish.tags && p.cuisines.includes(dish.tags.cuisine)) fit += 1;
  if (p.maxMinutes > 0 && dishMinutes(dish) <= p.maxMinutes) fit += 1;
  return fit;
}

/* ---------- dishes against the pantry ---------- */
function analyze(dish) {
  const ings = dish.ingredients.map(i => {
    const item = findItem(i.key);
    const avail = available(i.key);
    return { ...i, item, avail, have: avail > 0 };
  });
  const have = ings.filter(i => i.have);
  const missing = ings.filter(i => !i.have);
  let urgent = null;
  for (const i of have) {
    const dl = daysLeft(i.item);
    if (!urgent || dl < urgent.dl) urgent = { item: i.item, dl };
  }
  const urgentDays = urgent ? urgent.dl : 999;
  const badge = urgent && urgent.dl <= 5
    ? { text: `Uses your ${urgent.item.name.toLowerCase()} · ${shortDays(urgent.dl)}`, level: levelForDays(urgent.dl) }
    : null;
  return { dish, ings, have, missing, urgentDays, badge, warn: avoidHits(dish), fit: prefFit(dish), stretch: stretchOf(dish) };
}
const eligible = a => a.missing.length <= 2;

/* ---------- state ---------- */
const state = {
  pantry: [],
  deck: [],
  skipped: new Set(),
  cooked: new Set(),
  chosen: new Set(),        // dishes picked for tonight, in the order they were picked
  expanded: new Set(),      // pantry stack keys that are open
  prefs: normalizePrefs(DEFAULT_PREFS),   // cooking preferences; replaced by loadPrefs() at boot
  prefsHid: false,          // the deck is empty only because of the preferences (nothing to reshuffle)
  sheet: null,
  panelOpen: false,
  leaving: false,
  sheetReturn: null,        // where keyboard focus goes back to when the sheet closes
  panelReturn: null,
};

function buildDeck() {
  const makeable = activeDishes().map(analyze).filter(eligible);
  const all = makeable.filter(a => passesPrefs(a.dish));
  state.prefsHid = all.length === 0 && makeable.length > 0;
  state.deck = all
    .filter(a => !state.skipped.has(a.dish.id) && !state.cooked.has(a.dish.id) && !state.chosen.has(a.dish.id))
    .sort((a, b) => (a.urgentDays - b.urgentDays) || (a.missing.length - b.missing.length) || (a.stretch - b.stretch) || (b.fit - a.fit));
  return all;
}
const chosenDishes = () => [...state.chosen].map(dishById).filter(Boolean);

/* =========================================================================
   Rendering
   ========================================================================= */
const el = {
  deck: $('#deck'), caption: $('#deck-caption'), status: $('#deck-status'), deckScreen: $('#deck-screen'), endScreen: $('#end-screen'), emptyScreen: $('#empty-screen'),
  endTitle: $('#end-title'), endCopy: $('#end-copy'), reshuffle: $('#btn-reshuffle'), endPrefs: $('#btn-end-prefs'),
  count: $('#btn-pantry'), tonight: $('#btn-tonight'), reset: $('#btn-reset'), profile: $('#btn-profile'),
  veil: $('#veil'), sheet: $('#sheet'), panel: $('#panel'), panelBody: $('#panel-body'), panelCount: $('#panel-count'),
  toast: $('#toast'), file: $('#file-input'),
};

// The choke point after every mutation: everything derived is rebuilt here, then saved.
function renderAll(opts = {}) {
  buildDeck();
  const n = state.pantry.length;
  el.count.textContent = plural(n, 'item');
  el.count.setAttribute('aria-label', `Pantry, ${plural(n, 'item')}`);
  el.panelCount.textContent = plural(n, 'item');
  el.reset.textContent = n ? 'Clear pantry' : 'Load demo pantry';
  renderTonight();
  renderDeck(opts);
  if (state.panelOpen) renderPanel();
  saveState({ pantry: state.pantry, skipped: [...state.skipped], cooked: [...state.cooked], chosen: [...state.chosen] });
}

// Difficulty as a 1–3 level, and how far a dish sits above the cook's own skill
const DIFF_LEVEL = { 'no cook': 1, easy: 1, medium: 2, hard: 3 };
const SKILL_LEVEL = { beginner: 1, comfortable: 2, confident: 3 };
const difficultyLevel = d => DIFF_LEVEL[String(d.difficulty || 'easy').toLowerCase()] || 1;
const stretchOf = d => Math.max(0, difficultyLevel(d) - (SKILL_LEVEL[state.prefs.skill] || 2));
function difficultyHTML(d) {
  const lvl = difficultyLevel(d), stretch = stretchOf(d) > 0;
  return `<span class="diff l${lvl}${stretch ? ' stretch' : ''}" title="${stretch ? 'Above your usual skill level' : 'Difficulty'}"><span class="bars"><i></i><i></i><i></i></span><span>${esc(d.difficulty)}</span></span>`;
}

function cardHTML(a) {
  const d = a.dish;
  return `
    <div class="card-img">
      <img src="${d.img}" alt="" draggable="false">
      ${a.badge ? `<div class="badge glass ${a.badge.level}"><span class="dot"></span><span>${esc(a.badge.text)}</span></div>` : ''}
    </div>
    <div class="card-body">
      <h2>${esc(d.name)}</h2>
      <div class="meta"><span>${d.time}</span><i></i><span>${plural(d.servings, 'serving')}</span><i></i>${difficultyHTML(d)}</div>
      <div class="chips">${a.ings.map(i => i.have
        ? `<span class="chip have">${ICON.checkSm}<span>${esc(i.name)}</span></span>`
        : `<span class="chip missing">${esc(i.name)}</span>`).join('')}${warnChips(a)}</div>
      ${a.missing.length ? `<div class="missing-line">missing ${a.missing.length}: ${esc(a.missing.map(m => m.name.toLowerCase()).join(', '))}</div>` : ''}
    </div>
    <div class="overlay cook"><div class="glass ring">${ICON.checkBig}</div></div>
    <div class="overlay skip"><div class="glass ring">${ICON.xBig}</div></div>`;
}

// A dish that has something they'd rather not eat keeps its place, with a note
const warnChips = a => (a.warn || []).map(w => `<span class="chip warn"><span class="dot"></span><span>Has ${esc(w)}</span></span>`).join('')
  + (a.stretch > 0 ? `<span class="chip warn"><span class="dot"></span><span>A stretch for you</span></span>` : '');

function renderDeck(opts = {}) {
  const hasPantry = state.pantry.length > 0;
  el.emptyScreen.classList.toggle('hidden', hasPantry);
  el.deckScreen.classList.toggle('hidden', !hasPantry || state.deck.length === 0);
  el.endScreen.classList.toggle('hidden', !hasPantry || state.deck.length > 0);
  // End of deck: either they went through everything, or the preferences left nothing to show
  el.endTitle.textContent = state.prefsHid ? 'Nothing to cook yet' : 'That’s everything we can make right now';
  el.endCopy.textContent = state.prefsHid
    ? 'Nothing here fits your preferences yet. Scan a receipt or loosen them in your profile.'
    : 'Scan another receipt for new dishes, or reshuffle to see the ones you skipped.';
  el.reshuffle.hidden = state.prefsHid;
  el.endPrefs.hidden = !state.prefsHid;
  el.deck.innerHTML = '';
  const show = state.deck.slice(0, 3);
  // back to front so the top card is last in the DOM
  for (let pos = show.length - 1; pos >= 0; pos--) {
    const card = document.createElement('article');
    card.className = `card pos${pos}${opts.enter ? ' enter' : ''}`;
    if (opts.enter) {
      card.style.animationDelay = `${pos * 70}ms`;
      // once the entrance has played the card is a plain .card again
      card.addEventListener('animationend', e => { if (e.target === card) card.classList.remove('enter'); });
    }
    card.dataset.id = show[pos].dish.id;
    card.setAttribute('aria-label', show[pos].dish.name);
    card.innerHTML = cardHTML(show[pos]);
    el.deck.appendChild(card);
  }
  const top = $('#deck .pos0');
  if (top) top.addEventListener('pointerdown', onPointerDown);
  const n = state.deck.length;
  const left = n === 1 ? '1 dish left' : plural(n, 'dish', 'dishes');
  el.caption.textContent = `Sorted by what’s expiring first · ${left}`;
  // one short line for screen readers, and only when it actually changed
  const msg = !hasPantry ? 'Pantry is empty' : n ? `Now showing ${state.deck[0].dish.name}, ${left}` : state.prefsHid ? 'Nothing fits your preferences yet' : 'No dishes left';
  if (msg !== el.status.textContent) el.status.textContent = msg;
}

// The "Tonight" pill: what has been picked from the deck so far
function renderTonight() {
  const dishes = chosenDishes();
  el.tonight.hidden = dishes.length === 0;
  if (!dishes.length) return;
  const label = dishes.length === 1 ? dishes[0].name : plural(dishes.length, 'dish', 'dishes');
  $('span', el.tonight).textContent = `Tonight · ${label}`;
  el.tonight.setAttribute('aria-label', `Tonight: ${dishes.map(d => d.name).join(', ')}`);
}

/* ---------- swipe physics ---------- */
const drag = { active: false, el: null, startX: 0, startY: 0, dx: 0, vx: 0, lastX: 0, lastT: 0, raf: 0, moved: false };

function paint(card, dx) {
  card.style.transform = `translateX(${dx}px) rotate(${dx * 0.06}deg)`;
  const p = clamp(Math.abs(dx) / THRESHOLD, 0, 1);
  $('.overlay.cook', card).style.opacity = dx > 0 ? p : 0;
  $('.overlay.skip', card).style.opacity = dx < 0 ? p : 0;
}
function settle(card) {
  card.style.transform = '';
  card.classList.remove('dragging');
  $('.overlay.cook', card).style.opacity = '';
  $('.overlay.skip', card).style.opacity = '';
}
function endDrag() {
  if (!drag.active) return;
  drag.active = false;
  const card = drag.el;
  card.removeEventListener('pointermove', onPointerMove);
  card.removeEventListener('pointerup', onPointerUp);
  card.removeEventListener('pointercancel', onPointerUp);
  card.removeEventListener('lostpointercapture', onPointerUp);
}
function onPointerDown(e) {
  if (state.sheet || state.panelOpen || state.leaving || e.button !== 0) return;
  // one pointer at a time; a drag whose card was re-rendered away is stale and may be replaced
  if (drag.active && drag.el && drag.el.isConnected) return;
  const card = e.currentTarget;
  cancelAnimationFrame(drag.raf);
  card.classList.remove('enter');   // an entrance still playing would override the drag transform
  Object.assign(drag, { active: true, el: card, startX: e.clientX, startY: e.clientY, dx: 0, vx: 0, lastX: e.clientX, lastT: performance.now(), moved: false });
  card.classList.add('dragging');
  try { card.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
  card.addEventListener('pointermove', onPointerMove);
  card.addEventListener('pointerup', onPointerUp);
  card.addEventListener('pointercancel', onPointerUp);
  card.addEventListener('lostpointercapture', onPointerUp);
}
function onPointerMove(e) {
  if (!drag.active) return;
  const t = performance.now();
  drag.dx = (e.clientX - drag.startX) / fitScale;   // keep the card under the cursor when the deck is scaled
  if (Math.abs(drag.dx) > 4 || Math.abs(e.clientY - drag.startY) > 4) drag.moved = true;
  drag.vx = (e.clientX - drag.lastX) / Math.max(1, t - drag.lastT);   // px per ms
  drag.lastX = e.clientX; drag.lastT = t;
  paint(drag.el, drag.dx);
}
function onPointerUp() {
  if (!drag.active) return;
  const card = drag.el;
  endDrag();
  const { dx, vx } = drag;
  if (!drag.moved) { settle(card); openDetail(state.deck[0]); return; }   // a plain click opens the recipe
  const fling = Math.abs(vx) > 0.6;
  if (dx > THRESHOLD || (fling && vx > 0 && dx > 30)) commit('cook', dx);
  else if (dx < -THRESHOLD || (fling && vx < 0 && dx < -30)) commit('skip', dx);
  else springBack(card, dx, vx);
}
// Under-damped spring back to centre: it overshoots a little, which is the elastic feel.
function springBack(card, x, vMs) {
  if (reduceMotion) { settle(card); return; }
  let pos = x, vel = vMs * 400, last = performance.now();
  const k = 180, c = 14;
  const step = t => {
    const dt = Math.min(0.032, (t - last) / 1000); last = t;
    vel += (-k * pos - c * vel) * dt;
    pos += vel * dt;
    paint(card, pos);
    if (Math.abs(pos) < 0.5 && Math.abs(vel) < 5) { settle(card); return; }
    drag.raf = requestAnimationFrame(step);
  };
  drag.raf = requestAnimationFrame(step);
}

function commit(dir, fromDx = 0) {
  const a = state.deck[0];
  if (!a || state.leaving || state.sheet || state.panelOpen) return;
  // stop a spring or a live drag from painting over the fly-out
  cancelAnimationFrame(drag.raf);
  endDrag();
  state.leaving = true;
  const card = $('#deck .pos0');
  if (card) {
    const x = dir === 'cook' ? 900 : -900;
    card.classList.remove('dragging', 'enter');
    card.classList.add('leaving');
    card.style.transition = reduceMotion ? 'none' : 'transform .45s cubic-bezier(.3,.7,.4,1), opacity .25s ease .2s';
    card.style.transform = `translateX(${x}px) rotate(${x * 0.05}deg)`;
    card.style.opacity = '0';
    $('.overlay.' + dir, card).style.opacity = 1;
    $('.overlay.' + (dir === 'cook' ? 'skip' : 'cook'), card).style.opacity = '';
  }
  if (dir === 'skip') state.skipped.add(a.dish.id);
  else state.chosen.add(a.dish.id);   // cook: it joins tonight's list and leaves the deck
  setTimeout(() => {
    state.leaving = false;
    renderAll();
    // the recipe opens, unless the user went somewhere else in the meantime
    if (dir === 'cook' && !state.sheet && !state.panelOpen) openDetail(a);
  }, reduceMotion ? 0 : 400);
}

/* ---------- sheets (modals) ---------- */
// While a sheet or the panel is open the rest of the page is inert: no Tab into it, no clicks.
function syncInert() {
  const modal = !!(state.sheet || state.panelOpen);
  for (const n of $$('.topbar, .stage, .foot')) n.inert = modal;
  el.panel.inert = !state.panelOpen;
}
// The file input lives in the dropzone while the upload sheet is open; park it before the sheet's markup is replaced.
function parkFileInput() {
  if (el.sheet.contains(el.file)) document.body.appendChild(el.file);
}
function openSheet(kind, html, cls = '') {
  if (!state.sheet) state.sheetReturn = document.activeElement;   // first open only: sheet-to-sheet keeps the original trigger
  state.sheet = kind;
  parkFileInput();
  el.sheet.className = `sheet glass ${cls}`;
  el.sheet.innerHTML = html;
  const h = $('h2', el.sheet);
  if (h) { h.id = h.id || 'sheet-title'; el.sheet.setAttribute('aria-labelledby', h.id); }
  else el.sheet.removeAttribute('aria-labelledby');
  el.sheet.hidden = false;
  el.veil.hidden = false;
  syncInert();
  void el.sheet.offsetWidth;   // force a reflow so the transition runs even when animation frames are paused
  el.sheet.classList.add('in'); el.veil.classList.add('in');
  setTimeout(() => el.sheet.focus({ preventScroll: true }), 50);   // focus the dialog itself; Tab moves into it
}
function closeSheet() {
  if (!state.sheet) return;
  // Dismissing the onboarding (Escape, veil, the close button) counts as "skip for now":
  // whatever they had chosen so far is kept, and it will not open by itself again.
  if (state.sheet === 'onboarding' && draft) return finishOnboarding();
  state.sheet = null;
  syncInert();
  el.sheet.classList.remove('in');
  if (!state.panelOpen) el.veil.classList.remove('in');
  // hand focus back to whatever opened the sheet, unless the user already clicked somewhere else
  const back = state.sheetReturn; state.sheetReturn = null;
  if (back && back.isConnected && (el.sheet.contains(document.activeElement) || document.activeElement === document.body)) back.focus({ preventScroll: true });
  setTimeout(() => {
    if (!state.sheet) { parkFileInput(); el.sheet.hidden = true; el.sheet.innerHTML = ''; }
    if (!state.sheet && !state.panelOpen) el.veil.hidden = true;
  }, reduceMotion ? 0 : 220);
}
const closeBtn = (extra = '') => `<button class="circle sm glass muted close ${extra}" type="button" data-close aria-label="Close">${ICON.x}</button>`;

/* ---------- scan: upload ---------- */
function openScanUpload() {
  openSheet('upload', `
    <div class="sheet-head"><h2>Scan a receipt</h2>${closeBtn()}</div>
    <div class="sheet-body">
      <label class="dropzone drop" id="dropzone" for="file-input">
        <span class="icon-ring">${ICON.upload}</span>
        <strong>Drop a receipt or click to browse</strong>
        <small>Photos and PDFs · one receipt at a time</small>
      </label>
      <div class="sheet-note">
        <span>${apiConfigured() ? 'Items, prices and dates are read with Gemini.' : 'Backend offline — use the sample receipt, or set apiBaseUrl.'}</span>
        <button class="linkish accent" type="button" data-sample>Use sample receipt</button>
      </div>
    </div>`);
  const zone = $('#dropzone');
  zone.prepend(el.file);   // keyboard users tab onto the real input; the label is its name
  ['dragenter', 'dragover'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) startProcessing(f); });
}
el.file.addEventListener('change', () => { const f = el.file.files[0]; if (f) startProcessing(f); el.file.value = ''; });

/* ---------- scan: processing ---------- */
function receiptHTML(file) {
  if (file && file.type.startsWith('image/')) return `<img src="${URL.createObjectURL(file)}" alt="">`;
  const rows = [
    '<div class="b"><span>WHOLE FOODS MARKET</span></div>', '<div><span>SEP 19 2026  6:42 PM</span></div>', '<hr>',
    ...SAMPLE_RECEIPT.lines.map(l => `<div><span>${esc(l.raw)}</span><span>${l.price.toFixed(2)}</span></div>`),
    '<hr>', `<div class="b"><span>TOTAL</span><span>${SAMPLE_RECEIPT.total.toFixed(2)}</span></div>`,
  ];
  return `<div class="receipt-lines">${rows.join('')}</div>`;
}
async function startProcessing(file) {
  const usingSample = !file;
  const steps = usingSample
    ? [
      ['Reading items', '17 lines found, 2 look like non-food'],
      ['Estimating shelf life', 'Milk, spinach, chicken thighs…'],
      ['Finding recipes', 'Dishes that use what expires first'],
    ]
    : [
      ['Reading items', 'Sending your receipt to the AI parser'],
      ['Estimating shelf life', 'Servings, burn rate, and use-by dates'],
      ['Finding recipes', 'We’ll refresh the deck once it’s in your pantry'],
    ];
  openSheet('processing', `
    <div class="sheet-head"><h2>Reading your receipt</h2>${closeBtn()}</div>
    <div class="sheet-body">
      <div class="processing">
        <div class="receipt">${receiptHTML(file)}<div class="receipt-tint"></div><div class="scanline"></div></div>
        <div class="steps">${steps.map(([t, s]) => `<div class="step"><span class="mark">${ICON.checkMd}</span><div><strong>${t}</strong><small>${s}</small></div></div>`).join('')}</div>
      </div>
      <div class="sheet-note">
        <span>${usingSample
          ? (apiConfigured() ? 'Sample receipt — skip the camera when you just want to try the flow.' : 'Demo mode: sample receipt (API not configured).')
          : 'Parsing with Gemini. Keep this tab open.'}</span>
        <button class="linkish" type="button" data-back-upload>Cancel</button>
      </div>
    </div>`);
  const stepEls = $$('.step', el.sheet);

  if (usingSample) {
    for (let i = 0; i < stepEls.length; i++) {
      if (state.sheet !== 'processing') return;
      stepEls[i].classList.add('active');
      await wait(1100);
      stepEls[i].classList.remove('active');
      stepEls[i].classList.add('done');
    }
    if (state.sheet !== 'processing') return;
    await wait(250);
    lastReceipt = { store: SAMPLE_RECEIPT.store, date: SAMPLE_RECEIPT.date, total: SAMPLE_RECEIPT.total };
    openReview(SAMPLE_RECEIPT.lines.map(l => ({ ...l, id: uid(), dropped: false })));
    return;
  }

  if (!apiConfigured()) {
    toast('Backend not configured', 'Set apiBaseUrl in shared/config.js');
    return openScanUpload();
  }

  // Animate steps while the request runs
  let stepIdx = 0;
  stepEls[0]?.classList.add('active');
  const tick = setInterval(() => {
    if (state.sheet !== 'processing') return;
    if (stepEls[stepIdx]) {
      stepEls[stepIdx].classList.remove('active');
      stepEls[stepIdx].classList.add('done');
    }
    stepIdx = Math.min(stepIdx + 1, stepEls.length - 1);
    stepEls[stepIdx]?.classList.add('active');
  }, 1400);

  try {
    const parsed = await scanReceipt(file);
    clearInterval(tick);
    if (state.sheet !== 'processing') return;
    stepEls.forEach(s => { s.classList.remove('active'); s.classList.add('done'); });
    await wait(200);
    lastReceipt = {
      store: parsed.store_name || 'Grocery store',
      date: formatReceiptDate(parsed.purchase_date),
      total: Number(parsed.total) || 0,
    };
    const lines = (parsed.items || []).map(lineFromScanItem);
    if (!lines.length) {
      toast('No food items found', 'Try a clearer photo');
      return openScanUpload();
    }
    openReview(lines);
  } catch (err) {
    clearInterval(tick);
    console.warn('[pantry] scan failed', err);
    toast('Couldn’t read that receipt', String(err.message || err));
    if (state.sheet === 'processing') openScanUpload();
  }
}

/* ---------- scan: review ---------- */
let review = [];
function openReview(lines) {
  review = lines;
  openSheet('review', `
    <div class="sheet-head"><h2 id="review-title">Review items</h2>${closeBtn()}</div>
    <div class="sheet-sub"><span>${esc(lastReceipt.store)}</span><i></i><span>${esc(lastReceipt.date)}</span><i></i><span>Click a row to edit it</span></div>
    <div class="rlist scroll" id="rlist"></div>
    <div class="sheet-foot" style="flex-direction:column;align-items:stretch">
      <div class="summary"><span id="review-summary"></span><b>$${Number(lastReceipt.total).toFixed(2)}</b></div>
      <button class="pill prominent full" type="button" data-add-pantry>${ICON.checkMd}<span>Add to pantry</span></button>
    </div>`);
  renderReview(true);
}
// Rebuilding a list destroys the focused button; remember which row it was in and refocus the same row.
function focusIndexIn(container, rowSel) {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;
  const rows = $$(rowSel, container);
  return { idx: rows.findIndex(r => r.contains(active)), keyboard: active.matches(':focus-visible') };
}
function restoreFocusIn(container, rowSel, mem, fallback) {
  if (!mem) return;
  const rows = $$(rowSel, container);
  const row = mem.keyboard && mem.idx >= 0 ? rows[Math.min(mem.idx, rows.length - 1)] : null;
  const target = row && (row.matches('button') ? row : $('button', row));
  (target || fallback).focus({ preventScroll: true });
}
function renderReview(animate = false) {
  const list = $('#rlist');
  const mem = focusIndexIn(list, '.rrow');
  const food = review.filter(l => !l.nonFood && !l.dropped);
  const nonfood = review.filter(l => l.nonFood);
  let i = 0;
  const delay = () => animate ? `style="animation-delay:${(i++) * 60}ms"` : 'style="animation:none"';
  const rows = food.map(l => {
    if (l.editing) {
      return `<div class="rrow edit" data-id="${l.id}">
        <form class="editor" data-edit="${l.id}">
          <label class="sr-only" for="e-name-${l.id}">Name</label>
          <input id="e-name-${l.id}" class="field" name="name" value="${esc(l.name)}" autofocus>
          <label class="sr-only" for="e-qty-${l.id}">Quantity</label>
          <input id="e-qty-${l.id}" class="field short" name="qty" value="${esc(l.qty || '')}">
          <button class="pill prominent sm" type="submit">Save</button>
          <button class="linkish" type="button" data-canceledit="${l.id}">Cancel</button>
        </form></div>`;
    }
    if (l.low && !l.fixed) {
      return `<div class="rrow low" data-id="${l.id}" ${delay()}>
        <div class="main" style="padding:0">
          <div class="name"><strong class="raw">${esc(l.raw)}</strong><small>Couldn’t read this line cleanly</small></div>
          <span class="qty">$${l.price.toFixed(2)}</span>
        </div>
        <div class="fixes">
          <button class="pill glass sm" type="button" data-fix="${l.id}">${ICON.checkSm}<span>${esc(l.name)}, ${esc(l.qty)}</span></button>
          <button class="linkish" type="button" data-editrow="${l.id}">Edit</button>
          <button class="linkish" type="button" data-drop="${l.id}">Drop</button>
        </div></div>`;
    }
    return `<div class="rrow" data-id="${l.id}" ${delay()}>
      <button class="main" type="button" data-editrow="${l.id}">
        <div class="name"><strong>${esc(l.name)}</strong><small>${esc(estimateLabel(l.key, l))}</small></div>
        <span class="qty">${esc(l.qty || '')}</span>
      </button>
      <button class="circle sm glass del" type="button" data-drop="${l.id}" aria-label="Remove ${esc(l.name)}">${ICON.trash}</button>
    </div>`;
  });
  if (nonfood.length) {
    rows.push(`<button class="rrow collapsed ${state.nonfoodOpen ? 'open' : ''}" type="button" data-toggle-nonfood ${delay()}>
      <span class="main"><span class="chev">${ICON.chevron}</span><span>${plural(nonfood.length, 'non-food item')} ignored</span><small>${esc(nonfood.map(n => n.name.toLowerCase()).join(', '))}</small></span>
    </button>`);
    if (state.nonfoodOpen) nonfood.forEach(l => rows.push(`<div class="rrow nonfood" data-id="${l.id}" style="animation:none"><div class="main"><div class="name"><strong>${esc(l.name)}</strong><small>${esc(l.raw)}</small></div><span class="qty">$${l.price.toFixed(2)}</span></div></div>`));
  }
  list.innerHTML = rows.join('');
  $('#review-title').textContent = `Review ${plural(food.length, 'item')}`;
  const before = new Set(buildDeck().map(a => a.dish.id));
  const fresh = countNewDishes(food, before);
  $('#review-summary').textContent = `${plural(food.length, 'item')} · ${plural(fresh, 'new dish', 'new dishes')} possible`;
  const focus = $('input[autofocus]', list);
  if (focus) { focus.focus(); focus.select(); }
  else restoreFocusIn(list, '.rrow', mem, el.sheet);
}
function estimateLabel(key, line) {
  if (line && line.expiry) {
    const dl = (line.expiry - Date.now()) / DAY;
    if (dl <= 7) {
      const d = new Date(line.expiry);
      return `expires ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    }
    return timeLabel(dl);
  }
  const c = catalog(key);
  const dl = c.shelf;
  if (dl <= 7) { const d = new Date(Date.now() + dl * DAY); return `expires ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`; }
  return timeLabel(dl);
}
// How many dishes would become makeable if these lines were added (dry run).
function countNewDishes(lines, before) {
  const saved = state.pantry;
  state.pantry = saved.concat(lines.filter(l => !findItem(l.key)).map(l => mk(l.name, l.key, l.qty, 0)));
  const after = activeDishes().filter(passesPrefs).map(analyze).filter(eligible).map(a => a.dish.id);
  state.pantry = saved;
  return after.filter(id => !before.has(id)).length;
}
function addToPantry() {
  const food = review.filter(l => !l.nonFood && !l.dropped);
  for (const l of food) {
    addLot(l.name, l.key, l.qty, l.raw, {
      initial: l.initial,
      burn: l.burn,
      purchase: l.purchase,
      expiry: l.expiry,
      variant: l.variant,
    });
  }
  closeSheet();
  renderAll({ enter: true });
  logReceipt({ store: lastReceipt.store, total: lastReceipt.total, scannedAt: Date.now(), itemCount: food.length });
  toast(`${plural(food.length, 'item')} added`, apiConfigured() ? 'Finding recipes…' : 'Deck updated');
  refreshRecipes().then(list => {
    if (list.length) toast(`${plural(food.length, 'item')} added`, `${plural(list.length, 'recipe')} ready`);
    else toast(`${plural(food.length, 'item')} added`, 'Deck updated');
  });
}

/* ---------- recipe detail and Made It ---------- */
// Takes a deck analysis or a bare dish. The Tonight list is the one sheet allowed to open it sheet-to-sheet.
function openDetail(a) {
  if (!a || state.leaving) return;
  if (state.sheet && state.sheet !== 'tonight') return;
  a = analyze(a.dish || a);
  const d = a.dish;
  openSheet('detail', `
    <div class="hero">
      <img src="${d.img}" alt="">
      ${a.badge ? `<div class="badge glass ${a.badge.level}"><span class="dot"></span><span>${esc(a.badge.text)}</span></div>` : ''}
      ${closeBtn()}
      <div class="hero-text">
        <h2>${esc(d.name)}</h2>
        <div class="meta"><span>${d.time}</span><i></i><span>${plural(d.servings, 'serving')}</span><i></i>${difficultyHTML(d)}${a.missing.length ? `<i></i><span>${plural(a.missing.length, 'thing missing', 'things missing')}</span>` : ''}</div>
        ${(a.warn.length || a.stretch) ? `<div class="chips">${warnChips(a)}</div>` : ''}
      </div>
    </div>
    <div class="detail-body scroll">
      <div class="ings">
        <div class="eyebrow">Ingredients</div>
        ${a.have.map(i => `<div class="ing have"><span class="mark">${ICON.checkSm}</span><span class="n">${esc(i.name)}</span><span class="a">${esc(i.amt)}</span></div>`).join('')}
        ${a.missing.length ? `<div class="divider"><span>You’ll need</span></div>` + a.missing.map(i => `<div class="ing need"><span class="mark"></span><span class="n">${esc(i.name)}</span><span class="a">${esc(i.amt)}</span></div>`).join('') : ''}
      </div>
      <div class="ings">
        <div class="eyebrow">Steps</div>
        <ol class="stepslist">${d.steps.map((s, i) => `<li><span class="num glass">${i + 1}</span><span>${esc(s)}</span></li>`).join('')}</ol>
      </div>
    </div>
    <div class="sheet-foot">
      <button class="linkish" type="button" data-close>Back to deck</button>
      <button class="pill prominent lg" type="button" data-madeit="${d.id}">${ICON.checkMd}<span>I made this</span></button>
    </div>`, 'w-720');
}
// Tonight: one dish opens straight into its recipe; more than one gets a short list first.
function openTonight() {
  const dishes = chosenDishes().reverse();   // most recently chosen first
  if (!dishes.length) return;
  if (dishes.length === 1) return openDetail(dishes[0]);
  openSheet('tonight', `
    <div class="sheet-head"><h2>Tonight</h2>${closeBtn()}</div>
    <div class="sheet-sub"><span>${plural(dishes.length, 'dish', 'dishes')} picked</span><i></i><span>Open one to see the recipe</span></div>
    <div class="rlist scroll" style="padding-top:14px">
      ${dishes.map(d => `<div class="rrow" style="animation:none">
        <button class="main" type="button" data-open-dish="${d.id}">
          <div class="name"><strong>${esc(d.name)}</strong><small>${d.time} · ${plural(d.servings, 'serving')} · ${d.difficulty}</small></div>
          <span class="chev">${ICON.chevron}</span>
        </button></div>`).join('')}
    </div>
    <div class="sheet-foot"><button class="linkish" type="button" data-close>Back to deck</button></div>`, 'w-520');
}
function openMadeIt(dishId) {
  const a = analyze(dishById(dishId));
  const rows = a.have.map(i => {
    const cur = i.avail;
    const after = cur - i.need;
    const last = after <= OUT;
    const lots = lotsFor(i.key).filter(it => !needsCheckin(it) && current(it) > 0);
    let note;
    if (i.item.burn > 0 && i.item.initial >= 20) note = 'Staple, barely moves';
    else if (last) note = 'This uses the last of it';
    else if (lots.length > 1) note = `Uses oldest pack first · ${Math.round(after)} left after`;
    else note = `${Math.round(after)} left after this`;
    return { ...i, cur, last, note };
  });
  openSheet('madeit', `
    <div class="sheet-head"><h2>Update your pantry</h2>${closeBtn()}</div>
    <div class="sheet-sub"><span>${esc(a.dish.name)}</span><i></i><span>uncheck anything you skipped</span></div>
    <div class="sheet-body">
      <div class="deduct" id="deduct">
        ${rows.map(r => `<label><input class="chk" type="checkbox" checked data-key="${esc(r.key)}" data-last="${r.last ? 1 : 0}">
          <span class="name"><strong>${esc(r.name)}</strong><small class="${r.last ? 'warn' : ''}">${esc(r.note)}</small></span>
          <span class="amt">${r.need} of ${Math.round(r.cur)}</span></label>`).join('')}
      </div>
    </div>
    <div class="sheet-foot" style="flex-direction:column;align-items:stretch;gap:12px">
      <div class="sheet-note"><span id="deduct-summary"></span></div>
      <button class="pill prominent full" type="button" data-done="${a.dish.id}">${ICON.checkMd}<span>Done</span></button>
    </div>`, 'w-520');
  updateDeductSummary();
}
function updateDeductSummary() {
  const boxes = $$('#deduct input');
  const on = boxes.filter(b => b.checked);
  const out = on.filter(b => b.dataset.last === '1').map(b => $('strong', b.parentElement).textContent.toLowerCase());
  boxes.forEach(b => { const s = $('small', b.parentElement); if (b.dataset.last === '1') s.classList.toggle('warn', b.checked); });
  $('#deduct-summary').textContent = `${plural(on.length, 'item')} will be updated` + (out.length ? `. You’ll be out of ${out.join(', ')}.` : '.');
}
function finishMadeIt(dishId) {
  const dish = dishById(dishId);
  const checked = $$('#deduct input').filter(b => b.checked).map(b => b.dataset.key);
  const ranOut = [];
  const used = [];
  for (const i of dish.ingredients) {
    if (!checked.includes(i.key)) continue;
    const batch = deductServings(i.key, i.need);
    if (!batch.length) continue;
    used.push(...batch);
    if (available(i.key) <= OUT) ranOut.push(i.name.toLowerCase());
  }
  state.chosen.delete(dishId);
  state.cooked.add(dishId);
  closeSheet();
  renderAll({ enter: true });
  toast('Pantry updated', `${plural(checked.length, 'item')} used`, ranOut.length ? `You’re out of ${ranOut.join(', ')}.` : '');
  logCook({ recipeId: dish.id, title: dish.name, items: used });
  refreshRecipes();
}

/* ---------- pantry panel ---------- */
function openPanel() {
  if (!state.panelOpen) state.panelReturn = document.activeElement;
  state.panelOpen = true;
  renderPanel();
  el.panel.setAttribute('aria-hidden', 'false');
  el.count.setAttribute('aria-expanded', 'true');
  el.veil.hidden = false;
  syncInert();
  void el.panel.offsetWidth;   // same reflow trick as openSheet
  el.panel.classList.add('in'); el.veil.classList.add('in');
  setTimeout(() => el.panel.focus({ preventScroll: true }), 50);
}
function closePanel() {
  if (!state.panelOpen) return;
  state.panelOpen = false;
  syncInert();
  el.panel.classList.remove('in');
  el.panel.setAttribute('aria-hidden', 'true');
  el.count.setAttribute('aria-expanded', 'false');
  if (!state.sheet) { el.veil.classList.remove('in'); setTimeout(() => { if (!state.sheet && !state.panelOpen) el.veil.hidden = true; }, reduceMotion ? 0 : 400); }
  $('#add-form').hidden = true;
  $('#btn-add').setAttribute('aria-expanded', 'false');
  state.pantry.forEach(it => { it.asking = false; });   // a half-finished check-in starts over next time
  renderAll();
  const back = state.panelReturn; state.panelReturn = null;
  if (back && back.isConnected && (el.panel.contains(document.activeElement) || document.activeElement === document.body)) back.focus({ preventScroll: true });
}
function boughtLabel(it) {
  const d = new Date(it.purchase);
  return `bought ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
function lotLabel(it) {
  const bits = [];
  if (it.variant) bits.push(it.variant);
  bits.push(boughtLabel(it));
  if (it.qty) bits.push(it.qty);
  return bits.join(' · ');
}
function stackDisplayName(lots) {
  const names = [...new Set(lots.map(l => l.name))];
  if (names.length === 1) return names[0];
  // Prefer the shortest / most generic label for the stack header
  return names.sort((a, b) => a.length - b.length)[0];
}
function prowHTML(it, { lot = false } = {}) {
  const f = freshness(it);
  const cur = current(it);
  const sub = lot
    ? `${esc(lotLabel(it))} · about ${plural(Math.max(1, Math.round(cur)), 'serving')}`
    : `${esc(it.qty)}${it.qty ? ' · ' : ''}about ${plural(Math.max(1, Math.round(cur)), 'serving')}`;
  return `<div class="prow${lot ? ' lot' : ''}" data-id="${it.id}">
    <div class="name"><strong>${esc(lot && it.variant ? it.variant : it.name)}</strong><small>${sub}</small></div>
    <div class="fresh"><div class="bar ${f.level}"><i style="width:${Math.max(4, Math.round(f.pct * 100))}%"></i></div><small>${esc(f.label)}</small></div>
    <button class="circle sm glass del" type="button" data-remove="${it.id}" aria-label="Remove ${esc(it.name)}">${ICON.xSm}</button>
  </div>`;
}
function stackHTML(lots) {
  if (lots.length === 1) return prowHTML(lots[0]);
  const key = lots[0].key;
  const open = state.expanded.has(key);
  const primary = lots.slice().sort((a, b) => a.expiry - b.expiry)[0];
  const f = freshness(primary);
  const total = lots.reduce((s, it) => s + current(it), 0);
  const name = stackDisplayName(lots);
  return `<div class="prow stack${open ? ' open' : ''}" data-key="${esc(key)}">
    <button class="stack-main" type="button" data-toggle-stack="${esc(key)}" aria-expanded="${open}">
      <span class="chev">${ICON.chevron}</span>
      <div class="name"><strong>${esc(name)}</strong><small>${plural(lots.length, 'pack')} · about ${plural(Math.max(1, Math.round(total)), 'serving')}</small></div>
      <div class="fresh"><div class="bar ${f.level}"><i style="width:${Math.max(4, Math.round(f.pct * 100))}%"></i></div><small>${esc(f.label)}</small></div>
    </button>
  </div>
  <div class="lots">${lots.map(it => prowHTML(it, { lot: true })).join('')}</div>`;
}
function groupLots(items) {
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.key)) map.set(it.key, []);
    map.get(it.key).push(it);
  }
  return [...map.values()].map(lots => lots.sort((a, b) => a.expiry - b.expiry));
}
function renderPanel() {
  const mem = focusIndexIn(el.panelBody, '.checkin, .prow');
  const buckets = { checkin: [], soon: [], fresh: [], low: [] };
  // Place each food stack in the section of its most urgent lot
  for (const lots of groupLots(state.pantry.filter(it => !needsCheckin(it)))) {
    const primary = lots[0];
    const f = freshness(primary);
    if (f.mode === 'time' && f.level !== 'green') buckets.soon.push(lots);
    else if (f.mode === 'amount' && f.level !== 'green') buckets.low.push(lots);
    else buckets.fresh.push(lots);
  }
  buckets.checkin = state.pantry.filter(needsCheckin);
  const byStackUrgency = (a, b) => freshness(a[0]).urgency - freshness(b[0]).urgency;
  buckets.soon.sort(byStackUrgency); buckets.low.sort(byStackUrgency);
  buckets.fresh.sort((a, b) => daysLeft(a[0]) - daysLeft(b[0]));
  const section = (title, stacks) => stacks.length
    ? `<section class="psection"><div class="phead"><span class="eyebrow">${title}</span><small>${stacks.length}</small></div>${stacks.map(stackHTML).join('')}</section>`
    : '';
  const checkin = buckets.checkin.map(it => {
    const ranOut = it.burn > 0 ? Math.min(0, Math.round(((it.initial - it.deducted - OUT) / burnRate(it)) - (Date.now() - it.purchase) / DAY)) : 0;
    const when = it.deducted > 0 ? 'used up cooking' : ranOut === 0 ? 'we estimate it ran out today' : ranOut === -1 ? 'we estimate it ran out yesterday' : `we estimate it ran out ${-ranOut} days ago`;
    if (it.asking) {
      return `<div class="checkin" data-id="${it.id}">
        <div class="eyebrow">How much ${esc(it.name.toLowerCase())} is left?</div>
        <div class="opts">
          <button class="pill glass sm" type="button" data-some="${it.id}" data-frac=".5">About half</button>
          <button class="pill glass sm" type="button" data-some="${it.id}" data-frac=".25">About a quarter</button>
          <button class="pill glass sm" type="button" data-some="${it.id}" data-frac=".1">Almost none</button>
          <button class="pill glass sm" type="button" data-gone="${it.id}">None, it’s gone</button>
          <button class="linkish" type="button" data-unask="${it.id}">Back</button>
        </div></div>`;
    }
    return `<div class="checkin" data-id="${it.id}">
      <div class="eyebrow">Still have this?</div>
      <div class="item"><strong>${esc(it.name)}</strong><small>${esc(it.qty)}${it.qty ? ' · ' : ''}${when}</small></div>
      <div class="opts">
        <button class="pill glass sm" type="button" data-gone="${it.id}">All gone</button>
        <button class="pill prominent sm" type="button" data-ask="${it.id}">Still have some</button>
      </div></div>`;
  }).join('');
  el.panelBody.innerHTML = checkin + section('Use soon', buckets.soon) + section('Running low', buckets.low) + section('Fresh', buckets.fresh)
    || '<p class="empty-note">Nothing here yet. Scan a receipt or add something by hand.</p>';
  restoreFocusIn(el.panelBody, '.checkin, .prow', mem, el.panel);
}

/* ---------- toast ---------- */
// The element is always present (role=status), so only its content changes.
let toastTimer = 0, hideTimer = 0;
function toast(main, sub = '', line2 = '') {
  clearTimeout(toastTimer); clearTimeout(hideTimer);
  el.toast.innerHTML = `<span class="tick">${ICON.checkMd}</span><span class="lines"><span class="l1"><span>${esc(main)}</span>${sub ? `<i></i><span>${esc(sub)}</span>` : ''}</span>${line2 ? `<span class="l2">${esc(line2)}</span>` : ''}</span>`;
  el.toast.classList.add('in');
  toastTimer = setTimeout(() => { el.toast.classList.remove('in'); hideTimer = setTimeout(() => { el.toast.innerHTML = ''; }, 300); }, 4500);
}

/* ---------- profile: who is signed in, and how they like to cook ---------- */
let user = null;          // the Supabase auth user; null in demo mode
let draft = null;         // preferences being edited while the onboarding sheet is open
let obStep = 0;           // which onboarding step is showing
let avatarKey = null;     // what the avatar button currently shows, so auth events don't repaint it needlessly

const labelOf = (opts, id) => { const o = opts.find(x => x.id === id); return o ? o.label : id; };
const labelsOf = (opts, ids) => ids.map(id => labelOf(opts, id));
const SKILL_HELP = {
  beginner: 'Few steps, one pan, nothing fussy',
  comfortable: 'A knife, a couple of pans, a bit of timing',
  confident: 'Techniques and long simmers are welcome',
};

const meta = u => (u && u.user_metadata) || {};
function displayName(u) {
  const m = meta(u);
  const email = (u && u.email) || m.email || '';
  return String(m.full_name || m.name || email.split('@')[0] || '').trim() || 'You';
}
function photoUrl(u) {
  const url = String(meta(u).avatar_url || meta(u).picture || '');
  return /^https?:\/\//i.test(url) ? url : '';
}
// What goes inside an avatar circle: the Google photo, else the initial, else a person icon (demo mode).
function avatarHTML(u, { photo = true, icon = ICON.person } = {}) {
  const url = photo ? photoUrl(u) : '';
  if (url) return `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer" draggable="false">`;
  const letter = u ? displayName(u).charAt(0).toUpperCase() : '';
  return letter ? `<span aria-hidden="true">${esc(letter)}</span>` : icon;
}
function renderAvatar() {
  const key = user ? `${user.id}|${photoUrl(user)}|${displayName(user)}` : 'demo';
  if (key === avatarKey) return;
  avatarKey = key;
  el.profile.innerHTML = avatarHTML(user);
  const img = $('img', el.profile);
  // a photo that won't load (blocked, expired) falls back to the initial
  if (img) img.addEventListener('error', () => { el.profile.innerHTML = avatarHTML(user, { photo: false }); }, { once: true });
}

function openProfile() {
  if (state.sheet) return;
  const demo = !user;
  const provider = user && user.app_metadata && user.app_metadata.provider;
  const head = demo
    ? `<div class="profile-head">
        <span class="avatar glass lg" aria-hidden="true">${ICON.personBig}</span>
        <div class="who"><h2>Demo mode</h2><small>Your pantry stays in this browser.</small></div>
      </div>`
    : `<div class="profile-head">
        <span class="avatar glass lg" aria-hidden="true">${avatarHTML(user, { icon: ICON.personBig })}</span>
        <div class="who"><h2>${esc(displayName(user))}</h2><small>${esc(user.email || meta(user).email || '')}</small></div>
      </div>`;
  // Account line in the footer: Sign out with an account, Sign in in demo mode
  // (only when there is a Supabase project to sign in to).
  const account = demo
    ? (configured ? `<div class="sheet-note"><span>Sign in to keep your pantry on every device.</span><a class="pill prominent sm" href="../login/">Sign in</a></div>` : '')
    : `<div class="sheet-note"><span>${provider === 'google' ? 'Signed in with Google' : 'Signed in with email'}</span><button class="linkish" type="button" data-signout>Sign out</button></div>`;
  openSheet('profile', `
    <div class="sheet-head">${head}${closeBtn()}</div>
    <div class="sheet-body">
      <div class="pref">
        <div class="eyebrow">How you cook</div>
        ${summaryHTML(state.prefs, { edit: 'data-ob-edit' })}
      </div>
    </div>
    ${account ? `<div class="sheet-foot" style="flex-direction:column;align-items:stretch">${account}</div>` : ''}`, 'w-520');
}
// The preferences as six short rows; the profile sheet and the last onboarding step share them.
function prefsSummary(p) {
  const { adults, kids } = p.household;
  const household = `${plural(adults, 'adult')}${kids ? `, ${plural(kids, 'kid')}` : ''} · dishes for ${servingsTarget(p)}`;
  const cant = [...labelsOf(ALLERGENS, p.allergies), ...labelsOf(DIETS, p.diet)].join(', ') || 'Nothing';
  const cuisines = labelsOf(CUISINES, p.cuisines).join(', ') || 'Anything';
  const time = p.maxMinutes ? `under ${p.maxMinutes} min` : 'any cook time';
  const kitchen = `${labelOf(SKILLS, p.skill)} cook · ${labelsOf(EQUIPMENT, p.equipment).join(', ').toLowerCase() || 'no equipment listed'} · shops ${labelOf(SHOPPING, p.shopping).toLowerCase()}`;
  // Each row's `step` is the onboarding step where its values are actually edited.
  return [
    { key: 'household', label: 'Household', value: household, step: 0 },
    { key: 'cant', label: 'Can’t eat', value: cant, step: 1 },
    { key: 'avoid', label: 'Would rather not eat', value: p.avoid || 'Nothing', step: 1 },
    { key: 'cuisines', label: 'Cuisines & time', value: `${cuisines} · ${time}`, step: 2 },
    { key: 'kitchen', label: 'Kitchen', value: kitchen, step: 3 },
  ];
}
// `edit` names the data attribute the Edit link carries (which handler picks it up), or '' for none.
function summaryHTML(p, { edit = '' } = {}) {
  return `<div class="srows">${prefsSummary(p).map(r => `
    <div class="srow">
      <div class="stext"><small>${esc(r.label)}</small><strong>${esc(r.value)}</strong></div>
      ${edit ? `<button class="linkish" type="button" ${edit}="${r.step}" data-focus="edit-${r.key}" aria-label="Edit ${esc(r.label.toLowerCase())}">Edit</button>` : ''}
    </div>`).join('')}</div>`;
}

/* ---------- onboarding: five short questions, asked once ----------
   The draft is kept until Continue on the last step, Skip, or a dismiss (Escape, veil,
   close), all of which save what was chosen so far and mark the onboarding done. */
const OB_STEPS = [
  { title: 'Who’s eating?', help: 'Dishes get sized for your table, and the pantry estimates run at your pace.' },
  { title: 'Anything you can’t eat?', help: 'Allergies never make it onto a card. Diets are always respected.' },
  { title: 'What do you like to cook?', help: 'Pick as many as you like. We lean toward them without hiding the rest.' },
  { title: 'Your kitchen', help: 'So nothing we suggest needs gear you don’t have.' },
  { title: 'You’re set', help: 'Here’s what we’ll cook around. Change any of it from your profile.' },
];

function householdLine(p) {
  const n = servingsTarget(p);
  const s = householdScale(p);
  const pct = Math.round(Math.abs(s - 1) * 100);
  const pace = pct === 0 ? 'at about the pace of a two-person household' : `about ${pct}% ${s > 1 ? 'faster' : 'slower'} than a two-person household`;
  return `We’ll size dishes for ${n} and expect the pantry to move ${pace}.`;
}
const chip = (attrs, on, label, focus) => `<button class="choice${on ? ' on' : ''}" type="button" aria-pressed="${on}" data-focus="${focus}" ${attrs}>${ICON.checkSm}<span>${esc(label)}</span></button>`;
const multiChips = (field, opts, p) => opts.map(o => chip(`data-ob-toggle="${field}" data-value="${o.id}"`, p[field].includes(o.id), o.label, `${field}-${o.id}`)).join('');
const singleChips = (field, opts, p) => opts.map(o => chip(`data-ob-set="${field}" data-value="${o.id}"`, p[field] === o.id, o.label, `${field}-${o.id}`)).join('');
const noneChip = (field, p, label) => chip(`data-ob-clear="${field}"`, p[field].length === 0, label, `${field}-none`);
const skillChip = (o, p) => `<button class="choice desc${p.skill === o.id ? ' on' : ''}" type="button" aria-pressed="${p.skill === o.id}" data-focus="skill-${o.id}" data-ob-set="skill" data-value="${o.id}">
  <span class="lbl">${ICON.checkSm}<strong>${esc(o.label)}</strong></span><small>${esc(SKILL_HELP[o.id] || '')}</small></button>`;
function stepperHTML(field, value, lim, label, help = '') {
  return `<div class="pref">
    <span class="pref-label" id="ob-${field}-label">${label}${help ? ` <small>${help}</small>` : ''}</span>
    <div class="stepper" role="group" aria-labelledby="ob-${field}-label">
      <button class="circle sm glass" type="button" data-ob-step="${field}" data-dir="-1" data-focus="${field}-down" aria-label="Fewer ${label.toLowerCase()}" aria-disabled="${value <= lim.min}">${ICON.minus}</button>
      <output class="num" aria-live="polite">${value}</output>
      <button class="circle sm glass" type="button" data-ob-step="${field}" data-dir="1" data-focus="${field}-up" aria-label="More ${label.toLowerCase()}" aria-disabled="${value >= lim.max}">${ICON.plus}</button>
    </div>
  </div>`;
}
function obStepHTML(p, step) {
  const group = (id, label, inner) => `<div class="pref"><span class="pref-label" id="${id}">${label}</span><div class="choices" role="group" aria-labelledby="${id}">${inner}</div></div>`;
  switch (step) {
    case 0: return `
      <div class="ob-row">
        ${stepperHTML('adults', p.household.adults, HOUSEHOLD_LIMITS.adults, 'Adults')}
        ${stepperHTML('kids', p.household.kids, HOUSEHOLD_LIMITS.kids, 'Kids', 'count as half a serving')}
      </div>
      <p class="ob-line" role="status" aria-live="polite">${householdLine(p)}</p>`;
    case 1: return `
      ${group('ob-allergies', 'Allergies', noneChip('allergies', p, 'None') + multiChips('allergies', ALLERGENS, p))}
      ${group('ob-diet', 'Diet', noneChip('diet', p, 'No restrictions') + multiChips('diet', DIETS, p))}
      <div class="pref">
        <label class="pref-label" for="ob-avoid">Would rather not eat</label>
        <input class="field" id="ob-avoid" data-focus="avoid" value="${esc(p.avoid)}" placeholder="cilantro, olives, blue cheese…" autocomplete="off" spellcheck="false">
        <small class="pref-help">Dislikes, not allergies: the dish stays, with a note. Separate with commas.</small>
      </div>`;
    case 2: return `
      ${group('ob-cuisines', 'Cuisines you enjoy', multiChips('cuisines', CUISINES, p))}
      ${group('ob-time', 'Most nights I have', TIME_LIMITS.map(m => chip(`data-ob-set="maxMinutes" data-value="${m}"`, p.maxMinutes === m, m === 0 ? 'Any amount of time' : `${m} min`, `time-${m}`)).join(''))}`;
    case 3: return `
      ${group('ob-skill', 'In the kitchen I’m', SKILLS.map(o => skillChip(o, p)).join(''))}
      ${group('ob-equipment', 'What you cook with', multiChips('equipment', EQUIPMENT, p))}
      ${group('ob-shopping', 'You shop', singleChips('shopping', SHOPPING, p))}`;
    default: return summaryHTML(p, { edit: 'data-ob-go' });
  }
}
function onboardingHTML(p, step) {
  const s = OB_STEPS[step];
  const last = step === OB_STEPS.length - 1;
  const editing = state.prefs.onboarded;   // reopened from the profile: "skip" really means "save and close"
  const dots = OB_STEPS.map((_, i) => `<i class="${i < step ? 'done' : i === step ? 'on' : ''}"></i>`).join('');
  return `
    <div class="ob-head">
      <div class="dots" aria-hidden="true">${dots}</div>
      <span class="sr-only">Step ${step + 1} of ${OB_STEPS.length}</span>
      ${closeBtn()}
    </div>
    <div class="sheet-body ob-body">
      <div class="ob-titles">
        <h2 class="ob-title" id="ob-title" tabindex="-1">${s.title}</h2>
        <p class="ob-help">${s.help}</p>
      </div>
      ${obStepHTML(p, step)}
    </div>
    <div class="sheet-foot ob-foot">
      <button class="linkish" type="button" data-ob-back data-focus="back" ${step === 0 ? 'hidden' : ''}>Back</button>
      ${last
        ? `<button class="pill prominent" type="button" data-ob-scan data-focus="next">${ICON.camera}<span>Scan a receipt</span></button>
           <button class="pill glass" type="button" data-ob-done data-focus="done">See tonight’s dishes</button>`
        : `<button class="pill prominent" type="button" data-ob-next data-focus="next"><span>Continue</span>${ICON.chevron}</button>
           <span class="grow"></span>
           <button class="linkish dim" type="button" data-ob-skip data-focus="skip">${editing ? 'Save and close' : 'Skip for now'}</button>`}
    </div>`;
}
function openOnboarding(step = 0) {
  if (state.sheet && state.sheet !== 'profile') return;   // the profile's Edit links open it sheet-to-sheet
  draft = normalizePrefs(state.prefs);
  obStep = clamp(Math.round(Number(step) || 0), 0, OB_STEPS.length - 1);
  openSheet('onboarding', `<div class="ob" id="onboard">${onboardingHTML(draft, obStep)}</div>`, 'w-720 ob-sheet');
}
// Rebuild the sheet from the draft. Every control carries a data-focus key so a keyboard
// user lands back on the same control after the rebuild; a new step starts at its title.
function renderOnboarding({ moved = false } = {}) {
  const box = $('#onboard');
  if (!box || !draft) return;
  const active = document.activeElement;
  const mem = box.contains(active) ? { key: active.dataset.focus, keyboard: active.matches(':focus-visible') } : null;
  const body = $('.sheet-body', box);
  const scrollTop = body ? body.scrollTop : 0;
  box.innerHTML = onboardingHTML(draft, obStep);
  if (moved) { $('#ob-title', box).focus({ preventScroll: true }); return; }
  const nb = $('.sheet-body', box);
  if (nb) nb.scrollTop = scrollTop;
  if (!mem) return;
  const target = mem.keyboard && mem.key ? $(`[data-focus="${mem.key}"]`, box) : null;
  (target || el.sheet).focus({ preventScroll: true });
}
// A chip, stepper or clear button inside the onboarding; returns false when the click was something else.
function obChange(t) {
  const d = t.dataset;
  if (d.obToggle) { const f = d.obToggle; draft[f] = draft[f].includes(d.value) ? draft[f].filter(x => x !== d.value) : [...draft[f], d.value]; }
  else if (d.obClear) draft[d.obClear] = [];
  else if (d.obSet) draft[d.obSet] = d.obSet === 'maxMinutes' ? Number(d.value) : d.value;
  else if (d.obStep) { const lim = HOUSEHOLD_LIMITS[d.obStep]; draft.household[d.obStep] = clamp(draft.household[d.obStep] + Number(d.dir), lim.min, lim.max); }
  else return false;
  renderOnboarding();
  return true;
}
function obGo(step) {
  obStep = clamp(step, 0, OB_STEPS.length - 1);
  renderOnboarding({ moved: true });
}
// `next`: 'scan' opens the scan sheet in place of the onboarding, 'deck' just closes; null is a skip or dismiss.
function finishOnboarding({ next = null } = {}) {
  if (!draft) return;
  const first = !state.prefs.onboarded;
  const before = JSON.stringify(state.prefs);
  state.prefs = normalizePrefs({ ...draft, onboarded: true });
  draft = null;
  savePrefs(state.prefs);
  const changed = JSON.stringify(state.prefs) !== before;
  if (next === 'scan') openScanUpload();   // sheet-to-sheet, the way Tonight opens a recipe
  else closeSheet();
  const finding = apiConfigured() && state.pantry.length ? 'Finding recipes…' : '';
  if (first && next) toast('You’re set', finding || 'Dishes sorted for you');
  else if (!first && changed) toast('Preferences saved', finding);
  // With the API up the regenerated recipes take a moment; filter the current deck by the new rules meanwhile.
  // Without it refreshRecipes() renders straight away, so a second render here would only replay the entrance.
  if (changed && finding) renderAll();
  refreshRecipes();
}
async function doSignOut(btn) {
  btn.disabled = true;
  btn.textContent = 'Signing out…';
  clearLocalPrefs();   // the next account on this browser starts from its own answers
  await signOut();
  location.replace('../login/');
}

/* =========================================================================
   Wiring
   ========================================================================= */
$('#btn-scan').addEventListener('click', openScanUpload);
el.profile.addEventListener('click', openProfile);
$('#btn-scan-2').addEventListener('click', openScanUpload);
$('#empty-drop').addEventListener('click', () => el.file.click());   // "click to browse" means the file picker
$('#empty-sample').addEventListener('click', () => startProcessing(null));
$('#btn-pantry').addEventListener('click', () => (state.panelOpen ? closePanel() : openPanel()));
$('#btn-close-panel').addEventListener('click', closePanel);
$('#btn-tonight').addEventListener('click', openTonight);
$('#btn-skip').addEventListener('click', () => commit('skip'));
$('#btn-cook').addEventListener('click', () => commit('cook'));
$('#btn-details').addEventListener('click', () => openDetail(state.deck[0]));
$('#btn-reshuffle').addEventListener('click', () => { state.skipped.clear(); state.chosen.clear(); renderAll({ enter: true }); });
$('#btn-end-prefs').addEventListener('click', openProfile);   // shown instead of Reshuffle when the preferences hid every dish
// One button, two jobs, so it is labelled from state (see renderAll) and says what it did
$('#btn-reset').addEventListener('click', () => {
  const fresh = state.pantry.length === 0;
  state.pantry = fresh ? seedPantry() : [];
  state.skipped.clear(); state.cooked.clear(); state.chosen.clear();
  clearLocal();
  closeSheet(); closePanel();
  renderAll({ enter: true });
  toast(fresh ? 'Demo pantry loaded' : 'Pantry cleared', fresh ? plural(state.pantry.length, 'item') : '');
  refreshRecipes();
});
// Hover preview of the swipe overlays: mouse only, a touch tap would leave it stuck
['cook', 'skip'].forEach(k => {
  const b = $(`#btn-${k}`);
  b.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') el.deck.classList.add(`preview-${k}`); });
  b.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') el.deck.classList.remove(`preview-${k}`); });
  b.addEventListener('blur', () => el.deck.classList.remove(`preview-${k}`));
});
// Drop a receipt anywhere on the first-run card
const emptyDrop = $('#empty-drop');
['dragenter', 'dragover'].forEach(t => emptyDrop.addEventListener(t, e => { e.preventDefault(); emptyDrop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => emptyDrop.addEventListener(t, e => { e.preventDefault(); emptyDrop.classList.remove('over'); }));
emptyDrop.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) startProcessing(f); });
// A file dropped anywhere else must not navigate the tab away from the app
const isFileDrag = e => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
document.addEventListener('dragover', e => { if (isFileDrag(e)) { e.preventDefault(); if (!e.target.closest('.drop')) e.dataTransfer.dropEffect = 'none'; } });
document.addEventListener('drop', e => { if (isFileDrag(e)) e.preventDefault(); });

el.veil.addEventListener('click', () => { closeSheet(); closePanel(); });

// Everything inside the sheet is delegated
el.sheet.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.hasAttribute('data-close')) return closeSheet();
  if (t.hasAttribute('data-sample')) return startProcessing(null);
  if (t.hasAttribute('data-back-upload')) return openScanUpload();
  if (t.hasAttribute('data-add-pantry')) return addToPantry();
  if (t.hasAttribute('data-toggle-nonfood')) { state.nonfoodOpen = !state.nonfoodOpen; return renderReview(); }
  if (t.dataset.drop) { const l = review.find(x => x.id === t.dataset.drop); if (l) l.dropped = true; return renderReview(); }
  if (t.dataset.fix) { const l = review.find(x => x.id === t.dataset.fix); if (l) l.fixed = true; return renderReview(); }
  if (t.dataset.editrow) { review.forEach(x => { x.editing = x.id === t.dataset.editrow; }); return renderReview(); }
  if (t.dataset.canceledit) { const l = review.find(x => x.id === t.dataset.canceledit); if (l) l.editing = false; return renderReview(); }
  if (t.dataset.openDish) return openDetail(dishById(t.dataset.openDish));
  if (t.dataset.madeit) return openMadeIt(t.dataset.madeit);
  if (t.dataset.done) return finishMadeIt(t.dataset.done);
  // onboarding
  if (state.sheet === 'onboarding' && draft) {
    if (obChange(t)) return;
    if (t.hasAttribute('data-ob-back')) return obGo(obStep - 1);
    if (t.hasAttribute('data-ob-next')) return obGo(obStep + 1);
    if (t.dataset.obGo !== undefined) return obGo(Number(t.dataset.obGo));
    if (t.hasAttribute('data-ob-skip')) return finishOnboarding();
    if (t.hasAttribute('data-ob-done')) return finishOnboarding({ next: 'deck' });
    if (t.hasAttribute('data-ob-scan')) return finishOnboarding({ next: 'scan' });
  }
  // profile sheet: each row's Edit reopens the matching onboarding step
  if (t.dataset.obEdit !== undefined) return openOnboarding(Number(t.dataset.obEdit));
  if (t.hasAttribute('data-signout')) return doSignOut(t);
});
// Typing in "Would rather not eat" updates the draft without a rebuild, so the caret stays put; Enter moves on
el.sheet.addEventListener('input', e => { if (draft && e.target.id === 'ob-avoid') draft.avoid = e.target.value; });
el.sheet.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing && draft && e.target.id === 'ob-avoid') { e.preventDefault(); obGo(obStep + 1); }
});
el.sheet.addEventListener('submit', e => {
  const form = e.target.closest('form[data-edit]');
  if (!form) return;
  e.preventDefault();
  const l = review.find(x => x.id === form.dataset.edit);
  if (l) {
    l.name = form.name.value.trim() || l.name;
    l.qty = form.qty.value.trim();
    l.key = CATALOG[l.name.toLowerCase()] ? l.name.toLowerCase() : l.key;
    l.editing = false; l.fixed = true;
  }
  renderReview();
});
el.sheet.addEventListener('change', e => { if (e.target.matches('#deduct input')) updateDeductSummary(); });

// Panel
el.panel.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  const item = id => state.pantry.find(x => x.id === id);
  if (t.dataset.toggleStack) {
    const key = t.dataset.toggleStack;
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    return renderPanel();
  }
  if (t.dataset.remove) { state.pantry = state.pantry.filter(x => x.id !== t.dataset.remove); renderAll(); return refreshRecipes(); }
  if (t.dataset.gone) { state.pantry = state.pantry.filter(x => x.id !== t.dataset.gone); renderAll(); return refreshRecipes(); }
  if (t.dataset.ask) { const it = item(t.dataset.ask); if (it) it.asking = true; return renderPanel(); }
  if (t.dataset.unask) { const it = item(t.dataset.unask); if (it) it.asking = false; return renderPanel(); }
  if (t.dataset.some) {
    const it = item(t.dataset.some);
    if (it) {
      // The check-in is a correction: reset the estimate from what they told us.
      it.initial = Math.max(1, catalog(it.key).servings * parseFloat(t.dataset.frac));
      it.purchase = Date.now(); it.deducted = 0; it.asking = false;
      it.expiry = Math.max(it.expiry, Date.now() + 2 * DAY);
    }
    renderAll();
    return refreshRecipes();
  }
});
$('#btn-add').addEventListener('click', () => {
  const f = $('#add-form');
  f.hidden = !f.hidden;
  $('#btn-add').setAttribute('aria-expanded', String(!f.hidden));
  if (!f.hidden) $('#add-name').focus();
});
$('#add-form').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#add-name').value.trim();
  if (!name) return;
  const key = name.toLowerCase();
  upsert(name.charAt(0).toUpperCase() + name.slice(1), key, $('#add-qty').value.trim());
  $('#add-name').value = ''; $('#add-qty').value = '';
  renderAll();
  toast(`${name} added`);
  refreshRecipes();
});

// Keyboard: arrows drive the deck, Escape closes whatever is open (even from inside a field)
document.addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'Escape') {
    // an open row editor is what Escape cancels, not the whole review
    if (state.sheet === 'review' && review.some(l => l.editing)) { review.forEach(l => { l.editing = false; }); renderReview(); return; }
    if (state.sheet) closeSheet(); else if (state.panelOpen) closePanel();
    return;
  }
  if (e.target.matches('input, textarea, select')) return;
  if (state.sheet || state.panelOpen || state.leaving || !state.deck.length) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); commit('skip'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); commit('cook'); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); openDetail(state.deck[0]); }
});

/* ---------- fit the deck to shorter laptop screens and narrower phones ---------- */
let fitScale = 1;
function fit() {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  if (vh <= 0 || window.innerHeight <= 0) return;             // hidden tab / pre-layout: keep the last value
  const avail = vh - 88 - 44 - 16;                             // minus top bar, footer, breathing room
  const need = 760;                                            // caption + 580 card + stack offset + buttons + hints
  fitScale = clamp(Math.min(avail / need, (vw - 32) / 420), 0.6, 1);
  document.documentElement.style.setProperty('--fit', String(fitScale));
}
window.addEventListener('resize', fit);
window.addEventListener('load', fit);
window.addEventListener('pageshow', fit);
fit();

/* ---------- go ---------- */
syncInert();
const session = await requireAuth('../login/');   // bounces to the login page when configured and signed out, unless ?demo
// A sign-in that returned through the landing page arrives with the tokens still in
// the URL; the client has read them by now, so take them out of the address bar.
if (/(^|[#&])(access_token|refresh_token)=/.test(location.hash) || /[?&]code=/.test(location.search)) {
  history.replaceState(null, '', location.pathname);
}
user = session && session.user ? session.user : null;
renderAvatar();
// Keep the avatar honest when the session changes under us: metadata saved, token refreshed, signed out in another tab.
onAuthChange((event, s) => { user = s && s.user ? s.user : null; renderAvatar(); });
const [saved, prefs] = await Promise.all([loadState(), loadPrefs()]);
state.prefs = prefs;   // before the first refreshRecipes(), so the deck already honours them
if (saved) {
  state.pantry = saved.pantry;
  state.skipped = new Set(saved.skipped);
  state.cooked = new Set(saved.cooked);
  state.chosen = new Set(saved.chosen);
} else {
  state.pantry = seedPantry();
}
renderAll({ enter: true });
refreshRecipes();
// First visit (a fresh sign-in, or once per browser in demo mode): ask the five questions before anything else.
if (!state.prefs.onboarded) openOnboarding();
window.pantry = { state, drag, session, openOnboarding, openProfile, get prefs() { return state.prefs; }, get user() { return user; } };   // module scope hides these; handy in the console
