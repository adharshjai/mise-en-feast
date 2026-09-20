import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as preferences from '../frontend/shared/store.js';
import * as ingredients from '../frontend/shared/ingredients.js';
import * as units from '../frontend/shared/units.js';
import * as dishImages from '../frontend/shared/dish-images.js';
import * as report from '../frontend/shared/report.js';
import * as timers from '../frontend/shared/timers.js';
import * as substitutions from '../frontend/shared/substitutions.js';

function app({ chat = false } = {}) {
  const full = readFileSync(new URL('../frontend/app/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const source = full
    .split('/* =========================================================================\n   Wiring')[0]
    .replace(/^import [\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '');
  // One stub stands in for every element app.js looks up at load time; it swallows the
  // attribute and class work setTab() does, so section switches can be exercised here.
  const node = {
    addEventListener() {}, setAttribute() {}, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  const context = vm.createContext({
    ...preferences, ...ingredients, ...units, ...dishImages, ...report, ...timers, ...substitutions,
    console, crypto, setTimeout, clearTimeout,
    window: { matchMedia: () => ({ matches: true }) },
    document: { querySelector: () => node },
  });
  vm.runInContext(source, context);
  if (chat) vm.runInContext(full.slice(full.indexOf('const chatEl ='), full.indexOf('chatEl.fab.addEventListener')), context);
  return code => vm.runInContext(code, context);
}

test('merged recipe details use adult/kid preferences and retain Saved navigation', () => {
  const run = app();
  run(`state.prefs = normalizePrefs({version: 2, household: {adults: 3, kids: 1}});
    state.sheet = 'saved';
    openSheet = (kind, html) => { state.sheet = kind; globalThis.html = html; };
    openDetail(DISHES[0]);`);
  assert.equal(run('state.detailServings'), 4);
  assert.equal(run('html.includes("NaN")'), false);
  assert.equal(run('html.includes("data-open-saved")'), true);
});

test('cooking confirmation and actual deductions both follow selected servings', () => {
  const run = app();
  run(`const dish = {id: 'test', name: 'Test dish', servings: 2,
      ingredients: [{key: 'eggs', name: 'Eggs', need: 2}, {key: 'salt', name: 'Salt', need: 1, staple: true}]};
    liveDishes = [dish];`);
  run(`state.detailServings = 4;
    analyze = () => ({dish, have: [
      {...dish.ingredients[0], item: {burn: 0, initial: 10}, avail: 10},
      {...dish.ingredients[1], item: null, avail: 0}]});
    openSheet = (kind, html) => { globalThis.html = html; };
    updateDeductSummary = () => {};
    openMadeIt('test');`);
  assert.equal(run('html.includes("~4 servings of ~10 servings")'), true);   // no quantity on the lot: servings are all we know
  assert.equal(run('html.includes("Salt")'), false);
  // The app's query helper delegates to querySelectorAll.
  run(`document.querySelectorAll = () => [{checked: true, dataset: {key: 'eggs'}}];
    deductServings = (key, amount) => { globalThis.deducted = amount; return []; };
    closeSheet = renderAll = toast = logCook = refreshRecipes = () => {};
    finishMadeIt('test');`);
  assert.equal(run('deducted'), 4);
});

test('chat sends the pantry, preferences and recent meals to the assistant and renders its reply', async () => {
  const run = app({chat: true});
  run(`state.prefs = normalizePrefs({allergies: ['dairy']});
    state.cooked = new Set();
    state.pantry = [{id: 'm', name: 'Milk', key: 'milk', initial: 8, deducted: 0, burn: 0,
      purchase: Date.now(), expiry: Date.now() + 5 * 86400000}];
    globalThis.messages = [];
    addChat = (who, html) => { messages.push(html); return {remove(){}}; };
    globalThis.apiConfigured = () => true;
    globalThis.chatApi = async (history, ctx) => { globalThis.sent = ctx; globalThis.hist = history; return {
      reply: 'Here is an idea:',
      actions: [],
      recipes: [{title: 'Tomato rice', cook_minutes: 20, difficulty: 'easy', servings: 2, missing_count: 0,
        ingredients: [{name: 'Tomato', matched_name: 'Tomato', servings_used: 1}, {name: 'Rice', servings_used: 2}],
        steps: ['Cook it.']}],
    }; };`);
  await run(`handleChat('what can I make?')`);
  assert.equal(run(`sent.prefs.allergies[0]`), 'dairy');
  assert.equal(run(`sent.pantry[0].name`), 'Milk');
  assert.equal(run(`hist[0].role`), 'user');
  assert.equal(run(`hist[0].content`), 'what can I make?');
  assert.equal(run(`messages.at(-1).includes('Here is an idea:')`), true);
  // The returned recipe renders as a tappable card wired to the recipe popup.
  assert.equal(run(`messages.at(-1).includes('data-chat-open')`), true);
  assert.equal(run(`messages.at(-1).includes('Tomato rice')`), true);
  assert.equal(run(`dishById([...chatDishes.keys()].at(-1)).name`), 'Tomato rice');
});

test('assistant write-actions update the pantry and preferences through the deterministic model', async () => {
  const run = app({chat: true});
  run(`renderAll = refreshRecipes = () => {};
    state.prefs = normalizePrefs({});
    state.cooked = new Set();
    state.pantry = [
      {id: 'milk1', name: 'Milk', key: 'milk', initial: 8, deducted: 0, burn: 0, purchase: Date.now(), expiry: Date.now() + 5 * 86400000},
      {id: 'eggs1', name: 'Eggs', key: 'eggs', initial: 12, deducted: 0, burn: 0, purchase: Date.now(), expiry: Date.now() + 10 * 86400000}
    ];
    globalThis.messages = [];
    addChat = (who, html) => { messages.push(html); return {remove(){}}; };
    globalThis.apiConfigured = () => true;
    globalThis.chatApi = async () => ({reply: 'Done.', actions: [
      {type: 'mark_food_gone', id: 'milk1', name: 'Milk', key: 'milk'},
      {type: 'record_checkin', id: 'eggs1', name: 'Eggs', key: 'eggs', percent: 50},
      {type: 'update_preference', field: 'diet', value: ['vegetarian']}
    ]});`);
  await run(`handleChat('finished the milk, half the eggs left, we are vegetarian now')`);
  assert.equal(run(`state.pantry.some(x => x.key === 'milk')`), false);
  assert.equal(run(`state.prefs.diet[0]`), 'vegetarian');
  // The check-in re-baselines eggs to 50% of the catalog serving count (12 -> 6) in plain code.
  assert.equal(run(`state.pantry.find(x => x.key === 'eggs').initial`), 6);
  assert.equal(run(`messages.at(-1).includes('Done.')`), true);
});

test('offline chat falls back to built-in suggestions filtered by allergies and diet', async () => {
  const run = app({chat: true});
  run(`state.prefs = normalizePrefs({diet: ['vegan'], allergies: ['peanuts']});
    state.cooked = new Set();
    globalThis.messages = [];
    addChat = (who, html) => { messages.push(html); return {remove(){}}; };
    globalThis.apiConfigured = () => true;
    globalThis.chatApi = async () => { throw new Error('offline'); };
    liveDishes = [
      {id: 'chicken', name: 'Chicken soup', ingredients: [{name: 'Chicken', key: 'chicken', need: 1}], servings: 2},
      {id: 'nuts', name: 'Peanut rice', ingredients: [{name: 'Peanut', key: 'peanut', need: 1}], servings: 2},
      {id: 'rice', name: 'Tomato rice', ingredients: [{name: 'Tomato', key: 'tomato', need: 1}], servings: 2}
    ];`);
  await run(`handleChat('what can I make?')`);
  assert.equal(run(`messages.at(-1).includes('using available recipes')`), true);
  assert.equal(run(`messages.at(-1).includes('<b>Tomato rice</b>')`), true);
  assert.equal(run(`messages.at(-1).includes('Peanut rice')`), false);
});

test('recipe refresh failure falls back to built-in recipes', async () => {
  const run = app();
  run(`state.pantry = [{id: 'one'}];
    globalThis.apiConfigured = () => true;
    globalThis.fetchRecipes = async () => { throw new Error('offline'); };
    pantryForApi = () => [];
    renderAll = () => {};`);
  await run('refreshRecipes()');
  assert.equal(run('liveDishes'), null);
});

/* ---------- tabs, ingredient verification and undo (frontend-1) ---------- */
const lot = (name, key, initial, qty = '') => `{id: '${key}', name: '${name}', key: '${key}', qty: '${qty}', initial: ${initial}, deducted: 0, burn: 0, purchase: Date.now(), expiry: Date.now() + 5 * 86400000}`;

test('analyze verifies each ingredient against the pantry by name: have, short, missing, staple, approx', () => {
  const run = app();
  run(`state.pantry = [${lot('Tomatoes, roma', 'tomatoes', 6)}, ${lot('Garlic', 'garlic', 1)}, ${lot('Chicken thighs', 'chicken thighs', 3)}];
    globalThis.a = analyze({id: 'x', name: 'Test', servings: 2, ingredients: [
      {name: 'Roma tomatoes', need: 2, amt: '2'},
      {name: 'Garlic cloves', need: 2, amt: '2 cloves'},
      {name: 'Chicken breast', matched_name: '', need: 1, amt: '8 oz'},
      {name: 'Tomato paste', need: 1, amt: '1 tbsp'},
      {name: 'Salt', need: 1, staple: true},
    ]});`);
  assert.equal(run('JSON.stringify(a.ings.map(i => i.status))'), JSON.stringify(['have', 'short', 'have', 'missing', 'staple']));
  assert.equal(run('JSON.stringify(a.ings.map(i => i.key))'), JSON.stringify(['tomatoes', 'garlic', 'chicken thighs', 'tomato paste', 'salt']));
  assert.equal(run('a.ings[2].approx'), true);
  assert.equal(run('a.have.length'), 3);          // two matched with enough, plus the staple
  assert.equal(run('a.short[0].name'), 'Garlic cloves');
  assert.equal(run('a.missing[0].name'), 'Tomato paste');
  assert.equal(run('a.gap'), 2);
  // a pantry change re-verifies at read time: more garlic and it is no longer short
  run(`state.pantry = [...state.pantry, ${lot('Garlic', 'garlic', 5)}];`);
  assert.equal(run('analyze(a.dish).short.length'), 0);
});

test('Curated is everything in the pantry, low or not; Explore is one to three ingredients away', () => {
  const run = app();
  run(`renderAll = () => {};
    state.pantry = [${lot('Eggs', 'eggs', 12)}, ${lot('Tomatoes', 'tomatoes', 6)}];
    liveDishes = [
      {id: 'all', name: 'All in', servings: 2, ingredients: [{name: 'Eggs', need: 2}, {name: 'Tomatoes', need: 2}]},
      {id: 'low', name: 'Low on eggs', servings: 2, ingredients: [{name: 'Eggs', need: 20}, {name: 'Tomatoes', need: 2}]},
      {id: 'one', name: 'One away', servings: 2, ingredients: [{name: 'Eggs', need: 2}, {name: 'Feta', need: 1}]},
      {id: 'far', name: 'Far away', servings: 2, ingredients: [{name: 'Feta', need: 1}, {name: 'Lamb', need: 1}, {name: 'Mint', need: 1}, {name: 'Lemon', need: 1}]},
    ];
    state.tab = 'curated'; buildDeck(); globalThis.curated = state.deck.map(a => a.dish.id).sort();
    state.tab = 'explore'; buildDeck(); globalThis.explore = state.deck.map(a => a.dish.id);`);
  // being low on eggs keeps the dish in Curated (the chip warns); only a missing ingredient moves it to Explore
  assert.equal(run('JSON.stringify(curated)'), JSON.stringify(['all', 'low']));
  assert.equal(run('JSON.stringify(explore)'), JSON.stringify(['one']));
  assert.equal(run('state.tabTotal'), 1);
  // the deck tabs are the only ones the swipe filter follows; the pantry tab keeps the curated deck ready
  run(`state.tab = 'pantry'; buildDeck();`);
  assert.equal(run('JSON.stringify(state.deck.map(a => a.dish.id).sort())'), JSON.stringify(['all', 'low']));
});

test('setTab persists the section and undo brings the last swipe back on top of its deck', () => {
  const run = app();
  run(`renderAll = () => { buildDeck(); };
    globalThis.stored = {};
    globalThis.sessionStorage = { getItem: k => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; } };
    state.pantry = [${lot('Eggs', 'eggs', 12)}, ${lot('Tomatoes', 'tomatoes', 6)}];
    liveDishes = [
      {id: 'a', name: 'A', servings: 2, ingredients: [{name: 'Eggs', need: 2}]},
      {id: 'b', name: 'B', servings: 2, ingredients: [{name: 'Tomatoes', need: 2}]},
    ];
    setTab('curated');`);
  assert.equal(run('stored["mise.tab"]'), 'curated');
  assert.equal(run('state.deck.length'), 2);
  // a skip and a cook, recorded in order (commit() paints the card; the state part is what we replay here)
  run(`state.skipped.add('a'); state.history.push({id: 'a', dir: 'skip', tab: 'curated'});
    state.chosen.add('b'); state.history.push({id: 'b', dir: 'cook', tab: 'curated'});
    buildDeck();`);
  assert.equal(run('state.deck.length'), 0);
  run('undo()');
  assert.equal(run('JSON.stringify([...state.chosen])'), JSON.stringify([]));
  assert.equal(run('state.deck[0].dish.id'), 'b');
  assert.equal(run('state.history.length'), 1);
  run('undo()');
  assert.equal(run('state.skipped.has("a")'), false);
  assert.equal(run('state.deck.length'), 2);
  assert.equal(run('state.history.length'), 0);
  run('undo()');   // nothing left: a no-op
  assert.equal(run('state.deck.length'), 2);
  // switching tabs lands on the other deck, and undo follows the swipe back to the tab it was made on
  run(`setTab('explore'); state.skipped.add('a'); state.history.push({id: 'a', dir: 'skip', tab: 'curated'}); undo();`);
  assert.equal(run('state.tab'), 'curated');
  assert.equal(run('state.deck[0].dish.id'), 'a');
});

test('the made-it sheet lists what they are low on with one-decimal numbers and takes what is there', () => {
  const run = app();
  run(`state.prefs = normalizePrefs({household: {adults: 3, kids: 0}});
    state.pantry = [${lot('Eggs', 'eggs', 10, '10 pcs')}, ${lot('Garlic', 'garlic', 1, '1 head')}];
    const dish = {id: 'd', name: 'Dish', servings: 2, ingredients: [{name: 'Eggs', need: 1}, {name: 'Garlic', need: 1}]};
    liveDishes = [dish];
    state.detailServings = 3;
    openSheet = (kind, html) => { globalThis.html = html; };
    updateDeductSummary = () => {};
    openMadeIt('d');`);
  assert.equal(run('html.includes("1.5 eggs of 10 eggs")'), true);   // eggs: 1 × 3/2 people, in the unit the pantry keeps them in
  assert.equal(run('html.includes("1 head of 1 head")'), true);      // garlic: wants 1.5, has 1 — takes the 1
  assert.equal(run('html.includes("low on this")'), true);
  assert.equal(run('/\\d\\.\\d{2,}/.test(html)'), false);        // never 1.4999999
  run(`document.querySelectorAll = () => [{checked: true, dataset: {key: 'eggs'}}, {checked: true, dataset: {key: 'garlic'}}];
    state.history = [{id: 'd', dir: 'cook', tab: 'curated'}];
    closeSheet = renderAll = logCook = refreshRecipes = () => {};
    globalThis.toasted = null; toast = (...args) => { toasted = args; };
    finishMadeIt('d');`);
  assert.equal(run('state.pantry.find(x => x.key === "eggs").deducted'), 1.5);
  assert.equal(run('state.pantry.find(x => x.key === "garlic").deducted'), 1);
  assert.equal(run('toasted[2].includes("low on garlic")'), true);
  assert.equal(run('state.history.length'), 0);                 // cooked: undo cannot deal it again
});

/* ---------- servings from quantities, shopping list, chat actions, the week (frontend-2) ---------- */
// Every mutation helper ends in renderAll / refreshRecipes / populateFoodOptions; none of those
// belong in a test, and toast is captured so its copy can be asserted.
const quiet = `renderAll = refreshRecipes = populateFoodOptions = () => {}; savePlan = () => {};
  globalThis.toasts = []; toast = (...args) => { toasts.push(args); };`;

test('a new lot reads its servings off the quantity, and only falls back to the package default', () => {
  const run = app();
  run(`state.pantry = [];
    addLot('Eggs', 'eggs', '24 pcs');
    addLot('Jasmine rice', 'jasmine rice', '2 lb');
    addLot('Chili flakes', 'chili flakes', '1 jar');
    addLot('Garlic', 'garlic', '1 head');
    addLot('Milk', 'milk', '1 gal', '', { initial: 3 });`);
  assert.equal(run(`state.pantry.find(x => x.key === 'eggs').initial`), 24);           // F3.1: "24 eggs" is 24, not the 12-pack default
  assert.equal(run(`state.pantry.find(x => x.key === 'jasmine rice').initial`), 15.12); // 2 lb at 60 g a serving
  assert.equal(run(`state.pantry.find(x => x.key === 'chili flakes').initial`), 30);    // a jar says nothing: the catalog default
  assert.equal(run(`state.pantry.find(x => x.key === 'garlic').initial`), 10);          // a head is ten cloves
  assert.equal(run(`state.pantry.find(x => x.key === 'milk').initial`), 3);             // a caller's explicit initial (a review row's) is kept as given
  // the seed pantry and the receipt dry run go through the same rule
  assert.equal(run(`mk('Spaghetti', 'spaghetti', '1 lb', 0).initial`), 5.04);
});

test('a scanned lot is sized by its quantity, not the parser\'s package guess; the guess only stands in for unsizeable quantities', () => {
  const run = app();
  run(`globalThis.milk = lineFromScanItem({ name: 'Milk', quantity: 1, unit: 'gal', price: 3.98, is_food: true, servings: 16, initial_servings: 16 });
    globalThis.basil = lineFromScanItem({ name: 'Basil', quantity: 1, unit: 'bunch', price: 2.49, is_food: true, servings: 5, initial_servings: 5 });
    globalThis.beans = lineFromScanItem({ name: 'Black beans', quantity: 1, unit: 'can', price: 1.29, is_food: true });`);
  assert.equal(run('milk.qty'), '3.8 L');
  assert.equal(run('milk.initial'), 15.83);        // F3.1: 3.8 L at 240 ml a serving, the same yardstick as a hand-added gallon
  assert.equal(run('milk.estimated'), 16);          // the parser's guess is kept on the row, not used
  assert.equal(run('basil.initial'), 5);            // "1 bunch" says nothing: the parser's guess beats the catalog default (3)
  assert.equal(run('beans.initial'), 4);            // no guess either: the package default
});

test('editing a review row re-reads its servings from the corrected quantity before it becomes a lot', () => {
  const run = app();
  run(`${quiet} closeSheet = logReceipt = () => {}; refreshRecipes = async () => []; globalThis.apiConfigured = () => false;
    state.pantry = [];
    review = [
      lineFromScanItem({ name: 'Spaghetti', quantity: 1, unit: 'lb', price: 1.99, is_food: true, servings: 4, initial_servings: 4 }),
      lineFromScanItem({ name: 'Eggs', quantity: 12, unit: 'ct', price: 4.29, is_food: true, servings: 12, initial_servings: 12 }),
      { id: 'sample', name: 'Garlic', key: 'garlic', qty: '1 head', price: 0.89, dropped: false },   // a sample-receipt row carries no servings at all
    ];
    globalThis.before = review[0].initial;
    saveReviewEdit(review[0].id, 'Spaghetti', '2 lb');
    saveReviewEdit(review[1].id, 'Eggs', '24 pcs');
    saveReviewEdit('sample', 'Lemons', '3');`);
  assert.equal(run('before'), 5.06);                                       // the scanned "1 lb" -> "455 g" at 90 g a serving
  assert.equal(run('review[0].qty + ":" + review[0].initial'), '905 g:10.06');   // corrected to 2 lb: about twice as much
  assert.equal(run('review[1].qty + ":" + review[1].initial'), '24 pcs:24');
  assert.equal(run('review[2].name + ":" + review[2].key + ":" + review[2].initial'), 'Lemons:lemons:3');   // a new name is keyed afresh
  assert.equal(run('review.every(l => !l.editing && l.fixed)'), true);
  run('addToPantry();');
  assert.equal(run(`state.pantry.map(x => x.key + ':' + x.qty + ':' + x.initial).join('|')`), 'spaghetti:905 g:10.06|eggs:24 pcs:24|lemons:3 pcs:3');   // a bare "3" is spelt "3 pcs" like every other count
});

test('on boot, untouched package defaults are recomputed from the quantity; checked-in lots are left alone', () => {
  const run = app();
  run(`globalThis.n = recomputeDefaultServings([
    { key: 'eggs', qty: '24 pcs', initial: 12, deducted: 0 },        // default 12 -> 24
    { key: 'eggs', qty: '6', initial: 12, deducted: 2 },             // cooked from: theirs
    { key: 'eggs', qty: '6', initial: 5, deducted: 0 },              // not the default: theirs
    { key: 'chili flakes', qty: '1 jar', initial: 30, deducted: 0 },  // unparseable: stays
    { key: 'parmesan', qty: '8 oz', initial: 8, deducted: 0 },        // default 8 -> 7.56
  ].map(x => (globalThis['lot_' + x.qty.replace(/\\W/g, '')] = x)));`);
  assert.equal(run('n'), 2);
  assert.equal(run('lot_24pcs.initial'), 24);
  assert.equal(run('lot_6.initial'), 5);
  assert.equal(run('lot_1jar.initial'), 30);
  assert.equal(run('lot_8oz.initial'), 7.56);
});

test('what a generated dish takes is read off its amounts; built-in dishes keep their hand-set needs', () => {
  const run = app();
  run(`state.pantry = [${lot('Spaghetti', 'spaghetti', 4, '360 g')}, ${lot('Garlic', 'garlic', 1, '1 head')}];
    globalThis.a = analyze({ id: 'ai-pasta-0', name: 'Pasta', servings: 2, ingredients: [
      { name: 'Spaghetti', amt: '8 oz', servings_used: 1 },
      { name: 'Garlic', amt: '2 cloves', servings_used: 1 },
      { name: 'Parmesan', amt: 'a handful', servings_used: 1 },
      { name: 'Chili flakes', amt: '1 pinch', servings_used: 1, staple: true },
    ]});
    globalThis.b = analyze(DISHES[0]);`);
  assert.equal(run('JSON.stringify(a.ings.map(i => i.need))'), JSON.stringify([2.52, 2, 1, 1]));   // F3.2: 8 oz spaghetti ≈ 2.5 servings
  assert.equal(run('JSON.stringify(a.ings.map(i => i.status))'), JSON.stringify(['have', 'short', 'missing', 'staple']));
  assert.equal(run('b.ings.find(i => i.key === "spaghetti").need'), 2);   // DISHES hand-set 2 for its "8 oz"
  // the made-it sheet shows the same numbers
  run(`liveDishes = [a.dish]; state.detailServings = 2;
    openSheet = (kind, html) => { globalThis.html = html; }; updateDeductSummary = () => {};
    openMadeIt('ai-pasta-0');`);
  assert.equal(run('html.includes("225 g of 360 g")'), true);   // "8 oz" said in the grams the pantry keeps
  assert.equal(run('html.includes("1 head of 1 head")'), true);
});

test('shopping: rows merge by food, the larger like amount wins, unlike amounts go in the note, bought rows become lots', () => {
  const run = app();
  run(`${quiet} state.pantry = []; state.shopping = [];
    globalThis.r1 = addShopping([{ name: 'Lemons', qty: '2 pcs' }], { source: 'manual' });
    globalThis.r2 = addShopping([{ name: 'lemons', qty: '4 pcs' }, { name: 'Roma tomatoes', qty: '6' }], { source: 'chat' });
    globalThis.r3 = addShopping([{ name: 'Tomatoes', qty: '2 pcs' }, { name: 'Garlic', qty: '2 cloves' }], { source: 'manual' });
    addShopping([{ name: 'garlic', qty: '1 head' }]);`);
  assert.equal(run('JSON.stringify([r1.count, r2.count, r2.merged, r3.merged])'), JSON.stringify([1, 2, 1, 1]));
  assert.equal(run('state.shopping.length'), 3);
  assert.equal(run(`state.shopping.find(s => s.key === 'lemons').qty`), '4 pcs');         // the larger of two like amounts
  assert.equal(run(`state.shopping.find(s => s.key === 'tomatoes').qty`), '6');           // "Tomatoes" merged into "Roma tomatoes" (the pantry matcher), 6 > 2
  assert.equal(run(`state.shopping.find(s => s.key === 'garlic').note`), '+ 1 head');     // cloves and a head do not compare: kept side by side
  assert.equal(run(`state.shopping.find(s => s.key === 'lemons').source`), 'manual');    // the first row keeps its source
  // a bought row stacks a second time instead of merging
  run(`toggleShopping(state.shopping.find(s => s.key === 'lemons').id); addShopping([{ name: 'Lemons', qty: '1 pcs' }]);`);
  assert.equal(run(`state.shopping.filter(s => s.key === 'lemons').length`), 2);
  // "Add bought to pantry": the checked lemons become a lot whose servings come from its quantity
  run(`globalThis.moved = moveBoughtToPantry();`);
  assert.equal(run('moved'), 1);
  assert.equal(run(`state.pantry.length`), 1);
  assert.equal(run(`state.pantry[0].key + ':' + state.pantry[0].qty + ':' + state.pantry[0].initial`), 'lemons:4 pcs:4');
  assert.equal(run(`state.shopping.filter(s => s.key === 'lemons').length`), 1);
  assert.equal(run('clearBought()'), 0);
  // the API view carries canonical amounts
  assert.equal(run(`JSON.stringify(shoppingForApi().find(s => s.name === 'Garlic'))`), JSON.stringify({ name: 'Garlic', quantity: 2, unit: 'pcs', done: false }));
  // "take milk off the list" removes the milk still to buy, not the one already bought (the backend picks the same row)
  run(`state.shopping = [
    { id: 'a', name: 'Milk', key: 'milk', qty: '', note: '', done: true, source: 'manual' },
    { id: 'b', name: 'Milk', key: 'milk', qty: '', note: '', done: false, source: 'manual' },
  ];
  globalThis.removed = removeShoppingByNames(['Milk']);`);
  assert.equal(run('removed'), 1);
  assert.equal(run(`state.shopping.map(s => s.id + ':' + (s.done ? 'bought' : 'open')).join()`), 'a:bought');
  assert.equal(run(`removeShoppingByNames(['milk'])`), 1);   // the normalised spelling still finds the bought one once it is the only one
  assert.equal(run('state.shopping.length'), 0);
});

test('a recipe adds what it is missing or low on, scaled to the people it is cooked for, and the detail says so', () => {
  const run = app();
  run(`${quiet} state.shopping = [];
    state.prefs = normalizePrefs({ household: { adults: 3, kids: 0 } });
    state.pantry = [${lot('Cucumber', 'cucumber', 1)}, ${lot('Tomatoes', 'tomatoes', 6)}, ${lot('Red onion', 'red onion', 1)}, ${lot('Olives', 'olives', 1)}, ${lot('Olive oil', 'olive oil', 40)}, ${lot('Feta', 'feta', 1)}];
    globalThis.r = addDishToShopping(DISHES.find(d => d.id === 'salad'));`);   // Greek salad: feta needs 2 (have 1), everything else there
  assert.equal(run('JSON.stringify(r.names)'), JSON.stringify(['Feta']));
  assert.equal(run(`state.shopping[0].qty`), '170 g');   // "4 oz" x 3/2 people, in metric
  assert.equal(run(`state.shopping[0].source + '|' + state.shopping[0].dishName`), 'recipe|Greek salad');
  run(`openSheet = (kind, html) => { globalThis.html = html; }; state.sheet = null; openDetail(DISHES.find(d => d.id === 'salad'));`);
  assert.equal(run('html.includes("On your shopping list")'), true);   // already listed: no second offer
  run(`state.shopping = []; openDetail(DISHES.find(d => d.id === 'salad'));`);
  assert.equal(run('html.includes("Add 1 to shopping list")'), true);
  assert.equal(run('html.includes("data-shop-add=\\"salad\\"")'), true);
});

test('assistant actions add to the pantry (servings from the quantity), add to the list and take things off it', async () => {
  const run = app({ chat: true });
  run(`${quiet} state.prefs = normalizePrefs({}); state.cooked = new Set(); state.pantry = []; state.shopping = [];
    globalThis.messages = []; addChat = (who, html) => { messages.push(html); return { remove() {} }; };
    globalThis.apiConfigured = () => true;
    globalThis.chatApi = async (history, ctx) => { globalThis.sent = ctx; return { reply: 'Done.', actions: [
      { type: 'add_pantry_items', items: [{ name: 'chicken thighs', quantity: 907.2, unit: 'g', expires_in_days: 3 }, { name: 'eggs', quantity: 12, unit: 'pcs', expires_in_days: null }, { name: 'basil', quantity: null, unit: '', expires_in_days: null }] },
      { type: 'add_shopping_items', items: [{ name: 'lemons', quantity: 4, unit: 'pcs', note: '' }, { name: 'olive oil', quantity: 1, unit: 'l', note: 'the good one' }] },
      { type: 'remove_shopping_items', names: ['Lemons'] },
    ] }; };`);
  await run(`handleChat('I bought 2 lb of chicken thighs and a dozen eggs; put lemons and a litre of olive oil on the list, actually skip the lemons')`);
  assert.equal(run(`JSON.stringify(sent.shopping)`), '[]');   // the list goes up with every turn
  // 2 lb -> "905 g" -> 6.03 servings of chicken; a dozen -> 12; no amount for basil -> its catalog default (3)
  assert.equal(run(`state.pantry.map(x => x.key + ':' + x.qty + ':' + x.initial).join('|')`), 'chicken thighs:905 g:6.03|eggs:12 pcs:12|basil::3');
  assert.equal(run(`Math.round((state.pantry[0].expiry - Date.now()) / 86400000)`), 3);
  assert.equal(run(`JSON.stringify(state.shopping.map(s => [s.name, s.qty, s.note, s.source]))`), JSON.stringify([['Olive oil', '1 L', 'the good one', 'chat']]));
  assert.equal(run(`toasts.some(t => t[0] === '3 items added to your pantry')`), true);
  assert.equal(run(`messages.at(-1).includes('Done.')`), true);
});

test('offline, the three plain commands are handled locally', async () => {
  const run = app({ chat: true });
  run(`${quiet} state.prefs = normalizePrefs({}); state.cooked = new Set(); state.pantry = []; state.shopping = [];
    globalThis.messages = []; addChat = (who, html) => { messages.push(html); return { remove() {} }; };
    globalThis.apiConfigured = () => false;`);
  await run(`handleChat('add 12 eggs and 2 lb of chicken thighs to my pantry')`);
  assert.equal(run(`state.pantry.map(x => x.key + ':' + x.qty + ':' + x.initial).join('|')`), 'eggs:12 pcs:12|chicken thighs:905 g:6.03');
  assert.equal(run(`messages.at(-1).includes('Added')`), true);
  await run(`handleChat('put lemons on my shopping list')`);
  assert.equal(run(`state.shopping.map(s => s.name).join()`), 'Lemons');
  await run(`handleChat('Remove lemons from the list.')`);
  assert.equal(run(`state.shopping.length`), 0);
  assert.equal(run(`messages.at(-1).includes('Took')`), true);
  await run(`handleChat('what can I make?')`);   // anything else still goes to the recipe helper
  assert.equal(run(`messages.at(-1).includes('using available recipes')`), true);
});

test('the week: each meal becomes an openable plan- dish, ids survive a re-adopt, and the empty-pantry 400 deals a local week', async () => {
  const run = app();
  run(`${quiet} state.prefs = normalizePrefs({}); state.pantry = [${lot('Eggs', 'eggs', 12)}, ${lot('Tomatoes', 'tomatoes', 6)}];
    const meal = (title, minutes) => ({ title, description: '', cook_minutes: minutes, servings: 2, difficulty: 'easy',
      ingredients: [{ name: 'Eggs', amount: '2', matched_name: 'Eggs', servings_used: 2, staple: false, have: true }, { name: 'Feta', amount: '2 oz', matched_name: '', servings_used: 1, staple: false, have: false }],
      uses_expiring: [], missing_count: 1, coverage: 0.5, urgency_days: 5, steps: [] });
    globalThis.week = { start: '2026-09-21', days: [
      { date: '2026-09-21', meals: { breakfast: meal('Eggs on toast', 10), lunch: null, dinner: meal('Tomato omelette', 20) } },
      { date: '2026-09-22', meals: { breakfast: meal('Eggs on toast', 10), lunch: meal('Greek eggs', 15), dinner: null } },
    ] };
    adoptPlan(week, { source: 'api', signature: 'sig' });`);
  assert.equal(run('planDishes.size'), 4);
  assert.equal(run(`[...planDishes.keys()].every(id => id.startsWith('plan-'))`), true);
  assert.equal(run(`plan.days[0].meals.lunch`), null);
  const first = run(`plan.days[0].meals.breakfast.id`);
  assert.equal(run(`dishById(plan.days[0].meals.breakfast.id).name`), 'Eggs on toast');
  assert.equal(run(`dishById(plan.days[0].meals.dinner.id).time`), '20 min');
  assert.equal(run(`dishById(plan.days[0].meals.dinner.id).ingredients[0].matched_name`), 'Eggs');
  assert.equal(run(`analyze(dishById(plan.days[0].meals.dinner.id)).missing[0].name`), 'Feta');
  // the cached plan comes back with the same ids, so a meal on Tonight still resolves
  run(`adoptPlan(JSON.parse(JSON.stringify(plan)), { source: plan.source, signature: plan.signature, at: plan.at });`);
  assert.equal(run(`plan.days[0].meals.breakfast.id`), first);
  assert.equal(run(`dishById('${first}').name`), 'Eggs on toast');
  // every cell's needs onto the list, deduplicated: feta once
  run('state.shopping = []; globalThis.r = addPlanToShopping();');
  assert.equal(run(`state.shopping.map(s => s.name + ':' + s.source).join()`), 'Feta:plan');
  // the backend's empty-pantry 400 is not a dead end: the week is dealt from the dishes on hand
  run(`globalThis.apiConfigured = () => true; globalThis.fetchMealPlan = async () => { throw new Error('The pantry is empty: add some food before planning the week.'); };`);
  await run(`ensurePlan({ force: true })`);
  assert.equal(run('plan.source'), 'local');
  assert.equal(run('plan.days.length'), 7);
  assert.equal(run(`plan.days.every(d => ['breakfast', 'lunch', 'dinner'].every(s => d.meals[s] && dishById(d.meals[s].ref)))`), true);
  assert.equal(run('planError'), '');
  // any other failure keeps the last week on screen and offers a retry
  run(`globalThis.fetchMealPlan = async () => { throw new Error('Meal plan generation failed: boom'); };`);
  await run(`ensurePlan({ force: true })`);
  assert.equal(run('plan.source'), 'local');
  assert.equal(run(`planError.includes('boom')`), true);
  assert.equal(run(`planSheetHTML().includes('data-plan-retry')`), true);
  // a good answer replaces it
  run(`globalThis.fetchMealPlan = async (items, opts) => { globalThis.asked = opts; return week; };`);
  await run(`ensurePlan({ force: true })`);
  assert.equal(run('plan.source'), 'api');
  assert.equal(run('asked.days'), 7);
  assert.equal(run(`planSheetHTML().includes('data-plan-open="' + plan.days[0].meals.breakfast.id + '"')`), true);
  assert.equal(run(`planSheetHTML().includes('Add the week’s missing ingredients to the shopping list')`), true);
});

test('a plan meal put on Tonight survives the week being regenerated, and a reload of the regenerated week', () => {
  const run = app();
  run(`${quiet} closeSheet = () => {}; state.prefs = normalizePrefs({}); state.chosen = new Set(); state.pantry = [${lot('Eggs', 'eggs', 12)}];
    const meal = title => ({ title, cook_minutes: 10, servings: 2, difficulty: 'easy', ingredients: [{ name: 'Eggs', amount: '2', matched_name: 'Eggs', servings_used: 2 }], steps: [] });
    adoptPlan({ start: '2026-09-21', days: [{ date: '2026-09-21', meals: { breakfast: meal('Eggs on toast'), lunch: null, dinner: meal('Tomato omelette') } }] }, { source: 'api', signature: 'sig' });
    globalThis.picked = plan.days[0].meals.dinner.id;
    cookTonight(picked);`);
  assert.equal(run('state.chosen.has(picked)'), true);
  assert.equal(run('chosenDishes().map(d => d.name).join()'), 'Tomato omelette');
  // Regenerate: a whole new week, none of the old ids in it
  run(`adoptPlan({ start: '2026-09-21', days: [{ date: '2026-09-21', meals: { breakfast: meal('Porridge'), lunch: null, dinner: meal('Frittata') } }] }, { source: 'api', signature: 'sig2' });`);
  assert.equal(run('chosenDishes().map(d => d.name).join()'), 'Tomato omelette');   // still on Tonight, still opens
  assert.equal(run('dishById(picked).name'), 'Tomato omelette');
  assert.equal(run('plan.parked.map(d => d.id).join()'), run('picked'));                 // and saved with the week for the next visit
  assert.equal(run('planDishes.size'), 3);                                             // the two new meals plus the parked one
  // A reload adopts the cached (regenerated) week: the parked dish comes back with it
  run(`planDishes.clear(); adoptPlan(JSON.parse(JSON.stringify(plan)), { source: plan.source, signature: plan.signature, at: plan.at });`);
  assert.equal(run('chosenDishes().map(d => d.name).join()'), 'Tomato omelette');
  // Once it is cooked it is no longer chosen, and the next week lets it go
  run(`state.chosen.delete(picked); adoptPlan(JSON.parse(JSON.stringify(plan)), { source: plan.source, signature: plan.signature, at: plan.at });`);
  assert.equal(run('plan.parked.length'), 0);
  assert.equal(run('dishById(picked)'), null);
});

test('every ingredient carries a "+" that puts it on the shopping list', () => {
  const run = app();
  run(`renderAll = toast = () => {};
    state.pantry = [${lot('Eggs', 'eggs', 12)}];
    state.shopping = [];
    const dish = {id: 'd', name: 'Omelette', servings: 2, ingredients: [{name: 'Eggs', need: 2, amt: '2'}, {name: 'Feta', need: 1, amt: '2 oz'}]};
    liveDishes = [dish];
    const a = analyze(dish);
    globalThis.chips = a.ings.map(i => chipHTML(i, dish)).join('');
    globalThis.row = listBtnHTML(a.ings[1], dish, {qty: '2 oz'});`);
  // chips are buttons with the list attributes, for have and missing alike
  assert.equal(run('(chips.match(/<button class="chip/g) || []).length'), 2);
  assert.equal(run('chips.includes(\'data-list-add="Feta"\')'), true);
  assert.equal(run('chips.includes(\'data-list-add="Eggs"\')'), true);
  assert.equal(run('row.includes(\'aria-label="Add Feta to your shopping list"\')'), true);
  // pressing it adds the row once and flips the button to its listed state
  run(`const btn = {disabled: false, dataset: {listAdd: 'Feta', listKey: 'feta', listQty: '2 oz', listDish: 'd', listDishName: 'Omelette', listSource: 'recipe'},
      classList: {add(c) { this.added = c; }}, setAttribute() {}, querySelector: () => null, innerHTML: ''};
    globalThis.first = listAddFromEl(btn); globalThis.second = listAddFromEl(btn); globalThis.btn = btn;`);
  assert.equal(run('first'), true);
  assert.equal(run('second'), false);                      // disabled once listed
  assert.equal(run('btn.classList.added'), 'listed');
  assert.equal(run('state.shopping.length'), 1);
  assert.equal(run('state.shopping[0].name + \' \' + state.shopping[0].qty + \' \' + state.shopping[0].dishName'), 'Feta 2 oz Omelette');
  // rendered again, the chip shows the listed state instead of a plus
  assert.equal(run('chipHTML(analyze(liveDishes[0]).ings[1], liveDishes[0]).includes(\'class="chip missing listed"\')'), true);
});

test('pantry keys stack only the same food: brand groups split, look-alikes stay apart', () => {
  const run = app();
  // two frozen dinners that a scan grouped under one brand key
  run(`state.pantry = [${lot('Lean Cuisine Beef', 'lean cuisine', 1)}, ${lot('Lean Cuisine Thai Peanut Chicken', 'lean cuisine', 3)}];
    globalThis.n = rekeyLots(state.pantry);`);
  assert.equal(run('n'), 2);
  assert.notEqual(run('state.pantry[0].key'), run('state.pantry[1].key'));
  assert.equal(run('keyForName("Lean Cuisine Beef")'), 'lean cuisine beef');
  // catalog foods still stack under their food, variants included
  assert.equal(run('keyForName("Roma tomatoes")'), 'tomatoes');
  assert.equal(run('keyForName("Tomatoes, roma")'), 'tomatoes');
  assert.equal(run('keyForName("Garlic cloves")'), 'garlic');
  // look-alikes are not the catalog food
  assert.equal(run('keyForName("Coconut milk")'), 'coconut milk');
  assert.equal(run('keyForName("Chicken breast")'), 'chicken breast');
  assert.equal(run('keyForName("Onion powder")'), 'onion powder');
  // a scan's group_key only wins when it is a real food
  assert.equal(run('keyForScan({name: "Lean Cuisine Beef", group_key: "lean cuisine"})'), 'lean cuisine beef');
  assert.equal(run('keyForScan({name: "ORG SPINACH 5OZ", group_key: "spinach"})'), 'spinach');
  // a catalog-keyed lot is left alone by the boot pass
  run(`state.pantry = [${lot('2% Milk', 'milk', 8)}]; globalThis.n2 = rekeyLots(state.pantry);`);
  assert.equal(run('n2'), 0);
});

/* ---------- one unit per food: the pantry's own ---------- */
// The pantry decides how a food is measured. Whatever arrives after the first lot is
// converted into that unit — a receipt's weight becomes a count when that is how the
// shelf already reads — and recipes quote the same unit back.

test('a new account starts with an empty pantry', () => {
  const run = app();
  assert.equal(run('typeof seedPantry'), 'undefined');
  assert.equal(run('state.pantry.length'), 0);
});

test('a second lot of a food is converted into the unit the pantry already uses, and still stacks separately', () => {
  const run = app();
  run(`${quiet} state.pantry = [];
    addLot('Bananas', 'bananas', '8 pcs');
    addLot('Bananas', 'bananas', '4 kg');`);
  assert.equal(run(`state.pantry[0].qty`), '8 pcs');            // the first lot sets the unit, untouched
  assert.equal(run(`state.pantry[1].qty`), '34 bananas');       // 4 kg at about 118 g a banana
  assert.equal(run(`state.pantry[1].initial`), 34);             // servings follow the converted quantity
  assert.equal(run(`state.pantry.length`), 2);                  // separate use-by dates: never merged
  assert.equal(run(`JSON.stringify(pantryUnitOf('bananas'))`), JSON.stringify({ unit: 'pcs', label: 'bananas', perServing: 1 }));
  assert.equal(run(`stackAmountText(state.pantry)`), '42 bananas');
  assert.equal(run(`lotAmountText(state.pantry[0])`), '8 bananas');
  // a food the pantry has never held keeps whatever unit it came in
  run(`addLot('Jasmine rice', 'jasmine rice', '2 lb')`);
  assert.equal(run(`state.pantry[2].qty`), '2 lb');
});

test('a receipt line lands in the unit the pantry already keeps that food in', () => {
  const run = app();
  run(`${quiet} state.pantry = []; addLot('Bananas', 'bananas', '8 pcs');
    globalThis.line = lineFromScanItem({ name: 'Bananas', quantity: 4, unit: 'kg', price: 6.5, is_food: true });`);
  assert.equal(run('line.qty'), '34 bananas');
  assert.equal(run('line.initial'), 34);
  // two lines of a food new to the pantry agree with each other: the first one sets the unit
  run(`state.pantry = []; globalThis.rows = [];
    for (const it of [{ name: 'Apples', quantity: 6, unit: 'ct', price: 4 }, { name: 'Apples', quantity: 1, unit: 'kg', price: 3 }]) {
      rows.push(lineFromScanItem({ ...it, is_food: true }, rows));
    }`);
  assert.equal(run('rows[0].qty'), '6 pcs');
  assert.equal(run('rows[1].qty'), '5.5 apples');   // 1 kg at about 182 g an apple
});

test('recipes quote amounts in the pantry\'s unit, and cooking takes them in the same unit', () => {
  const run = app();
  // a pantry kept by the piece never hears about grams
  run(`state.pantry = [${lot('Bananas', 'bananas', 12, '12 pcs')}];
    globalThis.a = analyze({ id: 'x', name: 'Smoothie', servings: 2, ingredients: [{ name: 'Bananas', amt: '240 g' }] });`);
  assert.equal(run('takeFor(a.ings[0], 1).text'), '2 bananas');
  // a pantry kept by weight hears grams, whatever the recipe wrote
  run(`state.pantry = [${lot('Spaghetti', 'spaghetti', 4, '360 g')}];
    globalThis.b = analyze({ id: 'y', name: 'Pasta', servings: 2, ingredients: [{ name: 'Spaghetti', amt: '8 oz' }] });`);
  assert.equal(run('takeFor(b.ings[0], 1).text'), '225 g');
  assert.equal(run('takeFor(b.ings[0], 1).servings'), 2.52);   // 226.8 g at the lot's 90 g a serving
});

test('counts read at the nearest half, and what is left after cooking reads the same way', () => {
  const run = app();
  run(`${quiet} state.pantry = [${lot('Bananas', 'bananas', 5, '5 pcs')}];
    globalThis.a = analyze({ id: 'x', name: 'Banana bread', servings: 2, ingredients: [{ name: 'Bananas', amt: '1.7' }] });
    deductServings('bananas', takeFor(a.ings[0], 1).servings);`);
  assert.equal(run('state.pantry[0].deducted'), 1.7);             // the real amount leaves the pantry
  assert.equal(run('Math.round(current(state.pantry[0]) * 10) / 10'), 3.3);
  assert.equal(run('lotAmountText(state.pantry[0])'), '3.5 bananas');   // and reads at the nearest half
  assert.equal(run('servingsText("bananas", 4.2)'), '4 bananas');
  assert.equal(run('servingsText("bananas", 4.3)'), '4.5 bananas');
  assert.equal(run('servingsText("bananas", 0.1)'), '0.5 bananas');     // some left never rounds away to none
});

/* ---------- wave 2: cross-verify (K), timers, ratings, the report, swaps, the cooked log (J7) ---------- */

test('K: the chips, the missing line, the tab and the "Add N" count all come from one analyze() against the pantry as it is now', () => {
  const run = app();
  run(`renderAll = () => {}; state.shopping = [];
    state.pantry = [${lot('Milk (1 gal)', 'milk', 8)}, ${lot('Spaghetti', 'spaghetti', 4)}, ${lot('Egg noodles', 'egg noodles', 4)}, ${lot('Chicken thighs', 'chicken thighs', 3)}, ${lot('Roma tomatoes', 'tomatoes', 6)}, ${lot('Garlic', 'garlic', 10)}];
    const dish = { id: 'ai-test-0', name: 'Test bowl', servings: 2, ingredients: [
      { name: 'Coconut milk', amt: '1 can' }, { name: 'Penne', amt: '8 oz' }, { name: 'Fresh noodles', amt: '200 g' }, { name: 'Chicken breast', amt: '8 oz' },
      { name: 'Tomato paste', amt: '1 tbsp' }, { name: 'Garlic', amt: '2 cloves' }, { name: 'Cherry tomatoes', amt: '1 cup' }, { name: 'Garlic powder', amt: '1 tsp' },
    ] };
    liveDishes = [dish];
    globalThis.a = analyze(dish);
    globalThis.card = cardHTML(a);`);
  assert.equal(run('JSON.stringify(a.ings.map(i => i.status))'), JSON.stringify(['missing', 'have', 'have', 'have', 'missing', 'have', 'have', 'missing']));
  assert.equal(run('a.ings[1].approx && a.ings[3].approx'), true);   // penne via the pasta family, breast via the chicken family
  assert.equal(run('a.ings[2].key'), 'egg noodles');                  // "fresh noodles" is their egg noodles
  assert.equal(run('a.ings[5].need'), 2);                             // 2 cloves of garlic
  // exactly three dashed chips, and the line names the same three
  assert.equal(run('(card.match(/class="chip missing/g) || []).length'), 3);
  assert.equal(run('/missing 3: coconut milk, tomato paste, garlic powder/.test(card)'), true);
  // the tab placement and the shopping "Add N" count read the same analysis
  run(`state.tab = 'explore'; buildDeck(); globalThis.explore = state.deck.map(x => x.dish.id);
    state.tab = 'curated'; buildDeck(); globalThis.curated = state.deck.map(x => x.dish.id);
    globalThis.needed = neededForDish(dish).map(i => i.name);`);
  assert.equal(run('JSON.stringify(explore)'), JSON.stringify(['ai-test-0']));
  assert.equal(run('JSON.stringify(curated)'), '[]');
  assert.equal(run('JSON.stringify(needed)'), JSON.stringify(['Coconut milk', 'Tomato paste', 'Garlic powder']));
  // the pantry changes: coconut milk arrives, and the same dish re-verifies at read time
  run(`addLot('Coconut milk', keyForName('Coconut milk'), '400 ml'); globalThis.b = analyze(dish); globalThis.card2 = cardHTML(b);`);
  assert.equal(run('b.ings[0].status'), 'have');
  assert.equal(run('b.missing.map(i => i.name).join()'), 'Tomato paste,Garlic powder');
  assert.equal(run('(card2.match(/class="chip missing/g) || []).length'), 2);
  assert.equal(run('neededForDish(dish).length'), 2);
});

test('cook mode reads the timers out of a real step', () => {
  const run = app();
  run(`globalThis.d = findDurations(DISHES.find(x => x.id === 'shakshuka').steps[2]);`);   // "…simmer until thick, 10 to 12 minutes."
  assert.equal(run('d.length'), 1);
  assert.equal(run('d[0].seconds'), 720);
  assert.equal(run('d[0].label'), '12 min');
  assert.equal(run(`highlightDurations(esc('Simmer 10 to 12 minutes.'), findDurations(esc('Simmer 10 to 12 minutes.')), d => '<b>' + d.label + '</b>')`), 'Simmer <b>12 min</b>.');
  assert.equal(run(`findDurations('Heat the oven to 350°F.').length`), 0);
});

test('a rating after cooking feeds prefs.liked / disliked, sorts alike dishes up and keeps a rated-down dish off the deck', () => {
  const run = app({ chat: true });
  run(`${quiet} savePrefs = saveRatings = saveCooked = () => {};
    state.pantry = [${lot('Eggs', 'eggs', 12)}];
    state.prefs = normalizePrefs({}); state.ratings = {}; state.cookedLog = []; state.cooked = new Set();
    liveDishes = [
      { id: 'a', name: 'Eggs on toast', servings: 2, ingredients: [{ name: 'Eggs', need: 2 }] },
      { id: 'b', name: 'Cheesy eggs', servings: 2, ingredients: [{ name: 'Eggs', need: 2 }] },
    ];
    globalThis.e = rememberCooked(liveDishes[0]);
    globalThis.changed = applyRating(e.id, 1);`);
  assert.equal(run('changed'), true);
  assert.equal(run('JSON.stringify(state.prefs.liked)'), JSON.stringify(['Eggs on toast']));
  assert.equal(run('state.cookedLog[0].rating'), 1);
  assert.equal(run('prefFit(liveDishes[0])'), 2);
  assert.equal(run('prefFit(liveDishes[1])'), 2);   // every one of its ingredients is in a dish they rated up
  run(`globalThis.e2 = rememberCooked(liveDishes[1]); applyRating(e2.id, -1); state.tab = 'curated'; buildDeck();`);
  assert.equal(run('JSON.stringify(state.prefs.disliked)'), JSON.stringify(['Cheesy eggs']));
  assert.equal(run('JSON.stringify(state.deck.map(x => x.dish.id))'), JSON.stringify(['a']));
  // the same thumb again clears it
  run('applyRating(e2.id, -1); buildDeck();');
  assert.equal(run('state.prefs.disliked.length'), 0);
  assert.equal(run('state.deck.length'), 2);
  // the assistant's update_preference carries the complete list, and the ratings follow it
  run(`applyChatActions([{ type: 'update_preference', field: 'disliked', value: ['Eggs on toast'] }]); buildDeck();`);
  assert.equal(run('JSON.stringify(state.prefs.disliked)'), JSON.stringify(['Eggs on toast']));
  assert.equal(run('JSON.stringify(state.prefs.liked)'), '[]');
  assert.equal(run('JSON.stringify(state.deck.map(x => x.dish.id))'), JSON.stringify(['b']));
  // the deck signature carries the ratings, so the deck regenerates for them
  assert.equal(run(`deckSignature().includes('Eggs on toast')`), true);
});

test('"I made this" writes the cook events the report sums, then asks for a rating; a lot found expired counts as waste once', () => {
  const run = app();
  run(`${quiet} closeSheet = logCook = () => {}; saveCooked = saveRatings = savePrefs = () => {};
    openSheet = (kind, html) => { state.sheet = kind; globalThis.html = html; };
    state.prefs = normalizePrefs({ household: { adults: 2, kids: 0 } });
    state.events = []; state.cookedLog = []; state.ratings = {}; state.shopping = [];
    state.pantry = [${lot('Eggs', 'eggs', 12)}, ${lot('Tomatoes', 'tomatoes', 6)}];
    state.pantry[0].price = 4.80;   // a receipt price: 40¢ an egg
    const dish = { id: 'd', name: 'Shakshuka', servings: 2, ingredients: [{ name: 'Eggs', need: 4 }, { name: 'Tomatoes', need: 4 }] };
    liveDishes = [dish]; state.detailServings = 2;
    document.querySelectorAll = () => [{ checked: true, dataset: { key: 'eggs' } }, { checked: true, dataset: { key: 'tomatoes' } }];
    finishMadeIt('d');`);
  assert.equal(run(`state.events.filter(e => e.type === 'cook' && e.key).length`), 2);
  assert.equal(run(`state.events.filter(e => e.type === 'cook' && !e.key).length`), 1);   // the meal itself
  assert.equal(run(`state.events.find(e => e.key === 'eggs').value`), 1.6);               // 4 eggs at the receipt's 40¢
  assert.equal(run(`state.events.find(e => e.key === 'eggs').beforeExpiry`), true);
  assert.equal(run('state.sheet'), 'rate');
  assert.equal(run('html.includes("How was Shakshuka?")'), true);
  assert.equal(run('state.cookedLog[0].title'), 'Shakshuka');
  run(`globalThis.r = summarize({ events: state.events, lots: state.pantry, now: Date.now(), days: 7, costFor });`);
  assert.equal(run('r.used.items'), 2);
  assert.equal(run('r.cooked.meals'), 1);
  assert.equal(run('r.savedValue'), 3.6);   // 1.60 for the eggs + 4 tomatoes at the typical 50¢
  assert.equal(run('r.streakDays >= 1'), true);
  // a lot past its date with something left is logged as expired once, not on every boot
  run(`state.pantry.push({ id: 'old', name: 'Spinach', key: 'spinach', initial: 4, deducted: 0, burn: 0, purchase: Date.now() - 9 * 86400000, expiry: Date.now() - 2 * 86400000 });
    globalThis.n1 = sweepExpired(); globalThis.n2 = sweepExpired();
    globalThis.r2 = summarize({ events: state.events, lots: state.pantry, now: Date.now(), days: 7, costFor });`);
  assert.equal(run('n1 + ":" + n2'), '1:0');
  assert.equal(run('r2.wasted.items'), 1);
  assert.equal(run('r2.wasted.value'), 2.8);   // 4 servings of spinach at 70¢
  assert.equal(run('r2.streakDays'), 0);       // something expired today: no streak
  assert.equal(run('reportHTML().includes("used before expiry") && reportHTML().includes("Use these next")'), true);
  assert.equal(run('reportStripHTML().includes("This week")'), true);
});

test('"Use this" on a swap makes the ingredient had (approximately), deducts the swap\'s foods and leaves it off the list', () => {
  const run = app();
  run(`${quiet} state.shopping = []; state.saved = [];
    state.pantry = [${lot('Milk', 'milk', 8)}, ${lot('Butter', 'butter', 10)}, ${lot('Arborio rice', 'arborio rice', 6)}];
    const dish = { id: 'ai-risotto-0', name: 'Creamy risotto', servings: 2, ingredients: [{ name: 'Arborio rice', amt: '1 cup' }, { name: 'Heavy cream', amt: '½ cup' }, { name: 'Parmesan', amt: '1 oz' }] };
    liveDishes = [dish];
    globalThis.before = analyze(dish);
    globalThis.subs = localSubstitutions('Heavy cream', state.pantry);
    useSubstitution(dish, 'Heavy cream', subs[0]);
    globalThis.after = analyze(dish);`);
  assert.equal(run('before.missing.map(i => i.name).join()'), 'Heavy cream,Parmesan');
  assert.equal(run('subs[0].use + ":" + subs[0].from_pantry'), 'milk + butter:true');
  assert.equal(run('after.missing.map(i => i.name).join()'), 'Parmesan');
  assert.equal(run('after.ings[1].status + ":" + after.ings[1].approx + ":" + after.ings[1].sub.use'), 'have:true:milk + butter');
  assert.equal(run('chipHTML(after.ings[1], after.dish).includes("Using milk + butter")'), true);
  assert.equal(run('neededForDish(after.dish).map(i => i.name).join()'), 'Parmesan');   // "Add N" no longer counts the swapped one
  // the made-it sheet lists milk and butter instead of the cream
  run(`state.detailServings = 2; openSheet = (kind, html) => { globalThis.html = html; }; updateDeductSummary = () => {}; openMadeIt('ai-risotto-0');`);
  assert.equal(run('html.includes("Milk") && html.includes("Butter")'), true);
  assert.equal(run('html.includes("Instead of heavy cream")'), true);
  // saved dishes keep their swaps; undoing one puts the ingredient back on the list
  assert.equal(run('normalizeDish(dish).subs["heavy cream"].use'), 'milk + butter');
  run(`dropSubstitution(dish, 'Heavy cream');`);
  assert.equal(run('analyze(dish).missing.length'), 2);
});

test('the cooked log keeps the newest 100 entries, and "Cook again" puts a snapshot on Tonight', () => {
  const run = app();
  run(`${quiet} saveCooked = () => {}; closeSheet = () => {}; state.cookedLog = []; state.ratings = {}; state.chosen = new Set(); liveDishes = [];
    for (let i = 0; i < 105; i++) rememberCooked({ id: 'd' + i, name: 'Dish ' + i, servings: 2, ingredients: [{ name: 'Eggs', need: 1 }], steps: ['Cook.'] });`);
  assert.equal(run('state.cookedLog.length'), 100);
  assert.equal(run('state.cookedLog[0].title'), 'Dish 104');
  assert.equal(run('state.cookedLog.at(-1).title'), 'Dish 5');
  run('cookAgain(state.cookedLog[0].id);');
  assert.equal(run('chosenDishes().map(d => d.name).join()'), 'Dish 104');
  run(`state.savedTab = 'cooked';`);
  assert.equal(run('savedSheetHTML().includes("Cook again")'), true);
  assert.equal(run('savedSheetHTML().includes("data-rate-toggle")'), true);
});

test('the sample receipt is gone: processing needs a real file and the review starts with no store', async () => {
  const run = app();
  run(`globalThis.opened = null; openSheet = kind => { opened = kind; }; toast = () => {};`);
  await run('startProcessing(null)');
  assert.equal(run('opened'), null);
  assert.equal(run('typeof SAMPLE_RECEIPT'), 'undefined');
  assert.equal(run('lastReceipt.store + "|" + lastReceipt.total'), '|0');
});

test('nothing expires on the day it is added: every new lot lives until at least tomorrow', () => {
  const run = app();
  run(`state.pantry = [];
    const now = Date.now();
    addLot('Milk', 'milk', '1 L', '', { expiry: now });                 // "expires today" from a receipt
    addLot('Bread', 'bread', '1 pack', '', { expiry: now - 3 * DAY });  // already past its date
    addLot('Rice', 'jasmine rice', '1 kg', '', { expiry: now + 5 * DAY });
    addLot('Eggs', 'eggs', '12 pcs');                                   // catalog shelf life
    globalThis.now = now;`);
  assert.equal(run('state.pantry[0].expiry >= now + DAY'), true);
  assert.equal(run('state.pantry[1].expiry >= now + DAY'), true);
  assert.equal(run('state.pantry[2].expiry'), run('now + 5 * DAY'));    // a real date is left alone
  assert.equal(run('state.pantry[3].expiry >= now + DAY'), true);
});

test('a scanned package counted as "1" is a package, and everything is 100% at the scan', () => {
  const run = app();
  run(`state.pantry = [];
    const fiveDaysAgo = new Date(Date.now() - 5 * DAY).toISOString().slice(0, 10);
    globalThis.cereal = lineFromScanItem({ name: 'Natures Path Cereal', quantity: 1, unit: 'count', servings: 10, purchase_date: fiveDaysAgo, is_food: true });
    globalThis.eggs = lineFromScanItem({ name: 'Sparks Eggs', quantity: 1, unit: '', servings: 12, purchase_date: fiveDaysAgo, is_food: true });
    globalThis.chicken = lineFromScanItem({ name: 'Chicken thighs', quantity: 1.4, unit: 'lb', servings: 3, purchase_date: fiveDaysAgo, is_food: true });
    globalThis.mystery = lineFromScanItem({ name: 'Black Turtle Beans', quantity: 1, unit: 'count', purchase_date: fiveDaysAgo, is_food: true });`);
  assert.equal(run('cereal.initial'), 10);                                  // the parser's package estimate, not one serving
  assert.equal(run('eggs.initial'), 12);
  assert.equal(run('Math.round(chicken.initial * 10) / 10'), 4.2);         // a weight is sized from the weight (635 g / 150 g)
  assert.equal(run('mystery.initial'), run('catalog("black turtle beans").servings'));
  assert.equal(run('Date.now() - cereal.purchase < 5000'), true);          // the clock starts at the scan
  // added to the pantry, nothing is asking "Still have this?"
  run(`for (const l of [cereal, eggs, chicken, mystery]) addLot(l.name, l.key, l.qty, l.raw, { initial: l.initial, burn: l.burn, purchase: l.purchase, expiry: l.expiry });`);
  assert.equal(run('state.pantry.filter(needsCheckin).length'), 0);
  // The card shows a rounded percentage (see pctLeft), and a scanned lot's clock starts at
  // the scan, so the millisecond or two that elapses before this line burns a sliver of a
  // serving. Assert what the user actually reads -- 100% -- not float equality, which made
  // this fail whenever Date.now() ticked mid-test.
  assert.equal(run('state.pantry.every(it => Math.round((current(it) / it.initial) * 100) === 100)'), true);
});

test('the estimate alone cannot ask "Still have this?" in a lot\'s first two days, and shrunk lots are repaired once', () => {
  const run = app();
  run(`state.pantry = [];
    const it = addLot('Tangerines', 'tangerines', '1 pcs', '', { initial: 1, burn: 1, purchase: Date.now() - DAY }).item;
    globalThis.fresh = needsCheckin(it);
    it.purchase = Date.now() - 3 * DAY; globalThis.later = needsCheckin(it);
    it.purchase = Date.now() - DAY; it.deducted = 0.8; globalThis.cooked = needsCheckin(it);`);
  assert.equal(run('fresh'), false);      // day-old lot, estimate says empty: not asked
  assert.equal(run('later'), true);       // three days in, the estimate may ask
  assert.equal(run('cooked'), true);      // cooking emptied it: asked whatever the age
  run(`state.pantry = [{ id: 'a', name: 'Cereal', key: 'cereal', qty: '1 pcs', initial: 1, purchase: Date.now() - 4 * DAY, expiry: Date.now() + 30 * DAY, burn: 0.3, deducted: 0 }];
    globalThis.repaired = repairShrunkLots(state.pantry);`);
  assert.equal(run('repaired >= 1'), true);
  assert.equal(run('state.pantry[0].initial'), run('catalog("cereal").servings'));
  assert.equal(run('Date.now() - state.pantry[0].purchase < 5000'), true);
  assert.equal(run('needsCheckin(state.pantry[0])'), false);
});

test('a scanned package survives the next load: a bare count of one never re-sizes a saved lot', () => {
  const run = app();
  run(`state.pantry = [];
    const today = new Date().toISOString().slice(0, 10);
    const e = lineFromScanItem({ name: 'Sparks Eggs', quantity: 1, unit: '', servings: 12, purchase_date: today, is_food: true });
    const c = lineFromScanItem({ name: 'Natures Path Cereal', quantity: 1, unit: 'count', servings: 10, days_to_use_up: 14, purchase_date: today, is_food: true });
    for (const l of [e, c]) addLot(l.name, l.key, l.qty, l.raw, { initial: l.initial, burn: l.burn, purchase: l.purchase, expiry: l.expiry });
    globalThis.atScan = state.pantry.map(it => it.initial).join(',');`);
  assert.equal(run('atScan'), '12,10');
  // `eggs` is bought by the piece AND its package happens to equal the catalog default, so
  // the lot looked like a legacy row to recomputeDefaultServings and was shrunk to a single
  // egg on every load -- with the carton's burn rate still on it.
  run('recomputeDefaultServings(state.pantry); recomputeDefaultServings(state.pantry);');
  assert.equal(run("state.pantry.map(it => it.initial).join(',')"), '12,10');
  assert.equal(run('state.pantry.filter(needsCheckin).length'), 0);
  assert.equal(run('state.pantry.every(it => Math.round((current(it) / it.initial) * 100) === 100)'), true);
});

test('a real quantity is still re-sized from it, so legacy lots are not stranded', () => {
  const run = app();
  // The pass exists for lots saved with the package default before servings were read off
  // quantities. A quantity that actually says how much there is must still win.
  run(`state.pantry = [];
    globalThis.it = addLot('Chicken thighs', 'chicken thighs', '1.4 lb').item;
    it.initial = catalog('chicken thighs').servings; it.deducted = 0;
    globalThis.before = it.initial;
    recomputeDefaultServings(state.pantry);`);
  assert.equal(run('it.initial === before'), false);
  assert.equal(run('Math.round(it.initial * 10) / 10'), 4.2);   // 635 g / 150 g per serving
});

test('answering "still have some" does not re-arm the card it dismissed', () => {
  const run = app();
  run(`state.pantry = [];
    const e = lineFromScanItem({ name: 'Sparks Eggs', quantity: 1, unit: '', servings: 12, purchase_date: new Date().toISOString().slice(0, 10), is_food: true });
    globalThis.it = addLot(e.name, e.key, e.qty, e.raw, { initial: e.initial, burn: e.burn, purchase: e.purchase, expiry: e.expiry }).item;
    rebaseLot(it, 50);`);
  assert.equal(run('it.initial'), 6);               // half a 12-serving carton, not half a serving
  assert.equal(run('needsCheckin(it)'), false);
  assert.equal(run('it.deducted'), 0);
  // and it lasts about as long as half a carton should, at the carton's own burn rate
  assert.equal(run('(it.initial - OUT) / (it.burn * householdScale(state.prefs)) > 7'), true);
  run('rebaseLot(it, 50);');
  assert.equal(run('it.initial'), 3);               // scaling compounds off what is now there
});
