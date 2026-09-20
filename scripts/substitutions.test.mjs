import test from 'node:test';
import assert from 'node:assert/strict';
import { SUBSTITUTIONS, localSubstitutions, substitutionKey } from '../frontend/shared/substitutions.js';
import { fetchSubstitutions, chat } from '../frontend/shared/api.js';

const uses = (name, pantry = []) => localSubstitutions(name, pantry).map(s => s.use);

/* ---- api.js (wave 2 additions, owned with this module) ---- */

const API = 'https://api.test';
const configureApi = base => { globalThis.window = { PANTRY_CONFIG: { apiBaseUrl: base } }; };
function stubFetch(response) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null, init });
    if (typeof response === 'function') return response();
    return response;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const jsonResponse = (data, ok = true, status = 200) => ({ ok, status, statusText: ok ? 'OK' : 'Bad Gateway', json: async () => data });

test('fetchSubstitutions posts the snake_case body and resolves { substitutions }', async () => {
  configureApi(API);
  const subs = [{ use: 'milk + butter', from_pantry: true, ratio: '¾ cup milk + ¼ cup melted butter per 1 cup', note: '', pantry_names: ['Milk', 'Butter'] }];
  const stub = stubFetch(jsonResponse({ substitutions: subs }));
  try {
    const pantry = [{ name: 'Milk', quantity: 4, unit: 'servings' }];
    const prefs = { version: 2, allergies: ['nuts'] };
    const res = await fetchSubstitutions({ ingredient: ' heavy cream ', dishTitle: 'Risotto', dishIngredients: ['1 cup heavy cream', '', null, 'stock'], pantry, prefs });
    assert.deepEqual(res, { substitutions: subs });
    assert.equal(stub.calls[0].url, `${API}/substitutions`);
    assert.equal(stub.calls[0].init.method, 'POST');
    assert.deepEqual(stub.calls[0].body, { ingredient: 'heavy cream', dish_title: 'Risotto', dish_ingredients: ['1 cup heavy cream', 'stock'], pantry, prefs });
    await fetchSubstitutions({ ingredient: 'eggs' });
    assert.deepEqual(stub.calls[1].body, { ingredient: 'eggs', dish_title: '', dish_ingredients: [], pantry: [], prefs: null });
  } finally { stub.restore(); }
  // a malformed answer still resolves to an array
  const odd = stubFetch(jsonResponse({ substitutions: 'nope' }));
  try { assert.deepEqual(await fetchSubstitutions({ ingredient: 'eggs' }), { substitutions: [] }); } finally { odd.restore(); }
});

test('fetchSubstitutions tags its errors with a code the app can fall back on', async () => {
  configureApi('');
  await assert.rejects(() => fetchSubstitutions({ ingredient: 'eggs' }), err => err.code === 'unconfigured' && /API base URL/.test(err.message));
  configureApi(API);
  await assert.rejects(() => fetchSubstitutions({ ingredient: '  ' }), err => err.code === 'http' && err.status === 400);
  const down = stubFetch(() => { throw new TypeError('Failed to fetch'); });
  try { await assert.rejects(() => fetchSubstitutions({ ingredient: 'eggs' }), err => err.code === 'unreachable'); } finally { down.restore(); }
  const bad = stubFetch(jsonResponse({ detail: 'Bedrock is not configured' }, false, 503));
  try { await assert.rejects(() => fetchSubstitutions({ ingredient: 'eggs' }), err => err.code === 'http' && err.status === 503 && /Bedrock/.test(err.message)); } finally { bad.restore(); }
});

test('chat sends focus_recipe only when a focusRecipe is given', async () => {
  configureApi(API);
  const stub = stubFetch(jsonResponse({ reply: 'ok', actions: [], recipes: [] }));
  try {
    const msgs = [{ role: 'user', content: 'no cream?' }];
    await chat(msgs, { focusRecipe: { title: 'Risotto', servings: '4', ingredients: ['1 cup arborio rice', ' ', null], steps: ['Toast the rice'], missing: ['heavy cream'] } });
    assert.deepEqual(stub.calls[0].body, {
      messages: msgs, pantry: [], prefs: null, recent_meals: [], shopping: [],
      focus_recipe: { title: 'Risotto', servings: 4, ingredients: ['1 cup arborio rice'], steps: ['Toast the rice'], missing: ['heavy cream'] },
    });
    await chat(msgs, { focusRecipe: { title: 'Bare' } });
    assert.deepEqual(stub.calls[1].body.focus_recipe, { title: 'Bare', servings: 2, ingredients: [], steps: [], missing: [] });
    await chat(msgs);
    assert.equal('focus_recipe' in stub.calls[2].body, false);
    await chat(msgs, { focusRecipe: null });
    assert.equal('focus_recipe' in stub.calls[3].body, false);
  } finally { stub.restore(); }
});

test('the table: every key has entries with a use and a ratio', () => {
  assert.ok(Object.keys(SUBSTITUTIONS).length >= 20);
  for (const [key, entries] of Object.entries(SUBSTITUTIONS)) {
    assert.ok(Array.isArray(entries) && entries.length > 0, key);
    for (const e of entries) {
      assert.equal(typeof e.use, 'string', key);
      assert.equal(typeof e.ratio, 'string', key);
      assert.ok(e.use && e.ratio, key);
    }
  }
});

test('exact key: heavy cream with an empty pantry keeps the table order and nothing is from the pantry', () => {
  const subs = localSubstitutions('heavy cream');
  assert.deepEqual(subs, [
    { use: 'milk + butter', ratio: '¾ cup milk + ¼ cup melted butter per 1 cup', note: 'will not whip', from_pantry: false, pantry_names: [] },
    { use: 'greek yogurt', ratio: '1:1', note: 'tangier; add off the heat', from_pantry: false, pantry_names: [] },
  ]);
});

test('from_pantry needs every food in the swap; pantry_names echoes the pantry spelling', () => {
  const subs = localSubstitutions('heavy cream', ['Milk (1 gal)', 'Butter', 'Eggs']);
  assert.equal(subs[0].use, 'milk + butter');
  assert.equal(subs[0].from_pantry, true);
  assert.deepEqual(subs[0].pantry_names, ['Milk (1 gal)', 'Butter']);
  assert.equal(subs[1].from_pantry, false);
  // only half of it: not from the pantry, but the half they have is listed
  const half = localSubstitutions('heavy cream', ['milk']);
  assert.equal(half[0].from_pantry, false);
  assert.deepEqual(half[0].pantry_names, ['milk']);
  // pantry names are matched case-insensitively
  assert.equal(localSubstitutions('heavy cream', ['MILK', 'butter'])[0].from_pantry, true);
  // pantry lots ({ key, name }) work as well as names: the key is indexed, the name is echoed
  const lots = localSubstitutions('heavy cream', [{ key: 'milk', name: 'Milk, whole 2 L' }, { key: 'butter', name: 'Butter' }]);
  assert.equal(lots[0].from_pantry, true);
  assert.deepEqual(lots[0].pantry_names, ['Milk, whole 2 L', 'Butter']);
  assert.equal(localSubstitutions('heavy cream', ['Milk 1 gal', 'Butter 250 g'])[0].from_pantry, true);
});

test('pantry-based swaps sort first, table order within', () => {
  assert.deepEqual(uses('onion'), ['shallot', 'leek']);
  const subs = localSubstitutions('onion', ['Leeks']);
  assert.deepEqual(subs.map(s => [s.use, s.from_pantry]), [['leek', true], ['shallot', false]]);
  assert.deepEqual(subs[0].pantry_names, ['Leeks']);
  assert.deepEqual(uses('parmesan', ['Pecorino']), ['pecorino', 'any hard aged cheese']);
});

test('aliases and families reach the right row (the ingredients.js matcher)', () => {
  assert.equal(substitutionKey('whipping cream'), 'heavy cream');
  assert.equal(substitutionKey('heavy whipping cream'), 'heavy cream');
  assert.equal(substitutionKey('cream'), 'heavy cream');
  assert.equal(substitutionKey('2 cloves garlic'), 'garlic');
  assert.equal(substitutionKey('garlic cloves'), 'garlic');
  assert.equal(substitutionKey('green onions'), 'scallions');
  assert.equal(substitutionKey('spring onions'), 'scallions');
  assert.equal(substitutionKey('vegetable broth'), 'stock');
  assert.equal(substitutionKey('chicken stock'), 'stock');
  assert.equal(substitutionKey('Large eggs'), 'eggs');
  assert.equal(substitutionKey('egg'), 'eggs');
  assert.equal(substitutionKey('Roma tomatoes'), 'tomatoes');
  assert.equal(substitutionKey('cherry tomatoes'), 'tomatoes');
  assert.equal(substitutionKey('penne'), 'pasta');
  assert.equal(substitutionKey('spaghetti'), 'pasta');
  assert.equal(substitutionKey('basmati rice'), 'rice');
  assert.equal(substitutionKey('jasmine rice'), 'rice');
  assert.equal(substitutionKey('yellow onion'), 'onion');
  assert.equal(substitutionKey('onions'), 'onion');
  assert.equal(substitutionKey('baby spinach'), 'spinach');
  assert.equal(substitutionKey('unsalted butter'), 'butter');
  assert.equal(substitutionKey('whole milk'), 'milk');
  assert.equal(substitutionKey('Soy sauce'), 'soy sauce');
  assert.equal(substitutionKey('sour cream'), 'sour cream');
  assert.equal(substitutionKey('Buttermilk'), 'buttermilk');
  assert.equal(substitutionKey('boneless skinless chicken thighs'), 'chicken thighs');
  assert.deepEqual(uses('2 cloves garlic'), ['garlic powder']);
  assert.deepEqual(uses('green onions'), ['chives', 'onion']);
});

test('cheese names and bare herbs', () => {
  assert.equal(substitutionKey('parmesan cheese'), 'parmesan');
  assert.equal(substitutionKey('feta cheese'), 'feta');
  assert.equal(substitutionKey('grated parmesan'), 'parmesan');
  assert.equal(substitutionKey('fresh basil'), 'fresh herbs');
  assert.equal(substitutionKey('parsley'), 'fresh herbs');
  assert.equal(substitutionKey('chopped cilantro'), 'fresh herbs');
  assert.equal(substitutionKey('dried oregano'), null);   // already dried: the fresh-herbs swap is pointless
  assert.deepEqual(uses('fresh basil'), ['dried herbs']);
});

test('a different form of the food is a different food: nothing is suggested', () => {
  for (const name of ['coconut milk', 'tomato paste', 'garlic powder', 'peanut butter', 'red wine', 'ice cream', 'rice vinegar', 'lemon zest', 'arborio rice', 'red onion', 'goat cheese']) {
    assert.deepEqual(localSubstitutions(name), [], name);
  }
});

test('staples count as on hand and a lemon covers lemon juice', () => {
  const soy = localSubstitutions('soy sauce', ['Vinegar']);
  assert.equal(soy[0].from_pantry, true);
  assert.deepEqual(soy[0].pantry_names, ['Vinegar']);   // salt is a staple: not listed, not required
  assert.equal(localSubstitutions('soy sauce', ['White wine vinegar'])[0].from_pantry, true);
  assert.equal(localSubstitutions('soy sauce', ['Salt'])[0].from_pantry, false);
  const bm = localSubstitutions('buttermilk', ['Milk', 'Lemon']);
  assert.equal(bm[0].from_pantry, true);
  assert.deepEqual(bm[0].pantry_names, ['Milk', 'Lemon']);
  const stock = localSubstitutions('stock', ['Soy sauce']);
  assert.equal(stock[0].from_pantry, true);
  assert.deepEqual(stock[0].pantry_names, ['Soy sauce']);
  const wine = localSubstitutions('white wine', ['Chicken stock', 'Lemons']);
  assert.equal(wine[0].from_pantry, true);
  assert.deepEqual(wine[0].pantry_names, ['Chicken stock', 'Lemons']);
});

test('"any …" swaps accept a member of the family or a name that contains the head word', () => {
  const pasta = localSubstitutions('penne', ['Spaghetti']);
  assert.deepEqual(pasta.map(s => [s.use, s.from_pantry, s.pantry_names]), [['any pasta shape', true, ['Spaghetti']]]);
  assert.equal(localSubstitutions('penne', ['Rice'])[0].from_pantry, false);
  const parm = localSubstitutions('parmesan', ['Cheddar cheese']);
  assert.deepEqual(parm.map(s => [s.use, s.from_pantry]), [['any hard aged cheese', true], ['pecorino', false]]);
  assert.deepEqual(parm[0].pantry_names, ['Cheddar cheese']);
});

test('a swap that is the ingredient itself is dropped; unknown and empty input give nothing', () => {
  assert.deepEqual(localSubstitutions('chicken breast'), []);   // the thighs row only offers chicken breast
  assert.equal(uses('chicken thighs', ['Chicken breast'])[0], 'chicken breast');
  assert.deepEqual(localSubstitutions('saffron'), []);
  assert.deepEqual(localSubstitutions(''), []);
  assert.deepEqual(localSubstitutions(null), []);
  assert.deepEqual(localSubstitutions('milk', null), [{ use: 'water + butter', ratio: '1 cup water + 1 tbsp butter', note: '', from_pantry: false, pantry_names: [] }]);
  assert.equal(substitutionKey('saffron'), null);
  assert.equal(substitutionKey(''), null);
});

test('every result carries the backend shape', () => {
  for (const s of localSubstitutions('eggs', ['flax'])) {
    assert.deepEqual(Object.keys(s).sort(), ['from_pantry', 'note', 'pantry_names', 'ratio', 'use']);
    assert.equal(typeof s.from_pantry, 'boolean');
    assert.ok(Array.isArray(s.pantry_names));
  }
});
