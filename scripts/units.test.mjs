import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIT_OPTIONS, parseQuantity, toCanonical, formatQuantity, standardizeAmount, scaleAmount, servingsFor,
  SERVING_SIZES, DEFAULT_SERVING,
} from '../frontend/shared/units.js';

const near = (actual, expected, eps = 0.01, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${msg} expected ${expected} ± ${eps}, got ${actual}`);

test('UNIT_OPTIONS is the add-form dropdown in order', () => {
  assert.deepEqual(UNIT_OPTIONS, ['g', 'kg', 'ml', 'L', 'pcs', 'pack']);
});

/* ---------- parseQuantity ---------- */

test('parseQuantity reads every example in the brief', () => {
  const cases = [
    ['5 oz', 5, 'oz'], ['1.4 lb', 1.4, 'lb'], ['12', 12, null], ['1 gal', 1, 'gallon'], ['500ml', 500, 'ml'],
    ['2 cloves', 2, 'clove'], ['½ cup', 0.5, 'cup'], ['1/2 cup', 0.5, 'cup'], ['1 ½ cups', 1.5, 'cup'],
    ['a pinch', null, null], ['1 bunch', 1, 'bunch'], ['8 oz pack', 8, 'oz'], ['2 x 400 g', 800, 'g'],
    ['1.5 kg', 1.5, 'kg'], ['3 cups, cooked', 3, 'cup'], ['4 roma', 4, 'roma'], ['2', 2, null],
    ['1 dozen', 1, 'dozen'], ['6 ct', 6, 'pcs'], ['1 head', 1, 'head'], ['1 qt', 1, 'quart'], ['2 tbsp', 2, 'tbsp'],
    ['1 tsp', 1, 'tsp'], ['3 fl oz', 3, 'fl oz'], ['1 pint', 1, 'pint'], ['250 g', 250, 'g'], ['1 l', 1, 'l'],
    ['1 liter', 1, 'l'],
  ];
  for (const [text, qty, unit] of cases) {
    const p = parseQuantity(text);
    assert.equal(p.qty, qty, `qty of ${JSON.stringify(text)}`);
    assert.equal(p.unit, unit, `unit of ${JSON.stringify(text)}`);
    assert.equal(p.raw, text, `raw of ${JSON.stringify(text)}`);
  }
});

test('parseQuantity understands unicode fractions and mixed numbers', () => {
  near(parseQuantity('¼ tsp').qty, 0.25);
  near(parseQuantity('½ cup').qty, 0.5);
  near(parseQuantity('¾ cup').qty, 0.75);
  near(parseQuantity('⅓ cup').qty, 1 / 3, 1e-9);
  near(parseQuantity('⅔ cup').qty, 2 / 3, 1e-9);
  near(parseQuantity('⅛ tsp').qty, 0.125);
  near(parseQuantity('1½ cups').qty, 1.5);
  near(parseQuantity('1 1/2 cups').qty, 1.5);
  near(parseQuantity('1-1/2 cups').qty, 1.5);
  near(parseQuantity('11/2 cups').qty, 5.5);
  near(parseQuantity('.5 kg').qty, 0.5);
});

test('parseQuantity is case-insensitive and tolerant of trailing words', () => {
  assert.deepEqual(parseQuantity('5 OZ'), { qty: 5, unit: 'oz', raw: '5 OZ' });
  assert.deepEqual(parseQuantity('1 GAL'), { qty: 1, unit: 'gallon', raw: '1 GAL' });
  assert.deepEqual(parseQuantity('2 Tbsp.'), { qty: 2, unit: 'tbsp', raw: '2 Tbsp.' });
  assert.deepEqual(parseQuantity('3 fl. oz.'), { qty: 3, unit: 'fl oz', raw: '3 fl. oz.' });
  assert.deepEqual(parseQuantity('1 L'), { qty: 1, unit: 'l', raw: '1 L' });
  assert.deepEqual(parseQuantity('2 tbsp, melted'), { qty: 2, unit: 'tbsp', raw: '2 tbsp, melted' });
  assert.deepEqual(parseQuantity('1 cup of rice'), { qty: 1, unit: 'cup', raw: '1 cup of rice' });
  assert.deepEqual(parseQuantity('12 large eggs'), { qty: 12, unit: 'egg', raw: '12 large eggs' });
  assert.deepEqual(parseQuantity('  about 2 cups  '), { qty: 2, unit: 'cup', raw: 'about 2 cups' });
  assert.deepEqual(parseQuantity('2-3 cloves'), { qty: 2, unit: 'clove', raw: '2-3 cloves' });
  assert.deepEqual(parseQuantity('1,000 g'), { qty: 1000, unit: 'g', raw: '1,000 g' });
});

test('parseQuantity handles multipliers, articles and number words', () => {
  assert.deepEqual(parseQuantity('2x400g'), { qty: 800, unit: 'g', raw: '2x400g' });
  assert.deepEqual(parseQuantity('2 (400 g) cans'), { qty: 800, unit: 'g', raw: '2 (400 g) cans' });
  assert.deepEqual(parseQuantity('1 12 oz can'), { qty: 12, unit: 'oz', raw: '1 12 oz can' });
  assert.deepEqual(parseQuantity('2 x 6 eggs'), { qty: 12, unit: 'egg', raw: '2 x 6 eggs' });
  assert.deepEqual(parseQuantity('12 (1 dozen)'), { qty: 12, unit: null, raw: '12 (1 dozen)' });   // brackets never multiply counts
  assert.deepEqual(parseQuantity('a cup'), { qty: 1, unit: 'cup', raw: 'a cup' });
  assert.deepEqual(parseQuantity('an egg'), { qty: 1, unit: 'egg', raw: 'an egg' });
  assert.deepEqual(parseQuantity('two cloves'), { qty: 2, unit: 'clove', raw: 'two cloves' });
  assert.deepEqual(parseQuantity('a pinch of salt'), { qty: null, unit: null, raw: 'a pinch of salt' });
});

test('parseQuantity returns nulls for text without a number', () => {
  for (const t of ['', '   ', 'to taste', 'some', 'Eggs', null, undefined]) {
    const p = parseQuantity(t);
    assert.equal(p.qty, null, JSON.stringify(t));
    assert.equal(p.unit, null, JSON.stringify(t));
    assert.equal(typeof p.raw, 'string');
  }
  assert.deepEqual(parseQuantity(12), { qty: 12, unit: null, raw: '12' });
});

/* ---------- toCanonical ---------- */

test('toCanonical converts each family to g / ml / pcs / pack', () => {
  const cases = [
    ['5 oz', 141.75, 'g'], ['1.4 lb', 635.04, 'g'], ['8 oz pack', 226.8, 'g'], ['2 x 400 g', 800, 'g'],
    ['1.5 kg', 1500, 'g'], ['250 g', 250, 'g'],
    ['1 gal', 3785, 'ml'], ['500ml', 500, 'ml'], ['½ cup', 120, 'ml'], ['1/2 cup', 120, 'ml'], ['1 ½ cups', 360, 'ml'],
    ['3 cups, cooked', 720, 'ml'], ['1 qt', 946, 'ml'], ['2 tbsp', 30, 'ml'], ['1 tsp', 5, 'ml'], ['3 fl oz', 88.71, 'ml'],
    ['1 pint', 473, 'ml'], ['1 l', 1000, 'ml'], ['1 liter', 1000, 'ml'],
    ['12', 12, 'pcs'], ['2', 2, 'pcs'], ['1 dozen', 12, 'pcs'], ['6 ct', 6, 'pcs'],
  ];
  for (const [text, amount, unit] of cases) {
    const c = toCanonical(parseQuantity(text));
    near(c.amount, amount, 0.01, text);
    assert.equal(c.unit, unit, text);
    assert.equal('label' in c, false, `${text} should carry no label`);
  }
});

test('toCanonical keeps descriptive count nouns and packaging as labels', () => {
  assert.deepEqual(toCanonical('2 cloves'), { amount: 2, unit: 'pcs', label: 'clove' });
  assert.deepEqual(toCanonical('4 roma'), { amount: 4, unit: 'pcs', label: 'roma' });
  assert.deepEqual(toCanonical('1 bunch'), { amount: 1, unit: 'pack', label: 'bunch' });
  assert.deepEqual(toCanonical('1 head'), { amount: 1, unit: 'pack', label: 'head' });
  assert.deepEqual(toCanonical('3 slices'), { amount: 3, unit: 'pcs', label: 'slice' });
  assert.deepEqual(toCanonical('2 jars'), { amount: 2, unit: 'pack', label: 'jar' });
  assert.deepEqual(toCanonical('1 pack'), { amount: 1, unit: 'pack' });
  assert.deepEqual(toCanonical('a pinch'), { amount: null, unit: null });
  assert.deepEqual(toCanonical(''), { amount: null, unit: null });
});

test('toCanonical knows every spelling in the brief', () => {
  const fam = (t) => toCanonical(`1 ${t}`).unit;
  for (const t of ['oz', 'lb', 'kg', 'g', 'gram', 'grams', 'ounce', 'pound', 'lbs']) assert.equal(fam(t), 'g', t);
  for (const t of ['tsp', 'tbsp', 'cup', 'fl oz', 'pint', 'quart', 'qt', 'gallon', 'gal', 'l', 'liter', 'litre', 'ml', 'teaspoon', 'tablespoon', 'cups']) assert.equal(fam(t), 'ml', t);
  for (const t of ['ct', 'count', 'each', 'ea', 'pcs', 'pc', 'piece', 'pieces', 'whole', 'egg', 'eggs', 'clove', 'cloves', 'slice', 'slices', 'dozen']) assert.equal(fam(t), 'pcs', t);
  for (const t of ['pack', 'pk', 'jar', 'bottle', 'can', 'bag', 'box', 'carton', 'tub', 'bunch', 'head', 'loaf', 'stick', 'packet']) assert.equal(fam(t), 'pack', t);
  assert.equal(toCanonical('1 dozen').amount, 12);
  assert.equal(toCanonical('2 dozen').amount, 24);
});

test('toCanonical accepts canonical, parsed and chat-action shaped objects', () => {
  assert.deepEqual(toCanonical({ amount: 2, unit: 'kg' }), { amount: 2000, unit: 'g' });
  assert.deepEqual(toCanonical({ amount: 3, unit: 'L' }), { amount: 3000, unit: 'ml' });
  assert.deepEqual(toCanonical({ amount: 635, unit: 'g' }), { amount: 635, unit: 'g' });
  assert.deepEqual(toCanonical({ qty: 2, unit: 'cloves' }), { amount: 2, unit: 'pcs', label: 'clove' });
  assert.deepEqual(toCanonical({ quantity: 2, unit: '' }), { amount: 2, unit: 'pcs' });
  assert.deepEqual(toCanonical({ quantity: null, unit: 'g' }), { amount: null, unit: null });
  assert.deepEqual(toCanonical({ amount: 2, unit: 'pcs', label: 'cloves' }), { amount: 2, unit: 'pcs', label: 'clove' });
  assert.deepEqual(toCanonical({ amount: 4, unit: 'pcs', label: 'Roma' }), { amount: 4, unit: 'pcs', label: 'roma' });
  assert.deepEqual(toCanonical({ amount: 2, unit: 'pack', label: 'bunch' }), { amount: 2, unit: 'pack', label: 'bunch' });
  assert.deepEqual(toCanonical({ amount: 500, unit: 'g', label: 'ignored' }), { amount: 500, unit: 'g' });
  assert.deepEqual(toCanonical(null), { amount: null, unit: null });
});

/* ---------- formatQuantity ---------- */

test('formatQuantity renders the brief examples', () => {
  assert.equal(formatQuantity({ amount: 635, unit: 'g' }), '635 g');
  assert.equal(formatQuantity('1.4 lb'), '635 g');
  assert.equal(formatQuantity({ amount: 1500, unit: 'g' }), '1.5 kg');
  assert.equal(formatQuantity('1.5 kg'), '1.5 kg');
  assert.equal(formatQuantity({ amount: 1000, unit: 'g' }), '1 kg');
  assert.equal(formatQuantity('500ml'), '500 ml');
  assert.equal(formatQuantity({ amount: 3800, unit: 'ml' }), '3.8 L');
  assert.equal(formatQuantity('1 gal'), '3.8 L');
  assert.equal(formatQuantity('1 l'), '1 L');
  assert.equal(formatQuantity('1 liter'), '1 L');
  assert.equal(formatQuantity('6 ct'), '6 pcs');
  assert.equal(formatQuantity('12'), '12 pcs');
  assert.equal(formatQuantity('1 dozen'), '12 pcs');
  assert.equal(formatQuantity({ amount: 1, unit: 'pack' }), '1 pack');
  assert.equal(formatQuantity({ amount: 2, unit: 'pack' }), '2 packs');
  assert.equal(formatQuantity('2 cloves'), '2 cloves');
  assert.equal(formatQuantity({ amount: 1, unit: 'pcs', label: 'clove' }), '1 clove');
  assert.equal(formatQuantity('4 roma'), '4 roma');
  assert.equal(formatQuantity('1 bunch'), '1 bunch');
  assert.equal(formatQuantity('1 head'), '1 head');
  assert.equal(formatQuantity('2 jars'), '2 jars');
  assert.equal(formatQuantity('8 oz pack'), '225 g');
  assert.equal(formatQuantity('2 x 400 g'), '800 g');
  assert.equal(formatQuantity('3 cups, cooked'), '720 ml');
  assert.equal(formatQuantity('2 tbsp'), '30 ml');
  assert.equal(formatQuantity('1 tsp'), '5 ml');
  assert.equal(formatQuantity('½ cup'), '120 ml');
  assert.equal(formatQuantity('1 ½ cups'), '360 ml');
  assert.equal(formatQuantity('250 g'), '250 g');
});

test('formatQuantity returns unparseable text trimmed as-is', () => {
  assert.equal(formatQuantity('a pinch'), 'a pinch');
  assert.equal(formatQuantity('  a pinch '), 'a pinch');
  assert.equal(formatQuantity('to taste'), 'to taste');
  assert.equal(formatQuantity(''), '');
  assert.equal(formatQuantity(null), '');
  assert.equal(formatQuantity(undefined), '');
  assert.equal(formatQuantity({ amount: null, unit: null }), '');
  assert.equal(formatQuantity({ qty: null, unit: null, raw: ' a pinch ' }), 'a pinch');
});

test('formatQuantity rounds g/ml to 5 below a kilo and to one decimal above', () => {
  // below 100: nearest 5
  assert.equal(formatQuantity('3 fl oz'), '90 ml');            // 88.71
  assert.equal(formatQuantity({ amount: 97, unit: 'g' }), '95 g');
  assert.equal(formatQuantity({ amount: 98, unit: 'g' }), '100 g');
  assert.equal(formatQuantity({ amount: 99, unit: 'g' }), '100 g');
  assert.equal(formatQuantity({ amount: 100, unit: 'g' }), '100 g');
  assert.equal(formatQuantity({ amount: 102, unit: 'g' }), '100 g');
  assert.equal(formatQuantity({ amount: 103, unit: 'ml' }), '105 ml');
  // 100 .. 1000: nearest 5 (the brief's own examples 225 g / 455 g / 635 g need 5, not 10)
  assert.equal(formatQuantity('5 oz'), '140 g');               // 141.75
  assert.equal(formatQuantity('8 oz'), '225 g');               // 226.8
  assert.equal(formatQuantity('1 lb'), '455 g');               // 453.6
  assert.equal(formatQuantity('1 qt'), '945 ml');              // 946
  assert.equal(formatQuantity('1 pint'), '475 ml');            // 473
  // the kilo / litre boundary
  assert.equal(formatQuantity({ amount: 997.5, unit: 'g' }), '1 kg');
  assert.equal(formatQuantity({ amount: 999, unit: 'g' }), '1 kg');
  assert.equal(formatQuantity({ amount: 1001, unit: 'g' }), '1 kg');
  assert.equal(formatQuantity({ amount: 1049, unit: 'g' }), '1 kg');
  assert.equal(formatQuantity({ amount: 1051, unit: 'g' }), '1.1 kg');
  assert.equal(formatQuantity({ amount: 1200, unit: 'g' }), '1.2 kg');
  assert.equal(formatQuantity({ amount: 1500, unit: 'ml' }), '1.5 L');
  assert.equal(formatQuantity({ amount: 3785, unit: 'ml' }), '3.8 L');
  // spoon-sized amounts keep half steps instead of collapsing to 0 or 5
  assert.equal(formatQuantity({ amount: 2.5, unit: 'ml' }), '2.5 ml');
  assert.equal(formatQuantity('½ tsp'), '2.5 ml');
  assert.equal(formatQuantity('¼ tsp'), '1.5 ml');
  assert.equal(formatQuantity({ amount: 0.2, unit: 'g' }), '0.5 g');
  assert.equal(formatQuantity({ amount: 0, unit: 'g' }), '0 g');
});

test('formatQuantity keeps pcs to one decimal and singularises labels at one', () => {
  assert.equal(formatQuantity({ amount: 2.52, unit: 'pcs' }), '2.5 pcs');
  assert.equal(formatQuantity({ amount: 0.5, unit: 'pcs' }), '0.5 pcs');
  assert.equal(formatQuantity({ amount: 1, unit: 'pcs', label: 'egg' }), '1 egg');
  assert.equal(formatQuantity({ amount: 3, unit: 'pcs', label: 'egg' }), '3 eggs');
  assert.equal(formatQuantity({ amount: 1, unit: 'pack', label: 'bunch' }), '1 bunch');
  assert.equal(formatQuantity({ amount: 2, unit: 'pack', label: 'bunch' }), '2 bunches');
  assert.equal(formatQuantity({ amount: 2, unit: 'pack', label: 'loaf' }), '2 loaves');
  assert.equal(formatQuantity('1 breasts'), '1 breast');
  assert.equal(formatQuantity('2 ripe avocados'), '2 ripe avocados');
});

test('formatQuantity is idempotent', () => {
  const inputs = [
    '5 oz', '1.4 lb', '12', '1 gal', '500ml', '2 cloves', '½ cup', '1/2 cup', '1 ½ cups', 'a pinch', '1 bunch',
    '8 oz pack', '2 x 400 g', '1.5 kg', '3 cups, cooked', '4 roma', '2', '1 dozen', '6 ct', '1 head', '1 qt',
    '2 tbsp', '1 tsp', '3 fl oz', '1 pint', '250 g', '1 l', '1 liter', '¼ tsp', '½ tsp', '⅓ cup', '2 jars',
    '12 large eggs', '1 breasts', '2 ripe avocados', '1,000 g', '999 g', '1001 g', '1049 g', '1051 g', '97 g',
    '98 g', '2.5 ml', '0.2 g', 'to taste', '', '1 12 oz can', '2 (400 g) cans', '2 x 6 eggs',
  ];
  for (const x of inputs) {
    const once = formatQuantity(x);
    assert.equal(formatQuantity(once), once, `formatQuantity(${JSON.stringify(x)}) = ${JSON.stringify(once)}`);
  }
});

/* ---------- standardizeAmount ---------- */

test('standardizeAmount converts recipe amounts to metric, keeping qualifiers', () => {
  assert.equal(standardizeAmount('8 oz'), '225 g');
  assert.equal(standardizeAmount('1 lb'), '455 g');
  assert.equal(standardizeAmount('½ cup'), '120 ml');
  assert.equal(standardizeAmount('2 tbsp'), '30 ml');
  assert.equal(standardizeAmount('1 tsp'), '5 ml');
  assert.equal(standardizeAmount('2 cloves'), '2 cloves');
  assert.equal(standardizeAmount('4 roma'), '4 roma');
  assert.equal(standardizeAmount('a pinch'), 'a pinch');
  assert.equal(standardizeAmount('3 cups, cooked'), '720 ml, cooked');
  assert.equal(standardizeAmount('2'), '2');
  assert.equal(standardizeAmount(''), '');
  assert.equal(standardizeAmount('   '), '');
  assert.equal(standardizeAmount(null), '');
  assert.equal(standardizeAmount('½'), '0.5');
  assert.equal(standardizeAmount('2, beaten'), '2, beaten');
  assert.equal(standardizeAmount('1 dozen'), '12 pcs');
  assert.equal(standardizeAmount('1 bunch'), '1 bunch');
  assert.equal(standardizeAmount('1 ½ cups, sifted'), '360 ml, sifted');
  assert.equal(standardizeAmount('2 cloves, minced'), '2 cloves, minced');
  assert.equal(standardizeAmount('1 cup (240 ml)'), '240 ml');
  assert.equal(standardizeAmount('  8 OZ  '), '225 g');
});

/* ---------- scaleAmount ---------- */

test('scaleAmount multiplies the quantity after standardizing', () => {
  assert.equal(scaleAmount('8 oz', 2), '455 g');
  assert.equal(scaleAmount('8 oz', 0.5), '115 g');
  assert.equal(scaleAmount('½ cup', 4), '480 ml');
  assert.equal(scaleAmount('2 cloves', 0.5), '1 clove');
  assert.equal(scaleAmount('2 cloves', 1.5), '3 cloves');
  assert.equal(scaleAmount('1 clove', 2), '2 cloves');
  assert.equal(scaleAmount('4 roma', 0.5), '2 roma');
  assert.equal(scaleAmount('1 bunch', 2), '2 bunches');
  assert.equal(scaleAmount('3 cups, cooked', 0.5), '360 ml, cooked');
  assert.equal(scaleAmount('2', 2), '4');
  assert.equal(scaleAmount('1', 2 / 3), '0.7');
  assert.equal(scaleAmount('12', 0.5), '6');
  assert.equal(scaleAmount('1.5 kg', 2), '3 kg');
  assert.equal(scaleAmount('800 g', 1.5), '1.2 kg');
});

test('scaleAmount leaves quantity-less text alone and treats a bad factor as 1', () => {
  assert.equal(scaleAmount('a pinch', 3), 'a pinch');
  assert.equal(scaleAmount('to taste', 0.5), 'to taste');
  assert.equal(scaleAmount('', 2), '');
  assert.equal(scaleAmount(null, 2), '');
  assert.equal(scaleAmount('8 oz', 1), '225 g');
  assert.equal(scaleAmount('8 oz', NaN), '225 g');
  assert.equal(scaleAmount('8 oz', 0), '225 g');
  assert.equal(scaleAmount('8 oz', undefined), '225 g');
});

/* ---------- servingsFor ---------- */

test('servingsFor sizes a pantry quantity by the food', () => {
  assert.equal(servingsFor('eggs', '24 pcs'), 24);
  assert.equal(servingsFor('eggs', '12'), 12);
  assert.equal(servingsFor('eggs', '1 dozen'), 12);
  near(servingsFor('spaghetti', '8 oz'), 2.5, 0.05);        // 226.8 g / 90 g
  near(servingsFor('jasmine rice', '2 lb'), 15.12);          // 907.2 g / 60 g
  near(servingsFor('milk', '1 gal'), 15.77);                 // 3785 ml / 240 ml
  near(servingsFor('parmesan', '8 oz'), 7.56);
  near(servingsFor('chicken thighs', '1.4 lb'), 4.23);       // "chicken" by word
  near(servingsFor('spinach', '5 oz'), 2.36);
  assert.equal(servingsFor('tomatoes', '6'), 6);
  assert.equal(servingsFor('cucumber', '2'), 2);
  near(servingsFor('olive oil', '500 ml'), 33.33);
  near(servingsFor('butter', '250 g'), 16.67);
  near(servingsFor('cheddar', '200 g'), 6.67);
  assert.equal(servingsFor('scallions', '4'), 4);
  near(servingsFor('basil', '25 g'), 5);
});

test('servingsFor matches keys by exact name, then trailing phrase, then word', () => {
  assert.equal(servingsFor('Red Bell Pepper', '3'), 3);        // "bell pepper" (1 pcs) beats "pepper"
  assert.equal(servingsFor('black pepper', '50 g'), 25);       // the spice, 2 g
  assert.equal(servingsFor('pepper', '2'), 2);                 // a bell pepper, 1 pcs
  near(servingsFor('chicken stock', '1 l'), 4.17);             // head noun "stock" (240 ml, a cup), not chicken
  near(servingsFor('rice vinegar', '250 ml'), 8.33);           // "vinegar", not rice
  near(servingsFor('greek yogurt', '450 g'), 3);
  assert.equal(servingsFor('red onion', '2'), 2);
  assert.equal(servingsFor('cherry tomato', '4'), 4);          // plural table key reached from a singular word
  assert.equal(servingsFor('egg', '6'), 6);
  near(servingsFor('arborio rice', '500 g'), 8.33);
  assert.equal(servingsFor('MYSTERY THING', '300 g'), 3);      // unknown food: 100 g default
  near(servingsFor('mystery', '480 ml'), 2);                   // 240 ml default
  assert.equal(servingsFor('mystery', '5'), 5);                // 1 pcs default
  assert.equal(servingsFor('', '300 g'), 3);
  assert.equal(servingsFor(null, '2'), 2);
});

test('servingsFor treats a head of garlic as ten cloves and refuses to guess packs', () => {
  assert.equal(servingsFor('garlic', '1 head'), 10);
  assert.equal(servingsFor('Garlic', '3 heads'), 30);
  assert.equal(servingsFor('garlic', '2 cloves'), 2);
  assert.equal(servingsFor('garlic', '4'), 4);
  assert.equal(servingsFor('onion', '1 head'), null);         // only garlic knows how many pieces a head is
  assert.equal(servingsFor('basil', '1 bunch'), null);
  assert.equal(servingsFor('anything', '1 pack'), null);
  assert.equal(servingsFor('eggs', '2 cartons'), null);
  assert.equal(servingsFor('anything', 'a pinch'), null);
  assert.equal(servingsFor('anything', ''), null);
  assert.equal(servingsFor('anything', null), null);
});

test('servingsFor bridges families sensibly when the quantity is in a different unit', () => {
  assert.equal(servingsFor('cherry tomatoes', '500 g'), 5);    // pcs food, mass given -> 100 g default
  near(servingsFor('greek yogurt', '1 L'), 6.67);              // g food, volume given -> g ≈ ml
  near(servingsFor('cream', '250 g'), 4.17);                   // ml food, mass given -> g ≈ ml
  assert.equal(servingsFor('milk', '2'), 2);                   // ml food, count given -> 1 pcs default
  assert.equal(servingsFor('eggs', { quantity: 24, unit: '' }), 24);   // chat-action shape
  assert.equal(servingsFor('eggs', { amount: 24, unit: 'pcs' }), 24);
});

test('serving tables are exported for callers that need the raw sizes', () => {
  assert.deepEqual(DEFAULT_SERVING, { g: 100, ml: 240, pcs: 1, pack: null });
  assert.deepEqual(SERVING_SIZES.eggs, { size: 1, unit: 'pcs' });
  assert.deepEqual(SERVING_SIZES.garlic, { size: 1, unit: 'pcs', head: 10 });
  assert.deepEqual(SERVING_SIZES.spaghetti, { size: 90, unit: 'g' });
});
