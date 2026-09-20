/* mise en feast — ingredient ↔ pantry matching (pure ESM: no DOM, no imports).
   A recipe says "Roma tomatoes"; the pantry says "tomatoes". This module decides
   whether they are the same food. It runs at read time, so a pantry change
   re-verifies every recipe, and it only answers *which* pantry key an ingredient
   maps to — how much of it there is stays with the caller.

   buildPantryIndex(items, extraKeys) → an index over the pantry's `key` and `name`
   values plus `extraKeys` (the app's catalog keys, so an ingredient nobody has
   still resolves to its canonical key and can be reported as missing).
   matchIngredient({ name, matched_name }, index) → { key, approx } or null.
   `approx` is true when the match is a stand-in from the same family (a chicken
   breast for their chicken thighs, penne for their spaghetti) so the UI can say
   "using your chicken thighs". */

/* ---------- normalisation ---------- */

// Words that describe the item without changing what it is.
const FILLER = new Set([
  'fresh', 'organic', 'org', 'large', 'small', 'medium', 'chopped', 'sliced', 'diced', 'minced',
  'whole', 'raw', 'ripe', 'baby', 'boneless', 'skinless',
]);

// Plurals that the suffix rules would get wrong.
const IRREGULAR = { leaves: 'leaf', loaves: 'loaf', halves: 'half', tomatoes: 'tomato', potatoes: 'potato' };

/** One token to its singular: tomatoes→tomato, berries→berry, leaves→leaf, eggs→egg. */
export function singular(word) {
  const w = String(word || '');
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2);
  if (w.length > 4 && /(ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Lowercase, punctuation stripped, tokens singularised, filler dropped: "Fresh Roma tomatoes, chopped" → "roma tomato". */
export function normalizeName(text) {
  const head = String(text || '').toLowerCase().split(',')[0];   // "Tomatoes, roma" — the qualifier after the comma is not the food
  return head
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(t => t && !/^\d+$/.test(t))
    .map(singular)
    .filter(t => !FILLER.has(t))
    .join(' ');
}

/* ---------- forms: the same word, a different product ---------- */

// An ingredient carrying one of these that the pantry entry lacks (or vice versa) is a
// different thing: tomato paste is not tomatoes, lime juice is not a lime.
const FORMS = new Set(['powder', 'paste', 'juice', 'zest', 'vinegar', 'sauce', 'oil', 'flour', 'starch', 'extract', 'seed', 'dried', 'canned', 'frozen', 'chip', 'syrup', 'jam']);
// "ground" changes a meat (ground beef ≠ beef) but not a spice (ground cumin is cumin). This is
// a deliberate narrowing of the brief's list, where `ground` was unconditional: the cumin, paprika
// or coriander in a pantry jar is ground already, so a recipe's "ground cumin" must find it.
const MEATS = new Set(['beef', 'pork', 'turkey', 'chicken', 'lamb', 'veal', 'meat', 'sausage']);
// Two-word products whose head word is a food on its own: coconut milk is not milk.
const PAIR_FORMS = {
  milk: ['coconut', 'almond', 'oat', 'soy', 'cashew', 'rice', 'condensed', 'evaporated'],
  butter: ['peanut', 'almond', 'cashew', 'cocoa', 'apple'],
  cream: ['ice', 'sour'],
};

function formsOf(tokens) {
  const set = new Set();
  const head = tokens[tokens.length - 1];
  tokens.forEach((t, i) => {
    if (FORMS.has(t)) set.add(t);
    if (t === 'ground' && MEATS.has(head)) set.add('ground');
    const pre = PAIR_FORMS[t];
    if (pre && i > 0 && pre.includes(tokens[i - 1])) set.add(`${tokens[i - 1]} ${t}`);
  });
  return set;
}
const sameForms = (a, b) => a.size === b.size && [...a].every(f => b.has(f));

/* ---------- aliases: different names for the same food ---------- */

// Each group is one food. A `family` group holds substitutes rather than synonyms:
// any member stands in for any other, flagged approx so the UI can say so. Two
// different groups never match each other, which is what keeps red onion its own
// thing and arborio out of a jasmine-rice recipe.
const ALIAS_GROUPS = [
  { names: ['scallions', 'green onions', 'spring onions', 'scallion'] },
  { names: ['cilantro', 'coriander', 'coriander leaves'] },
  { names: ['bell pepper', 'capsicum', 'sweet pepper'] },
  { names: ['zucchini', 'courgette'] },
  { names: ['eggplant', 'aubergine'] },
  { names: ['chickpeas', 'garbanzo beans', 'garbanzos'] },
  { names: ['parmesan', 'parmigiano', 'parmigiano reggiano', 'parmesan cheese'] },
  { names: ['stock', 'broth', 'chicken stock', 'chicken broth', 'vegetable stock', 'vegetable broth', 'beef stock', 'beef broth'] },
  { names: ['rice', 'jasmine rice', 'basmati rice', 'long grain rice', 'white rice', 'long grain white rice'] },
  { names: ['arborio rice', 'risotto rice', 'carnaroli rice', 'arborio'] },
  { names: ['heavy cream', 'cream', 'double cream', 'whipping cream', 'heavy whipping cream', 'single cream'] },
  { names: ['tomato', 'tomatoes', 'roma tomatoes', 'cherry tomatoes', 'plum tomatoes', 'grape tomatoes', 'vine tomatoes'] },
  { names: ['onion', 'yellow onion', 'white onion', 'brown onion'] },
  { names: ['red onion', 'red onions'] },
  { names: ['garlic', 'garlic cloves', 'cloves garlic', 'clove of garlic', 'cloves of garlic'] },
  { names: ['eggs', 'egg'] },
  { names: ['chicken', 'chicken thighs', 'chicken breast', 'chicken breasts', 'chicken drumsticks', 'chicken legs', 'chicken wings', 'chicken tenders'], family: 'chicken' },
  { names: ['pasta', 'spaghetti', 'penne', 'linguine', 'fettuccine', 'rigatoni', 'fusilli', 'farfalle', 'macaroni', 'orzo', 'tagliatelle', 'pappardelle', 'bucatini', 'ziti', 'rotini', 'gemelli', 'cavatappi'], family: 'pasta' },
];
const ALIAS = new Map();          // normalised name → group index
const FAMILY = new Map();         // group index → family name (only for family groups)
ALIAS_GROUPS.forEach((g, gi) => {
  for (const n of g.names) { const k = normalizeName(n); if (k && !ALIAS.has(k)) ALIAS.set(k, gi); }
  if (g.family) FAMILY.set(gi, g.family);
});
// Cuts that make "chicken <cut>" a member of the chicken family even when unlisted.
const CHICKEN_CUTS = new Set(['chicken', 'thigh', 'breast', 'drumstick', 'leg', 'wing', 'tender', 'cutlet', 'fillet', 'quarter', 'tenderloin']);
const PASTA_GROUP = ALIAS.get('pasta');
const CHICKEN_GROUP = ALIAS.get('chicken');

function groupOf(norm, tokens, forms) {
  if (ALIAS.has(norm)) return ALIAS.get(norm);
  if (forms.size) return null;   // "chicken stock", "rice vinegar": the form is the food, not the family
  const head = tokens[tokens.length - 1];
  if (tokens.includes('chicken') && CHICKEN_CUTS.has(head)) return CHICKEN_GROUP;
  if (ALIAS.get(head) === PASTA_GROUP) return PASTA_GROUP;   // "whole wheat penne"
  return null;
}

/* ---------- the index ---------- */

function entryFor(text, key, inPantry) {
  const norm = normalizeName(text);
  if (!norm) return null;
  const tokens = norm.split(' ');
  const forms = formsOf(tokens);
  return { norm, key, tokens, head: tokens[tokens.length - 1], forms, group: groupOf(norm, tokens, forms), inPantry };
}

/**
 * Index the pantry (its `key` and `name` values) plus `extraKeys` (the catalog).
 * Pantry entries are added first, so when a name could mean two keys the one they
 * actually have wins.
 */
export function buildPantryIndex(items = [], extraKeys = []) {
  const byNorm = new Map();
  const entries = [];
  const seen = new Set();
  const add = (text, key, inPantry) => {
    const e = entryFor(text, key, inPantry);
    if (!e) return;
    const id = `${e.norm}|${e.key}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push(e);
    if (!byNorm.has(e.norm)) byNorm.set(e.norm, e.key);
  };
  for (const it of items || []) {
    if (!it) continue;
    const key = String(it.key || it.name || '').toLowerCase().trim();
    if (!key) continue;
    add(key, key, true);
    if (it.name) add(it.name, key, true);
  }
  for (const k of extraKeys || []) { const key = String(k || '').toLowerCase().trim(); if (key) add(key, key, false); }
  return { entries, byNorm };
}

/* ---------- matching ---------- */

// When several pantry rows fit, prefer one they actually have, then the more generic name.
const better = (a, b) => !b || (a.inPantry && !b.inPantry) || (a.inPantry === b.inPantry && a.tokens.length < b.tokens.length);

/**
 * Rules, in order: (1) the model's `matched_name`, verbatim; (2) the alias table;
 * (3) token overlap with the same head noun and no form conflict.
 */
export function matchIngredient(ingredient, index) {
  const ing = typeof ingredient === 'string' ? { name: ingredient } : (ingredient || {});
  if (!index || !Array.isArray(index.entries)) return null;
  // 1. the model already named the pantry row it meant
  const mn = normalizeName(ing.matched_name);
  if (mn && index.byNorm.has(mn)) return { key: index.byNorm.get(mn), approx: false };
  const norm = normalizeName(ing.name);
  if (!norm) return null;
  if (index.byNorm.has(norm)) return { key: index.byNorm.get(norm), approx: false };
  const tokens = norm.split(' ');
  const forms = formsOf(tokens);
  const group = groupOf(norm, tokens, forms);
  // 2. another name for the same food, or a substitute from the same family
  if (group != null) {
    let best = null;
    for (const e of index.entries) {
      if (e.group !== group || !sameForms(forms, e.forms)) continue;
      if (better(e, best)) best = e;
    }
    if (best) return { key: best.key, approx: FAMILY.has(group) };
  }
  // 3. the same head noun and enough words in common
  const head = tokens[tokens.length - 1];
  let best = null, bestScore = 0;
  for (const e of index.entries) {
    if (e.head !== head) continue;
    if (group != null && e.group != null && e.group !== group) continue;   // red onion is not onion
    if (!sameForms(forms, e.forms)) continue;
    const common = tokens.filter(t => e.tokens.includes(t)).length;
    const score = common / Math.min(tokens.length, e.tokens.length);
    if (score <= 0.5) continue;
    if (score > bestScore || (score === bestScore && better(e, best))) { best = e; bestScore = score; }
  }
  return best ? { key: best.key, approx: false } : null;
}
