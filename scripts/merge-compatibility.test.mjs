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

test('chat sends preferences, rejects allergenic staples, and keeps generated links resolvable', async () => {
  const run = app({chat: true});
  run(`state.prefs = normalizePrefs({allergies: ['dairy']});
    globalThis.messages = [];
    addChat = (who, html) => { messages.push(html); return {remove(){}}; };
    globalThis.apiConfigured = () => true;
    globalThis.fetchRecipes = async (items, opts) => {
      globalThis.sent = opts;
      return {recipes: [
        {title: 'Butter rice', ingredients: [{name: 'Butter', staple: true}], steps: []},
        {title: 'Tomato rice', ingredients: [{name: 'Tomato'}], steps: []}
      ]};
    };`);
  await run(`handleChat('rice')`);
  assert.equal(run(`sent.prefs.allergies[0]`), 'dairy');
  assert.equal(run(`messages.at(-1).includes('Tomato rice')`), true);
  assert.equal(run(`messages.at(-1).includes('Butter rice')`), false);
  assert.equal(run(`dishById([...chatDishes.keys()][0]).name`), 'Tomato rice');
});

test('offline chat filters exact matches and suggestions by allergies and diet', async () => {
  const run = app({chat: true});
  run(`state.prefs = normalizePrefs({diet: ['vegan'], allergies: ['peanuts']});
    globalThis.messages = [];
    addChat = (who, html) => { messages.push(html); return {remove(){}}; };
    globalThis.apiConfigured = () => true;
    globalThis.fetchRecipes = async () => { throw new Error('offline'); };
    liveDishes = [
      {id: 'chicken', name: 'Chicken soup', ingredients: [{name: 'Chicken', key: 'chicken', need: 1}], servings: 2},
      {id: 'nuts', name: 'Peanut rice', ingredients: [{name: 'Peanut', key: 'peanut', need: 1}], servings: 2},
      {id: 'rice', name: 'Tomato rice', ingredients: [{name: 'Tomato', key: 'tomato', need: 1}], servings: 2}
    ];`);
  assert.equal(run(`findDishForQuery('Chicken soup')`), null);
  await run(`handleChat('Chicken soup')`);
  assert.equal(run(`messages.at(-1).includes('AI is unavailable')`), true);
  assert.equal(run(`messages.at(-1).includes('<b>Tomato rice</b>')`), true);
  assert.equal(run(`messages.at(-1).includes('Peanut rice')`), false);
});

test('a preference edit while chat is loading discards stale AI instructions', async () => {
  const run = app({chat: true});
  run(`globalThis.messages = [];
    addChat = (who, html) => { messages.push(html); return {remove(){}}; };
    globalThis.apiConfigured = () => true;
    globalThis.fetchRecipes = () => new Promise(resolve => { globalThis.respond = resolve; });`);
  const pending = run(`handleChat('dinner')`);
  run(`state.prefs = normalizePrefs({diet: ['vegan']});
    respond({recipes: [{title: 'Old answer', ingredients: [], steps: []}]});`);
  await pending;
  assert.equal(run(`messages.at(-1).includes('Your preferences changed')`), true);
  assert.equal(run(`messages.at(-1).includes('Old answer')`), false);
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
