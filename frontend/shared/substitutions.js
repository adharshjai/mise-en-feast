/* mise en feast — offline ingredient substitutions (pure ESM; imports ingredients.js).

   "No heavy cream?" gets an answer even with no backend: a small table of the swaps
   a home cook reaches for, looked up with the same matcher that verifies recipes
   against the pantry, and annotated with whether they could do it from what they
   have. The shape mirrors what POST /substitutions returns, so the recipe sheet can
   render either source with one template:

     localSubstitutions(name, pantryNames) -> [{ use, ratio, note, from_pantry, pantry_names }]
     substitutionKey(name)                 -> the SUBSTITUTIONS key that answers `name`, or null

   `from_pantry` is true only when every food the swap names is in `pantryNames`
   (salt, pepper, water, oil and sugar are taken as always on hand, as the backend
   prompt does); `pantry_names` lists the pantry names it would use, exactly as given,
   so a cook can deduct them after making the dish. Pantry-based swaps come first. */

import { buildPantryIndex, matchIngredient, normalizeName } from './ingredients.js';

/** Offline fallback: the swap table, keyed by the ingredient a cook is out of. */
export const SUBSTITUTIONS = {
  'heavy cream': [
    { use: 'milk + butter', ratio: '¾ cup milk + ¼ cup melted butter per 1 cup', note: 'will not whip' },
    { use: 'greek yogurt', ratio: '1:1', note: 'tangier; add off the heat' },
  ],
  'buttermilk': [{ use: 'milk + lemon juice', ratio: '1 cup milk + 1 tbsp lemon or vinegar, rest 5 min' }],
  'butter': [{ use: 'olive oil', ratio: '¾ the amount' }],
  'sour cream': [{ use: 'greek yogurt', ratio: '1:1' }],
  'eggs': [{ use: 'flax egg', ratio: '1 tbsp ground flax + 3 tbsp water per egg', note: 'for binding, not for scrambles' }],
  'fresh herbs': [{ use: 'dried herbs', ratio: '⅓ the amount' }],
  'lemon juice': [{ use: 'white wine vinegar', ratio: '½ the amount' }],
  'garlic': [{ use: 'garlic powder', ratio: '⅛ tsp per clove' }],
  'onion': [{ use: 'shallot', ratio: '2 shallots per onion' }, { use: 'leek', ratio: 'white part, 1:1' }],
  'stock': [{ use: 'water + soy sauce', ratio: '1 cup water + 1 tsp soy' }],
  'parmesan': [{ use: 'pecorino', ratio: '1:1' }, { use: 'any hard aged cheese', ratio: '1:1' }],
  'soy sauce': [{ use: 'salt + a splash of vinegar', ratio: '¼ tsp salt per tbsp' }],
  'white wine': [{ use: 'stock + a squeeze of lemon', ratio: '1:1' }],
  'scallions': [{ use: 'chives', ratio: '1:1' }, { use: 'onion', ratio: 'a little, cooked' }],
  'tomatoes': [{ use: 'canned tomatoes', ratio: '1 can per 4 fresh' }],
  'spinach': [{ use: 'kale', ratio: '1:1, cook longer' }],
  'rice': [{ use: 'quinoa', ratio: '1:1' }, { use: 'couscous', ratio: '1:1, less water' }],
  'pasta': [{ use: 'any pasta shape', ratio: '1:1' }],
  'milk': [{ use: 'water + butter', ratio: '1 cup water + 1 tbsp butter' }],
  'chicken thighs': [{ use: 'chicken breast', ratio: '1:1, cook 2 min less' }],
  'feta': [{ use: 'goat cheese', ratio: '1:1' }],
};

/* ---------- which table row answers an ingredient ---------- */

// The table keys indexed like a pantry, so an ingredient finds its row the way it finds
// a pantry lot: exact name, then the alias table (whipping cream → heavy cream, green
// onions → scallions, penne → pasta), then token overlap on the same head noun.
const TABLE_INDEX = buildPantryIndex([], Object.keys(SUBSTITUTIONS));

// A bare herb ("fresh basil", "parsley") has no row of its own; the fresh-herbs row
// answers it. Only whole, fresh herbs: "dried oregano" carries a form and stays unmatched.
const HERBS = new Set(['basil', 'parsley', 'cilantro', 'coriander', 'dill', 'thyme', 'rosemary', 'oregano', 'mint', 'chive', 'tarragon', 'sage', 'marjoram']);
const FORM_WORDS = /\b(powder|paste|juice|zest|vinegar|sauce|oil|flour|starch|extract|seeds?|dried|canned|frozen|ground|chips?|syrup|jam)\b/;

function lookup(name) {
  const m = matchIngredient({ name }, TABLE_INDEX);
  return m ? m.key : null;
}

/** The SUBSTITUTIONS key that answers `ingredientName`, or null when the table has nothing for it. */
export function substitutionKey(ingredientName) {
  const norm = normalizeName(ingredientName);
  if (!norm) return null;
  const direct = lookup(norm);
  if (direct) return direct;
  const tokens = norm.split(' ');
  // "feta cheese", "parmesan cheese": the cheese is named by its first word
  if (tokens.length > 1 && tokens[tokens.length - 1] === 'cheese') {
    const bare = lookup(tokens.slice(0, -1).join(' '));
    if (bare) return bare;
  }
  if (!FORM_WORDS.test(norm) && tokens.some(t => HERBS.has(t))) return 'fresh herbs';
  return null;
}

/* ---------- which of a swap's foods the pantry has ---------- */

// "milk + butter", "milk, butter", "milk and butter", "milk & butter" -> the foods. The
// same separators backend/substitutions.py splits on, so both sides read a swap alike.
const SPLIT = /\s*(?:\+|,|&|\band\b)\s*/i;
// Words in a swap that say how much or which kind, not what: "a splash of vinegar" is vinegar.
const QUANTIFIERS = new Set(['a', 'an', 'the', 'some', 'any', 'of', 'splash', 'squeeze', 'dash', 'pinch', 'little', 'bit', 'drizzle', 'few', 'shape', 'kind', 'type', 'hard', 'aged', 'soft', 'melted', 'cooked']);
// Seasonings every kitchen has; they never decide from_pantry and are never deducted.
const STAPLES = new Set(['salt', 'pepper', 'water', 'oil', 'sugar', 'ice']);
// A lemon in the pantry covers "lemon juice" or "lemon zest": the cook makes the form.
const MADE_FROM = /\s(juice|zest)$/;

function foodOf(part) {
  const tokens = normalizeName(part).split(' ').filter(t => t && !QUANTIFIERS.has(t));
  return tokens.join(' ');
}

// "Milk (1 gal)", "Eggs 12 pcs": the size after a pantry name is not part of the food, and
// left in it would become the head noun the matcher compares.
const SIZE_TAIL = /\s*\([^)]*\)|\s+\d+(?:\.\d+)?\s*(?:gal|gallons?|l|liters?|litres?|ml|g|kg|oz|lbs?|pcs|packs?|ct|dozen|cups?)\b.*$/gi;
const cleanName = s => String(s ?? '').replace(SIZE_TAIL, '').trim();

// `pantryNames` may be plain names or pantry lots ({ key, name }); a lot's key is indexed
// too, the way buildPantryIndex does for the app, and its name is what pantry_names echoes.
function pantryIndexOf(pantryNames) {
  const names = new Map();   // index key → the pantry's own spelling
  const items = [];
  for (const entry of Array.isArray(pantryNames) ? pantryNames : []) {
    const obj = entry && typeof entry === 'object' ? entry : { name: entry };
    const label = String(obj.name ?? obj.key ?? '').trim();
    const key = String(obj.key ?? cleanName(label)).toLowerCase().trim();
    if (!key || names.has(key)) continue;
    names.set(key, label || key);
    items.push({ key, name: cleanName(label) || key });
  }
  return { index: buildPantryIndex(items), names };
}

// The pantry name a swap food resolves to, or null. `loose` (for "any hard aged cheese",
// "any pasta shape") also accepts a pantry entry that merely contains the head word, since
// "any cheese" is satisfied by a cheddar labelled "cheddar cheese".
function pantryNameFor(food, pantry, loose) {
  if (!food) return null;
  const tryMatch = name => { const m = matchIngredient({ name }, pantry.index); return m ? pantry.names.get(m.key) ?? m.key : null; };
  let hit = tryMatch(food);
  if (!hit && MADE_FROM.test(food)) hit = tryMatch(food.replace(MADE_FROM, ''));
  if (!hit && loose) {
    const head = food.split(' ').pop();
    const e = pantry.index.entries.find(x => x.tokens.includes(head));
    if (e) hit = pantry.names.get(e.key) ?? e.key;
  }
  return hit;
}

function annotate(entry, pantry) {
  const parts = String(entry.use || '').split(SPLIT).map(p => p.trim()).filter(Boolean);
  const pantryNamesUsed = [];
  let fromPantry = parts.length > 0;
  for (const part of parts) {
    const loose = /^any\b/i.test(part.trim());
    const food = foodOf(part);
    if (!food || STAPLES.has(food)) continue;
    const hit = pantryNameFor(food, pantry, loose);
    if (!hit) { fromPantry = false; continue; }
    if (!pantryNamesUsed.includes(hit)) pantryNamesUsed.push(hit);
  }
  return {
    use: entry.use,
    ratio: entry.ratio || '',
    note: entry.note || '',
    from_pantry: fromPantry && pantryNamesUsed.length > 0,
    pantry_names: pantryNamesUsed,
  };
}

/**
 * The table's swaps for `ingredientName`, each annotated with `from_pantry` (every food
 * it names is in `pantryNames`) and `pantry_names` (those foods, spelled as the pantry
 * spells them), pantry-based first and otherwise in the table's order. A swap that is
 * the ingredient itself (a chicken-breast row answering "chicken breast") is dropped.
 * Empty when the table has nothing for it.
 */
export function localSubstitutions(ingredientName, pantryNames = []) {
  const key = substitutionKey(ingredientName);
  if (!key) return [];
  const pantry = pantryIndexOf(pantryNames);
  const self = normalizeName(ingredientName);
  const out = (SUBSTITUTIONS[key] || [])
    .filter(e => e && e.use && normalizeName(e.use) !== self)
    .map(e => annotate(e, pantry));
  // stable: pantry-based first, the table's order within each half
  return out.map((s, i) => ({ s, i })).sort((a, b) => (Number(b.s.from_pantry) - Number(a.s.from_pantry)) || (a.i - b.i)).map(x => x.s);
}
