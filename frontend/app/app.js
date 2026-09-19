/* =========================================================================
   Pantry — interactive prototype
   Receipt in, pantry out, dinner on screen. Everything is derived at read
   time: current quantity = initial − burn rate × days − what cooking used.
   Runs as an ES module so it can share the auth and storage layers.
   ========================================================================= */

import { requireAuth, signOut, configured } from '../shared/supabase.js';
import { loadState, saveState, flushState, retrySave, checkIn, loadFoods, subscribe, clearLocal } from '../shared/store.js';
import { createFoodCatalog } from '../shared/foods.js';
import { DAY, OUT, currentAmount, calendarDaysLeft, dateValue, expiryFromDate, formatAmount, availableBatches, allocateIngredient, groupPantry, undoCook, addShoppingItem } from '../shared/pantry-model.js';

const THRESHOLD = 120;          // px of drag that commits a swipe
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
};

/* ---------- reference data: shelf life and household burn rate ---------- */
// shelf = days until it goes bad, burn = servings a household uses per day
// (0 = only recipes touch it), servings = what one purchase holds.
let foodCatalog = createFoodCatalog();
const catalog = key => foodCatalog.describe(key);

const ing = (name, key, need, amt) => ({ name, key, need, amt });
const DISHES = [
  {
    id: 'pasta', name: 'Spinach & garlic pasta', img: '../img/pasta.jpg', time: '20 min', servings: 2, difficulty: 'Easy',
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
    ingredients: [ing('Cucumber', 'cucumber', 1, '1'), ing('Tomatoes', 'tomatoes', 3, '3 roma'), ing('Red onion', 'red onion', 1, '½'), ing('Olives', 'olives', 1, 'a handful'), ing('Feta', 'feta', 2, '4 oz'), ing('Olive oil', 'olive oil', 1, '3 tbsp')],
    steps: [
      'Chop the cucumber and tomatoes into chunks and slice the red onion thin.',
      'Toss with olives, a good pour of olive oil and a pinch of salt.',
      'Crumble feta over the top if you have it. Best after ten minutes.',
    ],
  },
  {
    id: 'risotto', name: 'Mushroom risotto', img: '../img/risotto.jpg', time: '45 min', servings: 3, difficulty: 'Medium',
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
const dishById = id => DISHES.find(d => d.id === id);

const SAMPLE_RECEIPT = {
  store: 'Whole Foods Market', date: 'Sep 19', total: 64.18,
  lines: [
    { raw: 'ORG SPINACH 5OZ', name: 'Spinach', key: 'spinach', variety: 'Organic', qty: '5 oz', price: 3.49 },
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

/* ---------- the pantry model ---------- */
function mk(name, key, qty, daysAgo, raw = '') {
  const c = catalog(key);
  const purchase = Date.now() - daysAgo * DAY;
  return { id: uid(), name: c.name, key: c.key, qty, raw, initial: c.servings, purchase, expiry: expiryFromDate(dateValue(purchase + c.shelf * DAY)), burn: c.burn, deducted: 0, variety: c.variety, unit: c.unit, foodId: c.foodId };
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
    mk('Milk', 'milk', '1 gal', 18),
    ...[{variety:'Regular',amount:2,days:2},{variety:'Organic',amount:3,days:2},{variety:'Organic',amount:2,days:4}].map(b=>({...mk('Bananas','bananas','',0),variety:b.variety,initial:b.amount,burn:0,unit:'items',expiry:expiryFromDate(dateValue(Date.now()+b.days*DAY))})),
  ];
}
// Each purchase keeps its own quantity, variety and expiration date.
function upsert(name, key, qty, raw = '', options = {}) {
  const c = catalog(key || name);
  const item = {...mk(name,key || name,qty || c.qty,0,raw),
    variety:options.variety || catalog(name).variety,
    initial:options.amount ?? (c.unit==='items' && /^\d+(?:\.\d+)?$/.test(qty) ? Number(qty) : c.servings),
    unit:options.unit || c.unit, expiry:options.expiry || expiryFromDate(dateValue(Date.now()+c.shelf*DAY))};
  state.pantry.push(item);
  return {item,merged:false};
}
const current = it => currentAmount(it);
const daysLeft = it => calendarDaysLeft(it.expiry);
const needsCheckin = it => current(it) <= OUT;
const findItem = key => availableBatches(state.pantry,foodCatalog.key(key))[0];

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
  const pct = clamp(it.initial ? cur / it.initial : 0, 0, 1);
  const dl = daysLeft(it);
  const shelfDays = (it.expiry - it.purchase) / DAY;
  const tLevel = levelForDays(dl);
  const aLevel = pct <= 0.12 ? 'red' : pct <= 0.3 ? 'yellow' : 'green';
  const rank = { red: 0, yellow: 1, green: 2 };
  if (it.burn > 0 && rank[aLevel] < rank[tLevel]) {
    return { level: aLevel, pct, mode: 'amount', label: `about ${Math.round(pct * 100)}% left`, urgency: pct };
  }
  return { level: tLevel, pct: clamp(dl / shelfDays, 0, 1), mode: 'time', label: timeLabel(dl), urgency: dl / 30 };
}

/* ---------- dishes against the pantry ---------- */
function analyze(dish) {
  const ings = dish.ingredients.map(i => {
    const key = foodCatalog.key(i.key);
    const allocation = allocateIngredient(state.pantry,key,i.need);
    const item = allocation.allocations[0]?.item;
    return { ...i, key, ...allocation, item, have: allocation.missing < 0.01 };
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
  return { dish, ings, have, missing, urgentDays, badge };
}
const eligible = a => a.missing.length <= 2;

/* ---------- state ---------- */
const state = {
  pantry: [],
  shopping: [],
  cookLogs: [],
  receipts: [],
  panelTab: 'pantry',
  busy: false,
  ready: false,
  deck: [],
  skipped: new Set(),
  cooked: new Set(),
  chosen: new Set(),        // dishes picked for tonight, in the order they were picked
  sheet: null,
  panelOpen: false,
  leaving: false,
  sheetReturn: null,        // where keyboard focus goes back to when the sheet closes
  panelReturn: null,
};

function buildDeck() {
  const all = DISHES.map(analyze).filter(eligible);
  state.deck = all
    .filter(a => !state.skipped.has(a.dish.id) && !state.cooked.has(a.dish.id) && !state.chosen.has(a.dish.id))
    .sort((a, b) => (a.urgentDays - b.urgentDays) || (a.missing.length - b.missing.length));
  return all;
}
const chosenDishes = () => [...state.chosen].map(dishById).filter(Boolean);

/* =========================================================================
   Rendering
   ========================================================================= */
const el = {
  deck: $('#deck'), caption: $('#deck-caption'), status: $('#deck-status'), deckScreen: $('#deck-screen'), endScreen: $('#end-screen'), emptyScreen: $('#empty-screen'),
  count: $('#btn-pantry'), tonight: $('#btn-tonight'), reset: $('#btn-reset'),
  veil: $('#veil'), sheet: $('#sheet'), panel: $('#panel'), panelBody: $('#panel-body'), panelCount: $('#panel-count'),
  toast: $('#toast'), file: $('#file-input'),
};

// The choke point after every mutation: everything derived is rebuilt here, then saved.
function renderAll(opts = {}) {
  buildDeck();
  const n = groupPantry(state.pantry).length;
  el.count.textContent = plural(n, 'food');
  el.count.setAttribute('aria-label', `Pantry, ${plural(n, 'food')}`);
  el.panelCount.textContent = `${n} foods · ${state.pantry.length} batches`;
  $('#shopping-count').textContent = state.shopping.filter(x=>!x.checked).length;
  $('#btn-undo').hidden = !state.cookLogs.some(x=>!x.undone_at && x.items_deducted?.some(y=>y.purchase != null));
  el.reset.textContent = n ? 'Clear pantry' : 'Load demo pantry';
  renderTonight();
  renderDeck(opts);
  if (state.panelOpen) renderPanel();
  if (state.ready && opts.save !== false) saveState(state);
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
      <div class="meta"><span>${d.time}</span><i></i><span>${plural(d.servings, 'serving')}</span><i></i><span>${d.difficulty}</span></div>
      <div class="chips">${a.ings.map(i => i.have
        ? `<span class="chip have">${ICON.checkSm}<span>${esc(i.name)}</span></span>`
        : `<span class="chip missing">${esc(i.name)}</span>`).join('')}</div>
      ${a.missing.length ? `<div class="missing-line">missing ${a.missing.length}: ${esc(a.missing.map(m => m.name.toLowerCase()).join(', '))}</div>` : ''}
    </div>
    <div class="overlay cook"><div class="glass ring">${ICON.checkBig}</div></div>
    <div class="overlay skip"><div class="glass ring">${ICON.xBig}</div></div>`;
}

function renderDeck(opts = {}) {
  const hasPantry = state.pantry.length > 0;
  el.emptyScreen.classList.toggle('hidden', hasPantry);
  el.deckScreen.classList.toggle('hidden', !hasPantry || state.deck.length === 0);
  el.endScreen.classList.toggle('hidden', !hasPantry || state.deck.length > 0);
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
  const msg = !hasPantry ? 'Pantry is empty' : n ? `Now showing ${state.deck[0].dish.name}, ${left}` : 'No dishes left';
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
  const modal = !!(state.sheet || state.panelOpen || state.busy || !state.ready);
  for (const n of $$('.topbar, .stage, .foot')) n.inert = modal;
  el.panel.inert = !state.panelOpen || state.busy;
  el.sheet.inert = !state.sheet || state.busy;
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
        <span>Items, prices and the date are read for you.</span>
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
  const steps = [
    ['Reading items', '17 lines found, 2 look like non-food'],
    ['Estimating shelf life', 'Milk, spinach, chicken thighs…'],
    ['Finding recipes', 'Dishes that use what expires first'],
  ];
  openSheet('processing', `
    <div class="sheet-head"><h2>Reading your receipt</h2>${closeBtn()}</div>
    <div class="sheet-body">
      <div class="processing">
        <div class="receipt">${receiptHTML(file)}<div class="receipt-tint"></div><div class="scanline"></div></div>
        <div class="steps">${steps.map(([t, s]) => `<div class="step"><span class="mark">${ICON.checkMd}</span><div><strong>${t}</strong><small>${s}</small></div></div>`).join('')}</div>
      </div>
      <div class="sheet-note">
        <span>${file ? 'Prototype: parsing is simulated with the sample receipt.' : 'About ten seconds. The deck stays where it was.'}</span>
        <button class="linkish" type="button" data-back-upload>Cancel</button>
      </div>
    </div>`);
  const stepEls = $$('.step', el.sheet);
  for (let i = 0; i < stepEls.length; i++) {
    if (state.sheet !== 'processing') return;
    stepEls[i].classList.add('active');
    await wait(1100);
    stepEls[i].classList.remove('active');
    stepEls[i].classList.add('done');
  }
  if (state.sheet !== 'processing') return;
  await wait(250);
  openReview(SAMPLE_RECEIPT.lines.map(l => ({ ...l, id: uid(), dropped: false })));
}

/* ---------- scan: review ---------- */
let review = [];
function openReview(lines) {
  review = lines.map(l=>({...l,key:catalog(l.key || l.name).key,variety:l.variety || catalog(l.raw || l.name).variety,expiry:l.expiry || dateValue(Date.now()+catalog(l.key || l.name).shelf*DAY)}));
  openSheet('review', `
    <div class="sheet-head"><h2 id="review-title">Review items</h2>${closeBtn()}</div>
    <div class="sheet-sub"><span>${esc(SAMPLE_RECEIPT.store)}</span><i></i><span>${esc(SAMPLE_RECEIPT.date)}</span><i></i><span>Click a row to edit it</span></div>
    <div class="rlist scroll" id="rlist"></div>
    <div class="sheet-foot" style="flex-direction:column;align-items:stretch">
      <div class="summary"><span id="review-summary"></span><b>$${SAMPLE_RECEIPT.total.toFixed(2)}</b></div>
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
          <input id="e-name-${l.id}" class="field" name="name" list="food-options" value="${esc(l.name)}" required autofocus>
          <label class="sr-only" for="e-qty-${l.id}">Quantity</label>
          <input id="e-qty-${l.id}" class="field short" name="qty" value="${esc(l.qty || '')}">
          <label class="sr-only" for="e-variety-${l.id}">Variety</label>
          <input id="e-variety-${l.id}" class="field" name="variety" value="${esc(l.variety)}" placeholder="Variety">
          <label class="sr-only" for="e-expiry-${l.id}">Expiration date</label>
          <input id="e-expiry-${l.id}" class="field" name="expiry" type="date" value="${esc(l.expiry)}" required>
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
        <div class="name"><strong>${esc(l.name)}</strong><small>${esc(l.variety)} · ${esc(l.expiry)}</small></div>
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
function estimateLabel(key) {
  const c = catalog(key);
  const dl = c.shelf;
  if (dl <= 7) { const d = new Date(Date.now() + dl * DAY); return `expires ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`; }
  return timeLabel(dl);
}
// How many dishes would become makeable if these lines were added (dry run).
function countNewDishes(lines, before) {
  const saved = state.pantry;
  state.pantry = saved.concat(lines.map(l => mk(l.name, l.key, l.qty, 0)));
  const after = DISHES.map(analyze).filter(eligible).map(a => a.dish.id);
  state.pantry = saved;
  return after.filter(id => !before.has(id)).length;
}
function addToPantry() {
  const food = review.filter(l => !l.nonFood && !l.dropped);
  const before = new Set(buildDeck().map(a => a.dish.id));
  for (const l of food) upsert(l.name, l.key, l.qty, l.raw, {variety:l.variety,expiry:expiryFromDate(l.expiry)});
  state.receipts.push({id:uid(),store_name:SAMPLE_RECEIPT.store,total:SAMPLE_RECEIPT.total,scanned_at:new Date().toISOString(),item_count:food.length});
  closeSheet();
  renderAll({ enter: true });
  const fresh = buildDeck().filter(a => !before.has(a.dish.id)).length;
  toast(`${plural(food.length, 'item')} added`, `${plural(fresh, 'new dish', 'new dishes')}`);
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
        <div class="meta"><span>${d.time}</span><i></i><span>${plural(d.servings, 'serving')}</span><i></i><span>${d.difficulty}</span>${a.missing.length ? `<i></i><span>${plural(a.missing.length, 'thing missing', 'things missing')}</span>` : ''}</div>
      </div>
    </div>
    <div class="detail-body scroll">
      <div class="ings">
        <div class="eyebrow">Ingredients</div>
        ${a.have.map(i => `<div class="ing have"><span class="mark">${ICON.checkSm}</span><span class="n">${esc(i.name)}</span><span class="a">${esc(i.amt)}</span></div>`).join('')}
        ${a.missing.length ? `<div class="divider"><span>You’ll need</span></div>` + a.missing.map(i => `<div class="ing need"><span class="mark"></span><span class="n">${esc(i.name)}</span><span class="a">${esc(i.amt)}${i.available > 0 ? ` · short ${formatAmount(i.missing)} servings` : ''}</span></div>`).join('') + `<button class="pill glass sm" type="button" data-shop-missing="${d.id}">Add missing ingredients to shopping list</button>` : ''}
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
  const a=analyze(dishById(dishId));
  const usable=a.ings.filter(i=>i.allocations.length);
  openSheet('madeit', `
    <div class="sheet-head"><h2>Update your pantry</h2>${closeBtn()}</div>
    <div class="sheet-sub"><span>${esc(a.dish.name)}</span></div>
    <div class="sheet-body"><p class="batch-note">We’ll use the batches expiring soonest. Uncheck anything you didn’t use.</p>
      <div class="deduct" id="deduct">${usable.map(i=>`<label><input class="chk" type="checkbox" checked data-key="${esc(i.key)}">
        <span class="name"><strong>${esc(i.name)}</strong><small>${i.allocations.map(x=>`${formatAmount(x.servings)} from ${esc(x.item.variety.toLowerCase())} · ${esc(dateValue(x.item.expiry))}`).join('<br>')}${i.missing>.01 ? `<br>Only ${formatAmount(i.need-i.missing)} of ${i.need} available` : ''}</small></span>
        <span class="amt">${formatAmount(i.need-i.missing)}</span></label>`).join('')}</div>
    </div>
    <div class="sheet-foot madeit-foot"><p class="sheet-note" id="deduct-summary"></p>
      <button class="pill prominent full" type="button" data-done="${a.dish.id}">${ICON.checkMd}<span>Done</span></button>
    </div>`, 'w-520');
  updateDeductSummary();
}
function updateDeductSummary() {
  $('#deduct-summary').textContent=`${plural($$('#deduct input:checked').length,'ingredient')} will be deducted. You can undo this meal afterward.`;
}
function finishMadeIt(dishId) {
  if(state.cooked.has(dishId))return;
  const dish=dishById(dishId), checked=new Set($$('#deduct input:checked').map(b=>b.dataset.key)), used=[];
  for(const ingredient of dish.ingredients) {
    const key=foodCatalog.key(ingredient.key);
    if(!checked.has(key))continue;
    for(const {item,servings} of allocateIngredient(state.pantry,key,ingredient.need).allocations) {
      item.deducted+=servings;
      used.push({id:item.id,key:item.key,name:item.name,variety:item.variety,servings,purchase:item.purchase});
    }
  }
  state.cookLogs.unshift({id:uid(),recipe_id:dish.id,title:dish.name,cooked_at:new Date().toISOString(),items_deducted:used,undone_at:null});
  state.chosen.delete(dishId);state.cooked.add(dishId);
  closeSheet();renderAll({enter:true});
  toast('Pantry updated',`${plural(used.length,'batch')} used`,'Undo is available at the bottom of the screen.');
}
function undoLastCook() {
  const log=state.cookLogs.find(x=>!x.undone_at && x.items_deducted?.some(y=>y.purchase!=null));
  try {
    undoCook(state.pantry,log);
    if(!state.cookLogs.some(x=>x.recipe_id===log.recipe_id && !x.undone_at))state.cooked.delete(log.recipe_id);
    renderAll({enter:true});toast('Cooking undone',log.title,'The ingredients are back in their original batches.');
  }catch(error){toast('Couldn’t undo',error.message);}
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
function batchHTML(it) {
  const amount=current(it),dl=daysLeft(it);
  const quantity=`${it.burn>0 ? 'About ' : ''}${formatAmount(amount)} ${it.unit==='items' ? (Math.round(amount)===1 ? 'item' : 'items') : 'servings'}`;
  const check=needsCheckin(it),label=`${it.name}, ${it.variety}, ${dateValue(it.expiry)}`;
  const options=it.asking ? `<form class="batch-checkin" data-checkin="${it.id}">
    <label for="remaining-${it.id}">How many ${it.unit==='items' ? 'items' : 'servings'} are left?</label>
    <div class="form-inline"><input class="field" id="remaining-${it.id}" name="remaining" type="number" min="0" step="${it.unit==='items' ? '1' : '.1'}" required value="${Math.round(amount)}"><button class="pill prominent sm" type="submit">Update</button></div>
    ${it.unit!=='items' ? `<div class="batch-actions"><button class="linkish" type="button" data-some="${it.id}" data-frac=".5">Half the original amount</button><button class="linkish" type="button" data-some="${it.id}" data-frac=".25">A quarter</button></div>` : ''}
    <div class="batch-actions"><button class="linkish" type="button" data-gone="${it.id}">All gone</button><button class="linkish" type="button" data-unask="${it.id}">Cancel</button></div>
  </form>` : '';
  return `<div class="batch-row" data-id="${it.id}">
    <div class="batch-line"><strong>${esc(it.variety)}</strong><span class="batch-amount">${quantity}</span></div>
    <div class="batch-line batch-date"><span class="freshness-dot ${levelForDays(dl)}"></span><span>${esc(timeLabel(dl))}</span><time datetime="${dateValue(it.expiry)}">${new Date(it.expiry).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}</time></div>
    ${check ? '<p class="checkin-note">Estimated empty. Still have some?</p>' : ''}
    <div class="batch-actions"><button class="linkish" type="button" data-ask="${it.id}" aria-label="Check quantity: ${esc(label)}">${check ? 'Still have some' : 'Check quantity'}</button>
      ${check ? `<button class="linkish" type="button" data-gone="${it.id}">All gone</button><button class="linkish" type="button" data-shop-batch="${it.id}">Add to list</button>` : ''}
      <button class="circle sm del" type="button" data-remove="${it.id}" aria-label="Remove batch: ${esc(label)}">${ICON.xSm}</button>
    </div>${options}</div>`;
}
function renderPanel() {
  for(const tab of ['pantry','shopping']) {
    const button=$('#tab-'+tab),active=state.panelTab===tab;
    button.setAttribute('aria-selected',String(active));button.tabIndex=active ? 0 : -1;
  }
  el.panelBody.setAttribute('aria-labelledby','tab-'+state.panelTab);
  $('#btn-add').hidden=state.panelTab!=='pantry';
  $('#pantry-toolbar').hidden=state.panelTab!=='pantry';
  $('#shopping-form').hidden=state.panelTab!=='shopping';
  if(state.panelTab==='shopping')return renderShopping();
  const mem=focusIndexIn(el.panelBody,'.batch-row');
  el.panelBody.innerHTML=groupPantry(state.pantry).map(group=>{
    const sameUnit=new Set(group.batches.map(x=>x.unit)).size===1,total=group.batches.reduce((n,x)=>n+current(x),0);
    return `<section class="food-group" aria-label="${esc(group.name)}">
      <div class="food-heading"><h3>${esc(group.name)}</h3><span>${sameUnit ? `${group.batches.some(x=>x.burn>0) ? '≈ ' : ''}${formatAmount(total)} ${group.batches[0].unit} · ` : ''}${plural(group.batches.length,'batch','batches')}</span></div>
      ${group.batches.map(batchHTML).join('')}</section>`;
  }).join('') || '<p class="empty-note">No food yet. Add a batch or scan a receipt.</p>';
  restoreFocusIn(el.panelBody,'.batch-row',mem,el.panel);
}
function renderShopping() {
  const mem=focusIndexIn(el.panelBody,'.shopping-row');
  const items=[...state.shopping].sort((a,b)=>Number(a.checked)-Number(b.checked));
  el.panelBody.innerHTML=items.length ? `<p class="batch-note">${state.shopping.filter(x=>!x.checked).length} to buy. Check items off as you shop.</p>`+items.map(item=>`<div class="shopping-row ${item.checked ? 'checked' : ''}" data-id="${item.id}">
    <label><input class="chk" type="checkbox" data-shop-check="${item.id}" ${item.checked ? 'checked' : ''}><span><strong>${esc(item.name)}</strong><small>${formatAmount(item.amount)} ${esc(item.unit)}</small></span></label>
    <button class="circle sm" type="button" data-shop-remove="${item.id}" aria-label="Remove ${esc(item.name)} from shopping list">${ICON.xSm}</button>
  </div>`).join('')+`<button class="linkish clear-checked" type="button" data-clear-checked>Clear checked items</button>` : '<p class="empty-note">Your list is clear. Add an item above, or add missing ingredients from a recipe.</p>';
  restoreFocusIn(el.panelBody,'.shopping-row',mem,el.panel);
}
function addToShopping(key,name,amount=1,unit='servings') {
  return addShoppingItem(state.shopping,{key:foodCatalog.key(key),name,amount:Math.max(.1,Number(amount.toFixed(1))),unit});
}
function addMissing(dishId) {
  let added=0;
  for(const item of analyze(dishById(dishId)).missing)added+=Number(addToShopping(item.key,item.name,item.missing));
  renderAll();toast(added ? `${plural(added,'ingredient')} added to list` : 'Already on your shopping list');
}
function addDepleted() {
  let added=0;
  for(const group of groupPantry(state.pantry))if(group.batches.every(it=>needsCheckin(it)||daysLeft(it)<0)) {
    const c=catalog(group.key);added+=Number(addToShopping(group.key,group.name,c.servings,c.unit));
  }
  renderAll();toast(added ? `${plural(added,'food')} added to list` : 'Nothing new to add');
}
async function submitCheckin(id,style,value) {
  if(state.busy)return;
  const item=state.pantry.find(x=>x.id===id);if(!item)return;
  state.busy=true;document.body.dataset.busy='true';syncInert();
  try {
    const updated=await checkIn(item,style,value);
    state.pantry=state.pantry.flatMap(x=>x.id===id ? updated ? [updated] : [] : [x]);
    renderAll();toast('Quantity updated',updated ? 'Your estimate will adjust from this check-in.' : 'Batch marked as gone.');
  }catch(error){toast('Couldn’t update quantity',error.message,'Your batch has not been changed here.');}
  finally{state.busy=false;document.body.dataset.busy='false';syncInert();}
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

/* =========================================================================
   Wiring
   ========================================================================= */
$('#btn-scan').addEventListener('click', openScanUpload);
$('#btn-scan-2').addEventListener('click', openScanUpload);
$('#empty-drop').addEventListener('click', () => el.file.click());   // "click to browse" means the file picker
$('#empty-sample').addEventListener('click', () => startProcessing(null));
$('#btn-pantry').addEventListener('click', () => {state.panelTab='pantry';state.panelOpen ? closePanel() : openPanel();});
$('#btn-close-panel').addEventListener('click', closePanel);
$('#btn-tonight').addEventListener('click', openTonight);
$('#btn-skip').addEventListener('click', () => commit('skip'));
$('#btn-cook').addEventListener('click', () => commit('cook'));
$('#btn-details').addEventListener('click', () => openDetail(state.deck[0]));
$('#btn-reshuffle').addEventListener('click', () => { state.skipped.clear(); state.chosen.clear(); renderAll({ enter: true }); });
// One button, two jobs, so it is labelled from state (see renderAll) and says what it did
$('#btn-reset').addEventListener('click', () => {
  const fresh = state.pantry.length === 0;
  state.pantry = fresh ? seedPantry() : [];
  state.skipped.clear(); state.cooked.clear(); state.chosen.clear();
  clearLocal();
  closeSheet(); closePanel();
  renderAll({ enter: true });
  toast(fresh ? 'Demo pantry loaded' : 'Pantry cleared', fresh ? plural(state.pantry.length, 'item') : '');
});
$('#btn-signout').hidden = !configured;
$('#btn-signout').addEventListener('click', async () => {try {await flushState();await signOut();location.replace('../login/');} catch {toast('Not signed out','Retry saving your changes before signing out.');}});
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
  if (t.dataset.shopMissing) return addMissing(t.dataset.shopMissing);
});
el.sheet.addEventListener('submit', e => {
  const form = e.target.closest('form[data-edit]');
  if (!form) return;
  e.preventDefault();
  const l = review.find(x => x.id === form.dataset.edit);
  if (l) {
    l.name = form.name.value.trim() || l.name;
    l.qty = form.qty.value.trim();
    l.key = catalog(l.name).key;
    l.variety = form.variety.value.trim() || 'Regular';
    l.expiry = form.expiry.value;
    l.editing = false; l.fixed = true;
  }
  renderReview();
});
el.sheet.addEventListener('change', e => { if (e.target.matches('#deduct input')) updateDeductSummary(); });

// Pantry and shopping controls share the same side panel.
el.panel.addEventListener('click',e=>{
  const t=e.target.closest('button');if(!t || state.busy)return;
  const item=id=>state.pantry.find(x=>x.id===id);
  if(t.dataset.remove){state.pantry=state.pantry.filter(x=>x.id!==t.dataset.remove);return renderAll();}
  if(t.dataset.gone)return submitCheckin(t.dataset.gone,'empty');
  if(t.dataset.ask){const it=item(t.dataset.ask);if(it)it.asking=true;renderPanel();$('#remaining-'+t.dataset.ask)?.focus();return;}
  if(t.dataset.unask){const it=item(t.dataset.unask);if(it)it.asking=false;return renderPanel();}
  if(t.dataset.some)return submitCheckin(t.dataset.some,'percent',Number(t.dataset.frac));
  if(t.dataset.shopBatch){const it=item(t.dataset.shopBatch),c=catalog(it.key);addToShopping(it.key,it.name,c.servings,c.unit);renderAll();return toast('Added to shopping list');}
  if(t.dataset.shopRemove){state.shopping=state.shopping.filter(x=>x.id!==t.dataset.shopRemove);return renderAll();}
  if(t.hasAttribute('data-clear-checked')){state.shopping=state.shopping.filter(x=>!x.checked);return renderAll();}
});
el.panel.addEventListener('change',e=>{
  if(e.target.dataset.shopCheck){const it=state.shopping.find(x=>x.id===e.target.dataset.shopCheck);if(it)it.checked=e.target.checked;renderAll();}
});
el.panel.addEventListener('submit',e=>{
  const form=e.target.closest('[data-checkin]');if(!form)return;
  e.preventDefault();submitCheckin(form.dataset.checkin,'count',Number(form.remaining.value));
});
function selectPanelTab(tab){state.panelTab=tab;$('#add-form').hidden=true;$('#btn-add').setAttribute('aria-expanded','false');renderPanel();}
for(const tab of ['pantry','shopping']) {
  $('#tab-'+tab).addEventListener('click',()=>selectPanelTab(tab));
  $('#tab-'+tab).addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home' ? 'pantry' : e.key==='End' ? 'shopping' : tab==='pantry' ? 'shopping' : 'pantry';selectPanelTab(next);$('#tab-'+next).focus();}});
}
$('#btn-shopping').addEventListener('click',()=>{state.panelTab='shopping';openPanel();});
$('#btn-depleted').addEventListener('click',addDepleted);
$('#btn-undo').addEventListener('click',undoLastCook);
$('#btn-add').addEventListener('click',()=>{
  const f=$('#add-form');f.hidden=!f.hidden;$('#btn-add').setAttribute('aria-expanded',String(!f.hidden));
  if(!f.hidden){prefillFood();$('#add-name').focus();}
});
function prefillFood(){
  const c=catalog($('#add-name').value);
  $('#add-qty').value=c.servings;$('#add-unit').value=c.unit;
  $('#add-variety').value=c.variety;$('#add-expiry').value=dateValue(Date.now()+c.shelf*DAY);
  $('#food-hint').textContent=c.food ? `Suggested from ${c.food.name.toLowerCase()}. Adjust the amount and date to match this batch.` : 'Custom food. Set the amount and expiration date for this batch.';
}
$('#add-name').addEventListener('change',prefillFood);
$('#add-form').addEventListener('submit',e=>{
  e.preventDefault();const name=$('#add-name').value.trim();if(!name)return;
  const amount=Number($('#add-qty').value),expiry=expiryFromDate($('#add-expiry').value);
  if(!Number.isFinite(amount)||amount<=0||!Number.isFinite(expiry))return;
  const c=catalog(name);
  upsert(name,c.key,c.qty,'',{amount,unit:$('#add-unit').value,variety:$('#add-variety').value.trim()||'Regular',expiry});
  $('#add-form').reset();$('#add-form').hidden=true;$('#btn-add').setAttribute('aria-expanded','false');
  renderAll();toast('Batch added',c.name);
});
$('#shopping-form').addEventListener('submit',e=>{
  e.preventDefault();const name=$('#shop-name').value.trim();if(!name)return;
  const c=catalog(name),added=addToShopping(c.key,c.name,Number($('#shop-amount').value),$('#shop-unit').value);
  $('#shopping-form').reset();renderAll();$('#shop-name').focus();if(!added)toast('Already on your shopping list');
});
subscribe(status=>{
  for(const label of $$('[data-save-label]'))label.textContent=status.message;
  for(const button of $$('[data-retry-save]'))button.hidden=status.phase!=='error';
  document.body.dataset.saveState=status.phase;
});
for(const button of $$('[data-retry-save]'))button.addEventListener('click',()=>retrySave().catch(()=>{}));

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
async function init(){
  try {
    const session=await requireAuth('../login/');
    if(configured && !session)return;
    const saved=await loadState();
    try{foodCatalog=createFoodCatalog(await loadFoods());}
    catch{$('#catalog-status').textContent='Food suggestions are using offline defaults.';}
    $('#food-options').innerHTML=foodCatalog.foods.map(f=>`<option value="${esc(f.name)}"></option>`).join('');
    if(saved){
      state.pantry=saved.pantry.map(it=>({...it,key:foodCatalog.key(it.key),name:catalog(it.key).name,foodId:it.foodId || catalog(it.key).foodId}));
      state.skipped=new Set(saved.skipped);state.cooked=new Set(saved.cooked);state.chosen=new Set(saved.chosen);
      state.shopping=saved.shopping || [];state.cookLogs=saved.cookLogs || [];state.receipts=saved.receipts || [];
    }else state.pantry=seedPantry();
    state.ready=true;$('#load-error').hidden=true;renderAll({enter:true,save:!saved});syncInert();document.body.dataset.appReady='true';
    window.pantry={state,drag,session};
  }catch(error){$('#load-error').hidden=false;$('#load-error-message').textContent='Your pantry could not be loaded. Retry when your connection is back.';console.warn('[pantry] Load failed',error);}
}
$('#btn-retry-load').addEventListener('click',init);
await init();
