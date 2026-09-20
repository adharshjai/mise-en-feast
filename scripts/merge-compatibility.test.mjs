import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as preferences from '../frontend/shared/store.js';

function app({ chat = false } = {}) {
  const full = readFileSync(new URL('../frontend/app/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const source = full
    .split('/* =========================================================================\n   Wiring')[0]
    .replace(/^import [\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '');
  const node = { addEventListener() {} };
  const context = vm.createContext({
    ...preferences, console, crypto, setTimeout, clearTimeout,
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

test('recipe refresh failure visibly selects built-in recipes', async () => {
  const run = app();
  run(`state.pantry = [{id: 'one'}];
    globalThis.apiConfigured = () => true;
    globalThis.fetchRecipes = async () => { throw new Error('offline'); };
    pantryForApi = () => [];
    renderAll = renderRecipeNotice = () => {};`);
  await run('refreshRecipes()');
  assert.equal(run(`recipeNotice`), 'AI is unavailable · showing built-in recipes.');
  assert.equal(run('liveDishes'), null);
});
