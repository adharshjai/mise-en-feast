/* =========================================================================
   mise en feast — interactive prototype
   Receipt in, pantry out, dinner on screen. Everything is derived at read
   time: current quantity = initial − burn rate × days − what cooking used.
   Runs as an ES module so it can share the auth and storage layers.
   ========================================================================= */

import { requireAuth, signOut, configured, onAuthChange } from '../shared/supabase.js';
import {
  loadState, saveState, logCook, logReceipt, clearLocal, clearLocalPrefs, clearLocalSaved, clearLocalDeck,
  loadPrefs, savePrefs, prefsToRequest, normalizePrefs, servingsTarget, householdScale, ingredientHits,
  DEFAULT_PREFS, ALLERGENS, DIETS, CUISINES, EQUIPMENT, SKILLS, SHOPPING, TIME_LIMITS, HOUSEHOLD_LIMITS,
  loadSavedDishes, saveDish, removeDish, downscaleImage, SAMPLE_IDENTIFIED, loadDeck, saveDeck,
  loadShopping, saveShopping, clearLocalShopping, loadPlan, savePlan, clearLocalPlan,
  loadRatings, saveRatings, clearLocalRatings, loadCooked, saveCooked, clearLocalCooked, loadEvents, saveEvents, clearLocalEvents,
  titleKey, MAX_COOKED, MAX_EVENTS,
} from '../shared/store.js';
import { scanReceipt, fetchRecipes, fetchMealPlan, fetchSubstitutions, chat as chatApi, recipeDetail, identifyDish, apiConfigured } from '../shared/api.js';
import { matchIngredient, buildPantryIndex, normalizeName } from '../shared/ingredients.js';
import { UNIT_OPTIONS, parseQuantity, toCanonical, formatQuantity, standardizeAmount, scaleAmount, servingsFor, convertCanonical, convertQuantity } from '../shared/units.js';
import { dishSlug, needsGeneratedImage, applyDishImages, primeDishImages, clearDishImages, peekDishImage, warmDishImages } from '../shared/dish-images.js';
import { findDurations, highlightDurations, createTimer, formatRemaining } from '../shared/timers.js';
import { localSubstitutions } from '../shared/substitutions.js';
import { summarize, lotEvent, expiredLots, expiringSoon } from '../shared/report.js';

const DAY = 86400000;
const MIN_LIFE = DAY;           // a lot added today lives until at least tomorrow (see addLot)
const THRESHOLD = 120;          // px of drag that commits a swipe
const OUT = 0.5;                // servings at or below this count as "out"
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const fmt1 = n => Number(Number(n).toFixed(1)).toString();   // "1.5", never "1.4999999"
const uid = () => crypto.randomUUID();   // rows are keyed by uuid in storage too
const sentenceCase = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const listWords = arr => arr.length <= 1 ? (arr[0] || '') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
const normQ = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const isoDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
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
  cameraLg: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', 22, 2),
  receipt: svg('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>', 22, 2),
  cameraBig: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', 30, 2),
  bookmark: svg('<path d="M6 4.5h12v16l-6-4.2-6 4.2z"/>', 16),
  upload: svg('<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>', 30, 2),
  chevron: svg('<path d="M9 6l6 6-6 6"/>', 16),
  trash: svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>', 16, 2),
  person: svg('<circle cx="12" cy="8" r="4"/><path d="M4 20.5c0-3.6 3.6-6 8-6s8 2.4 8 6"/>', 20),
  personBig: svg('<circle cx="12" cy="8" r="4"/><path d="M4 20.5c0-3.6 3.6-6 8-6s8 2.4 8 6"/>', 24, 2),
  minus: svg('<path d="M5 12h14"/>', 16, 2.4),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 16, 2.4),
  plusSm: svg('<path d="M12 5v14M5 12h14"/>', 12, 2.8),
  chat: svg('<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.6A8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/>', 16, 2),
  flame: svg('<path d="M12 3c.6 3.4 4.5 5.2 4.5 9.4a4.5 4.5 0 0 1-9 0c0-1.7.7-3 1.6-4 .2 1.2.8 2 1.6 2.4C10.3 8.6 11 5.8 12 3z"/>', 16, 2),
  thumbUp: svg('<path d="M7 11v9"/><path d="M3 11h4l4-7.5a2 2 0 0 1 3.5 1.5L14 9h5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7"/>', 30, 2),
  thumbDown: svg('<path d="M17 13V4"/><path d="M21 13h-4l-4 7.5a2 2 0 0 1-3.5-1.5L10 15H5a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 6.2 4H17"/>', 30, 2),
  thumbUpSm: svg('<path d="M7 11v9"/><path d="M3 11h4l4-7.5a2 2 0 0 1 3.5 1.5L14 9h5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7"/>', 14, 2.2),
  thumbDownSm: svg('<path d="M17 13V4"/><path d="M21 13h-4l-4 7.5a2 2 0 0 1-3.5-1.5L10 15H5a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 6.2 4H17"/>', 14, 2.2),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 14, 2.2),
  chevronL: svg('<path d="M15 6l-6 6 6 6"/>', 20),
  chevronR: svg('<path d="M9 6l6 6-6 6"/>', 20),
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

/* ---------- food categories (for the Category tab) ---------- */
const CATEGORY = {
  'milk': 'Dairy & eggs', 'eggs': 'Dairy & eggs', 'parmesan': 'Dairy & eggs', 'feta': 'Dairy & eggs', 'cream': 'Dairy & eggs', 'butter': 'Dairy & eggs',
  'chicken thighs': 'Meat & fish',
  'spinach': 'Produce', 'spring mix': 'Produce', 'tomatoes': 'Produce', 'basil': 'Produce', 'cucumber': 'Produce', 'onion': 'Produce', 'red onion': 'Produce', 'mushrooms': 'Produce', 'garlic': 'Produce', 'scallions': 'Produce', 'olives': 'Produce',
  'spaghetti': 'Grains & pasta', 'jasmine rice': 'Grains & pasta', 'arborio rice': 'Grains & pasta',
  'olive oil': 'Pantry & spices', 'chili flakes': 'Pantry & spices', 'soy sauce': 'Pantry & spices', 'stock': 'Pantry & spices', 'cumin': 'Pantry & spices', 'paprika': 'Pantry & spices', 'white wine': 'Pantry & spices',
};
const CATEGORY_ORDER = ['Produce', 'Meat & fish', 'Dairy & eggs', 'Grains & pasta', 'Pantry & spices', 'Other'];
const categoryOf = key => CATEGORY[key] || 'Other';
// Colour a row by how much is left, not by urgency.
const amountLevel = pct => (pct <= 0.2 ? 'red' : pct <= 0.5 ? 'yellow' : 'green');

/* ---------- per-serving nutrition + cost (approximate, for sorting/labels) ---------- */
// kcal, protein/fat/carbs in grams, cost in USD — one "serving" as recipes count them.
const NUTRI_DEFAULT = { kcal: 60, protein: 2, fat: 1, carbs: 10, cost: 0.6 };
const NUTRITION = {
  'spinach':        { kcal: 25,  protein: 3,  fat: 0,  carbs: 4,  cost: 0.7 },
  'spring mix':     { kcal: 20,  protein: 2,  fat: 0,  carbs: 3,  cost: 0.8 },
  'milk':           { kcal: 120, protein: 8,  fat: 5,  carbs: 12, cost: 0.35 },
  'eggs':           { kcal: 78,  protein: 6,  fat: 5,  carbs: 1,  cost: 0.30 },
  'chicken thighs': { kcal: 210, protein: 26, fat: 12, carbs: 0,  cost: 1.6 },
  'garlic':         { kcal: 5,   protein: 0,  fat: 0,  carbs: 1,  cost: 0.10 },
  'spaghetti':      { kcal: 200, protein: 7,  fat: 1,  carbs: 42, cost: 0.35 },
  'tomatoes':       { kcal: 22,  protein: 1,  fat: 0,  carbs: 5,  cost: 0.50 },
  'basil':          { kcal: 2,   protein: 0,  fat: 0,  carbs: 0,  cost: 0.40 },
  'jasmine rice':   { kcal: 205, protein: 4,  fat: 0,  carbs: 45, cost: 0.30 },
  'parmesan':       { kcal: 110, protein: 10, fat: 7,  carbs: 1,  cost: 1.1 },
  'cucumber':       { kcal: 16,  protein: 1,  fat: 0,  carbs: 4,  cost: 0.50 },
  'olive oil':      { kcal: 120, protein: 0,  fat: 14, carbs: 0,  cost: 0.25 },
  'chili flakes':   { kcal: 6,   protein: 0,  fat: 0,  carbs: 1,  cost: 0.05 },
  'onion':          { kcal: 44,  protein: 1,  fat: 0,  carbs: 10, cost: 0.30 },
  'red onion':      { kcal: 44,  protein: 1,  fat: 0,  carbs: 10, cost: 0.35 },
  'mushrooms':      { kcal: 22,  protein: 3,  fat: 0,  carbs: 3,  cost: 0.9 },
  'arborio rice':   { kcal: 210, protein: 4,  fat: 0,  carbs: 46, cost: 0.50 },
  'stock':          { kcal: 15,  protein: 1,  fat: 0,  carbs: 2,  cost: 0.40 },
  'soy sauce':      { kcal: 10,  protein: 1,  fat: 0,  carbs: 1,  cost: 0.10 },
  'cream':          { kcal: 100, protein: 1,  fat: 11, carbs: 1,  cost: 0.50 },
  'olives':         { kcal: 40,  protein: 0,  fat: 4,  carbs: 1,  cost: 0.60 },
  'cumin':          { kcal: 8,   protein: 0,  fat: 0,  carbs: 1,  cost: 0.05 },
  'paprika':        { kcal: 6,   protein: 0,  fat: 0,  carbs: 1,  cost: 0.05 },
  'feta':           { kcal: 75,  protein: 4,  fat: 6,  carbs: 1,  cost: 0.9 },
  'scallions':      { kcal: 8,   protein: 0,  fat: 0,  carbs: 2,  cost: 0.30 },
  'white wine':     { kcal: 85,  protein: 0,  fat: 0,  carbs: 3,  cost: 0.9 },
};
const nutriFor = key => NUTRITION[key] || NUTRI_DEFAULT;
const timeMinutes = dish => parseInt(dish.time, 10) || 999;
// Whole-dish totals summed over ingredients, plus per-serving figures. `ings` are the
// analysed ingredients when the caller has them (their keys are resolved against the pantry).
function dishStats(dish, ings = dish.ingredients) {
  const t = { kcal: 0, protein: 0, fat: 0, carbs: 0, cost: 0 };
  for (const i of (ings || [])) {
    const n = nutriFor(i.key), q = Math.max(0, i.need || 1);
    t.kcal += n.kcal * q; t.protein += n.protein * q; t.fat += n.fat * q; t.carbs += n.carbs * q; t.cost += n.cost * q;
  }
  const per = Math.max(1, dish.servings || 1);
  return {
    kcal: Math.round(t.kcal / per / 10) * 10, protein: Math.round(t.protein / per),
    fat: Math.round(t.fat / per), carbs: Math.round(t.carbs / per),
    cost: t.cost / per, costTotal: t.cost, servings: per,
  };
}
const money = v => `$${v.toFixed(2)}`;

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
// Built-in dishes carry hand-set `need` per ingredient; every other dish's need is read
// off its amount at analyze() time (F3).
const BUILTIN_IDS = new Set(DISHES.map(d => d.id));
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
const chatDishes = new Map();
const planDishes = new Map();   // this week's meals by plan- id, so a cell opens like any dish

// Dishes that live outside the deck but must still open: a photo dish picked for tonight
// and then removed from Saved, or a cooked snapshot brought back with "Cook again". They
// sit in state.extraDishes so the Tonight pill and the detail sheet can still find them.
const isPhotoId = id => String(id).startsWith('photo-');
const dishById = id => (liveDishes || DISHES).find(d => d.id === id)
  || state.saved.find(d => d.id === id)
  || state.extraDishes.get(id)
  || chatDishes.get(id)
  || planDishes.get(id)
  || null;
const activeDishes = () => liveDishes || DISHES;
const onDeck = id => activeDishes().some(d => d.id === id);

// data- attributes that let shared/dish-images.js swap in a generated photo for a dish
// the model wrote; '' for built-in and photo dishes, which already have their own.
function dishImgAttrs(d) {
  if (!needsGeneratedImage(d)) return '';
  return ` data-dish-img="${dishSlug(d.name)}" data-dish-id="${esc(d.id)}" data-dish-name="${esc(d.name)}" data-dish-ings="${esc(dishNames(d).join(','))}" data-dish-fallback="${esc(d.img || '')}"`;
}
// What a dish paints with on first render: its picture when it is already in memory, its
// own photo for built-in and photo dishes, and nothing (the neutral placeholder) for a
// generated dish whose picture is still on its way. A stand-in that gets corrected a moment
// later is never shown; the stand-in only appears if no picture can be had at all.
function imgSrcAttr(d) {
  const src = needsGeneratedImage(d) ? peekDishImage(d) : d.img;
  return src ? ` src="${esc(src)}"` : '';
}

/** Metadata for the receipt currently in the review sheet; filled from the scan response. */
let lastReceipt = { store: '', date: '', total: 0 };

// The pantry key: a catalog food when the name really is that food, judged by the same
// head-noun and form rules the recipe matcher uses ("Roma tomatoes" is tomatoes, "coconut
// milk" is not milk, "chicken breast" is not chicken thighs), else the name itself. Two
// lots stack only when they share a key, so different products must get different keys.
const CATALOG_INDEX = buildPantryIndex([], Object.keys(CATALOG));
function keyForName(name) {
  const n = String(name || '').toLowerCase().trim();
  if (!n) return 'item';
  if (CATALOG[n]) return n;
  const base = n.split(',')[0].trim();
  if (CATALOG[base]) return base;
  const m = matchIngredient({ name: base }, CATALOG_INDEX);
  if (m && m.key && !m.approx) return m.key;
  return base.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() || 'item';
}
// A scan's group_key can be as coarse as a brand ("lean cuisine"); it decides the key only
// when it names a catalog food. Otherwise the item's own name does.
function keyForScan(item) {
  const fromGroup = item.group_key ? keyForName(item.group_key) : '';
  return fromGroup && CATALOG[fromGroup] ? fromGroup : keyForName(item.name);
}
// Lots keyed by such a group stacked different foods under one header. Re-key them by
// their own name once; catalog-keyed lots are left alone.
function rekeyLots(items) {
  let n = 0;
  for (const it of items) {
    if (CATALOG[it.key]) continue;
    const k = keyForName(it.name);
    if (k !== it.key) { it.key = k; n++; }
  }
  if (n) console.info(`[pantry] ${n} lots re-keyed by their own name`);
  return n;
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

// Servings a review row's lot starts with (F3.1): what its quantity says, by the same serving
// sizes every other lot and every recipe's `need` are measured in; the scanner's own estimate
// only stands in when the quantity cannot be sized ("1 bag"), and the package default last.
const lineServings = l => servingsFor(l.key, l.qty) ?? l.estimated ?? catalog(l.key).servings;

// A review row's quantity, said in the unit that food is already kept in, and the servings
// that comes to. `pending` is the rows settled ahead of this one, so two lines of the same
// food on one receipt agree with each other as well as with the pantry.
function settleLine(row, pending = []) {
  row.qty = qtyInPantryUnit(row.key, formatQuantity(row.qty), state.pantry.concat(pending));
  row.initial = lineServings(row);
  return row;
}

/** Map a /scan item into a review-row + pantry seed fields. */
function lineFromScanItem(item, pending = []) {
  const key = keyForScan(item);
  const purchaseMs = item.purchase_date ? Date.parse(item.purchase_date) : Date.now();
  const expiryMs = item.expiration_date ? Date.parse(item.expiration_date) : purchaseMs + catalog(key).shelf * DAY;
  const qty = formatQuantity(qtyLabel(item));   // "1.4 lb" -> "635 g": one spelling on the review row and the pantry row
  const line = {
    id: uid(),
    raw: item.raw_text || item.name,
    name: item.name,
    key,
    variant: item.variant || '',
    qty,
    price: Number(item.price) || 0,
    nonFood: item.is_food === false,
    low: false,
    dropped: false,
    estimated: Number(item.initial_servings || item.servings) || null,   // the parser's guess at the package, kept for unparseable quantities
    burn: Number(item.daily_burn_rate) || (item.burn_pattern === 'event' ? 0 : catalog(key).burn),
    purchase: Number.isFinite(purchaseMs) ? purchaseMs : Date.now(),
    expiry: Number.isFinite(expiryMs) ? expiryMs : Date.now() + catalog(key).shelf * DAY,
  };
  return settleLine(line, pending);
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
    // No pantry key is baked in here: analyze() matches each ingredient against the
    // pantry as it is now, so a scan or a check-in re-verifies every recipe.
    ingredients: (recipe.ingredients || [])
      .filter(ing => !ing.staple)
      .map(ing => ({
        name: ing.name,
        matched_name: ing.matched_name || '',
        servings_used: Number(ing.servings_used) || null,
        need: Math.max(0.5, Number(ing.servings_used) || 1),
        amt: ing.amount || '',
      })),
    // every ingredient name, staples included, for the allergy and dislike checks
    names: (recipe.ingredients || []).map(ing => String(ing.name || '')).filter(Boolean),
    steps: Array.isArray(recipe.steps) ? recipe.steps : [],
    description: String(recipe.description || '').trim(),
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

// A deck is only as good as the kitchen it came from. This fingerprints what
// the model was told — the pantry rows it cooked from and the rules it had to
// follow — so a cached deck can be told apart from a stale one. days_left is in
// it deliberately: yesterday's deck should re-rank as things get closer to going off.
function deckSignature() {
  const pantry = pantryForApi()
    .map(i => `${i.name}:${Math.round(i.quantity_servings * 10)}:${i.days_left}`)
    .sort()
    .join('|');
  return `${pantry}#${JSON.stringify(state.prefs)}`;
}

const DECK_MAX_AGE = 12 * 60 * 60 * 1000;

/** Take up a deck loaded from the cache so the caller's first render already has
    recipes in it. Returns whether it still matches the kitchen, which is what
    tells startup it can skip regenerating altogether. */
function adoptCachedDeck(cached) {
  try {
    if (!cached || !cached.dishes.length) return false;
    liveDishes = cached.dishes;
    return cached.signature === deckSignature() && Date.now() - cached.at < DECK_MAX_AGE;
  } catch (err) {
    console.warn('[pantry] could not use the cached deck', err);
    return false;
  }
}

// `quiet` keeps the deck on screen while a new one is generated behind it, so a
// cached deck never flashes away on load.
async function refreshRecipes({ quiet = false } = {}) {
  const token = ++recipeRefreshToken;
  if (!apiConfigured() || !state.pantry.length) {
    liveDishes = null;
    renderAll({ enter: true });
    return [];
  }
  const signature = deckSignature();
  // The structured prefs are the contract (allergies and diet are hard rules server-side);
  // the plain-English line is the fallback the model reads — '' when all default.
  const prefs = state.prefs;
  const request = prefsToRequest(prefs);
  // The loading bar and, with no cached deck, the skeleton cards, until the answer is in.
  // Settled before any render so the deck never paints a skeleton over a finished answer.
  const busy = beginBusy('Finding recipes…');
  recipesLoading++;
  let settled = false;
  const settle = () => { if (settled) return; settled = true; recipesLoading = Math.max(0, recipesLoading - 1); busy.end(); };
  if (!quiet && !liveDishes) renderDeck();   // paint the skeletons now, not after the model answers
  try {
    // Two batches at once, merged: one aimed at what they can make outright (Curated),
    // one told to reach for dishes a few store items away (Explore), so neither tab
    // is starved by the other. A title that turns up in both is kept once.
    const items = pantryForApi();
    const reach = [request, 'Lean toward dishes that need one to three ingredients from the store, so there is real variety beyond what is already here: different cuisines, main ingredients and methods.'].filter(Boolean).join(' ');
    const batches = await Promise.allSettled([
      fetchRecipes(items, { count: 12, maxMissing: 1, request, prefs }),
      fetchRecipes(items, { count: 16, maxMissing: 3, request: reach, prefs }),
    ]);
    settle();
    if (token !== recipeRefreshToken) return liveDishes || [];
    if (batches.every(b => b.status === 'rejected')) throw batches[0].reason;
    const keyOfTitle = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const seen = new Set();
    const recipes = [];
    for (const b of batches) {
      if (b.status !== 'fulfilled') continue;
      for (const r of (b.value.recipes || [])) {
        const k = keyOfTitle(r.title);
        if (!k || seen.has(k)) continue;
        seen.add(k); recipes.push(r);
      }
    }
    const list = recipes.map(dishFromApi);
    liveDishes = list.length ? list : null;
    saveDeck(list, signature);           // so the next visit paints without waiting on the model
    // The cards about to be dealt wait, briefly, for their pictures, so they appear right
    // rather than corrected a moment later; the rest of the deck fetches behind them.
    buildDeck();                         // the deck order decides which pictures to wait for
    const first = state.deck.slice(0, 3).map(a => a.dish);
    await warmDishImages(first, { network: true, timeoutMs: 1500 });
    if (token !== recipeRefreshToken) return liveDishes || [];
    primeDishImages(list.filter(d => !first.includes(d)));
    populateFoodOptions();               // live recipes bring new ingredient names
    const ids = new Set((liveDishes || DISHES).map(d => d.id));
    for (const set of [state.skipped, state.cooked, state.chosen]) {
      // photo, chat and plan dishes are never in the deck: keep them while they still resolve
      for (const id of [...set]) if (!ids.has(id) && !isPhotoId(id) && !dishById(id)) set.delete(id);
    }
    state.history = state.history.filter(h => ids.has(h.id));   // nothing to bring back that is no longer dealt
    renderAll({ enter: true });
    return liveDishes || [];
  } catch (err) {
    settle();
    console.warn('[pantry] recipe refresh failed', err);
    if (token !== recipeRefreshToken) return [];
    // A quiet refresh that fails leaves the cached deck alone: a deck from the
    // last visit beats dropping the user back to the built-ins.
    if (quiet && liveDishes) return liveDishes;
    liveDishes = null;
    renderAll({ enter: true });
    return [];
  }
}

/* ---------- the pantry model ---------- */
// Servings a lot holds when it is new: read off the quantity ("24 pcs" of eggs is 24,
// "2 lb" of rice about 15), and only when the quantity says nothing ("1 jar") the
// catalog's package default. The check-in slider re-baselines from the same number.
const baseServings = (key, qty) => servingsFor(key, qty) ?? catalog(key).servings;
function mk(name, key, qty, daysAgo, raw = '') {
  const c = catalog(key);
  const purchase = Date.now() - daysAgo * DAY;
  return { id: uid(), name, key, qty, raw, initial: baseServings(key, qty), purchase, expiry: purchase + c.shelf * DAY, burn: c.burn, deducted: 0 };
}
// Lots saved before servings were read from quantities carry the package default.
// Recompute those once, and only those: a lot they have checked in on (or cooked from)
// is their number, not ours.
function recomputeDefaultServings(items) {
  let n = 0;
  for (const it of items || []) {
    if (!it || it.deducted !== 0 || it.initial !== catalog(it.key).servings) continue;
    const s = servingsFor(it.key, it.qty);
    if (s == null || s <= 0 || s === it.initial) continue;
    it.initial = s;
    n++;
  }
  if (n) console.info(`[pantry] servings recomputed from quantities for ${plural(n, 'lot')}`);
  return n;
}
/* ---------- the unit a food is kept in ----------
   Everything the app says about a food is said in the unit its pantry rows already use.
   The first lot of a food sets that unit — whatever the receipt or the add form gave —
   and every later lot converts into it: a receipt's "4 kg" of bananas lands as about 34
   bananas, and the recipe sheet asks for bananas too, never servings or grams. Converted
   lots still stack separately, because each one has its own use-by date. */

// The noun a count reads best as ("12 bananas", not "12 pcs"): the wording the quantity
// came with, else the food's own name.
const countNoun = (key, name) => String(name || key || '').toLowerCase().trim() || null;
/** A lot's quantity as a canonical amount, with a readable noun for counts. */
function lotSize(it) {
  const c = toCanonical(it.qty);
  if (c.amount == null || !c.unit) return null;
  if (c.unit === 'pcs' && !c.label) c.label = countNoun(it.key, it.name);
  return c;
}
/**
 * How a food is measured in this pantry: the unit its rows use, the noun counts read
 * with, and how much of that unit one serving comes to. The oldest lot carrying a
 * readable quantity decides, so the answer does not move as newer lots come and go.
 * Null when the pantry holds none of it — then there is no unit to borrow.
 */
let unitCache = { pantry: null, size: -1, map: new Map() };
function pantryUnitOf(key, pantry = state.pantry) {
  if (pantry === state.pantry) {
    if (unitCache.pantry !== pantry || unitCache.size !== pantry.length) unitCache = { pantry, size: pantry.length, map: new Map() };
    else if (unitCache.map.has(key)) return unitCache.map.get(key);
  }
  const u = readPantryUnit(key, pantry);
  if (pantry === state.pantry) unitCache.map.set(key, u);
  return u;
}
function readPantryUnit(key, pantry) {
  const lots = pantry.filter(it => it.key === key).sort((a, b) => a.purchase - b.purchase);   // a stable sort keeps insertion order among same-day lots
  for (const it of lots) {
    const c = lotSize(it);
    if (!c) continue;
    const per = it.initial > 0 ? c.amount / it.initial : 0;
    return { unit: c.unit, label: c.label || null, perServing: per > 0 ? per : null };
  }
  return null;
}
/**
 * A quantity said in the unit `key` is already kept in. A food the pantry has never held,
 * or a quantity with no size to convert ("1 bag"), is left exactly as it came — only a
 * real conversion rewrites what is stored.
 */
function qtyInPantryUnit(key, qty, pantry = state.pantry) {
  const target = pantryUnitOf(key, pantry);
  const converted = target ? convertQuantity(qty, target, key) : null;
  return converted ? formatQuantity(converted) : (typeof qty === 'string' ? qty : formatQuantity(qty));
}
// A lot that arrived with no readable quantity ("1 bag", nothing at all) has no unit to
// be said in; servings are all we know, and they are quoted as such.
const servingsNote = n => `~${plural(Number(fmt1(Math.max(0, n))), 'serving')}`;
/** Servings of a food, said in the unit the pantry keeps it in. */
function servingsText(key, servings) {
  const u = pantryUnitOf(key);
  if (!u || !u.perServing) return servingsNote(servings);
  return formatQuantity({ amount: servings * u.perServing, unit: u.unit, label: u.label });
}
/** How much of one lot is left, said in the unit that lot is kept in. */
function lotAmountText(it, servings = current(it)) {
  const c = lotSize(it);
  if (!c || !(it.initial > 0)) return servingsText(it.key, servings);   // no quantity of its own: borrow the food's unit
  return formatQuantity({ ...c, amount: c.amount * (servings / it.initial) });
}
/** The same for a whole stack: every lot of a food shares its unit, so they add up. */
function stackAmountText(lots) {
  const key = lots[0].key;
  const u = pantryUnitOf(key);
  if (!u || !u.perServing) return servingsNote(lots.reduce((n, it) => n + current(it), 0));
  const total = lots.reduce((n, it) => { const c = lotSize(it); return n + (c && it.initial > 0 ? c.amount * (current(it) / it.initial) : current(it) * u.perServing); }, 0);
  return formatQuantity({ amount: total, unit: u.unit, label: u.label });
}

/**
 * A check-in is a correction: they have told us how much of this lot is really left, so
 * it becomes the lot's new full amount. The quantity comes down with the servings — both
 * sides of the ratio the display reads — or the row would keep quoting the old pack.
 */
function rebaseLot(it, pct) {
  unitCache.size = -1;   // the ratio this lot is read by has moved
  const c = lotSize(it);
  if (c) {
    it.qty = formatQuantity({ ...c, amount: c.amount * (pct / 100) });
    it.initial = Math.max(0.1, baseServings(it.key, it.qty));
  } else {
    it.initial = Math.max(0.1, baseServings(it.key, it.qty) * (pct / 100));   // no readable quantity: the package default, scaled
  }
  it.purchase = Date.now(); it.deducted = 0; it.asking = false;
  it.expiry = Math.max(it.expiry, Date.now() + 2 * DAY);
}

/**
 * What a recipe takes of one ingredient, worked out once so the recipe sheet, the
 * made-it list and the deduction all quote the same number: the amount in the unit the
 * pantry keeps that food in, and the servings that amount comes to. The recipe's own
 * wording is converted when it can be ("8 oz" of spaghetti against a pantry kept in
 * grams is "225 g"); otherwise the servings analyze() worked out are turned back into
 * pantry units. Packaging ("1 jar") has no size of its own, so those foods keep the
 * recipe's wording rather than being quoted in half-jars.
 */
function takeFor(i, factor = 1) {
  const servings = Math.max(0, (Number(i.need) || 0) * factor);
  const fallback = scaleAmount(i.amt, factor) || (servings ? servingsNote(servings) : '');
  const u = pantryUnitOf(i.key);
  if (!u || u.unit === 'pack') return { text: fallback, servings };
  // The conversion works from the amount as written, not from its rounded reading: the
  // sheet may say "1.5 bananas" while 1.7 is what really leaves the pantry.
  const raw = i.amt ? toCanonical(i.amt) : null;
  const direct = raw && raw.amount != null ? convertCanonical({ ...raw, amount: raw.amount * factor }, u, i.key) : null;
  if (direct) return { text: formatQuantity(direct), servings: u.perServing ? direct.amount / u.perServing : servings };
  if (u.perServing) return { text: formatQuantity({ amount: servings * u.perServing, unit: u.unit, label: u.label }), servings };
  return { text: fallback, servings };
}

// Each purchase is its own lot. Same group_key stacks in the panel with separate
// expiry dates — never merge and overwrite an older banana's use-by.
function addLot(name, key, qty, raw = '', extras = null) {
  const c = catalog(key);
  qty = qtyInPantryUnit(key, qty);   // "4 kg" of bananas joins a pantry kept in bananas as about 34 of them
  const initial = extras && extras.initial != null ? extras.initial : baseServings(key, qty);
  const burn = extras && extras.burn != null ? extras.burn : c.burn;
  const purchase = extras && extras.purchase != null ? extras.purchase : Date.now();
  // Permanent rule: nothing expires on the day it is added. Whatever a receipt, the
  // catalog or a typed date says, a lot always gets at least a full day from now.
  const expiry = Math.max(extras && extras.expiry != null ? extras.expiry : purchase + c.shelf * DAY, Date.now() + MIN_LIFE);
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
    // what the whole lot cost (a receipt line's price); null when nobody said, so the
    // kitchen report falls back to a typical cost per serving
    price: extras && Number.isFinite(Number(extras.price)) && Number(extras.price) > 0 ? Number(extras.price) : null,
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
  // Generated recipes have no diet tags. Check named ingredients too, including
  // staples omitted from the pantry shopping list. These are ingredient checks,
  // not certification of halal/kosher sourcing or preparation.
  const names = dishNames(dish);
  const text = names.join(' ').toLowerCase();
  const meat = /\b(chicken|beef|pork|bacon|ham|lard|lamb|turkey|duck|veal|venison|sausage|gelatin)\b/.test(text);
  const seafood = ingredientHits(names, ['fish', 'shellfish']).length > 0;
  const dairy = ingredientHits(names, ['dairy']).length > 0;
  const eggs = ingredientHits(names, ['eggs']).length > 0;
  const pork = /\b(pork|bacon|ham|lard)\b/.test(text);
  const alcohol = /\b(wine|beer|vodka|rum|brandy|sake|sherry|bourbon)\b/.test(text);
  if (p.diet.includes('vegan') && (meat || seafood || dairy || eggs || /\bhoney\b/.test(text))) return false;
  if (p.diet.includes('vegetarian') && (meat || seafood)) return false;
  if (p.diet.includes('pescatarian') && meat) return false;
  if (p.diet.includes('halal') && (pork || alcohol)) return false;
  if (p.diet.includes('kosher') && (pork || ingredientHits(names, ['shellfish']).length || (meat && dairy))) return false;
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
  if (isLiked(dish)) fit += 2;   // a 👍 after cooking it, or a dish made of the same things
  return fit;
}
// Ratings (👍 / 👎 after "I made this") are kept by title, so a regenerated deck's copy of a
// dish still carries them. A rated-down dish is left out of the deck; a rated-up one, or a
// dish sharing at least 60% of its ingredients with one, sorts earlier.
const ratingOf = dish => (dish && state.ratings[titleKey(dish.name)]) || null;
const isDisliked = dish => { const r = ratingOf(dish); return Boolean(r && r.value < 0); };
const ingredientKeys = dish => new Set(((dish && dish.ingredients) || []).map(i => normalizeName(i.name)).filter(Boolean));
function isLiked(dish) {
  const r = ratingOf(dish);
  if (r) return r.value > 0;
  const keys = ingredientKeys(dish);
  if (!keys.size) return false;
  for (const e of state.cookedLog) {
    if (!(e.rating > 0) || !e.dish) continue;
    const common = [...ingredientKeys(e.dish)].filter(k => keys.has(k)).length;
    if (common / keys.size >= 0.6) return true;
  }
  return false;
}

/* ---------- dishes against the pantry ---------- */
// The pantry index (see shared/ingredients.js) is rebuilt whenever the pantry array is
// replaced or grows; analyze() runs for every dish on every render, so it is cached.
const CATALOG_KEYS = Object.keys(CATALOG);
let pantryIndexCache = { pantry: null, size: -1, index: null };
function pantryIndex() {
  const p = state.pantry;
  if (pantryIndexCache.pantry !== p || pantryIndexCache.size !== p.length) {
    pantryIndexCache = { pantry: p, size: p.length, index: buildPantryIndex(p, CATALOG_KEYS) };
  }
  return pantryIndexCache.index;
}
// Half of the smallest step a food's pantry unit shows, in servings. A shortfall smaller
// than this prints as no shortfall at all, so counting it as "low" would put a warning on
// a row that reads "2 bananas of 2 bananas".
function displaySlack(key) {
  const u = pantryUnitOf(key);
  if (!u || !u.perServing) return 1e-9;
  const step = u.unit === 'pcs' || u.unit === 'pack' ? 0.5 : 5;   // counts read at halves, g and ml at fives
  return step / 2 / u.perServing;
}

// A key for an ingredient nothing in the pantry or the catalog matches: a plain slug of its
// name, so nutrition, chips and the made-it sheet still have something stable to hang on.
const fallbackKey = name => String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() || 'item';

// A substitution the cook picked on the recipe sheet lives on the dish (dish.subs, keyed by
// the ingredient's normalised name, so it survives the pantry changing under it): the
// swap counts as "have", approximately, and the made-it sheet deducts the swap's foods.
const subKeyOf = i => normQ(i.name);
const subFor = (dish, i) => (dish.subs && dish.subs[subKeyOf(i)]) || null;

// Every ingredient is verified against the pantry at read time: matched by name, so a
// scan or a check-in re-checks every recipe, then judged on amount. status is one of
// 'have' (enough), 'short' (some, not enough), 'missing' (none) or 'staple' (assumed on hand).
function analyze(dish) {
  const index = pantryIndex();
  const builtin = BUILTIN_IDS.has(dish.id);
  const ings = dish.ingredients.map(i => {
    const staple = Boolean(i.staple);
    const m = matchIngredient(i, index);
    const key = m ? m.key : (i.key || fallbackKey(i.name));   // built-in dishes carry exact keys
    // What the dish takes, in pantry servings. Built-ins say so by hand; for anything the
    // model wrote the amount is the truth ("2 cloves" of garlic is 2, "8 oz" of spaghetti
    // about 2.5) and the model's servings_used only stands in when the amount is wordless.
    const fromAmount = builtin ? null : servingsFor(key, i.amt);
    const need = Math.max(0, Number(fromAmount > 0 ? fromAmount : (i.servings_used ?? i.need)) || 1);
    const avail = available(key);
    const sub = staple ? null : subFor(dish, i);
    const status = staple ? 'staple' : sub ? 'have' : avail <= 0 ? 'missing' : avail + displaySlack(key) < need ? 'short' : 'have';
    return { ...i, key, need, item: sub ? null : findItem(key), avail, approx: Boolean(sub || (m && m.approx)), sub, status, staple, have: status === 'have' || status === 'staple' };
  });
  const have = ings.filter(i => i.have);
  const short = ings.filter(i => i.status === 'short');
  const missing = ings.filter(i => i.status === 'missing');
  let urgent = null;
  for (const i of [...have, ...short]) {
    if (!i.item) continue;   // an assumed staple has no lot to expire
    const dl = daysLeft(i.item);
    if (!urgent || dl < urgent.dl) urgent = { item: i.item, dl };
  }
  const urgentDays = urgent ? urgent.dl : 999;
  const badge = urgent && urgent.dl <= 5
    ? { text: `Uses your ${urgent.item.name.toLowerCase()} · ${shortDays(urgent.dl)}`, level: levelForDays(urgent.dl) }
    : null;
  return {
    dish, ings, have, short, missing, gap: short.length + missing.length, urgentDays, badge,
    stats: dishStats(dish, ings), warn: avoidHits(dish), fit: prefFit(dish), stretch: stretchOf(dish),
  };
}
// Which deck a dish belongs on: Curated is strictly what they have, Explore is one to
// three ingredients away (short or missing). Anything further is not dealt at all.
// Being low on something does not demote a dish: Curated is everything whose ingredients
// are all in the pantry (the "low on" chip says go easy); Explore is one to three
// ingredients that are not there at all.
const TAB_FILTER = {
  curated: a => a.missing.length === 0,
  explore: a => a.missing.length >= 1 && a.missing.length <= 3,
};
const eligible = a => a.missing.length <= 3;

// Deck ordering modes for the sort control.
const SORTS = {
  urgent:   { label: 'Expiring first', cmp: (a, b) => (a.urgentDays - b.urgentDays) || (a.gap - b.gap) },
  missing:  { label: 'Fewest missing', cmp: (a, b) => (a.missing.length - b.missing.length) || (a.gap - b.gap) || (a.urgentDays - b.urgentDays) },
  calories: { label: 'Fewest calories', cmp: (a, b) => a.stats.kcal - b.stats.kcal },
  protein:  { label: 'Most protein', cmp: (a, b) => b.stats.protein - a.stats.protein },
  cost:     { label: 'Cheapest', cmp: (a, b) => a.stats.cost - b.stats.cost },
  time:     { label: 'Quickest', cmp: (a, b) => timeMinutes(a.dish) - timeMinutes(b.dish) },
};

/* ---------- state ---------- */
// The sections in the top bar. The open one survives a reload within the session.
const TABS = ['curated', 'explore', 'pantry', 'shopping'];
const TAB_KEY = 'mise.tab';
function readTab() {
  try { const t = sessionStorage.getItem(TAB_KEY); return TABS.includes(t) ? t : 'curated'; } catch (_) { return 'curated'; }
}
const state = {
  pantry: [],
  deck: [],
  skipped: new Set(),
  cooked: new Set(),
  chosen: new Set(),        // dishes picked for tonight, in the order they were picked
  history: [],              // swipes in order, { id, dir: 'skip'|'cook', tab }, so Undo can bring the last one back
  undoing: null,            // the dish Undo just brought back: buildDeck puts it on top for one render
  saved: [],                // dishes kept from the photo flow, newest first; replaced by loadSavedDishes() at boot
  extraDishes: new Map(),   // dishes outside the deck that must still open (photo dishes on Tonight, "Cook again" snapshots), by id
  ratings: {},              // { [titleKey]: { title, value: 1|-1, at, dishId } }; replaced by loadRatings() at boot
  cookedLog: [],            // [{ id, title, at, rating, dishId, dish }] newest first, capped; replaced by loadCooked() at boot
  events: [],               // what happened to each lot (see shared/report.js), oldest first, capped; replaced by loadEvents() at boot
  savedTab: 'saved',        // the Saved sheet's tab: saved | cooked
  shopping: [],             // the shopping list, see the Shopping list section; replaced by loadShopping() at boot
  expanded: new Set(),      // pantry stack keys that are open
  prefs: normalizePrefs(DEFAULT_PREFS),   // cooking preferences; replaced by loadPrefs() at boot
  prefsHid: false,          // the deck is empty only because of the preferences (nothing to reshuffle)
  tab: readTab(),           // curated | explore | pantry | shopping
  tabTotal: 0,              // dishes this deck tab holds before skips and picks (0 = the tab is empty, not exhausted)
  sheet: null,
  sortMode: 'urgent',       // deck ordering, see SORTS
  detailDishId: null,       // recipe open in the detail sheet
  detailServings: 2,        // people the open recipe is scaled to
  detailFromSaved: false,   // retain the return destination while changing servings
  detailFromPlan: false,    // opened from the week sheet: "Back to this week" instead of the deck
  panelTab: 'expiring',     // pantry page sort tab: expiring | amount | category
  leaving: false,
  sheetReturn: null,        // where keyboard focus goes back to when the sheet closes
};
const isDeckTab = () => state.tab === 'curated' || state.tab === 'explore';
const isPantryTab = () => state.tab === 'pantry';
const isShoppingTab = () => state.tab === 'shopping';

function buildDeck() {
  const filter = TAB_FILTER[state.tab] || TAB_FILTER.curated;   // the pantry and shopping tabs keep the curated deck ready behind them
  const inTab = activeDishes().map(analyze).filter(filter);
  const all = inTab.filter(a => passesPrefs(a.dish));   // allergies/diet are hard rules
  state.prefsHid = all.length === 0 && inTab.length > 0;
  state.tabTotal = all.length;
  const cmp = (SORTS[state.sortMode] || SORTS.urgent).cmp;
  state.deck = all
    .filter(a => !state.skipped.has(a.dish.id) && !state.cooked.has(a.dish.id) && !state.chosen.has(a.dish.id))
    .filter(a => !isDisliked(a.dish))   // rated down: not dealt again (it stays under Cooked so the rating can be flipped)
    .sort((a, b) => cmp(a, b) || (a.stretch - b.stretch) || (b.fit - a.fit));
  // the dish Undo brought back goes on top, whatever the sort says, until it is painted
  if (state.undoing) {
    const i = state.deck.findIndex(a => a.dish.id === state.undoing);
    if (i > 0) state.deck.unshift(...state.deck.splice(i, 1));
  }
  return all;
}
const chosenDishes = () => [...state.chosen].map(dishById).filter(Boolean);

/* =========================================================================
   Rendering
   ========================================================================= */
const el = {
  deck: $('#deck'), caption: $('#deck-caption'), status: $('#deck-status'), deckScreen: $('#deck-screen'), endScreen: $('#end-screen'), emptyScreen: $('#empty-screen'),
  endTitle: $('#end-title'), endCopy: $('#end-copy'), reshuffle: $('#btn-reshuffle'), endPrefs: $('#btn-end-prefs'), goExplore: $('#btn-go-explore'), endUndo: $('#btn-end-undo'),
  tabs: $('#tabs'), tabCount: $('#tab-pantry-count'), tabShopCount: $('#tab-shopping-count'), undo: $('#btn-undo'),
  tonight: $('#btn-tonight'), profile: $('#btn-profile'), week: $('#btn-week'),
  veil: $('#veil'), sheet: $('#sheet'), panel: $('#pantry-screen'), panelBody: $('#panel-body'), panelCount: $('#panel-count'),
  shoppingScreen: $('#shopping-screen'), shoppingBody: $('#shopping-body'), shoppingCount: $('#shopping-count'),
  toast: $('#toast'), file: $('#file-input'), dishFile: $('#dish-input'), savedBtn: $('#btn-saved'),
  progress: $('#progress'), busyPill: $('#busy-pill'), busyLabel: $('#busy-label'),
  chat: $('#chat'), chatFab: $('#btn-chat'),
};

/* ---------- the loading bar and pill ----------
   One indeterminate bar along the bottom edge of the top bar and a small glass pill
   naming the job, driven by a counter so overlapping jobs (a refresh behind a plan)
   keep them up until the last one ends. The pill waits 300 ms, so a fast job never
   flashes it. `const busy = beginBusy('Finding recipes…'); … busy.end()`. */
let busyJobs = [];
let busyPillTimer = 0;
let recipesLoading = 0;   // refreshRecipes() calls in flight, for the deck's skeleton cards
function paintBusy() {
  const on = busyJobs.length > 0;
  el.progress.hidden = !on;
  el.progress.setAttribute('aria-busy', String(on));
  if (on) {
    el.busyLabel.textContent = busyJobs[busyJobs.length - 1].label;
    if (!busyPillTimer && !el.busyPill.classList.contains('in')) {
      busyPillTimer = setTimeout(() => { busyPillTimer = 0; if (busyJobs.length) { el.busyPill.hidden = false; el.busyPill.classList.add('in'); } }, 300);
    }
  } else {
    clearTimeout(busyPillTimer); busyPillTimer = 0;
    el.busyPill.classList.remove('in');
    setTimeout(() => { if (!busyJobs.length) el.busyPill.hidden = true; }, reduceMotion ? 0 : 200);
  }
}
function beginBusy(label = 'Working…') {
  const job = { label, done: false };
  busyJobs.push(job);
  paintBusy();
  return { end() { if (job.done) return; job.done = true; busyJobs = busyJobs.filter(j => j !== job); paintBusy(); } };
}

// Photos fade in once they have loaded; until then their frame shimmers. A generated
// picture that replaces a stand-in later (shared/dish-images.js swaps the src) fades in
// over the old one. Idempotent: safe after every render.
function watchImages(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const img of root.querySelectorAll('.card-img img, .hero img, img.thumb, img.chat-thumb')) {
    if (img.dataset.watched) continue;
    img.dataset.watched = '1';
    const mark = () => img.classList.add('loaded');
    if (img.complete && img.naturalWidth > 0) mark();
    img.addEventListener('load', () => {
      if (!img.classList.contains('loaded')) return mark();
      img.classList.remove('swap'); void img.offsetWidth; img.classList.add('swap');   // a new src arrived: crossfade
    });
    img.addEventListener('error', mark);   // a broken picture must not shimmer forever
  }
}

// The choke point after every mutation: everything derived is rebuilt here, then saved.
function renderAll(opts = {}) {
  buildDeck();
  const n = state.pantry.length;
  el.panelCount.textContent = plural(n, 'item');
  el.tabCount.textContent = String(n);
  el.tabCount.hidden = n === 0;
  const toBuy = state.shopping.filter(s => !s.done).length;
  el.tabShopCount.textContent = String(toBuy);
  el.tabShopCount.hidden = toBuy === 0;
  const clearBtn = $('#btn-clear'); if (clearBtn) clearBtn.hidden = n === 0;
  renderTonight();
  renderDeck(opts);
  el.undo.disabled = state.history.length === 0;
  if (isPantryTab()) renderPanel();
  if (isShoppingTab()) renderShopping();
  saveState({ pantry: state.pantry, skipped: [...state.skipped], cooked: [...state.cooked], chosen: [...state.chosen] });
  if (shoppingDirty) { shoppingDirty = false; saveShopping(state.shopping); }
  if (eventsDirty) { eventsDirty = false; saveEvents(state.events); }
}

/* ---------- sections ---------- */
// Switch sections: the tab buttons, which screens show, then a render of the one that opened.
// The deck screens (deck / end / first-run) belong to Curated and Explore; renderDeck picks
// between them and hides all three on the other tabs.
function setTab(name, { render = true } = {}) {
  if (!TABS.includes(name)) name = 'curated';
  const changed = state.tab !== name;
  state.tab = name;
  try { sessionStorage.setItem(TAB_KEY, name); } catch (_) { /* private mode: the tab just does not survive a reload */ }
  for (const b of $$('.tab', el.tabs)) {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  el.panel.classList.toggle('hidden', name !== 'pantry');
  el.shoppingScreen.classList.toggle('hidden', name !== 'shopping');
  if (changed && name !== 'pantry') {
    // leaving the pantry: fold the add form and drop a half-finished check-in
    $('#add-form').hidden = true;
    $('#btn-add').setAttribute('aria-expanded', 'false');
    state.pantry.forEach(it => { it.asking = false; });
  }
  if (changed && name !== 'shopping') {
    $('#shop-form').hidden = true;
    $('#btn-shop-add').setAttribute('aria-expanded', 'false');
  }
  if (render) renderAll({ enter: changed && isDeckTab() });
}
// The last swipe comes back: out of skipped or tonight's list, onto the top of its deck.
function undo() {
  if (state.leaving) return;
  const entry = state.history.pop();
  if (!entry) return;
  if (entry.dir === 'skip') state.skipped.delete(entry.id);
  else {
    state.chosen.delete(entry.id);
    if (state.sheet === 'detail' && state.detailDishId === entry.id) closeSheet();   // the recipe that opened on the cook swipe
  }
  if (entry.tab !== state.tab && TABS.includes(entry.tab)) setTab(entry.tab, { render: false });   // it left from the other deck
  state.undoing = entry.id;
  renderAll({ enter: 'top' });
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

// Every dish is served for the household (D5): the label says so, and the detail sheet scales the amounts.
const servesLabel = () => `Serves ${servingsTarget(state.prefs)}`;
// One ingredient chip by status; a stand-in from the pantry says which row it is using.
// Every chip is also the "+" that puts that ingredient on the shopping list (the pointer
// handler on the card tells a chip tap from a card tap).
function chipHTML(i, dish) {
  const using = i.approx && i.item ? ` title="Using your ${esc(i.item.name.toLowerCase())}"` : '';
  const listed = onShoppingList(i.key || keyForName(i.name));
  const attrs = ` type="button"${listAttrs(i, dish, 'recipe')} aria-label="${listed ? `${esc(i.name)}, on your shopping list` : `Add ${esc(i.name)} to your shopping list`}"${listed ? ' disabled' : ''}`;
  const plus = `<span class="plus" aria-hidden="true">${listed ? ICON.checkSm : ICON.plusSm}</span>`;
  const on = listed ? ' listed' : '';
  if (i.status === 'staple') return `<button class="chip staple${on}"${attrs}><span>${esc(i.name)}</span>${plus}</button>`;
  if (i.status === 'short') return `<button class="chip low${on}"${using}${attrs}><span class="dot"></span><span>Low on ${esc(i.name)}</span>${plus}</button>`;
  if (i.status === 'missing') return `<button class="chip missing${on}"${attrs}><span>${esc(i.name)}</span>${plus}</button>`;
  if (i.sub) return `<button class="chip have sub${on}" title="Instead of ${esc(i.name)}"${attrs}>${ICON.checkSm}<span>Using ${esc(i.sub.use)}</span>${plus}</button>`;
  return `<button class="chip have${on}"${using}${attrs}>${ICON.checkSm}<span>${esc(i.name)}</span>${plus}</button>`;
}
// "missing 2: fresh noodles, lime · low on: garlic"
function gapLine(a) {
  const bits = [];
  if (a.missing.length) bits.push(`missing ${a.missing.length}: ${a.missing.map(m => m.name.toLowerCase()).join(', ')}`);
  if (a.short.length) bits.push(`low on: ${a.short.map(m => m.name.toLowerCase()).join(', ')}`);
  return bits.length ? `<div class="missing-line">${esc(bits.join(' · '))}</div>` : '';
}
function cardHTML(a) {
  const d = a.dish;
  return `
    <div class="card-img">
      <img${imgSrcAttr(d)} alt="" draggable="false"${dishImgAttrs(d)}>
      ${a.badge ? `<div class="badge glass ${a.badge.level}"><span class="dot"></span><span>${esc(a.badge.text)}</span></div>` : ''}
    </div>
    <div class="card-body">
      <h2 class="${d.name.length > 24 ? 'long' : ''}">${esc(d.name)}</h2>
      <div class="meta"><span>${d.time}</span><i></i><span>${servesLabel()}</span><i></i>${difficultyHTML(d)}</div>
      <div class="stats"><span>${a.stats.kcal} cal</span><i></i><span>${a.stats.protein}g protein</span><i></i><span>${money(a.stats.cost)}/serving</span></div>
      <div class="chips">${a.ings.map(i => chipHTML(i, a.dish)).join('')}${warnChips(a)}</div>
      ${gapLine(a)}
    </div>
    <div class="overlay cook"><div class="glass ring">${ICON.checkBig}</div></div>
    <div class="overlay skip"><div class="glass ring">${ICON.xBig}</div></div>`;
}

// A dish that has something they'd rather not eat keeps its place, with a note
const warnChips = a => (a.warn || []).map(w => `<span class="chip warn"><span class="dot"></span><span>Has ${esc(w)}</span></span>`).join('')
  + (a.stretch > 0 ? `<span class="chip warn"><span class="dot"></span><span>A stretch for you</span></span>` : '');

// Why the deck is empty, and what to offer. `done` is the ordinary case: they went through it.
const END_COPY = {
  prefs:   { title: 'Nothing to cook yet', copy: 'Nothing here fits your preferences yet. Scan a receipt or loosen them in your profile.' },
  curated: { title: 'Nothing to make with only what’s here yet', copy: 'Explore has dishes that are one to three ingredients away.' },
  explore: { title: 'Nothing to explore right now', copy: 'Everything you can cook is in Curated. Scan a receipt for new ideas.' },
  done:    { title: 'That’s everything we can make right now', copy: 'Scan another receipt for new dishes, or reshuffle to see the ones you skipped.' },
};
// Three stand-in cards while the first deck is still being written: the shape of a card, shimmering.
const skeletonCardHTML = () => `
    <div class="card-img"></div>
    <div class="card-body">
      <span class="sk t1"></span><span class="sk t2"></span><span class="sk m"></span>
      <div class="chips"><span class="sk c"></span><span class="sk c"></span><span class="sk c"></span><span class="sk c"></span></div>
    </div>`;
function renderDeck(opts = {}) {
  const hasPantry = state.pantry.length > 0;
  const deckTab = isDeckTab();
  // Nothing to deal only because the recipes are still on their way (no cached deck yet):
  // skeleton cards instead of an end-of-deck message that would be wrong in a moment.
  const loading = deckTab && hasPantry && state.deck.length === 0 && recipesLoading > 0 && !liveDishes && apiConfigured();
  el.emptyScreen.classList.toggle('hidden', !deckTab || hasPantry);
  el.deckScreen.classList.toggle('hidden', !deckTab || !hasPantry || (state.deck.length === 0 && !loading));
  el.endScreen.classList.toggle('hidden', !deckTab || !hasPantry || state.deck.length > 0 || loading);
  // End of deck: the preferences hid everything, this tab holds nothing, or they went through it
  const end = state.prefsHid ? 'prefs' : state.tabTotal === 0 && END_COPY[state.tab] ? state.tab : 'done';
  el.endTitle.textContent = END_COPY[end].title;
  el.endCopy.textContent = END_COPY[end].copy;
  el.reshuffle.hidden = end === 'prefs';
  el.endPrefs.hidden = end !== 'prefs';
  el.goExplore.hidden = end !== 'curated';
  el.endUndo.hidden = end === 'prefs' || state.history.length === 0;   // the last swipe emptied the deck: bring it back
  el.deck.innerHTML = '';
  if (loading) {
    el.deck.innerHTML = [2, 1, 0].map(pos => `<article class="card skeleton pos${pos}" aria-hidden="true">${skeletonCardHTML()}</article>`).join('');
    el.caption.textContent = 'Finding recipes…';
    if (el.status.textContent !== 'Finding recipes') el.status.textContent = 'Finding recipes';
    return;
  }
  const show = state.deck.slice(0, 3);
  // back to front so the top card is last in the DOM. enter: true animates the stack,
  // 'top' only the top card (the one Undo just brought back).
  for (let pos = show.length - 1; pos >= 0; pos--) {
    const card = document.createElement('article');
    const enter = opts.enter === 'top' ? pos === 0 : Boolean(opts.enter);
    card.className = `card pos${pos}${enter ? ' enter' : ''}`;
    if (enter) {
      card.style.animationDelay = `${pos * 70}ms`;
      // once the entrance has played the card is a plain .card again
      card.addEventListener('animationend', e => { if (e.target === card) card.classList.remove('enter'); });
    }
    card.dataset.id = show[pos].dish.id;
    card.setAttribute('aria-label', show[pos].dish.name);
    card.innerHTML = cardHTML(show[pos]);
    el.deck.appendChild(card);
  }
  state.undoing = null;   // painted on top once; the sort owns it from here
  applyDishImages(el.deck);   // generated pictures replace the stand-ins as they arrive
  watchImages(el.deck);
  const top = $('#deck .pos0');
  if (top) top.addEventListener('pointerdown', onPointerDown);
  const n = state.deck.length;
  const left = plural(n, 'dish', 'dishes');
  el.caption.textContent = `${(SORTS[state.sortMode] || SORTS.urgent).label} · ${left}`;
  // one short line for screen readers, and only when it actually changed
  const msg = !deckTab ? '' : !hasPantry ? 'Pantry is empty' : n ? `Now showing ${state.deck[0].dish.name}, ${left}` : END_COPY[end].title;
  if (msg && msg !== el.status.textContent) el.status.textContent = msg;
}

// The "Tonight" pill: what has been picked from the deck so far
function renderTonight() {
  const dishes = chosenDishes();
  el.tonight.hidden = dishes.length === 0;
  if (!dishes.length) return;
  const label = dishes.length === 1 ? dishes[0].name : plural(dishes.length, 'dish', 'dishes');
  $('.t-dish', el.tonight).textContent = ` · ${label}`;   // the word "Tonight" is static markup; phones show only that
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
  if (state.sheet || state.leaving || e.button !== 0) return;
  // one pointer at a time; a drag whose card was re-rendered away is stale and may be replaced
  if (drag.active && drag.el && drag.el.isConnected) return;
  const card = e.currentTarget;
  cancelAnimationFrame(drag.raf);
  card.classList.remove('enter');   // an entrance still playing would override the drag transform
  Object.assign(drag, { active: true, el: card, target: e.target, startX: e.clientX, startY: e.clientY, dx: 0, vx: 0, lastX: e.clientX, lastT: performance.now(), moved: false });
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
  if (!drag.moved) {   // a plain tap: on a chip it puts that ingredient on the list, anywhere else it opens the recipe
    settle(card);
    const chip = drag.target && drag.target.closest ? drag.target.closest('[data-list-add]') : null;
    if (chip) listAddFromEl(chip); else openDetail(state.deck[0]);
    return;
  }
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
  if (!a || state.leaving || state.sheet || !isDeckTab()) return;
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
  state.history.push({ id: a.dish.id, dir, tab: state.tab });
  // cooking something they are short on means a shop first: what it needs goes on the list
  if (dir === 'cook' && a.gap) {
    const r = addDishToShopping(a.dish);
    if (r.count) toast(`${plural(r.count, 'item')} added to your shopping list`, `for ${a.dish.name}`);
  }
  setTimeout(() => {
    state.leaving = false;
    renderAll();
    // the recipe opens, unless the user went somewhere else in the meantime
    if (dir === 'cook' && !state.sheet && isDeckTab()) openDetail(a);
  }, reduceMotion ? 0 : 400);
}

/* ---------- sheets (modals) ---------- */
// While a sheet is open the rest of the page is inert: no Tab into it, no clicks. The
// helper (#chat, #btn-chat) is never inerted: "Ask a question" floats it over the sheet.
function syncInert() {
  const modal = !!state.sheet;
  for (const n of $$('.topbar, .stage, .foot')) n.inert = modal;   // the section tabs are inside the top bar
}
// The recipe the helper is being asked about ("Ask a question" on the recipe sheet): while
// set, every turn carries it as focus_recipe and the panel floats above the sheet.
let chatFocus = null;
const askedAbout = new Set();   // dish ids that already got the "Ask me anything about…" line
function clearChatFocus() {
  chatFocus = null;
  el.chat.classList.remove('over');
}
// The file inputs live in their dropzone while an upload sheet is open; park them before the sheet's markup is replaced.
function parkFileInput() {
  for (const input of [el.file, el.dishFile]) if (el.sheet.contains(input)) document.body.appendChild(input);
}
function openSheet(kind, html, cls = '') {
  if (!state.sheet) state.sheetReturn = document.activeElement;   // first open only: sheet-to-sheet keeps the original trigger
  state.sheet = kind;
  parkFileInput();
  el.sheet.className = `sheet glass ${cls}`;
  el.sheet.innerHTML = html;
  applyDishImages(el.sheet);
  watchImages(el.sheet);
  el.chatFab.classList.add('over');   // the helper stays reachable above the veil while a sheet is open
  if (kind !== 'detail' && kind !== 'rate') clearChatFocus();   // a different sheet: the helper is no longer about that recipe
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
  clearChatFocus();
  el.chatFab.classList.remove('over');
  el.sheet.classList.remove('in');
  el.veil.classList.remove('in');
  // hand focus back to whatever opened the sheet, unless the user already clicked somewhere else
  const back = state.sheetReturn; state.sheetReturn = null;
  if (back && back.isConnected && (el.sheet.contains(document.activeElement) || document.activeElement === document.body)) back.focus({ preventScroll: true });
  setTimeout(() => {
    if (!state.sheet) { parkFileInput(); el.sheet.hidden = true; el.sheet.innerHTML = ''; el.veil.hidden = true; }
  }, reduceMotion ? 0 : 220);
}
const closeBtn = (extra = '') => `<button class="circle sm glass muted close ${extra}" type="button" data-close aria-label="Close">${ICON.x}</button>`;

/* ---------- scan: upload ---------- */
/* ---------- scan: what kind of photo? ---------- */
function openScanChooser() {
  openSheet('scan-choose', `
    <div class="sheet-head"><h2>What are we looking at?</h2>${closeBtn()}</div>
    <div class="sheet-body">
      <div class="choose">
        <button class="option glass" type="button" data-choose-receipt>
          <span class="icon">${ICON.receipt}</span>
          <span class="text"><strong>Scan a receipt</strong><small>Add what you bought. Items, quantities and use-by dates are read for you.</small></span>
          <span class="go">${ICON.chevron}</span>
        </button>
        <button class="option glass" type="button" data-choose-dish>
          <span class="icon">${ICON.cameraLg}</span>
          <span class="text"><strong>Break down a dish</strong><small>A photo of any meal becomes a recipe, with what you have and what you'll need.</small></span>
          <span class="go">${ICON.chevron}</span>
        </button>
      </div>
    </div>`, 'w-520');
}

function openScanUpload() {
  openSheet('upload', `
    <div class="sheet-head"><h2>Scan a receipt</h2>${closeBtn()}</div>
    <div class="sheet-body">
      <label class="dropzone drop" id="dropzone" for="file-input">
        <span class="icon-ring">${ICON.upload}</span>
        <strong>Drop a receipt or click to browse</strong>
        <small>Photos and PDFs · one receipt at a time</small>
      </label>
      <div class="sheet-note wrap">
        <span>${apiConfigured() ? 'Items, prices and dates are read with Gemini.' : 'Connect the API in shared/config.js to scan receipts, or add items by hand from the Pantry tab.'}</span>
        <span class="note-links">
          <button class="linkish" type="button" data-dish-upload>Have a photo of a dish instead?</button>
          ${apiConfigured() ? '' : '<button class="linkish accent" type="button" data-go-pantry>Open the Pantry tab</button>'}
        </span>
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
// The receipt being read: the photo itself, or a paper-shaped stand-in naming a PDF.
function receiptHTML(file) {
  if (file && file.type.startsWith('image/')) return `<img src="${URL.createObjectURL(file)}" alt="">`;
  return `<div class="receipt-lines"><div class="b"><span>${esc(file && file.name ? file.name : 'receipt')}</span></div><hr><div><span>Reading the pages…</span></div></div>`;
}
/** file: a File from the dropzone or the first-run card. Nothing happens without one. */
async function startProcessing(file) {
  if (!file) return;
  if (!apiConfigured()) {
    toast('Backend not configured', 'Set apiBaseUrl in shared/config.js');
    return openScanUpload();
  }
  const steps = [
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
        <span>Parsing with Gemini. Keep this tab open.</span>
        <button class="linkish" type="button" data-back-upload>Cancel</button>
      </div>
    </div>`);
  const stepEls = $$('.step', el.sheet);

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
    const lines = [];
    for (const item of parsed.items || []) lines.push(lineFromScanItem(item, lines));
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
          <button class="pill glass sm" type="button" data-fix="${l.id}">${ICON.checkSm}<span>${esc(l.name)}, ${esc(formatQuantity(l.qty))}</span></button>
          <button class="linkish" type="button" data-editrow="${l.id}">Edit</button>
          <button class="linkish" type="button" data-drop="${l.id}">Drop</button>
        </div></div>`;
    }
    return `<div class="rrow" data-id="${l.id}" ${delay()}>
      <button class="main" type="button" data-editrow="${l.id}">
        <div class="name"><strong>${esc(l.name)}</strong><small>${esc(estimateLabel(l.key, l))}</small></div>
        <span class="qty">${esc(formatQuantity(l.qty || ''))}</span>
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
// A row's editor was saved: the name and quantity as typed, the quantity in the one spelling the
// pantry uses, and the servings read again from it, so a corrected "2 lb" is not added with the
// servings of the scanned "1 lb". A new name is keyed afresh; an unchanged one keeps the scanner's key.
function saveReviewEdit(id, name, qty) {
  const l = review.find(x => x.id === id);
  if (!l) return null;
  const newName = String(name || '').trim() || l.name;
  if (newName !== l.name) { l.name = newName; l.key = keyForName(newName); }
  l.qty = qtyInPantryUnit(l.key, formatQuantity(String(qty || '').trim()));
  l.initial = lineServings(l);
  l.editing = false; l.fixed = true;
  return l;
}
// How many dishes would become makeable if these lines were added (dry run).
function countNewDishes(lines, before) {
  const saved = state.pantry;
  state.pantry = saved.concat(lines.filter(l => !findItem(l.key)).map(l => mk(l.name, l.key, l.qty, 0)));
  const after = activeDishes().filter(passesPrefs).map(analyze).filter(eligible).map(a => a.dish.id);   // anything either deck would deal
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
      price: l.price > 0 ? l.price : null,   // the receipt's price, so the kitchen report can say what it saved
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
// Recipe details can open from the deck, Tonight, or Saved.
// Inner HTML for the recipe sheet, scaled to `people` (default from the household profile).
function detailBody(a, people) {
  const d = a.dish;
  const fromSaved = state.detailFromSaved;
  const fromPlan = state.detailFromPlan;
  const kept = isSaved(d.id);
  const base = Math.max(1, d.servings || 1);
  const factor = people / base;
  const short = a.short || [];
  const needed = [...a.missing, ...short];
  // amount, then which pantry row a stand-in uses ("· your chicken thighs") or how low they are
  const note = (i, take) => {
    if (i.sub) return ` <small>· using ${esc(i.sub.use)}</small> <button class="linkish sm" type="button" data-unswap="${esc(i.name)}">Undo</button>`;
    if (i.status === 'short') return ` <small>· low, ${esc(servingsText(i.key, i.avail))} of ${esc(take.text)}</small>`;
    if (i.approx && i.item) return ` <small>· your ${esc(i.item.name.toLowerCase())}</small>`;
    return '';
  };
  // Under "You'll need", each row offers a swap; the suggestions open in a slot below it.
  const swapBtn = i => `<button class="linkish sm swap" type="button" data-swap="${esc(i.name)}">Swap?</button>`;
  // Amounts are quoted in the unit the pantry keeps that food in: 12 bananas on the
  // shelf means this row asks for bananas, never servings or grams.
  const ing = (i, cls) => {
    const take = takeFor(i, factor);
    return `<div class="ing ${cls}"><span class="mark">${cls === 'have' ? ICON.checkSm : ''}</span><span class="n">${esc(i.name)}</span><span class="a">${esc(take.text)}${note(i, take)}</span>${cls !== 'have' ? swapBtn(i) : ''}${listBtnHTML(i, d, { qty: take.text })}</div>`
      + (cls !== 'have' ? `<div class="subs-slot" data-subs-for="${esc(i.name)}" hidden></div>` : '');
  };
  // everything under "You'll need" is already on the list: say so instead of offering it again
  const listed = needed.length > 0 && needed.every(i => onShoppingList(i.key));
  const shopBtn = needed.length
    ? (listed
      ? `<span class="shop-add listed">${ICON.checkSm}<span>On your shopping list</span></span>`
      : `<button class="pill glass sm shop-add" type="button" data-shop-add="${esc(d.id)}">${ICON.plus}<span>Add ${needed.length} to shopping list</span></button>`)
    : '';
  // Cook tonight: for dishes that are not dealt on the deck (a chat or plan recipe, a saved
  // photo) or were opened from the week, where a swipe is not how you pick them
  const cookBtn = !state.chosen.has(d.id) && (!onDeck(d.id) || fromPlan)
    ? `<button class="pill glass lg" type="button" data-cook-tonight="${esc(d.id)}">${ICON.checkMd}<span>Cook tonight</span></button>`
    : '';
  const back = fromSaved
    ? `<button class="linkish" type="button" data-open-saved>Back to saved</button>`
    : fromPlan
      ? `<button class="linkish" type="button" data-open-plan>Back to this week</button>`
      : `<button class="linkish" type="button" data-close>Back to deck</button>`;
  return `
    <div class="hero">
      <img${imgSrcAttr(d)} alt=""${dishImgAttrs(d)}>
      ${a.badge ? `<div class="badge glass ${a.badge.level}"><span class="dot"></span><span>${esc(a.badge.text)}</span></div>` : ''}
      ${closeBtn()}
      <div class="hero-text">
        <h2>${esc(d.name)}</h2>
        <div class="meta"><span>${d.time}</span><i></i>${difficultyHTML(d)}${a.missing.length ? `<i></i><span>${plural(a.missing.length, 'thing missing', 'things missing')}</span>` : ''}${short.length ? `<i></i><span>low on ${short.length}</span>` : ''}</div>
        ${(a.warn.length || a.stretch) ? `<div class="chips">${warnChips(a)}</div>` : ''}
      </div>
    </div>
    <div class="detail-body scroll">
      <div class="servings">
        <span class="eyebrow">Cooking for</span>
        <div class="stepper" role="group" aria-label="People to cook for">
          <button class="circle sm glass" type="button" data-serv="-1" aria-label="Fewer people"${people <= 1 ? ' disabled' : ''}>−</button>
          <output>${plural(people, 'person', 'people')}</output>
          <button class="circle sm glass" type="button" data-serv="1" aria-label="More people"${people >= 20 ? ' disabled' : ''}>+</button>
        </div>
      </div>
      ${base !== people ? `<p class="serv-note">Recipe written for ${base} · amounts scaled</p>` : ''}
      <div class="nutri">
        <div class="nstat"><strong>${a.stats.kcal}</strong><small>cal / serving</small></div>
        <div class="nstat"><strong>${a.stats.protein}g</strong><small>protein</small></div>
        <div class="nstat"><strong>${a.stats.fat}g</strong><small>fat</small></div>
        <div class="nstat"><strong>${a.stats.carbs}g</strong><small>carbs</small></div>
        <div class="nstat"><strong>${money(a.stats.cost)}</strong><small>per serving</small></div>
        <div class="nstat"><strong>${money(a.stats.cost * people)}</strong><small>for ${plural(people, 'person', 'people')}</small></div>
      </div>
      <div class="ings">
        <div class="eyebrow">Ingredients</div>
        ${a.have.map(i => ing(i, 'have')).join('')}
        ${needed.length ? `<div class="divider"><span>You’ll need</span></div>` + a.missing.map(i => ing(i, 'need')).join('') + short.map(i => ing(i, 'low')).join('') + shopBtn : ''}
      </div>
      <div class="ings">
        <div class="eyebrow">Steps</div>
        ${d.stepsLoading
          ? '<p class="ing-note steps-loading"><span class="dots"><i></i><i></i><i></i></span> Writing the steps…</p>'
          : (d.steps.length
            ? `<ol class="stepslist">${d.steps.map((s, i) => `<li><span class="num glass">${i + 1}</span><span>${esc(s)}</span></li>`).join('')}</ol>`
            : '<p class="ing-note">No steps for this one yet.</p>')}
      </div>
    </div>
    <div class="sheet-foot">
      ${back}
      ${kept ? `<button class="linkish dim" type="button" data-remove-saved="${d.id}">Remove</button>` : ''}
      <span class="grow"></span>
      ${cookBtn}
      <button class="pill glass" type="button" data-ask-dish="${esc(d.id)}">${ICON.chat}<span>Ask a question</span></button>
      <button class="pill prominent" type="button" data-cook-mode="${esc(d.id)}">${ICON.flame}<span>Start cooking</span></button>
      <button class="pill glass" type="button" data-madeit="${d.id}">${ICON.checkMd}<span>I made this</span></button>
    </div>`;
}
const DETAIL_FROM = new Set(['tonight', 'saved', 'plan']);   // sheets a recipe may open on top of
function openDetail(a) {
  if (!a || state.leaving) return;
  if (state.sheet && !DETAIL_FROM.has(state.sheet)) return;
  state.detailFromSaved = state.sheet === 'saved';
  state.detailFromPlan = state.sheet === 'plan';
  a = analyze(a.dish || a);
  state.detailDishId = a.dish.id;
  state.detailServings = servingsTarget(state.prefs);
  openSheet('detail', detailBody(a, state.detailServings), 'w-720');
}
// Re-render the open recipe sheet in place (used by the servings stepper).
function rerenderDetail() {
  const d = dishById(state.detailDishId);
  if (!d) return;
  el.sheet.innerHTML = detailBody(analyze(d), state.detailServings);
  applyDishImages(el.sheet);
  watchImages(el.sheet);
}
// A chat or plan recipe arrives without steps (kept fast); the first time one is opened
// we fetch its steps and fill them into the open sheet.
async function openGeneratedDish(d) {
  if ((d.steps && d.steps.length) || !apiConfigured()) { openDetail(d); return; }
  d.stepsLoading = true;
  openDetail(d);                       // shows ingredients now, "Writing the steps…" below
  try {
    const names = (d.names && d.names.length) ? d.names : d.ingredients.map(i => i.name);
    const { steps } = await recipeDetail({ title: d.name, servings: d.servings, ingredients: names });
    d.steps = Array.isArray(steps) ? steps : [];
  } catch {
    d.steps = [];
  } finally {
    d.stepsLoading = false;
    if (state.detailDishId === d.id) rerenderDetail();
    if (cookState.open && cookState.dish === d && typeof renderCook === 'function') renderCook();   // cook mode was waiting on the steps
  }
}
// Tonight, without a swipe: chat and plan recipes, saved photos, or a deck dish opened from
// the week. A deck dish leaves the deck the way a cook swipe does, so Undo can bring it back.
// A plan dish needs no parking here: adoptPlan() carries the chosen ones across a regenerate.
function cookTonight(id) {
  const d = dishById(id);
  if (!d || state.chosen.has(id)) return;
  if (isPhotoId(id)) state.extraDishes.set(id, d);   // stays openable even if removed from Saved
  state.chosen.add(id);
  if (onDeck(id)) state.history.push({ id, dir: 'cook', tab: isDeckTab() ? state.tab : 'curated' });
  closeSheet();
  renderAll();
  toast(`Tonight · ${d.name}`);
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
          ${d.img ? `<img class="thumb" src="${esc(d.img)}" alt="" draggable="false"${dishImgAttrs(d)}>` : ''}
          <div class="name"><strong>${esc(d.name)}</strong><small>${d.time} · ${servesLabel()} · ${d.difficulty}</small></div>
          <span class="chev">${ICON.chevron}</span>
        </button></div>`).join('')}
    </div>
    <div class="sheet-foot"><button class="linkish" type="button" data-close>Back to deck</button></div>`, 'w-520');
}
function openMadeIt(dishId) {
  const dish = dishById(dishId);
  if (!dish) return;
  const a = analyze(dish);
  const factor = state.detailServings / Math.max(1, a.dish.servings || 1);
  // what they have, plus what they are low on: the pantry gives up whatever it holds of those
  const rows = [...a.have, ...(a.short || [])].filter(i => i.item).map(original => {
    const t = takeFor(original, factor);          // the same number the recipe sheet showed
    const i = { ...original, need: t.servings };
    const cur = i.avail;
    const take = Math.min(cur, i.need);
    const after = cur - take;
    const low = i.need > cur + 1e-9;
    const last = low || after <= OUT;
    const lots = lotsFor(i.key).filter(it => !needsCheckin(it) && current(it) > 0);
    const amt = n => servingsText(i.key, n);      // said in the unit this food is kept in
    let note;
    if (low) note = `You’re low on this · uses all ${amt(cur)} you have`;
    else if (i.item.burn > 0 && i.item.initial >= 20) note = 'Staple, barely moves';
    else if (last) note = 'This uses the last of it';
    else if (lots.length > 1) note = `Uses oldest pack first · ${amt(after)} left after`;
    else note = `${amt(after)} left after this`;
    return { ...i, cur, take, last, note, takeText: amt(take), curText: amt(cur), listQty: t.text };
  });
  rows.push(...subDeductions(a, factor));   // a swapped ingredient gives up the swap's foods instead
  openSheet('madeit', `
    <div class="sheet-head"><h2>Update your pantry</h2>${closeBtn()}</div>
    <div class="sheet-sub"><span>${esc(a.dish.name)}</span><i></i><span>uncheck anything you skipped</span></div>
    <div class="sheet-body">
      <div class="deduct" id="deduct">
        ${rows.map(r => `<div class="drow"><label><input class="chk" type="checkbox" checked data-key="${esc(r.key)}" data-last="${r.last ? 1 : 0}">
          <span class="name"><strong>${esc(r.name)}</strong><small class="${r.last ? 'warn' : ''}">${esc(r.note)}</small></span>
          <span class="amt">${esc(r.takeText)} of ${esc(r.curText)}</span></label>${listBtnHTML(r, a.dish, { qty: r.listQty || '', source: 'pantry' })}</div>`).join('')
          || '<p class="empty-note">Nothing in this dish is tracked in your pantry yet.</p>'}
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
  if (!dish) return closeSheet();
  const checked = $$('#deduct input').filter(b => b.checked).map(b => b.dataset.key);
  // keys are resolved against the pantry here, the same way the sheet listed them
  const a = analyze(dish);
  const factor = state.detailServings / Math.max(1, dish.servings || 1);
  const ranOut = [];
  const low = [];
  const used = [];
  for (const i of [...a.have, ...(a.short || [])]) {
    if (!i.item || !checked.includes(i.key)) continue;
    const want = takeFor(i, factor).servings;   // exactly what the sheet said would be used
    if (want > i.avail + 1e-9) low.push(i.name.toLowerCase());
    const batch = deductServings(i.key, want);   // takes what is there and no more
    if (!batch.length) continue;
    used.push(...batch);
    if (available(i.key) <= OUT) ranOut.push(i.name.toLowerCase());
  }
  // the swaps they picked: their pantry foods go instead of the ingredient they replace
  for (const r of subDeductions(a, factor)) {
    if (!checked.includes(r.key)) continue;
    const batch = deductServings(r.key, r.need);
    if (!batch.length) continue;
    used.push(...batch);
    if (available(r.key) <= OUT) ranOut.push(r.name.toLowerCase());
  }
  // the report's input: one cook event per lot that gave something up, and one for the meal
  for (const u of used) { const lot = state.pantry.find(x => x.id === u.id); if (lot) recordLotEvent('cook', lot, u.servings, { dishId: dish.id, title: dish.name }); }
  logEvent(lotEvent('cook', null, { now: Date.now(), dishId: dish.id, title: dish.name }));
  const entry = rememberCooked(dish);
  state.chosen.delete(dishId);
  state.cooked.add(dishId);
  state.history = state.history.filter(h => h.id !== dishId);   // cooked is cooked: Undo cannot deal it again
  renderAll({ enter: true });
  const notes = [ranOut.length ? `You’re out of ${ranOut.join(', ')}.` : '', low.length ? `You were low on ${low.join(', ')}.` : ''].filter(Boolean).join(' ');
  toast('Pantry updated', `${plural(checked.length, 'item')} used`, notes);
  logCook({ recipeId: dish.id, title: dish.name, items: used });
  openRate(entry);   // sheet-to-sheet: how was it?
  refreshRecipes();
}

/* ---------- photo of a dish → recipe ----------
   Upload (or the sample) → downscale → POST /identify → a dish object shaped like the
   deck's → the result sheet, from which it can be saved or put on tonight's list.
   When the backend is unreachable or has no key, SAMPLE_IDENTIFIED stands in. */
const SAMPLE_DISH_IMG = '../img/shakshuka.jpg';
const DISH_SHEETS = new Set(['upload', 'saved', 'dish-upload', 'dish-processing', 'dish-result', 'scan-choose']);   // sheets the flow may open from
const confidenceLabel = c => (c >= 0.8 ? 'pretty sure' : c >= 0.6 ? 'fairly sure' : 'best guess');
const isSaved = id => state.saved.some(d => d.id === id);
const isImageFile = f => /^image\//i.test(f.type || '') || /\.(heic|heif)$/i.test(f.name || '');
let identifyToken = 0;    // a cancelled identify must not open a result over a newer one
let resultDish = null;    // the dish in the result sheet, until it is saved or dropped

// Servings a recipe takes from the pantry when its amount cannot be sized for the food
// (analyze() reads the amount first): 1, or 2 for something that reads as the bulk of the dish.
function needFor(i) {
  if (i.staple) return 1;
  const c = toCanonical(String(i.amount || ''));
  if (c.amount == null) return 1;
  if (c.unit === 'g' && c.amount >= 400) return 2;    // a pound of anything
  if (c.unit === 'ml' && c.amount >= 480) return 2;   // two cups
  if (c.unit === 'pcs' && c.amount >= 4) return 2;    // "4" eggs
  return 1;
}
/** The /identify response as a deck-shaped dish (see the contract in shared/store.js). */
function dishFromIdentified(res, imgDataUrl) {
  const r = res && typeof res === 'object' ? res : {};
  const t = r.tags && typeof r.tags === 'object' ? r.tags : {};
  const level = String(r.difficulty || 'easy').toLowerCase();
  const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : [])
    .filter(i => i && i.name)
    .map(i => ({ name: String(i.name).trim(), need: needFor(i), amt: String(i.amount || '').trim(), staple: Boolean(i.staple) }));   // matched to the pantry by analyze()
  const cuisine = String(r.cuisine || '').toLowerCase().trim();
  return {
    id: `photo-${uid()}`,
    name: String(r.title || 'Untitled dish').trim() || 'Untitled dish',
    img: imgDataUrl || '',
    time: `${Math.max(1, Math.round(Number(r.cook_minutes) || 20))} min`,
    servings: Math.max(1, Math.round(Number(r.servings) || 2)),
    difficulty: ['easy', 'medium', 'hard'].includes(level) ? level.replace(/^\w/, c => c.toUpperCase()) : 'Easy',
    ingredients,
    names: ingredients.map(i => i.name),   // staples included, for the allergy and dislike checks
    steps: (Array.isArray(r.steps) ? r.steps : []).map(s => String(s).trim()).filter(Boolean),
    tags: { vegetarian: Boolean(t.vegetarian) || Boolean(t.vegan), vegan: Boolean(t.vegan), contains: Array.isArray(t.contains) ? t.contains.map(String) : [], cuisine },
    cuisine,
    source: 'photo',
    confidence: clamp(Number(r.confidence) || 0, 0, 1),
    description: String(r.description || '').trim(),
    savedAt: Date.now(),
  };
}
// The backend is deployed without a key (503), not there (offline, no base URL), or an older
// build that still answers 501: show the sample instead of an error.
function backendNotReady(err) {
  const code = err && err.code;
  if (code === 'not_implemented' || code === 'unreachable' || code === 'unconfigured') return true;
  if (err && (err.status === 501 || err.status === 503)) return true;
  const msg = String((err && err.message) || err || '').toLowerCase();
  return /not implemented/.test(msg) || /failed to fetch|networkerror|load failed|network request failed/.test(msg);
}

function openDishUpload() {
  if (state.sheet && !DISH_SHEETS.has(state.sheet)) return;
  identifyToken++;   // whatever was being identified is dropped
  resultDish = null;
  openSheet('dish-upload', `
    <div class="sheet-head"><h2>Photo of a dish</h2>${closeBtn()}</div>
    <div class="sheet-body">
      <label class="dropzone drop" id="dish-dropzone" for="dish-input">
        <span class="icon-ring">${ICON.cameraBig}</span>
        <strong>Drop a photo of any dish, or click to browse</strong>
        <small>One dish per photo works best</small>
      </label>
      <div class="sheet-note wrap">
        <span>${apiConfigured() ? 'The dish, its recipe and what you already have are worked out with Gemini.' : 'Backend offline — use the sample photo, or set apiBaseUrl.'}</span>
        <span class="note-links">
          <button class="linkish accent" type="button" data-dish-sample>Use a sample photo</button>
          <button class="linkish" type="button" data-close>Cancel</button>
        </span>
      </div>
    </div>`);
  const zone = $('#dish-dropzone');
  zone.prepend(el.dishFile);   // same pattern as the receipt: the real input is inside, the label names it
  ['dragenter', 'dragover'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) startIdentify(f); });
}
el.dishFile.addEventListener('change', () => { const f = el.dishFile.files[0]; if (f) startIdentify(f); el.dishFile.value = ''; });

/** file: a File from the dropzone, or null for the sample photo. */
async function startIdentify(file) {
  const token = ++identifyToken;
  const usingSample = !file;
  if (file && !isImageFile(file)) {
    toast('That doesn’t look like a photo', 'JPG, PNG, WEBP or HEIC');
    return openDishUpload();
  }
  let img = SAMPLE_DISH_IMG;
  if (file) {
    img = await downscaleImage(file);   // never rejects; '' when the browser can't read it at all
    if (token !== identifyToken || (state.sheet && state.sheet !== 'dish-upload')) return;   // dismissed or replaced meanwhile
    if (!img) img = URL.createObjectURL(file);
  }
  const live = Boolean(file) && apiConfigured();
  const steps = [
    ['Looking at the dish', live ? 'Sending your photo to Gemini' : 'What is on the plate'],
    ['Writing the recipe', 'Ingredients, amounts and steps'],
    ['Checking your pantry', 'What you have and what you’ll need'],
  ];
  openSheet('dish-processing', `
    <div class="sheet-head"><h2>Looking at your photo</h2>${closeBtn()}</div>
    <div class="sheet-body">
      <div class="processing">
        <div class="dish-photo"><img src="${esc(img)}" alt=""><div class="receipt-tint"></div><div class="scanline"></div></div>
        <div class="steps">${steps.map(([t, s]) => `<div class="step"><span class="mark">${ICON.checkMd}</span><div><strong>${t}</strong><small>${s}</small></div></div>`).join('')}</div>
      </div>
      <div class="sheet-note wrap">
        <span>${usingSample
          ? 'Sample photo — skip the camera when you just want to try the flow.'
          : live ? 'Identifying with Gemini. Keep this tab open.' : 'Demo mode: the sample recipe stands in for the backend.'}</span>
        <button class="linkish" type="button" data-dish-upload>Cancel</button>
      </div>
    </div>`);
  const stepEls = $$('.step', el.sheet);
  const still = () => token === identifyToken && state.sheet === 'dish-processing';
  let res = null, fallback = false;

  if (!live) {
    // no request to wait for: play the steps, then use the canned answer
    for (let i = 0; i < stepEls.length; i++) {
      if (!still()) return;
      stepEls[i].classList.add('active');
      await wait(900);
      stepEls[i].classList.remove('active');
      stepEls[i].classList.add('done');
    }
    res = SAMPLE_IDENTIFIED;
    fallback = !usingSample;   // they gave us a real photo and got the sample back: say so
  } else {
    // Animate steps while the request runs (same pattern as the receipt)
    let stepIdx = 0;
    stepEls[0]?.classList.add('active');
    const tick = setInterval(() => {
      if (!still()) return;
      if (stepEls[stepIdx]) {
        stepEls[stepIdx].classList.remove('active');
        stepEls[stepIdx].classList.add('done');
      }
      stepIdx = Math.min(stepIdx + 1, stepEls.length - 1);
      stepEls[stepIdx]?.classList.add('active');
    }, 1400);
    try {
      res = await identifyDish(file);
    } catch (err) {
      console.warn('[pantry] identify failed', err);
      if (backendNotReady(err)) { res = SAMPLE_IDENTIFIED; fallback = true; }
      else {
        clearInterval(tick);
        if (!still()) return;
        toast('Couldn’t read that photo', String(err.message || err));
        return openDishUpload();
      }
    }
    clearInterval(tick);
  }
  if (!still()) return;
  stepEls.forEach(s => { s.classList.remove('active'); s.classList.add('done'); });
  await wait(200);
  if (!still()) return;
  openDishResult(dishFromIdentified(res, img));
  if (fallback) toast('Backend not ready yet — showing a sample');
}

const resultListBtn = i => listBtnHTML(i, resultDish, { qty: standardizeAmount(i.amt) });
const ingHaveHTML = i => `<div class="ing have"><span class="mark">${ICON.checkSm}</span><span class="n">${esc(i.name)}</span><span class="a">${esc(standardizeAmount(i.amt))}</span>${resultListBtn(i)}</div>`;
const ingNeedHTML = i => `<div class="ing need"><span class="mark"></span><span class="n">${esc(i.name)}</span><span class="a">${esc(standardizeAmount(i.amt))}</span>${resultListBtn(i)}</div>`;
const ingLowHTML = i => `<div class="ing low"><span class="mark"></span><span class="n">${esc(i.name)}</span><span class="a">${esc(standardizeAmount(i.amt))} <small>· low</small></span>${resultListBtn(i)}</div>`;

// The result: the recipe detail's layout with the photo as the hero, split into what they have and what they'll need.
function openDishResult(dish) {
  resultDish = dish;
  const a = analyze(dish);
  const matched = a.have.filter(i => !i.staple);
  const staples = a.ings.filter(i => i.staple);
  const haveCol = (matched.length || staples.length)
    ? matched.map(ingHaveHTML).join('') + (staples.length ? `<div class="divider"><span>Staples</span></div>${staples.map(ingHaveHTML).join('')}` : '')
    : '<p class="ing-note">Nothing from your pantry yet.</p>';
  const needCol = (a.missing.length || a.short.length)
    ? a.missing.map(ingNeedHTML).join('') + a.short.map(ingLowHTML).join('')
    : '<p class="ing-note">Nothing — you have it all.</p>';
  openSheet('dish-result', `
    <div class="hero">
      <img src="${esc(dish.img)}" alt="">
      <div class="badge glass looks"><span>Looks like ${esc(dish.name)} · ${confidenceLabel(dish.confidence)}</span></div>
      ${closeBtn()}
      <div class="hero-text">
        <h2>${esc(dish.name)}</h2>
        <div class="meta"><span>${esc(dish.time)}</span><i></i><span>${servesLabel()}</span><i></i>${difficultyHTML(dish)}${a.missing.length ? `<i></i><span>${plural(a.missing.length, 'thing missing', 'things missing')}</span>` : ''}</div>
        ${dish.description ? `<p class="dish-desc">${esc(dish.description)}</p>` : ''}
      </div>
    </div>
    <div class="sheet-body result-body">
      <div class="result-cols">
        <div class="ings"><div class="eyebrow">You have</div>${haveCol}</div>
        <div class="ings"><div class="eyebrow">You’ll need</div>${needCol}</div>
      </div>
      <div class="ings">
        <div class="eyebrow">Steps</div>
        ${dish.steps.length
          ? `<ol class="stepslist">${dish.steps.map((s, i) => `<li><span class="num glass">${i + 1}</span><span>${esc(s)}</span></li>`).join('')}</ol>`
          : '<p class="ing-note">No steps came back for this one.</p>'}
      </div>
    </div>
    <div class="sheet-foot result-foot">
      <button class="pill prominent lg" type="button" data-dish-save>${ICON.bookmark}<span>Save for later</span></button>
      <button class="pill glass lg" type="button" data-dish-cook>${ICON.checkMd}<span>Cook tonight</span></button>
      <button class="linkish dim" type="button" data-dish-upload>Not it? Try another photo</button>
    </div>`, 'w-720 dish-result');
}
// Save keeps the recipe; cook also puts it on tonight's list, the way a cook swipe does.
function keepResult({ cook = false } = {}) {
  const dish = resultDish;
  if (!dish) return closeSheet();
  resultDish = null;
  saveDish(dish);   // localStorage now, public.recipes in the background; never throws
  state.saved = [dish, ...state.saved.filter(d => d.id !== dish.id)];
  if (cook) {
    state.extraDishes.set(dish.id, dish);
    state.chosen.add(dish.id);
  }
  closeSheet();
  renderAll();
  toast(cook ? `Tonight · ${dish.name}` : `Saved · ${dish.name}`, cook ? 'Saved for later too' : '');
}
function removeSaved(id) {
  const dish = state.saved.find(d => d.id === id);
  state.saved = state.saved.filter(d => d.id !== id);
  removeDish(id);
  if (dish && state.chosen.has(id)) state.extraDishes.set(id, dish);   // still on tonight's list: keep it openable
  renderAll();
  toast('Removed from saved', dish ? dish.name : '');
  openSaved();   // back to the list (sheet-to-sheet from the detail)
}

/* ---------- saved dishes ---------- */
function savedRowHTML(d, i) {
  const a = analyze(d);
  const counted = a.ings.filter(x => !x.staple);   // staples are assumed, so they don't count either way
  const haveN = counted.filter(x => x.have).length;
  const lowN = a.short.length;
  const thumb = d.img ? `<img class="thumb" src="${esc(d.img)}" alt="" draggable="false"${dishImgAttrs(d)}>` : `<span class="thumb" aria-hidden="true">${ICON.camera}</span>`;
  return `<div class="rrow" style="animation-delay:${i * 50}ms">
    <button class="main" type="button" data-open-saved-dish="${esc(d.id)}">
      ${thumb}
      <div class="name">
        <strong>${esc(d.name)}</strong>
        <small class="meta"><span>${esc(d.time)}</span><i></i><span>${servesLabel()}</span><i></i>${difficultyHTML(d)}</small>
        <small>you have ${haveN} of ${counted.length}${lowN ? ` · low on ${lowN}` : ''}</small>
      </div>
      <span class="chev">${ICON.chevron}</span>
    </button>
  </div>`;
}
// The Cooked tab: every dish they made, newest first, with its rating and a way back to it.
const relativeDay = ms => { const d = Math.floor((Date.now() - ms) / DAY); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 7 ? `${d} days ago` : shortDate(ms); };
function cookedRowHTML(e, i) {
  const live = dishById(e.dishId);
  const d = live && titleKey(live.name) === titleKey(e.title) ? live : e.dish;   // the deck's copy while it lasts, else the snapshot
  const img = (d && d.img) || '';
  const thumb = img ? `<img class="thumb" src="${esc(img)}" alt="" draggable="false"${d ? dishImgAttrs(d) : ''}>` : `<span class="thumb" aria-hidden="true">${ICON.camera}</span>`;
  return `<div class="rrow cooked" style="animation-delay:${i * 50}ms">
    ${thumb}
    <div class="name"><strong>${esc(e.title)}</strong><small>${esc(relativeDay(e.at))}${d && d.time ? ` · ${esc(d.time)}` : ''}</small></div>
    <span class="rate-mini" role="group" aria-label="Rate ${esc(e.title)}">
      <button class="circle xs glass${e.rating > 0 ? ' on' : ''}" type="button" data-rate-toggle="${esc(e.id)}" data-value="1" aria-pressed="${e.rating > 0}" aria-label="Loved it">${ICON.thumbUpSm}</button>
      <button class="circle xs glass${e.rating < 0 ? ' on' : ''}" type="button" data-rate-toggle="${esc(e.id)}" data-value="-1" aria-pressed="${e.rating < 0}" aria-label="Not again">${ICON.thumbDownSm}</button>
    </span>
    ${e.dish ? `<button class="pill glass sm" type="button" data-cook-again="${esc(e.id)}">Cook again</button>` : ''}
  </div>`;
}
function savedSheetHTML() {
  const tab = state.savedTab === 'cooked' ? 'cooked' : 'saved';
  const tab_ = (id, label, n) => `<button class="ptab${tab === id ? ' on' : ''}" type="button" role="tab" aria-selected="${tab === id}" data-saved-tab="${id}">${label}${n ? ` <small>${n}</small>` : ''}</button>`;
  const body = tab === 'cooked'
    ? (state.cookedLog.length ? state.cookedLog.map(cookedRowHTML).join('') : '<p class="empty-note">Nothing cooked yet. “I made this” on a recipe puts it here, with a thumbs up or down.</p>')
    : (state.saved.length ? state.saved.map(savedRowHTML).join('') : '<p class="empty-note">Nothing saved yet. Snap a dish and keep the recipe here.</p>');
  return `
    <div class="sheet-head"><h2>${tab === 'cooked' ? 'Cooked' : 'Saved dishes'}</h2>${closeBtn()}</div>
    <div class="sheet-body">
      <div class="ptabs" role="tablist">${tab_('saved', 'Saved', state.saved.length)}${tab_('cooked', 'Cooked', state.cookedLog.length)}</div>
      ${tab === 'saved' ? `<button class="pill prominent full" type="button" data-dish-upload>${ICON.camera}<span>Identify a dish from a photo</span></button>` : ''}
      <div class="dlist" id="saved-list">${body}</div>
    </div>`;
}
function openSaved(tab) {
  if (tab === 'saved' || tab === 'cooked') state.savedTab = tab;
  if (state.sheet && state.sheet !== 'detail' && state.sheet !== 'saved') return;   // the detail's "Back to saved" and Remove reopen it sheet-to-sheet
  openSheet('saved', savedSheetHTML(), 'w-520');
}
function rerenderSaved() {
  if (state.sheet !== 'saved') return;
  el.sheet.innerHTML = savedSheetHTML();
  applyDishImages(el.sheet);
  watchImages(el.sheet);
}

/* ---------- pantry page ---------- */
// The pantry is a section now, not a panel: opening it is setTab('pantry'), closing it is
// setTab('curated'), and setTab folds the add form and any half-finished check-in on the way out.
const shortDate = ms => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function boughtLabel(it) {
  return `bought ${shortDate(it.purchase)}`;
}
// "4.5 bananas of 8 bananas", or just "8 bananas" while none of it has gone.
function amountOfLabel(it) {
  const left = lotAmountText(it);
  const full = qtyText(it);
  return !full || left === full ? left : `${left} of ${full}`;
}
function lotLabel(it) {
  const bits = [];
  if (it.variant) bits.push(it.variant);
  bits.push(boughtLabel(it));
  if (it.qty) bits.push(amountOfLabel(it));
  return bits.join(' · ');
}
// The stored quantity string is left as it was typed or scanned; only the display is
// standardised — and a count reads with the food's own noun, as the amount left does.
const qtyText = it => (it.qty ? formatQuantity(lotSize(it) || it.qty) : '');
function stackDisplayName(lots) {
  const names = [...new Set(lots.map(l => l.name))];
  if (names.length === 1) return names[0];
  // Prefer the shortest / most generic label for the stack header
  return names.sort((a, b) => a.length - b.length)[0];
}
function prowHTML(it, { lot = false } = {}) {
  const cur = current(it);
  const pctLeft = it.initial > 0 ? clamp(cur / it.initial, 0, 1) : 0;
  const lvl = amountLevel(pctLeft);
  // What is left is said in the unit this lot is kept in, not in servings.
  const sub = lot ? esc(lotLabel(it)) : `${esc(amountOfLabel(it))} left`;
  return `<div class="prow${lot ? ' lot' : ''}${pantrySeen.has(it.id) ? '' : ' enter'}" data-id="${it.id}">
    <div class="name"><strong>${esc(lot && it.variant ? it.variant : it.name)}</strong><small>${sub}</small></div>
    <div class="fresh amt-${lvl}">
      <div class="bar"><i style="width:${Math.max(4, Math.round(pctLeft * 100))}%"></i></div>
      <div class="fmeta"><span class="pct">${Math.round(pctLeft * 100)}% left</span><span class="exp">exp ${esc(shortDate(it.expiry))}</span></div>
    </div>
    ${listBtnHTML(it, null, { qty: it.qty || '', source: 'pantry', size: 'sm' })}
    <button class="circle sm glass del" type="button" data-remove="${it.id}" aria-label="Remove ${esc(it.name)}">${ICON.xSm}</button>
  </div>`;
}
function stackHTML(lots) {
  if (lots.length === 1) return prowHTML(lots[0]);
  const key = lots[0].key;
  const open = state.expanded.has(key);
  const primary = lots.slice().sort((a, b) => a.expiry - b.expiry)[0];
  const total = lots.reduce((s, it) => s + current(it), 0);
  const totalInitial = lots.reduce((s, it) => s + it.initial, 0);
  const pctLeft = totalInitial > 0 ? clamp(total / totalInitial, 0, 1) : 0;
  const lvl = amountLevel(pctLeft);
  const name = stackDisplayName(lots);
  return `<div class="prow stack${open ? ' open' : ''}" data-key="${esc(key)}">
    <button class="stack-main" type="button" data-toggle-stack="${esc(key)}" aria-expanded="${open}">
      <span class="chev">${ICON.chevron}</span>
      <div class="name"><strong>${esc(name)}</strong><small>${plural(lots.length, 'pack')} · ${esc(stackAmountText(lots))} left</small></div>
      <div class="fresh amt-${lvl}">
        <div class="bar"><i style="width:${Math.max(4, Math.round(pctLeft * 100))}%"></i></div>
        <div class="fmeta"><span class="pct">${Math.round(pctLeft * 100)}% left</span><span class="exp">exp ${esc(shortDate(primary.expiry))}</span></div>
      </div>
    </button>
    ${listBtnHTML({ name, key }, null, { qty: primary.qty || '', source: 'pantry', size: 'sm' })}
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
function checkinHTML(it) {
  const ranOut = it.burn > 0 ? Math.min(0, Math.round(((it.initial - it.deducted - OUT) / burnRate(it)) - (Date.now() - it.purchase) / DAY)) : 0;
  const when = it.deducted > 0 ? 'used up cooking' : ranOut === 0 ? 'we estimate it ran out today' : ranOut === -1 ? 'we estimate it ran out yesterday' : `we estimate it ran out ${-ranOut} days ago`;
  if (it.asking) {
    return `<div class="checkin" data-id="${it.id}">
      <div class="eyebrow">How much ${esc(it.name.toLowerCase())} is left?</div>
      <div class="slider-row">
        <input type="range" class="amt-slider" min="0" max="100" step="5" value="50" data-slider="${it.id}" aria-label="Percent of ${esc(it.name)} remaining">
        <output class="amt-out" data-out="${it.id}">50% left</output>
      </div>
      <div class="opts">
        <button class="pill prominent sm" type="button" data-setamt="${it.id}">Save</button>
        <button class="linkish" type="button" data-unask="${it.id}">Back</button>
      </div></div>`;
  }
  return `<div class="checkin" data-id="${it.id}">
    <div class="eyebrow">Still have this?</div>
    <div class="item"><strong>${esc(it.name)}</strong><small>${esc(qtyText(it))}${it.qty ? ' · ' : ''}${when}</small></div>
    <div class="opts">
      <button class="pill glass sm" type="button" data-gone="${it.id}">All gone</button>
      <button class="pill prominent sm" type="button" data-ask="${it.id}">Still have some</button>
    </div></div>`;
}
const stackAmountPct = lots => { const t = lots.reduce((s, it) => s + current(it), 0), ti = lots.reduce((s, it) => s + it.initial, 0); return ti > 0 ? t / ti : 0; };
// Rows already painted once do not replay their entrance on the next render; only new
// lots (and, on the shopping list, rows that just changed group) rise in.
const pantrySeen = new Set();
const shopSeen = new Map();   // row id → done, as last painted
function renderPanel() {
  const mem = focusIndexIn(el.panelBody, '.checkin, .prow');
  const tab = state.panelTab || 'expiring';
  const checkins = state.pantry.filter(needsCheckin).map(checkinHTML).join('');
  const stacks = groupLots(state.pantry.filter(it => !needsCheckin(it)));
  let body = '';
  if (!stacks.length) {
    body = checkins ? '' : '<p class="empty-note">Nothing here yet. Scan a receipt or add something by hand.</p>';
  } else if (tab === 'category') {
    const groups = new Map();
    for (const lots of stacks) { const c = categoryOf(lots[0].key); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(lots); }
    body = CATEGORY_ORDER.filter(c => groups.has(c)).map(c => {
      const g = groups.get(c).sort((a, b) => a[0].name.localeCompare(b[0].name));
      return `<section class="psection"><div class="phead"><span class="eyebrow">${esc(c)}</span><small>${g.length}</small></div>${g.map(stackHTML).join('')}</section>`;
    }).join('');
  } else {
    const sorted = tab === 'amount'
      ? stacks.slice().sort((a, b) => stackAmountPct(a) - stackAmountPct(b))   // least left first
      : stacks.slice().sort((a, b) => a[0].expiry - b[0].expiry);             // soonest expiry first
    body = `<section class="psection">${sorted.map(stackHTML).join('')}</section>`;
  }
  const tab_ = (id, label) => `<button class="ptab${tab === id ? ' on' : ''}" type="button" role="tab" aria-selected="${tab === id}" data-ptab="${id}">${label}</button>`;
  const tabs = stacks.length ? `<div class="ptabs" role="tablist">${tab_('expiring', 'Expiring')}${tab_('amount', 'Amount left')}${tab_('category', 'Category')}</div>` : '';
  el.panelBody.innerHTML = reportStripHTML() + checkins + tabs + body;
  for (const it of state.pantry) pantrySeen.add(it.id);
  restoreFocusIn(el.panelBody, '.checkin, .prow', mem, $('#btn-add'));   // the page itself is not focusable; its add button is
}

/* ---------- shopping list ----------
   Rows arrive from four places: a recipe's "You'll need" (a cook swipe, or the button on
   the detail sheet), the kitchen helper, the add form, and the week's plan. The same
   food still to buy merges into its row rather than stacking. Persisted through
   store.js (localStorage, and app_state.shopping on the account) by renderAll once a
   change has been made. */
let shoppingDirty = false;
const openShopping = () => state.shopping.filter(s => !s.done);
const onShoppingList = key => openShopping().some(s => s.key === key);

// The open row a new item would merge into: matched by name the way ingredients are
// matched to the pantry (so "Roma tomatoes" joins "tomatoes"), else by key.
function findOpenRow(item) {
  const open = openShopping();
  const m = matchIngredient({ name: item.name }, buildPantryIndex(open, []));
  return (m && open.find(s => s.key === m.key)) || open.find(s => s.key === item.key) || null;
}
// A quantity for a row that is already there: the larger of two like amounts wins;
// amounts that do not compare are kept side by side in the note ("+ 2 cloves").
function mergeQty(row, qty) {
  if (!qty) return;
  const a = toCanonical(row.qty), b = toCanonical(qty);
  if (b.amount == null) return;
  if (a.amount == null) { row.qty = qty; return; }
  if (a.unit === b.unit) { if (b.amount > a.amount) row.qty = qty; return; }
  const extra = `+ ${formatQuantity(qty)}`;
  if (!row.note.includes(extra)) row.note = [row.note, extra].filter(Boolean).join(' · ');
}
/**
 * Put items on the list. items: [{ name, key?, qty?, note?, dishId?, dishName? }].
 * Returns { count, names, merged }: rows added or merged, their names, how many merged.
 */
function addShopping(items, { source = 'manual' } = {}) {
  const names = [];
  let merged = 0;
  for (const raw of items || []) {
    const name = String(raw.name || '').trim();
    if (!name) continue;
    const item = { name, key: String(raw.key || keyForName(name)).toLowerCase(), qty: String(raw.qty || '').trim(), note: String(raw.note || '').trim() };
    const row = findOpenRow(item);
    if (row) {
      mergeQty(row, item.qty);
      if (item.note && !row.note.includes(item.note)) row.note = [row.note, item.note].filter(Boolean).join(' · ');
      merged++;
    } else {
      state.shopping.push({
        id: uid(), name, key: item.key, qty: item.qty, note: item.note, done: false, source,
        dishId: String(raw.dishId || ''), dishName: String(raw.dishName || ''), addedAt: Date.now(),
      });
    }
    names.push(name);
  }
  if (names.length) shoppingDirty = true;
  return { count: names.length, names, merged };
}
// What a dish still needs, scaled to the people it is cooked for: its missing and low ingredients.
function neededForDish(d, people = servingsTarget(state.prefs)) {
  const a = analyze(d);
  const factor = people / Math.max(1, d.servings || 1);
  return [...a.missing, ...a.short].map(i => ({ name: i.name, key: i.key, qty: takeFor(i, factor).text, dishId: d.id, dishName: d.name }));
}
const addDishToShopping = (d, people) => addShopping(neededForDish(d, people), { source: 'recipe' });

/* ---------- "+" on every ingredient ----------
   One rule wherever an ingredient is shown (card chips, recipe rows, the photo result,
   the made-it sheet, pantry rows): a small + puts it on the shopping list. The button
   carries what the list needs as data attributes; listAddFromEl reads them back. */
function listAttrs(i, dish, source = 'recipe', qty) {
  const factor = dish ? servingsTarget(state.prefs) / Math.max(1, dish.servings || 1) : 1;
  const amount = qty != null ? qty : (i.amt ? takeFor(i, factor).text : '');
  return ` data-list-add="${esc(i.name)}" data-list-key="${esc(i.key || keyForName(i.name))}" data-list-qty="${esc(amount)}"`
    + ` data-list-dish="${esc(dish ? dish.id : '')}" data-list-dish-name="${esc(dish ? dish.name : '')}" data-list-source="${esc(source)}"`;
}
function listBtnHTML(i, dish, { source = 'recipe', qty, size = 'xs' } = {}) {
  const listed = onShoppingList(i.key || keyForName(i.name));
  const label = listed ? `${esc(i.name)}, on your shopping list` : `Add ${esc(i.name)} to your shopping list`;
  return `<button class="circle ${size} glass list${listed ? ' listed' : ''}" type="button"${listAttrs(i, dish, source, qty)} aria-label="${label}" title="${listed ? 'On your shopping list' : 'Add to shopping list'}"${listed ? ' disabled' : ''}>${listed ? ICON.checkSm : ICON.plusSm}</button>`;
}
// Flip a "+" to its listed state in place, so sheets need no re-render to show it.
function markListed(b) {
  b.classList.add('listed'); b.disabled = true;
  b.setAttribute('aria-label', `${b.dataset.listAdd}, on your shopping list`); b.title = 'On your shopping list';
  const plus = b.querySelector('.plus');
  if (plus) plus.innerHTML = ICON.checkSm; else b.innerHTML = ICON.checkSm;
}
function listAddFromEl(b) {
  if (!b || b.disabled) return false;
  const d = b.dataset;
  const r = addShopping([{ name: d.listAdd, key: d.listKey, qty: d.listQty, dishId: d.listDish, dishName: d.listDishName }], { source: d.listSource || 'recipe' });
  if (!r.count) return false;
  markListed(b);
  toast(`${d.listAdd} added to your shopping list`, r.merged ? 'merged with what was there' : (d.listDishName ? `for ${d.listDishName}` : ''));
  renderAll();
  return true;
}
function toggleShopping(id) {
  const s = state.shopping.find(x => x.id === id);
  if (s) { s.done = !s.done; shoppingDirty = true; }
}
function removeShopping(id) {
  const n = state.shopping.length;
  state.shopping = state.shopping.filter(x => x.id !== id);
  if (state.shopping.length !== n) shoppingDirty = true;
}
// Rows by name as the assistant read them (its names are ours verbatim; a normalised
// spelling is the fallback for the offline parser). Returns how many went.
function removeShoppingByNames(names) {
  let n = 0;
  for (const name of names || []) {
    const q = normQ(name);
      // the row still to buy goes first, so "take milk off" is not the milk already bought (chat.py agrees)
    const s = state.shopping.find(x => !x.done && x.name === name)
      || state.shopping.find(x => x.name === name)
      || state.shopping.find(x => !x.done && normQ(x.name) === q)
      || state.shopping.find(x => normQ(x.name) === q);
    if (s) { state.shopping = state.shopping.filter(x => x.id !== s.id); n++; }
  }
  if (n) shoppingDirty = true;
  return n;
}
function clearBought() {
  const n = state.shopping.length;
  state.shopping = state.shopping.filter(s => !s.done);
  if (state.shopping.length !== n) shoppingDirty = true;
  return n - state.shopping.length;
}
// Checked rows become pantry lots, servings read from their quantity, and leave the list.
function moveBoughtToPantry() {
  const bought = state.shopping.filter(s => s.done);
  for (const s of bought) addLot(s.name, s.key, s.qty ? formatQuantity(s.qty) : '', '');   // addLot says it in the unit that food is kept in
  state.shopping = state.shopping.filter(s => !s.done);
  if (bought.length) shoppingDirty = true;
  return bought.length;
}
// The list as the assistant reads it: canonical amounts, so it can answer "what's on my list?".
function shoppingForApi() {
  return state.shopping.map(s => {
    const c = toCanonical(s.qty);
    return { name: s.name, quantity: c.amount, unit: c.unit || '', done: s.done };
  });
}
function shopSourceLine(s) {
  if (s.source === 'recipe' || s.source === 'plan') {
    const dish = s.dishName || (s.dishId ? (dishById(s.dishId) || {}).name : '');
    return dish ? `for ${dish}` : s.source === 'plan' ? 'for this week' : 'for a recipe';
  }
  return s.source === 'chat' ? 'from the kitchen helper' : '';
}
function shopRowHTML(s) {
  const sub = [s.qty ? formatQuantity(s.qty) : '', shopSourceLine(s), s.note].filter(Boolean).join(' · ');
  const enter = !shopSeen.has(s.id) || shopSeen.get(s.id) !== s.done;   // new, or just moved between To buy and Bought
  return `<div class="prow shop${s.done ? ' done' : ''}${enter ? ' enter' : ''}" data-id="${s.id}">
    <button class="shop-chk" type="button" role="checkbox" aria-checked="${s.done}" data-shop-toggle="${s.id}" aria-label="Mark ${esc(s.name)} as ${s.done ? 'still to buy' : 'bought'}">${ICON.checkSm}</button>
    <div class="name"><strong>${esc(s.name)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
    <button class="circle sm glass del" type="button" data-shop-remove="${s.id}" aria-label="Remove ${esc(s.name)}">${ICON.xSm}</button>
  </div>`;
}
function renderShopping() {
  const mem = focusIndexIn(el.shoppingBody, '.prow');
  const open = openShopping(), done = state.shopping.filter(s => s.done);
  el.shoppingCount.textContent = open.length ? `${plural(open.length, 'item')} to buy` : 'Nothing to buy';
  const group = (label, rows) => `<section class="psection"><div class="phead"><span class="eyebrow">${label}</span><small>${rows.length}</small></div>${rows.map(shopRowHTML).join('')}</section>`;
  el.shoppingBody.innerHTML = state.shopping.length
    ? (open.length ? group('To buy', open) : '') + (done.length ? group('Bought', done) : '')
    : '<p class="empty-note">Nothing to buy. Explore dishes add what they’re missing here.</p>';
  const move = $('#btn-shop-move'), clear = $('#btn-shop-clear');
  if (move) move.hidden = done.length === 0;
  if (clear) clear.hidden = done.length === 0;
  shopSeen.clear();
  for (const s of state.shopping) shopSeen.set(s.id, s.done);
  restoreFocusIn(el.shoppingBody, '.prow', mem, $('#btn-shop-add'));
}

/* ---------- this week: the meal plan ----------
   Seven days of breakfast, lunch and dinner from POST /meal-plan, cached through store.js
   under a fingerprint of the kitchen (food names, servings to the nearest whole one, the
   preferences), so a day passing keeps the week and a scan or a changed diet regenerates
   it. Without the backend, with nothing in the pantry, or on its 400, the week is dealt
   round-robin from the dishes on hand so the sheet never dead-ends. Each generated meal is
   a plan- dish in planDishes, opened like any other dish; the cached plan keeps that id so
   a meal picked for Tonight still resolves after a reload. */
const PLAN_DAYS = 7;
const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner'];
const SLOT_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let plan = null;          // { start, days, signature, at, source: 'api'|'local' }
let planLoading = false;
let planError = '';
let planToken = 0;
const todayIso = () => isoDay(Date.now());
const dayFrom = (iso, n) => isoDay(Date.parse(`${iso}T12:00:00`) + n * DAY);
const shortDateOf = iso => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function planSignature() {
  const pantry = pantryForApi().map(i => `${i.name}:${Math.round(i.quantity_servings)}`).sort().join('|');
  return `${pantry}#${JSON.stringify(state.prefs)}`;
}
// The dish behind a cell: a plan- dish the model wrote, or the dish on hand a local plan points at.
const planDish = meal => (meal ? dishById(meal.ref || meal.id) : null);
// Still this week, same kitchen, every cell still resolves. A week dealt locally while the
// backend is up was a stopgap: it is asked for again the next time the sheet opens.
function planFresh(p) {
  if (!p || !Array.isArray(p.days) || !p.days.length) return false;
  if (p.signature !== planSignature()) return false;
  const today = todayIso();
  if (!(p.start <= today && today <= p.days[p.days.length - 1].date)) return false;   // ISO dates order as text
  if (p.source === 'local' && apiConfigured() && pantryForApi().length) return false;
  return p.days.every(day => MEAL_SLOTS.every(slot => !day.meals[slot] || planDish(day.meals[slot])));
}
// The model's week (or a cached one) becomes dishes the app can open: each meal a plan- dish,
// its id written back into the plan so a reload rebuilds the same ids. A meal picked for Tonight
// outlives the week it came from: whatever is still in state.chosen is carried over from the
// plan being replaced (and from a cached plan's own `parked` list) and saved with the new one.
function adoptPlan(data, { source = 'api', signature = planSignature(), at = Date.now() } = {}) {
  const parked = new Map();
  for (const d of data.parked || []) if (d && d.id && state.chosen.has(d.id)) parked.set(d.id, d);
  for (const [id, d] of planDishes) if (state.chosen.has(id)) parked.set(id, d);
  planDishes.clear();
  for (const [id, d] of parked) planDishes.set(id, d);
  const inWeek = new Set();
  const days = (data.days || []).map((day, di) => {
    const meals = {};
    MEAL_SLOTS.forEach((slot, si) => {
      const meal = day.meals && day.meals[slot];
      if (!meal) { meals[slot] = null; return; }
      if (meal.ref) { meals[slot] = meal; return; }   // a local plan: points at a dish already on hand
      const id = /^plan-/.test(String(meal.id || '')) ? String(meal.id) : `plan-${uid()}`;
      planDishes.set(id, { ...dishFromApi(meal, di * MEAL_SLOTS.length + si), id });
      inWeek.add(id);
      meals[slot] = { ...meal, id };
    });
    return { date: day.date, meals };
  });
  plan = {
    start: data.start || (days[0] && days[0].date) || todayIso(), days, signature, at, source,
    parked: [...parked.values()].filter(d => !inWeek.has(d.id)),   // still on Tonight, no longer in the week
  };
  return plan;
}
// Without the model: the dishes on hand, dealt round-robin, the ones they can make first.
// Breakfasts take the quickest.
function buildLocalPlan(start = todayIso()) {
  const all = activeDishes();
  const fits = all.filter(passesPrefs);
  const pool = (fits.length ? fits : all).map(analyze).sort((a, b) => (a.gap - b.gap) || (a.urgentDays - b.urgentDays));
  const quick = pool.slice().sort((a, b) => dishMinutes(a.dish) - dishMinutes(b.dish));
  const meal = d => ({ ref: d.id, title: d.name, cook_minutes: dishMinutes(d), servings: d.servings });
  let qi = 0, mi = 0;
  const days = [];
  for (let i = 0; i < PLAN_DAYS; i++) {
    const meals = {};
    for (const slot of MEAL_SLOTS) {
      const src = slot === 'breakfast' ? quick : pool;
      meals[slot] = src.length ? meal(src[(slot === 'breakfast' ? qi++ : mi++) % src.length].dish) : null;
    }
    days.push({ date: dayFrom(start, i), meals });
  }
  return { start, days };
}
// The plan for this week: the cached one while it still fits, else a fresh one from the
// model, or dealt locally when there is no backend, no food, or the backend says so (400).
// `force` is the Regenerate button.
async function ensurePlan({ force = false } = {}) {
  if (!force && planFresh(plan)) return plan;
  const token = ++planToken;
  const start = todayIso();
  const signature = planSignature();
  const items = pantryForApi();
  planError = '';
  if (apiConfigured() && items.length) {
    planLoading = true;
    renderPlanSheet();
    const busy = beginBusy('Planning your week…');
    try {
      const data = await fetchMealPlan(items, { prefs: normalizePrefs(state.prefs), days: PLAN_DAYS, start });
      if (token !== planToken) return plan;
      adoptPlan(data, { source: 'api', signature });
      savePlan(plan);
      return plan;
    } catch (err) {
      if (token !== planToken) return plan;
      console.warn('[pantry] meal plan failed', err);
      // A backend that is away, has no key (503), predates the route (404) or has nothing to
      // cook from (400) is the offline case: deal the week locally. Only the model failing
      // on a real request (502, a timeout) is worth a retry button.
      const msg = String((err && err.message) || err || '');
      const notReady = backendNotReady(err) || /pantry is empty|not found|api key|not set/i.test(msg);
      if (!notReady) {
        planError = msg || 'Could not reach the backend';
        return plan;
      }
    } finally {
      busy.end();
      if (token === planToken) planLoading = false;
    }
  }
  // Nothing in the kitchen yet: a week dealt from the built-in dishes would be seven days
  // of things they cannot cook. The sheet's own empty state says it better.
  if (!state.pantry.length) return plan;
  adoptPlan(buildLocalPlan(start), { source: 'local', signature });
  savePlan(plan);
  return plan;
}
const rangeLabel = p => `${shortDateOf(p.start)} – ${shortDateOf(p.days[p.days.length - 1].date)}`;
function planCellHTML(meal, slot, cls) {
  const d = planDish(meal);
  if (!d) return `<div class="plan-cell empty${cls}"><span class="text"><span class="slot">${SLOT_LABEL[slot]}</span><small>Nothing planned</small></span></div>`;
  const a = analyze(d);
  const gap = a.missing.length ? `missing ${a.missing.length}` : a.short.length ? `low on ${a.short.length}` : 'all in pantry';
  return `<button class="plan-cell${cls}" type="button" data-plan-open="${esc(d.id)}" aria-label="${SLOT_LABEL[slot]}: ${esc(d.name)}">
    <img class="thumb sm" src="${esc(d.img)}" alt="" draggable="false"${dishImgAttrs(d)}>
    <span class="text"><span class="slot">${SLOT_LABEL[slot]}</span><strong>${esc(d.name)}</strong><small>${esc(d.time)} · ${esc(gap)}</small></span>
  </button>`;
}
function planGridHTML(p) {
  const today = todayIso();
  const rows = p.days.map(day => {
    const cls = day.date < today ? ' past' : day.date === today ? ' today' : '';
    const d = new Date(`${day.date}T12:00:00`);
    return `<div class="plan-day${cls}"><strong>${DOW[d.getDay()]}</strong><small>${esc(shortDateOf(day.date))}</small></div>`
      + MEAL_SLOTS.map(slot => planCellHTML(day.meals[slot], slot, cls)).join('');
  }).join('');
  return `<div class="plan-grid"><div class="plan-hdr"></div>${MEAL_SLOTS.map(s => `<div class="plan-hdr">${SLOT_LABEL[s]}</div>`).join('')}${rows}</div>`;
}
function planSheetHTML() {
  const p = plan;
  const sub = [p ? rangeLabel(p) : 'Seven days', servesLabel(), p && p.source === 'local' ? 'Built from your saved dishes' : ''].filter(Boolean);
  let body;
  if (planLoading) body = '<p class="plan-note"><span class="dots"><i></i><i></i><i></i></span> Planning your week from what’s in the pantry…</p>';
  else if (planError && !p) {
    body = `<div class="plan-err"><p>Couldn’t plan the week. ${esc(planError)}</p><div class="row-btns">
      <button class="pill prominent" type="button" data-plan-retry>Try again</button>
      <button class="linkish" type="button" data-plan-local>Use my saved dishes instead</button></div></div>`;
  } else if (p) {
    body = (planError ? `<p class="plan-err-line">Couldn’t refresh the week (${esc(planError)}) — showing the last one. <button class="linkish accent" type="button" data-plan-retry>Try again</button></p>` : '') + planGridHTML(p);
  } else body = '<p class="plan-note">Nothing planned yet.</p>';
  return `
    <div class="sheet-head"><h2 id="plan-title">This week</h2>${closeBtn()}</div>
    <div class="sheet-sub plan-sub">${sub.map(s => `<span>${esc(s)}</span>`).join('<i></i>')}</div>
    <div class="sheet-body plan-body">${body}</div>
    <div class="sheet-foot plan-foot">
      <button class="linkish" type="button" data-plan-regen${planLoading ? ' disabled' : ''}>Regenerate</button>
      <span class="grow"></span>
      <button class="pill prominent" type="button" data-plan-shop${!p || planLoading ? ' disabled' : ''}>${ICON.plus}<span>Add the week’s missing ingredients to the shopping list</span></button>
    </div>`;
}
function renderPlanSheet() {
  if (state.sheet !== 'plan') return;
  el.sheet.innerHTML = planSheetHTML();
  applyDishImages(el.sheet);
}
function openPlan() {
  if (state.sheet && state.sheet !== 'detail') return;   // the detail's "Back to this week" reopens it sheet-to-sheet
  openSheet('plan', planSheetHTML(), 'w-720');
  ensurePlan().then(renderPlanSheet);
}
function regeneratePlan() { ensurePlan({ force: true }).then(renderPlanSheet); }
// Every cell's missing and low ingredients, deduplicated onto the list.
function addPlanToShopping() {
  if (!plan) return { count: 0, names: [], merged: 0 };
  const items = [];
  for (const day of plan.days) for (const slot of MEAL_SLOTS) { const d = planDish(day.meals[slot]); if (d) items.push(...neededForDish(d)); }
  return addShopping(items, { source: 'plan' });
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
  wireAccountButton(user);   // keep the profile-menu account row (sign in / sign out) in sync
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
  clearLocalSaved();   // and does not inherit this account's saved dishes (they stay in public.recipes)
  clearLocalDeck();    // nor its deck, which is cached on the account anyway
  clearLocalShopping();   // nor the shopping list and the week, which live on app_state too
  clearLocalPlan();
  clearLocalRatings(); clearLocalCooked(); clearLocalEvents();   // nor the ratings, the cooked log and the report's events
  await clearDishImages();   // generated pictures are per dish, not per pantry: only a sign-out drops them
  await signOut();
  location.replace('../login/');
}

/* =========================================================================
   Wave 2 — the events log and the kitchen report, ratings and the cooked
   log, substitutions on the recipe sheet. (Cook mode and voice input own
   their DOM and live with the wiring below.)
   ========================================================================= */

/* ---------- the events log ----------
   What happened to each lot, for shared/report.js: a cook event per lot a dish took
   from (and one for the meal), a check-in that consumed something, a lot marked gone,
   a lot found past its date. Written here, saved by renderAll like the shopping list. */
let eventsDirty = false;
const costFor = key => nutriFor(key).cost;   // a typical cost per serving, when a lot has no receipt price
function logEvent(e) {
  if (!e || !e.type) return;
  state.events.push(e);
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  eventsDirty = true;
}
// One lot's event: `servings` is what left it (cook, checkin) or what was still in it (gone, expired).
function recordLotEvent(type, lot, servings, extra = {}) {
  if (!lot || !(servings > 0)) return null;
  const e = lotEvent(type, lot, { servings, now: Date.now(), costPerServing: costFor(lot.key), ...extra });
  e.lotId = lot.id;   // so the boot sweep never logs the same lot twice, whatever the flag says
  logEvent(e);
  return e;
}
// The boot sweep: lots past their date with something left get one `expired` event, once.
function sweepExpired() {
  const now = Date.now();
  let n = 0;
  for (const it of expiredLots(state.pantry, now)) {
    if (!state.events.some(e => e.type === 'expired' && e.lotId === it.id)) {
      const left = current(it);
      if (left > OUT) { recordLotEvent('expired', it, left); n++; }
    }
    it.wasteLogged = true;
  }
  if (n) console.info(`[pantry] ${plural(n, 'lot')} found past their date`);
  return n;
}

/* ---------- ratings and the cooked log ----------
   A thumbs up or down after "I made this", kept by title so a regenerated deck's copy of
   the dish still carries it, and mirrored into prefs.liked / prefs.disliked so every
   model call knows (which also changes the deck signature: the deck regenerates). */
function syncRatingsToPrefs() {
  const all = Object.values(state.ratings).sort((a, b) => b.at - a.at);
  const next = normalizePrefs({ ...state.prefs, liked: all.filter(r => r.value > 0).map(r => r.title), disliked: all.filter(r => r.value < 0).map(r => r.title) });
  if (JSON.stringify(next) === JSON.stringify(state.prefs)) return false;
  state.prefs = next;
  savePrefs(state.prefs);
  return true;
}
// value: 1, -1, or 0 to clear. Returns whether the preferences changed.
function rateDish({ title, dishId = '', logId = '' }, value) {
  const key = titleKey(title);
  if (!key) return false;
  if (value) state.ratings[key] = { title, value, at: Date.now(), dishId };
  else delete state.ratings[key];
  for (const e of state.cookedLog) if (logId ? e.id === logId : titleKey(e.title) === key) e.rating = value;
  saveRatings(state.ratings);
  saveCooked(state.cookedLog);
  return syncRatingsToPrefs();
}
// Tapping the thumb it already has clears it. Returns whether the preferences changed.
function applyRating(logId, value) {
  const e = state.cookedLog.find(x => x.id === logId);
  if (!e) return false;
  return rateDish({ title: e.title, dishId: e.dishId, logId: e.id }, e.rating === value ? 0 : value);
}
// What "Cook again" needs: the dish without its runtime flags. A photo's data: URL is
// dropped (a hundred of those would not fit in localStorage); the saved copy still has it.
function cookedSnapshot(dish) {
  const { stepsLoading, ...rest } = dish;
  return JSON.parse(JSON.stringify({ ...rest, img: String(dish.img || '').startsWith('data:') ? '' : dish.img }));
}
function rememberCooked(dish) {
  const entry = { id: uid(), title: dish.name, at: Date.now(), rating: (ratingOf(dish) || {}).value || 0, dishId: dish.id, dish: cookedSnapshot(dish) };
  state.cookedLog = [entry, ...state.cookedLog].slice(0, MAX_COOKED);
  saveCooked(state.cookedLog);
  return entry;
}
function openRate(entry) {
  if (!entry) return closeSheet();
  openSheet('rate', `
    <div class="sheet-head"><h2>How was ${esc(entry.title)}?</h2>${closeBtn()}</div>
    <div class="sheet-body rate-body">
      <p class="rate-help">A thumbs up brings more like it. A thumbs down keeps it off the deck.</p>
      <div class="rate-btns">
        <button class="circle glass rate up" type="button" data-rate="1" data-rate-log="${esc(entry.id)}" aria-label="Loved it">${ICON.thumbUp}</button>
        <button class="circle glass rate down" type="button" data-rate="-1" data-rate-log="${esc(entry.id)}" aria-label="Not again">${ICON.thumbDown}</button>
      </div>
      <button class="linkish dim" type="button" data-close>Skip</button>
    </div>`, 'w-520 rate-sheet');
}
// A cooked snapshot back onto Tonight. The deck's copy is used while it still exists
// (same id, same title); otherwise the snapshot is registered as an extra dish.
function cookAgain(logId) {
  const e = state.cookedLog.find(x => x.id === logId);
  if (!e || !e.dish) return;
  let d = dishById(e.dishId);
  if (!d || titleKey(d.name) !== titleKey(e.title)) {
    d = { ...e.dish, id: e.dish.id && !dishById(e.dish.id) ? e.dish.id : `cooked-${uid()}` };
    state.extraDishes.set(d.id, d);
  }
  if (state.chosen.has(d.id)) { toast('Already on Tonight', d.name); return; }
  state.cooked.delete(d.id);   // being cooked again: the deck may deal it once more later
  cookTonight(d.id);
}

/* ---------- the kitchen report ---------- */
const REPORT_RANGES = {
  week:  { days: 7,    title: 'Your kitchen this week',  label: 'Week' },
  month: { days: 30,   title: 'Your kitchen this month', label: 'Month' },
  all:   { days: null, title: 'Your kitchen so far',     label: 'All' },
};
let reportRange = 'week';
const reportFor = (range = reportRange) => summarize({ events: state.events, lots: state.pantry, now: Date.now(), days: REPORT_RANGES[range].days, costFor });
const approxMoney = v => `~$${Math.round(Number(v) || 0)}`;   // estimates read better rounded
// The strip on top of the Pantry tab: this week in one line.
function reportStripHTML() {
  if (!state.events.length) return '';
  const r = reportFor('week');
  return `<div class="pstrip"><span>This week · ${plural(r.used.items, 'item')} used before expiring · ${approxMoney(r.savedValue)} saved</span><button class="linkish accent" type="button" data-report>See report</button></div>`;
}
function reportHTML() {
  const range = REPORT_RANGES[reportRange];
  const r = reportFor();
  const now = Date.now();
  const soon = expiringSoon(state.pantry, { now, limit: 5 }).filter(it => current(it) > OUT);
  const max = Math.max(1, ...r.weekly.map(w => w.value));
  const bars = r.weekly.map((w, i) => `<div class="rbar"><b>$${w.value.toFixed(0)}</b><span class="col"><i style="height:${Math.max(4, Math.round(w.value / max * 100))}%"></i></span><small>${i === 3 ? 'this week' : `${3 - i} wk ago`}</small></div>`).join('');
  const tabs = Object.entries(REPORT_RANGES).map(([id, x]) => `<button class="ptab${reportRange === id ? ' on' : ''}" type="button" role="tab" aria-selected="${reportRange === id}" data-report-range="${id}">${x.label}</button>`).join('');
  const tile = (n, label, sub = '') => `<div class="rtile"><strong>${n}</strong><small>${label}</small>${sub ? `<small class="sub">${esc(sub)}</small>` : ''}</div>`;
  const streak = r.streakDays > 0
    ? `<p class="rstreak"><span class="tick">${ICON.checkMd}</span><span><b>${plural(r.streakDays, 'day')} no-waste streak</b> · cooked every day, nothing expired</span></p>`
    : '<p class="rstreak dim"><span>No streak yet: cook something today and let nothing expire to start one.</span></p>';
  const next = soon.length
    ? `<div class="rnext">${soon.map(it => `<div class="prow"><div class="name"><strong>${esc(it.name)}</strong><small>${esc(shortDays(daysLeft(it)))}</small></div>${listBtnHTML(it, null, { qty: it.qty || '', source: 'pantry', size: 'sm' })}</div>`).join('')}</div>`
    : '<p class="ing-note">Nothing in the pantry is close to its date.</p>';
  const empty = !state.events.length;
  return `
    <div class="sheet-head"><h2 id="report-title">${range.title}</h2>${closeBtn()}</div>
    <div class="sheet-body report-body">
      <div class="ptabs" role="tablist">${tabs}</div>
      ${empty ? '<p class="empty-note">Nothing to report yet. Cook something from the deck and what you saved shows up here.</p>' : `
      <div class="rtiles">
        ${tile(r.used.items, 'used before expiry', plural(Math.round(r.used.servings), 'serving'))}
        ${tile(r.cooked.meals, 'meals cooked', r.cooked.titles.slice(0, 2).join(', '))}
        ${tile(approxMoney(r.savedValue), 'saved', 'estimated')}
        ${tile(r.wasted.items, 'wasted', `${approxMoney(r.wasted.value)} · ${plural(Math.round(r.wasted.servings), 'serving')}`)}
      </div>
      <div class="rchart" role="img" aria-label="Value saved per week over the last four weeks">${bars}</div>
      ${streak}
      <p class="rnote">Money is an estimate: receipt prices where a lot has one, typical costs otherwise.</p>`}
      <div class="eyebrow">Use these next</div>
      ${next}
    </div>
    <div class="sheet-foot">
      <button class="linkish" type="button" data-close>Close</button>
      <span class="grow"></span>
      ${soon.length ? `<button class="pill prominent" type="button" data-find-dish>${ICON.checkMd}<span>Find a dish</span></button>` : ''}
    </div>`;
}
function openReport(range) {
  if (range && REPORT_RANGES[range]) reportRange = range;
  if (state.sheet && state.sheet !== 'report') return;
  openSheet('report', reportHTML(), 'w-720');
}
function rerenderReport() { if (state.sheet === 'report') el.sheet.innerHTML = reportHTML(); }

/* ---------- substitutions ("Swap?" on the recipe sheet) ----------
   The backend answers first (POST /substitutions, pantry-based swaps from the model);
   the table in shared/substitutions.js stands in when it is not there. Both give the
   same shape, so one template renders either. "Use this" stores the swap on the dish
   (dish.subs) and analyze() treats the ingredient as had, approximately. */
const swapResults = new Map();   // `${dishId}|${ingredient}` → the suggestions last shown, so "Use this" can pick one by index
const pantryNamesForSubs = () => state.pantry.filter(it => !needsCheckin(it)).map(it => ({ key: it.key, name: it.name }));
async function findSubstitutions(dish, name) {
  const local = () => localSubstitutions(name, pantryNamesForSubs());
  if (!apiConfigured()) return { list: local(), source: 'local' };
  const busy = beginBusy('Finding swaps…');
  try {
    const { substitutions } = await fetchSubstitutions({
      ingredient: name, dishTitle: dish.name,
      dishIngredients: dish.ingredients.map(i => `${i.amt || ''} ${i.name}`.trim()),
      pantry: pantryForApi(), prefs: normalizePrefs(state.prefs),
    });
    return substitutions.length ? { list: substitutions, source: 'api' } : { list: local(), source: 'local' };
  } catch (err) {
    console.warn('[pantry] substitutions failed, using the table', err);   // unconfigured, unreachable or an http error alike
    return { list: local(), source: 'local' };
  } finally {
    busy.end();
  }
}
function subsHTML(dish, name, list) {
  if (!list.length) return `<div class="subs"><span class="eyebrow">Suggestions</span><p class="ing-note">Nothing sensible stands in for ${esc(name.toLowerCase())} here.</p></div>`;
  return `<div class="subs"><span class="eyebrow">Suggestions</span>${list.map((s, i) => `
    <div class="sub${s.from_pantry ? ' from-pantry' : ''}">
      <div class="sub-text"><strong>${esc(s.use)}</strong>${s.from_pantry ? `<span class="sub-from">${ICON.checkSm}<span>from your pantry</span></span>` : ''}<small>${esc([s.ratio, s.note].filter(Boolean).join(' · '))}</small></div>
      <button class="pill glass sm" type="button" data-use-sub="${i}" data-use-for="${esc(name)}" data-use-dish="${esc(dish.id)}">Use this</button>
    </div>`).join('')}</div>`;
}
async function openSwap(dish, name) {
  const slot = $$('.subs-slot', el.sheet).find(s => s.dataset.subsFor === name);
  if (!slot) return;
  slot.hidden = false;
  slot.innerHTML = '<div class="subs"><span class="eyebrow">Suggestions</span><p class="ing-note"><span class="dots"><i></i><i></i><i></i></span> Looking for a swap…</p></div>';
  const { list } = await findSubstitutions(dish, name);
  swapResults.set(`${dish.id}|${name}`, list);
  if (state.detailDishId !== dish.id || !slot.isConnected) return;   // the sheet moved on
  slot.innerHTML = subsHTML(dish, name, list);
}
function useSubstitution(dish, name, s) {
  dish.subs = { ...(dish.subs || {}), [normQ(name)]: { use: String(s.use || ''), ratio: String(s.ratio || ''), pantry_names: Array.isArray(s.pantry_names) ? s.pantry_names.slice() : [] } };
  if (isSaved(dish.id)) saveDish(dish);   // a saved dish remembers its swaps
  return dish.subs;
}
function dropSubstitution(dish, name) {
  if (!dish.subs) return;
  delete dish.subs[normQ(name)];
  if (isSaved(dish.id)) saveDish(dish);
}
// The pantry lot a swap's food names: the pantry's own spelling first, then its key.
function lotForPantryName(name) {
  const n = normQ(name);
  return state.pantry.find(it => !needsCheckin(it) && normQ(it.name) === n)
    || state.pantry.find(it => !needsCheckin(it) && it.key === keyForName(name))
    || null;
}
// What a swap takes of one pantry food when the dish is made: one serving, unless the
// ratio carries an amount for that food ("¾ cup milk + ¼ cup butter" → 0.75 of milk).
function subServings(key, food, ratio) {
  const head = normalizeName(food).split(' ').pop();
  const part = String(ratio || '').split(/\s*(?:\+|,|;)\s*/).find(p => normalizeName(p).split(' ').includes(head)) || '';
  const q = parseQuantity(part);
  if (q.qty == null || !q.unit) return 1;
  return servingsFor(key, part) ?? 1;
}
// The made-it rows a substituted ingredient contributes: its pantry foods instead of itself.
function subDeductions(a, factor = 1) {
  const rows = [];
  for (const i of (a.ings || [])) {
    if (!i.sub) continue;
    for (const pn of (i.sub.pantry_names || [])) {
      const lot = lotForPantryName(pn);
      if (!lot || rows.some(r => r.key === lot.key)) continue;
      const cur = available(lot.key);
      if (cur <= 0) continue;
      const need = subServings(lot.key, pn, i.sub.ratio) * factor;
      const take = Math.min(cur, need);
      const after = cur - take;
      const last = need > cur + 1e-9 || after <= OUT;
      const amt = n => (typeof servingsText === 'function' ? servingsText(lot.key, n) : fmt1(n));   // in the unit the pantry keeps it in
      rows.push({
        key: lot.key, name: lot.name, amt: '', need, cur, avail: cur, take, last, item: lot,
        note: `Instead of ${i.name.toLowerCase()} · ${last ? 'uses the last of it' : `${amt(after)} left after this`}`,
        takeText: amt(take), curText: amt(cur), listQty: '',
      });
    }
  }
  return rows;
}

/* ---------- cook mode's state (its DOM lives with the wiring) ---------- */
const cookState = { dish: null, step: 0, open: false };

/* =========================================================================
   Wiring
   ========================================================================= */
$('#btn-scan').addEventListener('click', openScanChooser);
el.savedBtn.addEventListener('click', openSaved);
el.week.addEventListener('click', openPlan);
$('#btn-scan-2').addEventListener('click', openScanUpload);
$('#empty-drop').addEventListener('click', () => el.file.click());   // "click to browse" means the file picker
// Without a backend the first-run card cannot scan: say so and point at the Pantry tab instead.
$('#empty-offline').hidden = apiConfigured();
$('#empty-offline').addEventListener('click', e => { if (e.target.closest('[data-go-pantry]')) setTab('pantry'); });
el.tabs.addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab); });
el.goExplore.addEventListener('click', () => setTab('explore'));
$('#btn-tonight').addEventListener('click', openTonight);
$('#btn-skip').addEventListener('click', () => commit('skip'));
$('#btn-cook').addEventListener('click', () => commit('cook'));
el.undo.addEventListener('click', undo);
el.endUndo.addEventListener('click', undo);
$('#btn-reshuffle').addEventListener('click', () => { state.skipped.clear(); state.chosen.clear(); state.history = []; renderAll({ enter: true }); });
$('#btn-end-prefs').addEventListener('click', openProfile);   // shown instead of Reshuffle when the preferences hid every dish
function clearPantry() {
  if (!state.pantry.length) return;
  state.pantry = [];
  state.skipped.clear(); state.cooked.clear(); state.chosen.clear();
  state.history = [];
  clearLocal();
  closeSheet();
  setTab('curated', { render: false });   // the first-run card lives on the deck
  renderAll({ enter: true });
  toast('Pantry cleared');
  refreshRecipes();
}
$('#btn-clear').addEventListener('click', clearPantry);

// The logo is a plain link to the landing page. Demo mode is kept in sessionStorage, so
// coming back through "Open the app" does not bounce a demo visitor to the login page.

/* ---------- profile menu (account: preferences, clear, sign out) ---------- */
const profileEl = $('#profile'), profileBtn = $('#btn-profile'), profileMenu = $('#profile-menu');
const closeProfileMenu = () => { profileMenu.hidden = true; profileEl.classList.remove('open'); profileBtn.setAttribute('aria-expanded', 'false'); };
profileBtn.addEventListener('click', () => {
  if (profileMenu.hidden) { profileMenu.hidden = false; profileEl.classList.add('open'); profileBtn.setAttribute('aria-expanded', 'true'); }
  else closeProfileMenu();
});
document.addEventListener('click', e => { if (!profileEl.contains(e.target)) closeProfileMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !profileMenu.hidden) closeProfileMenu(); });
profileMenu.addEventListener('click', e => {
  const b = e.target.closest('[data-profile]'); if (!b) return;
  closeProfileMenu();
  if (b.dataset.profile === 'preferences') return openProfile();
  if (b.dataset.profile === 'report') return openReport('week');
  if (b.dataset.profile === 'clear') return clearPantry();
  if (b.dataset.profile === 'theme') return toggleTheme();
  if (b.dataset.profile === 'auth') return b.dataset.action === 'signin'
    ? location.assign('../login/')
    : doSignOut(b);
});
// Light / dark: html[data-theme] drives the tokens; the choice is per browser (the head script
// applies it before first paint on every page). The menu item names the mode you'd switch to.
const themeBtn = $('#menu-theme');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  themeBtn.textContent = t === 'dark' ? 'Light mode' : 'Dark mode';
  try { localStorage.setItem('pantry-theme', t); } catch (_) {}
}
function toggleTheme() { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); }
themeBtn.textContent = document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
// Account row in the profile menu: sign out (signed in), sign in (demo), hidden (no auth configured).
function wireAccountButton(session) {
  const b = profileMenu.querySelector('[data-profile="auth"]');
  b.hidden = !configured;
  if (!configured) return;
  b.textContent = session ? 'Sign out' : 'Sign in';
  b.dataset.action = session ? 'signout' : 'signin';
}

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

el.veil.addEventListener('click', closeSheet);

// Everything inside the sheet is delegated
el.sheet.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.hasAttribute('data-close')) return closeSheet();
  if (t.hasAttribute('data-go-pantry')) { closeSheet(); return setTab('pantry'); }
  if (t.hasAttribute('data-back-upload')) return openScanUpload();
  if (t.hasAttribute('data-add-pantry')) return addToPantry();
  if (t.hasAttribute('data-toggle-nonfood')) { state.nonfoodOpen = !state.nonfoodOpen; return renderReview(); }
  if (t.dataset.drop) { const l = review.find(x => x.id === t.dataset.drop); if (l) l.dropped = true; return renderReview(); }
  if (t.dataset.fix) { const l = review.find(x => x.id === t.dataset.fix); if (l) l.fixed = true; return renderReview(); }
  if (t.dataset.editrow) { review.forEach(x => { x.editing = x.id === t.dataset.editrow; }); return renderReview(); }
  if (t.dataset.canceledit) { const l = review.find(x => x.id === t.dataset.canceledit); if (l) l.editing = false; return renderReview(); }
  if (t.dataset.serv) { state.detailServings = clamp(state.detailServings + Number(t.dataset.serv), 1, 20); return rerenderDetail(); }
  if (t.dataset.openDish) return openDetail(dishById(t.dataset.openDish));
  if (t.dataset.madeit) return openMadeIt(t.dataset.madeit);
  if (t.dataset.done) return finishMadeIt(t.dataset.done);
  // shopping list and tonight, from the recipe sheet
  if (t.dataset.shopAdd) {
    const d = dishById(t.dataset.shopAdd);
    if (!d) return;
    const r = addDishToShopping(d, state.detailServings);
    toast(r.count ? `${plural(r.count, 'item')} added to your shopping list` : 'Nothing to add', r.count ? `for ${d.name}` : '');
    renderAll();
    return rerenderDetail();
  }
  if (t.dataset.cookTonight) return cookTonight(t.dataset.cookTonight);
  // this week
  if (t.hasAttribute('data-open-plan')) return openPlan();
  if (t.dataset.planOpen) { const d = dishById(t.dataset.planOpen); if (d) openGeneratedDish(d); return; }
  if (t.hasAttribute('data-plan-regen') || t.hasAttribute('data-plan-retry')) return regeneratePlan();
  if (t.hasAttribute('data-plan-local')) { planError = ''; adoptPlan(buildLocalPlan(), { source: 'local' }); savePlan(plan); return renderPlanSheet(); }
  if (t.hasAttribute('data-plan-shop')) {
    const r = addPlanToShopping();
    renderAll();
    return toast(r.count ? `${plural(r.count, 'item')} on your shopping list` : 'Nothing missing this week', r.count ? 'for this week' : 'You have it all');
  }
  // photo of a dish, and the saved list
  if (t.hasAttribute('data-dish-upload')) return openDishUpload();
  if (t.hasAttribute('data-choose-receipt')) return openScanUpload();
  if (t.hasAttribute('data-choose-dish')) return openDishUpload();
  if (t.hasAttribute('data-dish-sample')) return startIdentify(null);
  if (t.hasAttribute('data-dish-save')) return keepResult();
  if (t.hasAttribute('data-dish-cook')) return keepResult({ cook: true });
  if (t.hasAttribute('data-open-saved')) return openSaved();
  if (t.dataset.openSavedDish) return openDetail(dishById(t.dataset.openSavedDish));
  if (t.dataset.removeSaved) return removeSaved(t.dataset.removeSaved);
  if (t.dataset.savedTab) { state.savedTab = t.dataset.savedTab; return rerenderSaved(); }
  // the recipe sheet: ask the helper, cook mode, swaps
  if (t.dataset.askDish) return askAboutDish(t.dataset.askDish);
  if (t.dataset.cookMode) return openCookMode(t.dataset.cookMode);
  if (t.dataset.swap) { const d = dishById(state.detailDishId); if (d) openSwap(d, t.dataset.swap); return; }
  if (t.dataset.unswap) { const d = dishById(state.detailDishId); if (d) { dropSubstitution(d, t.dataset.unswap); renderAll(); rerenderDetail(); } return; }
  if (t.dataset.useSub) {
    const d = dishById(t.dataset.useDish), name = t.dataset.useFor;
    const s = d ? (swapResults.get(`${d.id}|${name}`) || [])[Number(t.dataset.useSub)] : null;
    if (!s) return;
    useSubstitution(d, name, s);
    toast(`Using ${s.use}`, `instead of ${name.toLowerCase()}`);
    renderAll();   // the card's chips and the "Add N" count follow
    return rerenderDetail();
  }
  // ratings, the cooked log and the report
  if (t.dataset.rate) {
    const value = Number(t.dataset.rate);
    const changed = applyRating(t.dataset.rateLog, value);
    closeSheet();
    toast(value > 0 ? 'Noted: more like this' : 'Noted: not that one again', changed && apiConfigured() ? 'Refreshing the deck…' : '');
    renderAll();
    if (changed) refreshRecipes();
    return;
  }
  if (t.dataset.rateToggle) {
    const changed = applyRating(t.dataset.rateToggle, Number(t.dataset.value));
    rerenderSaved();
    renderAll();
    if (changed) refreshRecipes();
    return;
  }
  if (t.dataset.cookAgain) return cookAgain(t.dataset.cookAgain);
  if (t.dataset.reportRange) { reportRange = t.dataset.reportRange; return rerenderReport(); }
  if (t.hasAttribute('data-find-dish')) { closeSheet(); setSort('urgent'); return setTab('curated'); }
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
  saveReviewEdit(form.dataset.edit, form.name.value, form.qty.value);
  renderReview();
});
el.sheet.addEventListener('change', e => { if (e.target.matches('#deduct input')) updateDeductSummary(); });

// Panel
el.panel.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  const item = id => state.pantry.find(x => x.id === id);
  if (t.dataset.ptab) { state.panelTab = t.dataset.ptab; return renderPanel(); }
  if (t.dataset.toggleStack) {
    const key = t.dataset.toggleStack;
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    return renderPanel();
  }
  if (t.hasAttribute('data-report')) return openReport('week');
  if (t.dataset.remove || t.dataset.gone) {
    const it = item(t.dataset.remove || t.dataset.gone);
    if (it) { const left = current(it); recordLotEvent('gone', it, left, { wasted: left > OUT }); }   // whatever was still in it counts as waste
    state.pantry = state.pantry.filter(x => x !== it);
    renderAll();
    return refreshRecipes();
  }
  if (t.dataset.ask) { const it = item(t.dataset.ask); if (it) it.asking = true; return renderPanel(); }
  if (t.dataset.unask) { const it = item(t.dataset.unask); if (it) it.asking = false; return renderPanel(); }
  if (t.dataset.setamt) {
    const it = item(t.dataset.setamt);
    if (it) {
      const slider = el.panel.querySelector(`.amt-slider[data-slider="${it.id}"]`);
      const pct = slider ? clamp(Number(slider.value), 0, 100) : 50;
      const before = current(it);
      if (pct <= 0) {
        recordLotEvent('gone', it, before, { wasted: before > OUT });
        state.pantry = state.pantry.filter(x => x.id !== it.id);   // slid to empty = gone
      } else {
        rebaseLot(it, pct);
        recordLotEvent('checkin', it, before - current(it));   // what went since the estimate, if anything
      }
    }
    renderAll();
    return refreshRecipes();
  }
});
// Shopping list page: check off, remove, and the footer's two actions
$('#btn-shop-add').addEventListener('click', () => {
  const f = $('#shop-form');
  f.hidden = !f.hidden;
  $('#btn-shop-add').setAttribute('aria-expanded', String(!f.hidden));
  if (!f.hidden) $('#shop-name').focus();
});
$('#shop-form').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#shop-name').value.trim();
  if (!name) return;
  const amount = Number($('#shop-qty').value);
  const qty = amount > 0 ? formatQuantity({ amount, unit: $('#dd-shop-unit').dataset.value }) : '';
  const r = addShopping([{ name: sentenceCase(name), qty }], { source: 'manual' });
  $('#shop-name').value = ''; $('#shop-qty').value = '';   // keep the unit
  renderAll();
  toast(r.merged ? `${sentenceCase(name)} updated on your list` : `${sentenceCase(name)} added to your list`);
  $('#shop-name').focus();
});
el.shoppingScreen.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.shopToggle) { toggleShopping(t.dataset.shopToggle); return renderAll(); }
  if (t.dataset.shopRemove) { removeShopping(t.dataset.shopRemove); return renderAll(); }
  if (t.id === 'btn-shop-move') {
    const n = moveBoughtToPantry();
    renderAll();
    populateFoodOptions();
    toast(`${plural(n, 'item')} moved to your pantry`, apiConfigured() ? 'Finding recipes…' : 'Deck updated');
    return refreshRecipes();
  }
  if (t.id === 'btn-shop-clear') { const n = clearBought(); renderAll(); return toast(`${plural(n, 'item')} cleared`); }
});
// Live label while dragging the "how much is left" slider (no re-render, keeps the thumb)
el.panel.addEventListener('input', e => {
  if (!e.target.classList.contains('amt-slider')) return;
  const out = el.panel.querySelector(`.amt-out[data-out="${e.target.dataset.slider}"]`);
  if (out) out.textContent = Number(e.target.value) <= 0 ? 'empty' : `${e.target.value}% left`;
});
/* ---------- autocomplete: foods we know about, for the add form ---------- */
function foodSuggestions() {
  const names = new Map();               // key -> display name (first one wins)
  const add = (key, name) => { const k = String(key || '').toLowerCase(); if (k && !names.has(k)) names.set(k, name || sentenceCase(k)); };
  for (const d of activeDishes()) for (const i of (d.ingredients || [])) add(i.key || i.name, i.name);   // generated dishes carry no key
  for (const it of state.pantry) add(it.key || it.name, it.name);   // what they already buy
  for (const k of Object.keys(CATALOG)) add(k, sentenceCase(k));
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}
function populateFoodOptions() {
  const dl = $('#food-options');
  if (dl) dl.innerHTML = foodSuggestions().map(n => `<option value="${esc(n)}"></option>`).join('');
}

/* ---------- themed dropdown (replaces native <select>) ---------- */
function initDropdown(el, onChange) {
  if (!el) return;
  const btn = el.querySelector('.dd-btn'), menu = el.querySelector('.dd-menu'), label = el.querySelector('.dd-label');
  const opts = () => Array.from(menu.querySelectorAll('.dd-opt'));
  opts().forEach(o => { o.tabIndex = -1; });
  const close = () => { menu.hidden = true; el.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
  const open = () => {
    document.querySelectorAll('.dd.open').forEach(d => { if (d !== el && d.__close) d.__close(); });
    menu.hidden = false; el.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    opts().forEach(o => o.setAttribute('aria-selected', String(o.dataset.value === el.dataset.value)));
    (menu.querySelector('.dd-opt[aria-selected="true"]') || opts()[0])?.focus();
  };
  el.__close = close;
  const pick = o => { el.dataset.value = o.dataset.value; label.textContent = o.textContent; close(); btn.focus(); onChange && onChange(o.dataset.value); };
  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  menu.addEventListener('click', e => { const o = e.target.closest('.dd-opt'); if (o) pick(o); });
  menu.addEventListener('keydown', e => {
    const list = opts(), i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (document.activeElement.classList.contains('dd-opt')) pick(document.activeElement); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
  });
}
document.addEventListener('click', e => { document.querySelectorAll('.dd.open').forEach(d => { if (!d.contains(e.target)) d.__close(); }); });
initDropdown($('#dd-unit'));
// the shopping form's unit list is the same one, built from the units module so the two never drift
$('#dd-shop-unit .dd-menu').innerHTML = UNIT_OPTIONS.map(u => `<li class="dd-opt" role="option" data-value="${u}">${u}</li>`).join('');
initDropdown($('#dd-shop-unit'));
initDropdown($('#dd-sort'), v => {
  state.sortMode = SORTS[v] ? v : 'urgent';
  buildDeck();
  renderDeck({ enter: true });
});
// The report's "Find a dish" sorts the deck by what expires first; the control follows.
function setSort(v) {
  state.sortMode = SORTS[v] ? v : 'urgent';
  const dd = $('#dd-sort');
  if (dd) { dd.dataset.value = state.sortMode; const l = $('.dd-label', dd); if (l) l.textContent = SORTS[state.sortMode].label; }
}

/* ---------- kitchen helper (chat: "what do I buy to make X?") ---------- */
const chatEl = { fab: $('#btn-chat'), panel: $('#chat'), log: $('#chat-log'), form: $('#chat-form'), input: $('#chat-input'), close: $('#btn-chat-close') };
let chatGreeted = false;
const chatHistory = [];   // [{ role, content }] plain text, sent to /chat for multi-turn context

function addChat(who, html) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.innerHTML = html;
  chatEl.log.appendChild(div);
  chatEl.log.scrollTop = chatEl.log.scrollHeight;
  applyDishImages(div);   // recipe cards in the reply get their generated thumbs
  return div;
}
function chatOpen() {
  chatEl.panel.hidden = false;
  if (state.sheet) chatEl.panel.classList.add('over');   // above the veil and the sheet, never behind them
  requestAnimationFrame(() => chatEl.panel.classList.add('in'));
  chatEl.panel.setAttribute('aria-hidden', 'false');
  chatEl.fab.setAttribute('aria-expanded', 'true');
  if (!chatGreeted) {
    chatGreeted = true;
    const hint = apiConfigured()
      ? 'Hey! I can help with your pantry and your list. Try “what can I make in 15 minutes?”, “add eggs to my pantry”, “put lemons on my shopping list”, “I finished the milk”, or “I don’t like seafood”.'
      : 'Hey! Tell me a dish you want to make and I’ll tell you what to buy. Try “shakshuka”, “add eggs to my pantry” or “put lemons on my shopping list”.';
    addChat('bot', hint);
  }
  chatEl.input.focus();
}
function chatClose() {
  chatEl.panel.classList.remove('in');
  chatEl.panel.setAttribute('aria-hidden', 'true');
  chatEl.fab.setAttribute('aria-expanded', 'false');
  setTimeout(() => { chatEl.panel.hidden = true; chatEl.panel.classList.remove('over'); }, 200);
}
// "Ask a question" on the recipe sheet: the helper opens over the sheet, about that dish.
// chatFocus stays set while the sheet is open (closeSheet clears it), so a closed and
// reopened panel is still about the same recipe.
function askAboutDish(id) {
  const d = dishById(id);
  if (!d) return;
  chatFocus = { dish: d };
  chatEl.panel.classList.add('over');
  chatOpen();
  if (askedAbout.has(d.id)) return;
  askedAbout.add(d.id);
  addChat('bot', apiConfigured()
    ? `Ask me anything about <strong>${esc(d.name)}</strong> — swaps, timing, technique, or what to serve it with.`
    : `The assistant isn’t connected, but I can list the steps for <strong>${esc(d.name)}</strong> (say “steps”) and suggest swaps (“no cream?”).`);
}
// The recipe on screen, as the backend's focus_recipe.
function focusRecipeFor(d) {
  return {
    title: d.name,
    servings: state.detailDishId === d.id ? state.detailServings : (d.servings || 2),
    ingredients: d.ingredients.map(i => `${i.amt || ''} ${i.name}`.trim()),
    steps: d.steps || [],
    missing: analyze(d).missing.map(i => i.name),
  };
}
// Offline, about the dish on screen: its steps, or a swap from the table.
const CMD_NO = /^(?:no|out of|without|(?:i )?don'?t have|(?:i )?have no|what (?:can i use |to use )?instead of|swap|replace|sub(?:stitute)?(?: for)?)\s+(?:any |the |some )?(.+?)$/i;
function focusOfflineAnswer(text) {
  if (!chatFocus) return null;
  const d = chatFocus.dish;
  const t = String(text || '').trim().replace(/[.!?]+$/, '');
  if (/^(?:steps?|the steps|how (?:do|would) i (?:make|cook) (?:it|this)|how is it made)$/i.test(t)) {
    return d.steps && d.steps.length
      ? `<strong>${esc(d.name)}</strong>:<br>${d.steps.map((s, i) => `${i + 1}. ${esc(s)}`).join('<br>')}`
      : `I don’t have the steps for <strong>${esc(d.name)}</strong> yet.`;
  }
  const m = CMD_NO.exec(t);
  if (!m) return null;
  const name = m[1].trim();
  const subs = localSubstitutions(name, pantryNamesForSubs());
  if (!subs.length) return `I don’t know a good swap for <b>${esc(name)}</b> in ${esc(d.name)}.`;
  return `Instead of <b>${esc(name)}</b>: ${subs.map(s => `<b>${esc(s.use)}</b> (${esc(s.ratio)}${s.note ? `; ${esc(s.note)}` : ''}${s.from_pantry ? ' — you have it' : ''})`).join('; ')}.`;
}
// Best recipe match for a free-text query, by name then name+ingredient word overlap.
function findDishForQuery(text) {
  const q = normQ(text);
  if (!q) return null;
  const words = q.split(' ').filter(w => w.length > 2);
  let best = null, bestScore = 0;
  for (const d of activeDishes().filter(passesPrefs)) {
    const name = normQ(d.name);
    let score = 0;
    if (name === q) score = 100;
    else if (name.includes(q) || q.includes(name)) score = 60;
    const hay = normQ(`${d.name} ${d.ingredients.map(i => `${i.name} ${i.key || ''}`).join(' ')}`);
    for (const w of words) if (hay.includes(w)) score += 12;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return bestScore >= 24 ? best : null;
}
function shoppingAnswer(d) {
  const a = analyze(d);
  const have = a.have.map(i => i.name.toLowerCase());
  const open = `<button class="chat-open" type="button" data-chat-open="${d.dish ? d.dish.id : d.id}">See recipe</button>`;
  if (!a.missing.length) {
    return `You’ve got everything for <strong>${esc(d.name)}</strong> 🎉 Uses ${esc(listWords(have))}. ${servesLabel()}, about ${money(a.stats.cost)}/serving. ${open}`;
  }
  const buy = a.missing.map(i => `${i.name.toLowerCase()}${i.amt ? ` (${standardizeAmount(i.amt)})` : ''}`);
  const buyCost = a.missing.reduce((s, i) => s + nutriFor(i.key).cost * Math.max(1, i.need || 1), 0);
  const haveBit = have.length ? ` You already have ${esc(listWords(have))}.` : '';
  const lowBit = a.short.length ? ` You’re low on ${esc(listWords(a.short.map(i => i.name.toLowerCase())))}.` : '';
  if (!buy.length) return `You’ve got everything for <strong>${esc(d.name)}</strong>, just about.${lowBit} ${open}`;
  const add = `<button class="chat-open" type="button" data-list-dish-add="${esc(d.dish ? d.dish.id : d.id)}">Add to list</button>`;
  return `For <strong>${esc(d.name)}</strong>, buy: <b>${esc(buy.join(', '))}</b> — roughly ${money(buyCost)}.${haveBit}${lowBit} ${open} ${add}`;
}
// Claude replies in plain text. Escape it, then honour a little markdown (**bold**)
// and line breaks so a multi-line answer reads cleanly in the bubble.
function chatTextToHtml(text) {
  return esc(String(text || ''))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

// Recent meals for the assistant's context: dishes marked cooked, newest first.
function recentMealsForApi() {
  return [...state.cooked].reverse().map(dishById).filter(Boolean).map(d => ({ title: d.name }));
}

// Turn the recipes the assistant returned into tappable cards. Each becomes a real dish
// (same shape the deck uses) stored under a chat- id, so clicking it opens the normal
// recipe detail popup via the existing [data-chat-open] handler.
function renderChatRecipes(recipes) {
  const cards = [];
  (recipes || []).forEach((r, i) => {
    const dish = { ...dishFromApi(r, i), id: `chat-${uid()}` };
    if (!passesPrefs(dish)) return;   // safety net; recipes already honour prefs server-side
    chatDishes.set(dish.id, dish);
    const missing = r.missing_count ? `${plural(r.missing_count, 'thing')} to buy` : 'all in your pantry';
    cards.push(
      `<button class="chat-recipe" type="button" data-chat-open="${dish.id}">`
      + `<img class="chat-thumb" src="${esc(dish.img)}" alt="" draggable="false"${dishImgAttrs(dish)}>`
      + `<span class="chat-text"><strong>${esc(dish.name)}</strong>`
      + `<small>${esc(dish.time)} · ${esc(dish.difficulty)} · ${esc(missing)}</small></span>`
      + `</button>`,
    );
  });
  return cards.length ? `<div class="chat-recipes">${cards.join('')}</div>` : '';
}

// Apply the validated write-actions the backend returned. All the quantity / expiry math
// stays here in the deterministic client model — Claude only asked for the change.
function applyChatActions(actions) {
  let changed = false;       // the pantry or the preferences moved: re-render and regenerate
  let listChanged = false;   // only the shopping list moved: re-render is enough
  for (const a of actions || []) {
    if (a.type === 'update_preference') {
      if (a.field === 'liked' || a.field === 'disliked') {
        // the complete list: the ratings follow it, and the prefs are derived from the ratings
        const titles = (Array.isArray(a.value) ? a.value : [a.value]).map(t => String(t || '').trim()).filter(Boolean);
        const value = a.field === 'liked' ? 1 : -1;
        const keep = new Set(titles.map(titleKey));
        for (const [k, r] of Object.entries(state.ratings)) if (r.value === value && !keep.has(k)) delete state.ratings[k];
        for (const t of titles) state.ratings[titleKey(t)] = { title: t, value, at: Date.now(), dishId: '' };
        saveRatings(state.ratings);
        syncRatingsToPrefs();
      } else {
        state.prefs = normalizePrefs({ ...state.prefs, [a.field]: a.value });
        savePrefs(state.prefs);
      }
      changed = true;
    } else if (a.type === 'mark_food_gone') {
      const lot = state.pantry.find(x => x.id === a.id);
      const key = lot ? lot.key : null;
      const before = state.pantry.length;
      for (const it of state.pantry.filter(x => (key ? x.key === key : x.id === a.id))) { const left = current(it); recordLotEvent('gone', it, left, { wasted: left > OUT }); }
      state.pantry = state.pantry.filter(x => (key ? x.key !== key : x.id !== a.id));
      if (state.pantry.length !== before) changed = true;
    } else if (a.type === 'record_checkin') {
      const it = state.pantry.find(x => x.id === a.id);
      if (it) {
        const key = it.key;
        const before = current(it);
        state.pantry = state.pantry.filter(x => x.key !== key || x.id === it.id);
        if (Number(a.percent) <= 0) {
          recordLotEvent('gone', it, before, { wasted: before > OUT });
          state.pantry = state.pantry.filter(x => x.id !== it.id);
        } else {
          rebaseLot(it, clamp(Number(a.percent), 0, 100));
          recordLotEvent('checkin', it, before - current(it));
        }
        changed = true;
      }
    } else if (a.type === 'add_pantry_items') {
      // quantities arrive canonical (g/kg/ml/l/pcs/pack or ''); the lot's servings are read off them
      const names = [];
      for (const it of a.items || []) {
        const name = String(it.name || '').trim();
        if (!name) continue;
        const days = Number(it.expires_in_days);
        addLot(sentenceCase(name), keyForName(name), chatQty(it), '', days > 0 ? { expiry: Date.now() + days * DAY } : null);
        names.push(name.toLowerCase());
      }
      if (names.length) {
        changed = true;
        populateFoodOptions();
        toast(`${plural(names.length, 'item')} added to your pantry`, listWords(names));
      }
    } else if (a.type === 'add_shopping_items') {
      const r = addShopping((a.items || []).map(it => ({ name: sentenceCase(String(it.name || '').trim()), qty: chatQty(it), note: it.note || '' })), { source: 'chat' });
      if (r.count) { listChanged = true; toast(`${plural(r.count, 'item')} on your shopping list`, listWords(r.names.map(n => n.toLowerCase()))); }
    } else if (a.type === 'remove_shopping_items') {
      const n = removeShoppingByNames(a.names || []);
      if (n) { listChanged = true; toast(`${plural(n, 'item')} taken off your shopping list`); }
    }
  }
  if (changed) { renderAll(); refreshRecipes(); }
  else if (listChanged) renderAll();
  return changed || listChanged;
}
// "2 lb" from the assistant is already { quantity: 907.2, unit: 'g' }; '' when it gave no amount.
const chatQty = it => (it.quantity == null ? '' : formatQuantity({ amount: it.quantity, unit: it.unit || '' }) || '');

/* Offline (or when the assistant is away): the three plain commands are handled here, so
   "add eggs to my pantry" still works without a backend. */
const CMD_SHOP_ADD = /^(?:add|put)\s+(.+?)\s+(?:to|on|in)\s+(?:my\s+|the\s+)?(?:shopping\s+)?list$/i;
const CMD_PANTRY_ADD = /^(?:add|put)\s+(.+?)\s+(?:to|in)\s+(?:my\s+|the\s+)?pantry$/i;
const CMD_SHOP_REMOVE = /^(?:remove|take)\s+(.+?)\s+(?:from|off)\s+(?:my\s+|the\s+)?(?:shopping\s+)?list$/i;
// Words that read as a unit in "2 lb of chicken" / "1 bunch basil" (the units module knows more,
// but only this short list is ever typed in a chat command).
const CMD_UNIT = /^(?:kgs?|kilos?|kilograms?|g|gr|grams?|lbs?|pounds?|oz|ounces?|ml|l|litres?|liters?|cups?|tbsps?|tablespoons?|tsps?|teaspoons?|pcs?|pieces?|packs?|packets?|jars?|bottles?|cans?|bags?|box|boxes|bunch|bunches|dozen|heads?|cloves?|cartons?|tubs?|loaf|loaves|sticks?|slices?|pints?|quarts?|qts?|gallons?|gal)$/i;
const CMD_NUMBER = /^(?:[\d.,/¼½¾⅓⅔⅛-]+|x|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/i;
// "2 lb of chicken thighs" -> { name: 'chicken thighs', qty: '905 g' }; "eggs" -> { name: 'eggs', qty: '' }
function parseItemText(text) {
  const words = String(text).trim().replace(/^(?:some|a few)\s+/i, '').split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let i = 0;
  while (i < words.length - 1 && CMD_NUMBER.test(words[i])) i++;
  if (i === 0) return { name: words.join(' '), qty: '' };
  if (i < words.length - 1 && CMD_UNIT.test(words[i].replace(/\.$/, ''))) i++;
  if (i < words.length - 1 && /^of$/i.test(words[i])) i++;
  const name = words.slice(i).join(' ');
  const qty = formatQuantity(words.slice(0, i).filter(w => !/^of$/i.test(w)).join(' '));
  return name ? { name, qty: parseQuantity(qty).qty == null ? '' : qty } : { name: words.join(' '), qty: '' };
}
const splitItems = s => String(s).split(/\s*,\s*|\s+and\s+/i).map(parseItemText).filter(Boolean);
function localChatCommand(text) {
  const t = String(text || '').trim().replace(/[.!?]+$/, '');
  let m;
  if ((m = CMD_PANTRY_ADD.exec(t))) {
    const items = splitItems(m[1]);
    for (const it of items) addLot(sentenceCase(it.name), keyForName(it.name), it.qty, '');
    renderAll(); populateFoodOptions(); refreshRecipes();
    return `Added ${listWords(items.map(it => `<b>${esc(it.qty ? `${it.qty} ${it.name}` : it.name)}</b>`))} to your pantry.`;
  }
  if ((m = CMD_SHOP_ADD.exec(t))) {
    const items = splitItems(m[1]);
    const r = addShopping(items.map(it => ({ name: sentenceCase(it.name), qty: it.qty })), { source: 'chat' });
    renderAll();
    return `Put ${listWords(items.map(it => `<b>${esc(it.name)}</b>`))} on your shopping list${r.merged ? ' (some were already there, so I topped them up)' : ''}.`;
  }
  if ((m = CMD_SHOP_REMOVE.exec(t))) {
    const names = splitItems(m[1]).map(it => it.name);
    const n = removeShoppingByNames(names);
    renderAll();
    return n
      ? `Took ${listWords(names.map(x => `<b>${esc(x)}</b>`))} off your shopping list.`
      : `I couldn’t find ${listWords(names.map(x => `<b>${esc(x)}</b>`))} on your list.`;
  }
  return null;
}

// Offline / no-API fallback: the old "what do I buy to make X" keyword helper.
function offlineChatAnswer(text) {
  let reply;
  const d = findDishForQuery(text);
  if (d) {
    reply = shoppingAnswer(d);
  } else {
    const opts = activeDishes().filter(passesPrefs).map(analyze).filter(eligible)
      .sort((a, b) => a.gap - b.gap).slice(0, 3).map(a => a.dish.name);
    reply = opts.length
      ? `With your preferences, you can make: <b>${esc(opts.join(', '))}</b>.`
      : 'No available recipes match your pantry and preferences. Try adding ingredients or reviewing your preferences.';
  }
  const source = apiConfigured() ? 'Assistant unavailable — using available recipes.' : 'Assistant not connected — using available recipes.';
  return `<small class="chat-source">${esc(source)}</small>${reply}`;
}

async function handleChat(text) {
  addChat('user', esc(text));
  chatHistory.push({ role: 'user', content: text });
  const thinking = addChat('bot', '<span class="dots"><i></i><i></i><i></i></span>');

  let done = false;
  if (apiConfigured()) {
    let timeout;
    try {
      const data = await Promise.race([
        chatApi(chatHistory, {
          pantry: pantryForApi(),
          prefs: normalizePrefs(state.prefs),
          recentMeals: recentMealsForApi(),
          shopping: shoppingForApi(),
          focusRecipe: chatFocus ? focusRecipeFor(chatFocus.dish) : null,   // the recipe on screen, if they asked from it
        }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), 25000); }),
      ]);
      const reply = String(data && data.reply || '').trim();
      if (reply) {
        applyChatActions(data.actions);
        chatHistory.push({ role: 'assistant', content: reply });
        thinking.remove();
        addChat('bot', chatTextToHtml(reply) + renderChatRecipes(data.recipes));
        done = true;
      }
    } catch { /* fall through to the offline helper */ } finally {
      clearTimeout(timeout);
    }
  }

  if (!done) {
    thinking.remove();
    // a plain "add X to my pantry / list" needs no model at all, nor do the steps and swaps of the dish on screen
    const local = focusOfflineAnswer(text) || localChatCommand(text);
    if (local) {
      chatHistory.push({ role: 'assistant', content: local.replace(/<[^>]+>/g, '') });
      addChat('bot', local);
      return;
    }
    chatHistory.push({ role: 'assistant', content: '(answered offline from the local recipe list)' });
    addChat('bot', offlineChatAnswer(text));
  }
}

chatEl.fab.addEventListener('click', () => (chatEl.panel.hidden ? chatOpen() : chatClose()));
chatEl.close.addEventListener('click', chatClose);
chatEl.form.addEventListener('submit', e => {
  e.preventDefault();
  const t = chatEl.input.value.trim();
  if (!t) return;
  chatEl.input.value = '';
  handleChat(t);
});

/* ---------- voice input ----------
   The browser's own speech recognition, where it has one (Chrome, Safari, Edge): the mic
   fills the input as it hears, and the final result sends itself after a beat unless the
   user started typing. Errors say why in plain words and the button goes back to idle. */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const micBtn = $('#btn-mic');
const MIC_PLACEHOLDER = chatEl.input.placeholder;
let rec = null, recTimer = 0, recTyped = false;
if (!SpeechRec) micBtn.hidden = true;
function micIdle() {
  rec = null;
  clearTimeout(recTimer);
  micBtn.classList.remove('listening');
  micBtn.setAttribute('aria-pressed', 'false');
  chatEl.input.placeholder = MIC_PLACEHOLDER;
}
function micStart() {
  if (!SpeechRec || rec) return;
  try {
    const r = new SpeechRec();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = false;
    recTyped = false;
    let heard = '';
    r.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) heard += res[0].transcript; else interim += res[0].transcript;
      }
      if (recTyped) return;   // they took over the field: leave their words alone
      chatEl.input.value = (heard || interim).trim();
      if (heard) {
        clearTimeout(recTimer);
        recTimer = setTimeout(() => {
          if (recTyped || !chatEl.input.value.trim()) return;
          if (chatEl.form.requestSubmit) chatEl.form.requestSubmit(); else chatEl.form.dispatchEvent(new Event('submit', { cancelable: true }));
        }, 700);
      }
    };
    r.onerror = e => {
      const why = { 'not-allowed': 'Microphone access was blocked', 'service-not-allowed': 'Microphone access was blocked', 'no-speech': 'Didn’t catch anything', network: 'Voice input needs a connection', 'audio-capture': 'No microphone found' }[e.error] || 'Couldn’t listen just now';
      toast(why, e.error === 'not-allowed' ? 'Allow the microphone for this site and try again' : '');
      micIdle();
    };
    r.onend = micIdle;
    r.start();
    rec = r;
    micBtn.classList.add('listening');
    micBtn.setAttribute('aria-pressed', 'true');
    chatEl.input.placeholder = 'Listening…';
    chatEl.input.focus();
  } catch (err) {
    console.warn('[pantry] voice input failed', err);
    toast('Couldn’t start listening');
    micIdle();
  }
}
function micStop() { const r = rec; micIdle(); try { r && r.stop(); } catch (_) { /* already stopped */ } }
micBtn.addEventListener('click', () => (rec ? micStop() : micStart()));
chatEl.input.addEventListener('input', () => { if (rec) { recTyped = true; clearTimeout(recTimer); } });
// Open a recipe from a chat card: the panel folds away and the step-less card opens like a
// plan cell does (steps written on first open, see openGeneratedDish).
function openChatDish(d) {
  chatClose();
  return openGeneratedDish(d);
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-list-add]');
  if (!b || b.closest('#deck')) return;   // chips on the deck are handled by the card's pointer-up
  e.preventDefault();
  listAddFromEl(b);
});
chatEl.log.addEventListener('click', e => {
  const add = e.target.closest('[data-list-dish-add]');
  if (add) {
    const d = dishById(add.dataset.listDishAdd);
    if (!d) return;
    const r = addDishToShopping(d);
    toast(r.count ? `${plural(r.count, 'item')} added to your shopping list` : 'Already on your list', r.count ? `for ${d.name}` : '');
    add.replaceWith(Object.assign(document.createElement('span'), { className: 'chat-source', textContent: 'On your list' }));
    return renderAll();
  }
  const b = e.target.closest('[data-chat-open]');
  if (!b) return;
  const d = dishById(b.dataset.chatOpen);
  if (d && !passesPrefs(d)) { toast('This recipe no longer matches your preferences'); return; }
  if (d) openChatDish(d);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !chatEl.panel.hidden && !cookState.open) chatClose(); });

/* ---------- cook mode ----------
   One step at a time in big type, the durations in it as tappable timers, the
   ingredients the step mentions as chips. The overlay owns the whole screen (over the
   recipe sheet it came from); timers keep running when it closes, behind a floating
   pill that reopens it. Only the arithmetic lives in shared/timers.js; this ticks. */
const cookEl = {
  root: $('#cook-mode'), title: $('#cook-title'), count: $('#cook-count'), bar: $('#cook-progress'), step: $('#cook-step'), ings: $('#cook-ings'),
  prev: $('#cook-prev'), next: $('#cook-next'), tray: $('#cook-tray'), actions: $('#cook-actions'), pill: $('#timer-pill'), pillText: $('#timer-pill-text'),
};
let timers = [];       // [{ t: createTimer(), dish, alerted }]
let timerTick = 0;     // the one setInterval, only while a timer exists
let wakeLock = null;
const timerChip = d => `<button class="tchip" type="button" data-timer-seconds="${d.seconds}" data-timer-label="${esc(d.label)}">${ICON.clock}<span>${esc(d.label)}</span></button>`;
// Ingredients a step mentions: any word of the name (singularised, fillers dropped) that is in the step.
function stepIngredients(dish, text) {
  const words = new Set(normalizeName(text).split(' '));
  return (dish.ingredients || []).filter(i => normalizeName(i.name).split(' ').some(w => w.length > 2 && words.has(w)));
}
function openCookMode(id) {
  const d = dishById(id);
  if (!d) return;
  if (cookState.dish !== d) cookState.step = 0;
  cookState.dish = d;
  cookState.open = true;
  cookEl.root.hidden = false;
  requestAnimationFrame(() => cookEl.root.classList.add('in'));
  renderCook();
  renderTray();
  if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').then(l => { wakeLock = l; }).catch(() => { /* not granted: the screen may dim */ });
  setTimeout(() => (cookEl.next.disabled ? cookEl.root : cookEl.next).focus({ preventScroll: true }), 50);
}
function closeCookMode() {
  if (!cookState.open) return;
  cookState.open = false;
  cookEl.root.classList.remove('in');
  setTimeout(() => { if (!cookState.open) cookEl.root.hidden = true; }, reduceMotion ? 0 : 200);
  if (wakeLock) { try { wakeLock.release(); } catch (_) { /* already released */ } wakeLock = null; }
  renderTimerPill();
}
function cookStep(delta) {
  const d = cookState.dish;
  if (!d || !(d.steps || []).length) return;
  cookState.step = clamp(cookState.step + delta, 0, d.steps.length - 1);
  renderCook();
}
function renderCook() {
  const d = cookState.dish;
  if (!d || !cookState.open) return;
  const steps = d.steps || [];
  const n = steps.length, i = clamp(cookState.step, 0, Math.max(0, n - 1));
  cookEl.title.textContent = d.name;
  const blank = html => {
    cookEl.count.textContent = '';
    cookEl.bar.style.width = '0%';
    cookEl.step.innerHTML = html;
    cookEl.ings.innerHTML = '';
    cookEl.prev.disabled = cookEl.next.disabled = true;
  };
  if (d.stepsLoading) {
    blank('<p class="cook-note"><span class="dots"><i></i><i></i><i></i></span> Writing the steps…</p>');
    cookEl.actions.innerHTML = '';
    return;
  }
  if (!n) {
    blank('<p class="cook-note">No steps for this one yet.</p>');
    cookEl.actions.innerHTML = `<button class="pill glass" type="button" data-ask-dish="${esc(d.id)}">${ICON.chat}<span>Ask a question</span></button>`;
    return;
  }
  const text = steps[i];
  const escaped = esc(text);
  cookEl.count.textContent = `Step ${i + 1} of ${n}`;
  cookEl.bar.style.width = `${Math.round(((i + 1) / n) * 100)}%`;
  cookEl.step.innerHTML = `<p class="cook-text">${highlightDurations(escaped, findDurations(escaped), timerChip)}</p>`;
  const factor = (state.detailDishId === d.id ? state.detailServings : servingsTarget(state.prefs)) / Math.max(1, d.servings || 1);
  cookEl.ings.innerHTML = stepIngredients(d, text).map((ing, k) => {
    const amt = scaleAmount(ing.amt || '', factor);
    return `<span class="cook-ing"><button class="chip have" type="button" data-cook-ing="${k}" aria-expanded="false"><span>${esc(ing.name)}</span><small class="amt" hidden>${esc(amt || 'to taste')}</small></button>${listBtnHTML(ing, d, { qty: amt })}</span>`;
  }).join('');
  cookEl.prev.disabled = i === 0;
  cookEl.next.disabled = i === n - 1;
  cookEl.actions.innerHTML = i === n - 1
    ? `<button class="pill prominent" type="button" data-cook-madeit="${esc(d.id)}">${ICON.checkMd}<span>I made this</span></button><button class="pill glass" type="button" data-cook-done>Done</button>`
    : '';
}
/* timers */
function ensureTick() {
  if (timers.length && !timerTick) timerTick = setInterval(tickTimers, 250);
  if (!timers.length && timerTick) { clearInterval(timerTick); timerTick = 0; }
}
function startTimer(seconds, label) {
  const t = createTimer({ seconds, label, now: Date.now() });
  timers.push({ t, dish: cookState.dish ? cookState.dish.name : '', alerted: false });
  renderTray();
  ensureTick();
  toast(`Timer started · ${t.label}`);
}
function tickTimers() {
  const now = Date.now();
  for (const x of timers) if (!x.alerted && x.t.running && x.t.done(now)) { x.alerted = true; alertTimer(x); }
  for (const row of $$('.trow', cookEl.tray)) {
    const x = timers.find(y => y.t.id === row.dataset.timer);
    if (!x) continue;
    const left = $('.tleft', row);
    const txt = formatRemaining(x.t.remaining(now));
    if (left.textContent !== txt) left.textContent = txt;
  }
  renderTimerPill();
}
// Two short 880 Hz tones; no audio (autoplay rules, no speakers) is fine: the toast and the red row still say so.
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.35].forEach(at => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.25);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + 0.3);
    });
    setTimeout(() => { ctx.close().catch(() => {}); }, 1200);
  } catch (_) { /* no audio */ }
}
function alertTimer(x) {
  beep();
  try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (_) { /* not on this device */ }
  toast(`${x.t.label} is up`, x.dish);
  renderTray();
}
function renderTray() {
  const now = Date.now();
  cookEl.tray.hidden = timers.length === 0;
  cookEl.tray.innerHTML = timers.map(x => `<div class="trow${x.alerted && x.t.done(now) ? ' done' : ''}${x.t.running ? '' : ' paused'}" data-timer="${esc(x.t.id)}">
    <span class="tlabel">${ICON.clock}<span>${esc(x.t.label)}</span></span>
    <strong class="tleft">${formatRemaining(x.t.remaining(now))}</strong>
    <button class="linkish sm" type="button" data-timer-toggle="${esc(x.t.id)}">${x.t.running ? 'Pause' : 'Resume'}</button>
    <button class="linkish sm" type="button" data-timer-reset="${esc(x.t.id)}">Reset</button>
    <button class="circle xs glass muted" type="button" data-timer-del="${esc(x.t.id)}" aria-label="Dismiss timer">${ICON.xSm}</button>
  </div>`).join('');
  renderTimerPill();
}
// Cook mode closed, timers still running: the soonest one, bottom-left, reopens it.
function renderTimerPill() {
  const show = timers.length > 0 && !cookState.open;
  cookEl.pill.hidden = !show;
  if (!show) return;
  const now = Date.now();
  const live = timers.filter(x => x.t.running && !x.t.done(now)).sort((a, b) => a.t.remaining(now) - b.t.remaining(now))[0] || timers[0];
  cookEl.pill.classList.toggle('done', Boolean(live.alerted && live.t.done(now)));
  const txt = `${formatRemaining(live.t.remaining(now))}${live.dish ? ` · ${live.dish}` : ''}`;
  if (cookEl.pillText.textContent !== txt) cookEl.pillText.textContent = txt;
}
cookEl.root.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.timerSeconds) return startTimer(Number(t.dataset.timerSeconds), t.dataset.timerLabel);
  if (t.dataset.cookIng != null) { const amt = $('.amt', t); if (amt) { amt.hidden = !amt.hidden; t.setAttribute('aria-expanded', String(!amt.hidden)); } return; }
  const timer = id => timers.find(y => y.t.id === id);
  if (t.dataset.timerToggle) { const x = timer(t.dataset.timerToggle); if (x) { x.t.toggle(Date.now()); renderTray(); } return; }
  if (t.dataset.timerReset) { const x = timer(t.dataset.timerReset); if (x) { x.t.reset(); x.t.start(Date.now()); x.alerted = false; renderTray(); } return; }
  if (t.dataset.timerDel) { timers = timers.filter(y => y.t.id !== t.dataset.timerDel); renderTray(); ensureTick(); return; }
  if (t.id === 'cook-prev') return cookStep(-1);
  if (t.id === 'cook-next') return cookStep(1);
  if (t.id === 'cook-close' || t.hasAttribute('data-cook-done')) return closeCookMode();
  if (t.dataset.cookMadeit) { closeCookMode(); return openMadeIt(t.dataset.cookMadeit); }
  if (t.dataset.askDish) { closeCookMode(); return askAboutDish(t.dataset.askDish); }
});
cookEl.pill.addEventListener('click', () => { if (cookState.dish) openCookMode(cookState.dish.id); });
// a swipe across the step moves on (touch only: a mouse drag over the text is a selection)
let cookSwipeX = null;
cookEl.root.addEventListener('pointerdown', e => { cookSwipeX = e.pointerType === 'touch' && !e.target.closest('button') ? e.clientX : null; });
cookEl.root.addEventListener('pointerup', e => {
  if (cookSwipeX == null) return;
  const dx = e.clientX - cookSwipeX; cookSwipeX = null;
  if (Math.abs(dx) > 60) cookStep(dx < 0 ? 1 : -1);
});

// Default use-by tracks the food's own shelf life (7 days only for unknown items).
const shelfExpiryStr = name => isoDay(Date.now() + catalog(keyForName(name || '')).shelf * DAY);
const resetAddDefaults = () => { const f = $('#add-expiry'); f.min = isoDay(Date.now() + MIN_LIFE); f.value = shelfExpiryStr($('#add-name').value); };   // the picker will not offer today

$('#btn-add').addEventListener('click', () => {
  const f = $('#add-form');
  f.hidden = !f.hidden;
  $('#btn-add').setAttribute('aria-expanded', String(!f.hidden));
  if (!f.hidden) { resetAddDefaults(); $('#add-name').focus(); }
});
// As the food name changes, re-estimate the expiry from its shelf life.
$('#add-name').addEventListener('input', () => { $('#add-expiry').value = shelfExpiryStr($('#add-name').value); });
$('#add-form').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#add-name').value.trim();
  const amount = $('#add-qty').value.trim();
  if (!name || !amount) return;   // name and quantity are both required
  const key = keyForName(name);
  const unit = $('#dd-unit').dataset.value;
  const qty = qtyInPantryUnit(key, { amount: Number(amount), unit });   // one spelling everywhere, and the unit this food is already kept in
  const expVal = $('#add-expiry').value;
  const expiry = expVal ? new Date(`${expVal}T12:00:00`).getTime() : Date.now() + 7 * DAY;
  upsert(sentenceCase(name), key, qty, '', { expiry });   // servings come from the quantity (addLot)
  $('#add-name').value = ''; $('#add-qty').value = '';   // keep the unit; refresh the date default
  resetAddDefaults();
  renderAll();
  toast(`${name} added`);
  refreshRecipes();
});

// Keyboard: arrows drive the deck (on its tabs only), Escape closes the open sheet (even from inside a field)
document.addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'Escape') {
    if (cookState.open) return closeCookMode();                 // the top layer goes first
    if (!chatEl.panel.hidden) return;                          // the helper's own listener closed it; the sheet waits for the next Escape
    // an open row editor is what Escape cancels, not the whole review
    if (state.sheet === 'review' && review.some(l => l.editing)) { review.forEach(l => { l.editing = false; }); renderReview(); return; }
    if (state.sheet) closeSheet();
    return;
  }
  const t = e.target instanceof Element ? e.target : document.body;   // a keydown can target the document itself
  // cook mode: Left/Right move between steps
  if (cookState.open) {
    if (t.matches('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); cookStep(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); cookStep(1); }
    return;
  }
  // on the tab bar, Left/Right move between sections
  if (el.tabs.contains(t) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    const i = TABS.indexOf(state.tab);
    setTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length]);
    const b = $(`.tab[data-tab="${state.tab}"]`, el.tabs); if (b) b.focus();
    return;
  }
  if (t.matches('input, textarea, select') || t.closest('.dd')) return;
  if (state.sheet || !isDeckTab() || state.leaving) return;
  if (e.key === 'ArrowDown' || e.key === 'Backspace') { if (state.history.length) { e.preventDefault(); undo(); } return; }
  if (!state.deck.length) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); commit('skip'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); commit('cook'); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); openDetail(state.deck[0]); }
});

/* ---------- fit the deck to shorter laptop screens and narrower phones ---------- */
let fitScale = 1;
const topbarEl = $('.topbar');
// The top bar is 88px on wide screens and grows by the tab row under 1100px (the section tabs
// are laid out inside it either way): its measured height is what the stage does not get.
function topbarHeight() {
  const h = topbarEl ? topbarEl.offsetHeight : 0;
  return h > 0 ? h : 88;
}
function fit() {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  if (vh <= 0 || window.innerHeight <= 0) return;             // hidden tab / pre-layout: keep the last value
  const bar = topbarHeight();
  document.documentElement.style.setProperty('--topbar-h', `${bar}px`);   // the toast sits just under it
  const avail = vh - bar - 44 - 16;                            // minus top bar (tab row included), footer, breathing room
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
const [saved, prefs, kept, cachedDeck, shopping, cachedPlan, ratings, cookedLog, events] = await Promise.all([
  loadState(), loadPrefs(), loadSavedDishes(), loadDeck(), loadShopping(), loadPlan(), loadRatings(), loadCooked(), loadEvents(),
]);
state.prefs = prefs;   // before the first refreshRecipes(), so the deck already honours them
state.saved = Array.isArray(kept) ? kept.filter(d => d && d.id && Array.isArray(d.ingredients)) : [];   // before renderAll, so a photo dish on tonight's list resolves
state.shopping = Array.isArray(shopping) ? shopping : [];
state.ratings = ratings && typeof ratings === 'object' ? ratings : {};
state.cookedLog = Array.isArray(cookedLog) ? cookedLog : [];
state.events = Array.isArray(events) ? events : [];
syncRatingsToPrefs();   // the ratings are the truth; the prefs' liked/disliked lists follow them
if (saved) {
  state.pantry = saved.pantry;
  state.skipped = new Set(saved.skipped);
  state.cooked = new Set(saved.cooked);
  state.chosen = new Set(saved.chosen);
  rekeyLots(state.pantry);                  // lots stacked by a coarse scan group split back into their own foods, once
  recomputeDefaultServings(state.pantry);   // lots saved with the package default get their servings from their quantity, once
  sweepExpired();                           // lots found past their date get their one `expired` event for the report
} else {
  state.pantry = [];   // a new account starts empty: the first receipt or hand-added item fills it
}
// last week's plan comes back with the same plan- ids, so a meal on Tonight still opens
if (cachedPlan) adoptPlan(cachedPlan, { source: cachedPlan.source, signature: cachedPlan.signature, at: cachedPlan.at });
// Last visit's deck goes in before the first render, so the app opens with
// recipes already on screen instead of waiting on two model calls. If it no
// longer matches the kitchen, regenerate quietly behind it.
const deckFresh = adoptCachedDeck(cachedDeck);
populateFoodOptions();
setTab(state.tab, { render: false });   // the section from last time in this session, before the first paint
await warmDishImages(liveDishes || [], { timeoutMs: 400 });   // cached pictures into memory first, so the first paint is already right
renderAll({ enter: true });
if (!deckFresh) refreshRecipes({ quiet: Boolean(liveDishes) });
// First visit (a fresh sign-in, or once per browser in demo mode): ask the five questions before anything else.
if (!state.prefs.onboarded) openOnboarding();
window.pantry = { state, drag, session, setTab, undo, analyze, openDetail, openOnboarding, openProfile, openDishUpload, openSaved, openPlan, openReport, openCookMode, askAboutDish, rateDish, addShopping, beginBusy, get prefs() { return state.prefs; }, get user() { return user; }, get plan() { return plan; }, get timers() { return timers; } };   // module scope hides these; handy in the console and in scripts/merge-browser-check.js
