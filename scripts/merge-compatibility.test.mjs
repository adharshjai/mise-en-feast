import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as preferences from '../frontend/shared/store.js';

function app() {
  const source = readFileSync(new URL('../frontend/app/app.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('/* =========================================================================\n   Wiring')[0]
    .replace(/^import [\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '');
  const node = { addEventListener() {} };
  const context = vm.createContext({
    ...preferences, console, crypto, setTimeout, clearTimeout,
    window: { matchMedia: () => ({ matches: true }) },
    document: { querySelector: () => node },
  });
  vm.runInContext(source, context);
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
