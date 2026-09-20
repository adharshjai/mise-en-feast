import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPantryIndex, matchIngredient, normalizeName, singular } from '../frontend/shared/ingredients.js';

// The catalog keys the app passes as extraKeys (a subset is enough to exercise the rules).
const CATALOG_KEYS = ['spinach', 'milk', 'eggs', 'chicken thighs', 'garlic', 'spaghetti', 'tomatoes', 'basil', 'jasmine rice',
  'parmesan', 'cucumber', 'olive oil', 'chili flakes', 'onion', 'red onion', 'mushrooms', 'arborio rice', 'stock', 'soy sauce',
  'cream', 'olives', 'cumin', 'paprika', 'feta', 'scallions', 'white wine'];
const lot = (name, key = name.toLowerCase()) => ({ id: name, name, key });
const pantry = [
  lot('Tomatoes, roma', 'tomatoes'), lot('Milk'), lot('Onion'), lot('Red onion'), lot('Garlic'), lot('Scallions'),
  lot('Chicken thighs'), lot('Lime'), lot('Soy sauce'), lot('Jasmine rice'), lot('Cream'), lot('Eggs'), lot('Spaghetti'),
  lot('Spinach'), lot('Olive oil'), lot('Cumin'), lot('Beef'), lot('Stock'),
];
const index = buildPantryIndex(pantry, CATALOG_KEYS);
const key = (name, idx = index) => { const m = matchIngredient({ name }, idx); return m ? m.key : null; };

test('normalisation: lowercase, punctuation, singular tokens, filler words', () => {
  assert.equal(singular('tomatoes'), 'tomato');
  assert.equal(singular('leaves'), 'leaf');
  assert.equal(singular('berries'), 'berry');
  assert.equal(singular('eggs'), 'egg');
  assert.equal(singular('grass'), 'grass');
  assert.equal(singular('peaches'), 'peach');
  assert.equal(normalizeName('Fresh organic baby Spinach, chopped'), 'spinach');
  assert.equal(normalizeName('Boneless skinless chicken thighs'), 'chicken thigh');
  assert.equal(normalizeName('2 large Eggs'), 'egg');
  assert.equal(normalizeName(''), '');
});

test('the examples that must hold', () => {
  assert.equal(key('Roma tomatoes'), 'tomatoes');
  assert.equal(key('tomato paste'), null);
  assert.equal(key('coconut milk'), null);
  assert.equal(key('onion powder'), null);
  assert.equal(key('red onion'), 'red onion');            // its own key, never folded into onion
  assert.equal(key('garlic cloves'), 'garlic');
  assert.equal(key('green onions'), 'scallions');
  assert.deepEqual(matchIngredient({ name: 'chicken breast' }, index), { key: 'chicken thighs', approx: true });
  assert.equal(key('lime juice'), null);
  assert.equal(key('soy sauce'), 'soy sauce');
  assert.equal(key('rice vinegar'), null);
  assert.equal(key('ice cream'), null);
  assert.equal(key('eggplant'), null);
  assert.equal(key('egg'), 'eggs');
  assert.deepEqual(matchIngredient({ name: 'spaghetti' }, index), { key: 'spaghetti', approx: false });
  assert.deepEqual(matchIngredient({ name: 'penne' }, index), { key: 'spaghetti', approx: true });
});

test('red onion stays distinct even when the index has no red onion at all', () => {
  const idx = buildPantryIndex([lot('Onion')], ['onion']);
  assert.equal(key('red onion', idx), null);
  assert.equal(key('yellow onion', idx), 'onion');
  // and plain "onion" never takes their red onion
  assert.equal(key('onion', buildPantryIndex([lot('Red onion')], ['onion', 'red onion'])), 'onion');
});

test('matched_name from the model wins when it names a pantry row', () => {
  assert.equal(matchIngredient({ name: 'Plum tomatoes', matched_name: 'Tomatoes' }, index).key, 'tomatoes');
  // an unknown matched_name falls through to the name itself
  assert.equal(matchIngredient({ name: 'Garlic cloves', matched_name: 'Allium' }, index).key, 'garlic');
});

test('rice: jasmine and basmati are rice, arborio is not', () => {
  assert.equal(key('rice'), 'jasmine rice');
  assert.equal(key('basmati rice'), 'jasmine rice');
  assert.equal(key('arborio rice'), 'arborio rice');
  assert.equal(key('risotto rice'), 'arborio rice');
  const onlyArborio = buildPantryIndex([lot('Arborio rice')], []);
  assert.equal(key('rice', onlyArborio), null);
});

test('forms: the same word can be a different product', () => {
  assert.equal(key('garlic powder'), null);
  assert.equal(key('ground cumin'), 'cumin');           // ground spice is the spice
  assert.equal(key('ground beef'), null);               // ground meat is not the cut
  assert.equal(key('sour cream'), null);
  assert.equal(key('heavy cream'), 'cream');
  assert.equal(key('chicken stock'), 'stock');
  assert.equal(key('chicken broth'), 'stock');
  assert.equal(key('oil'), 'olive oil');
  assert.equal(key('sesame oil'), null);
});

test('token overlap needs the same head noun and more than half the words', () => {
  assert.equal(key('baby spinach'), 'spinach');
  assert.equal(key('cherry tomatoes'), 'tomatoes');
  assert.equal(key('black pepper', buildPantryIndex([lot('Bell pepper')], [])), null);
  assert.equal(key('spring mix', buildPantryIndex([lot('Spring onion', 'scallions')], [])), null);
  assert.equal(key('chicken drumsticks'), 'chicken thighs');
  assert.equal(key('ground chicken'), null);
});

test('what they have beats the catalog, and an empty index matches nothing', () => {
  // "chicken" hand-added under the catalog key: the pantry name resolves first
  const idx = buildPantryIndex([lot('Chicken', 'chicken thighs')], CATALOG_KEYS);
  assert.equal(key('chicken', idx), 'chicken thighs');
  assert.equal(key('chicken', buildPantryIndex([], CATALOG_KEYS)), 'chicken thighs');   // catalog fallback, still resolves
  assert.equal(matchIngredient({ name: 'chicken' }, buildPantryIndex([], [])), null);
  assert.equal(matchIngredient({ name: '' }, index), null);
  assert.equal(matchIngredient('Spinach', index).key, 'spinach');
});
