import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as preferences from '../frontend/shared/store.js';
import * as ingredients from '../frontend/shared/ingredients.js';
import * as units from '../frontend/shared/units.js';
import * as dishImages from '../frontend/shared/dish-images.js';

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
    ...preferences, ...ingredients, ...units, ...dishImages, console, crypto, setTimeout, clearTimeout,
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
  assert.equal(run('html.includes("4 of 10")'), true);
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
const lot = (name, key, initial) => `{id: '${key}', name: '${name}', key: '${key}', initial: ${initial}, deducted: 0, burn: 0, purchase: Date.now(), expiry: Date.now() + 5 * 86400000}`;

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
    state.pantry = [${lot('Eggs', 'eggs', 10)}, ${lot('Garlic', 'garlic', 1)}];
    const dish = {id: 'd', name: 'Dish', servings: 2, ingredients: [{name: 'Eggs', need: 1}, {name: 'Garlic', need: 1}]};
    liveDishes = [dish];
    state.detailServings = 3;
    openSheet = (kind, html) => { globalThis.html = html; };
    updateDeductSummary = () => {};
    openMadeIt('d');`);
  assert.equal(run('html.includes("1.5 of 10")'), true);        // eggs: 1 × 3/2 people
  assert.equal(run('html.includes("1 of 1")'), true);           // garlic: wants 1.5, has 1 — takes the 1
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
  run(`state.pantry = [${lot('Spaghetti', 'spaghetti', 4)}, ${lot('Garlic', 'garlic', 1)}];
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
  assert.equal(run('html.includes("2.5 of 4")'), true);
  assert.equal(run('html.includes("1 of 1")'), true);
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
