/* mise en feast — quantities and units (ES module: no DOM, no imports).

   Pantry quantities arrive as free text from three directions — the receipt
   scanner ("1.4 lb"), the add-by-hand form ("500 ml") and recipe ingredients
   ("½ cup", "2 cloves", "a pinch") — and the app needs one honest number out
   of each: how many servings it represents. Everything funnels through one
   pipeline so the pantry row, the recipe sheet and the made-it maths agree:

     parseQuantity(text)   -> { qty, unit, raw }         what was typed
     toCanonical(parsed)   -> { amount, unit, label? }   one unit per family: g, ml, pcs, pack
     formatQuantity(x)     -> "635 g" / "1.5 kg" / "2 cloves"
     standardizeAmount(t)  -> recipe amounts in metric, qualifier kept ("720 ml, cooked")
     scaleAmount(t, f)     -> the same, multiplied by a servings factor
     servingsFor(key, x)   -> servings, or null when we honestly cannot tell

   Descriptive count nouns that are not units ("4 roma", "2 cloves") become
   `pcs` with a `label`, so the display keeps the cook's wording. Packaging
   ("1 bunch", "2 jars") becomes `pack`, which servingsFor refuses to guess
   at — the caller falls back to the food catalog's package default. */

/** The add-form unit dropdown, in this order. 'L' is display casing; the parser is case-insensitive. */
export const UNIT_OPTIONS = ['g', 'kg', 'ml', 'L', 'pcs', 'pack'];

/* ---------- unit tables ---------- */

// canonical unit name -> family (what it converts to), factor, and whether the
// noun is worth keeping as a label ("2 cloves" reads better than "2 pcs").
const UNITS = {
  // mass -> g
  g: { family: 'g', factor: 1 },
  kg: { family: 'g', factor: 1000 },
  oz: { family: 'g', factor: 28.35 },
  lb: { family: 'g', factor: 453.6 },
  // volume -> ml
  ml: { family: 'ml', factor: 1 },
  l: { family: 'ml', factor: 1000 },
  tsp: { family: 'ml', factor: 5 },
  tbsp: { family: 'ml', factor: 15 },
  cup: { family: 'ml', factor: 240 },
  'fl oz': { family: 'ml', factor: 29.57 },
  pint: { family: 'ml', factor: 473 },
  quart: { family: 'ml', factor: 946 },
  gallon: { family: 'ml', factor: 3785 },
  // count -> pcs
  pcs: { family: 'pcs', factor: 1 },
  dozen: { family: 'pcs', factor: 12 },
  egg: { family: 'pcs', factor: 1, label: true },
  clove: { family: 'pcs', factor: 1, label: true },
  slice: { family: 'pcs', factor: 1, label: true },
  // packaging -> pack
  pack: { family: 'pack', factor: 1 },
  jar: { family: 'pack', factor: 1, label: true },
  bottle: { family: 'pack', factor: 1, label: true },
  can: { family: 'pack', factor: 1, label: true },
  bag: { family: 'pack', factor: 1, label: true },
  box: { family: 'pack', factor: 1, label: true },
  carton: { family: 'pack', factor: 1, label: true },
  tub: { family: 'pack', factor: 1, label: true },
  bunch: { family: 'pack', factor: 1, label: true },
  head: { family: 'pack', factor: 1, label: true },
  loaf: { family: 'pack', factor: 1, label: true },
  stick: { family: 'pack', factor: 1, label: true },
  packet: { family: 'pack', factor: 1, label: true },
};

const ALIASES = {
  g: ['gr', 'gm', 'gms', 'gram', 'grams', 'gramme', 'grammes'],
  kg: ['kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'],
  oz: ['ozs', 'ounce', 'ounces'],
  lb: ['lbs', 'pound', 'pounds'],
  ml: ['mls', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'cc'],
  l: ['lt', 'ltr', 'ltrs', 'liter', 'liters', 'litre', 'litres'],
  tsp: ['tsps', 'teaspoon', 'teaspoons'],
  tbsp: ['tbsps', 'tbs', 'tbl', 'tablespoon', 'tablespoons'],
  cup: ['cups'],
  'fl oz': ['floz', 'fluid ounce', 'fluid ounces', 'fl ounce', 'fl ounces'],
  pint: ['pints', 'pt', 'pts'],
  quart: ['quarts', 'qt', 'qts'],
  gallon: ['gallons', 'gal', 'gals'],
  pcs: ['pc', 'piece', 'pieces', 'ct', 'count', 'each', 'ea', 'whole', 'unit', 'units', 'item', 'items'],
  dozen: ['dozens', 'dz', 'doz'],
  egg: ['eggs'],
  clove: ['cloves'],
  slice: ['slices'],
  pack: ['packs', 'pk', 'pkg', 'pkgs', 'package', 'packages'],
  jar: ['jars'], bottle: ['bottles'], can: ['cans'], bag: ['bags'], box: ['boxes'], carton: ['cartons'],
  tub: ['tubs'], bunch: ['bunches'], head: ['heads'], loaf: ['loaves'], stick: ['sticks'], packet: ['packets'],
};

const ALIAS_INDEX = {};
for (const name of Object.keys(UNITS)) ALIAS_INDEX[name] = name;
for (const [name, list] of Object.entries(ALIASES)) for (const alias of list) ALIAS_INDEX[alias] = name;

// Plural spellings for the labels we keep; anything not listed is shown as typed.
const PLURAL = {
  egg: 'eggs', clove: 'cloves', slice: 'slices', pack: 'packs', jar: 'jars', bottle: 'bottles', can: 'cans',
  bag: 'bags', box: 'boxes', carton: 'cartons', tub: 'tubs', bunch: 'bunches', head: 'heads', loaf: 'loaves',
  stick: 'sticks', packet: 'packets',
};

/** Canonical unit name for any spelling we know ("Cups", "fl. oz.", "L"), else null. */
function resolveUnit(text) {
  const t = String(text == null ? '' : text).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  return ALIAS_INDEX[t] || null;
}

/* ---------- helpers ---------- */

const str = v => (v == null ? '' : String(v));
const num = v => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const round2 = n => Math.round(n * 100) / 100;
/** At most `d` decimals, trailing zeros dropped: 1.5 -> "1.5", 2 -> "2", 3.785 -> "3.8". */
const fmtNum = (n, d = 1) => Number(n.toFixed(d)).toString();

/** "2 cloves" / "1 clove"; unknown nouns lose a plural s only at exactly one ("1 breast"). */
function inflect(label, n) {
  if (n === 1) {
    if (PLURAL[label]) return label;
    return label.replace(/([^s])s$/, '$1');
  }
  return PLURAL[label] || label;
}

// Cooks read "225 g" and "90 ml" more easily than "226.8 g" and "88.7 ml":
// spoon-sized amounts keep half steps, anything up to a kilo/litre snaps to 5.
function roundMetric(n) {
  if (n < 10) return Math.max(n > 0 ? 0.5 : 0, Math.round(n * 2) / 2);
  return Math.round(n / 5) * 5;
}

/* ---------- parsing ---------- */

const FRACTIONS = {
  '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};
const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const FRAC = `[${Object.keys(FRACTIONS).join('')}]`;
const DEC = '(?:\\d*\\.\\d+|\\d+)';
// Leading number, in priority order: mixed "1 1/2" / "1-1/2" / "1½" / "1 ½", plain "1/2", lone "½", decimal "1.5" / ".5" / "12".
const LEAD_RE = new RegExp(`^(?:(\\d+)(?:[\\s-]+(\\d+)\\s*/\\s*(\\d+)|\\s*(${FRAC}))|(\\d+)\\s*/\\s*(\\d+)|(${FRAC})|(${DEC}))`);
// "2-3 cloves" / "2 to 3": keep the lower bound, drop the rest of the range.
const RANGE_RE = new RegExp(`^\\s*(?:-|–|—|to)\\s*${DEC}(?![\\d/])`);
const WORD_RE = /^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/;
const LOOSE_RE = /^(?:about|approx\.?|approximately|roughly|around|~)\s*/;
// "2 x 400 g", "2 (400 g) cans", "1 12 oz can": the second number carries the real unit.
const MULT_RE = new RegExp(`^\\s*([x×*]\\s*|\\(\\s*)?(${DEC})\\s*([a-z]+)(?:\\s+([a-z]+))?`);

/**
 * Read the leading quantity out of free text. Case-insensitive, tolerant of
 * trailing words ("8 oz pack", "3 cups, cooked", "12 large eggs").
 * @returns {{ qty: number|null, unit: string|null, raw: string }} `unit` is the
 *   canonical spelling of a unit we know ('oz', 'cup', 'fl oz', 'clove', 'pcs', 'bunch', …)
 *   or, for a descriptive count noun, the noun itself ('roma'). `qty` is null when
 *   there is no number ("a pinch", "to taste", "").
 */
export function parseQuantity(text) {
  const raw = str(text).trim();
  // thousands separators and odd whitespace get in the way of the number regexes
  let s = raw.replace(/(\d),(\d{3})\b/g, '$1$2').replace(/\s+/g, ' ').toLowerCase().replace(LOOSE_RE, '');
  let qty, article = false;
  const m = LEAD_RE.exec(s);
  if (m) {
    if (m[1] != null) qty = Number(m[1]) + (m[2] != null ? Number(m[2]) / (Number(m[3]) || 1) : FRACTIONS[m[4]]);
    else if (m[5] != null) qty = Number(m[5]) / (Number(m[6]) || 1);
    else if (m[7] != null) qty = FRACTIONS[m[7]];
    else qty = Number(m[8]);
    s = s.slice(m[0].length).replace(RANGE_RE, '');
  } else {
    const w = WORD_RE.exec(s);
    if (!w) return { qty: null, unit: null, raw };
    article = w[1] === 'a' || w[1] === 'an';
    qty = article ? 1 : WORD_NUMBERS[w[1]];
    s = s.slice(w[0].length);
  }

  const x = MULT_RE.exec(s);
  if (x) {
    const unit = (x[4] && resolveUnit(`${x[3]} ${x[4]}`)) || resolveUnit(x[3]);
    // An explicit "x" multiplies anything ("2 x 6 eggs"); a bare or bracketed
    // second number only when it carries a weight or volume ("2 (400 g) cans"),
    // so "12 (1 dozen)" stays 12.
    const explicit = x[1] != null && x[1][0] !== '(';
    if (unit && (explicit || UNITS[unit].family === 'g' || UNITS[unit].family === 'ml')) {
      return { qty: qty * Number(x[2]), unit, raw };
    }
  }

  // Words before a comma or bracket, minus a stray multiplier sign and anything after "of".
  let words = s.split(/[,(]/)[0].split(' ').map(w => w.replace(/^[^a-z]+|[^a-z]+$/g, '')).filter(Boolean);
  if (words[0] === 'x') words = words.slice(1);
  const of = words.indexOf('of');
  if (of >= 0) words = words.slice(0, of);
  // The unit is usually the first word, but adjectives sneak in ("12 large eggs").
  for (let i = 0; i < Math.min(3, words.length); i++) {
    const unit = (i + 1 < words.length && resolveUnit(`${words[i]} ${words[i + 1]}`)) || resolveUnit(words[i]);
    if (unit) return { qty, unit, raw };
  }
  // "a pinch": an article only counts as 1 in front of a unit we know
  if (article) return { qty: null, unit: null, raw };
  const label = words.slice(0, 3).join(' ');
  return { qty, unit: label || null, raw };
}

/**
 * Convert a parsed quantity (or raw text, or any `{ amount|qty|quantity, unit, label? }`
 * object such as a chat action) into one unit per family.
 * @returns {{ amount: number|null, unit: 'g'|'ml'|'pcs'|'pack'|null, label?: string }}
 *   `label` (singular, lowercase) is present for descriptive counts ('clove', 'roma')
 *   and named packaging ('bunch', 'jar') so formatting can keep the cook's word.
 */
export function toCanonical(input) {
  const p = (input == null || typeof input !== 'object') ? parseQuantity(input) : input;
  const qty = num(p.qty ?? p.amount ?? p.quantity);
  if (qty == null) return { amount: null, unit: null };
  const unitText = str(p.unit).trim();
  const name = resolveUnit(unitText);
  const def = name ? UNITS[name] : null;
  const out = { amount: qty * (def ? def.factor : 1), unit: def ? def.family : 'pcs' };
  let label = null;
  if (def) { if (def.label) label = name; }
  else if (unitText) label = unitText.toLowerCase();      // "4 roma": not a unit, keep the noun
  if (p.label != null && str(p.label).trim()) {          // a canonical object handed back to us
    const known = resolveUnit(p.label);
    label = known && UNITS[known].label ? known : str(p.label).trim().toLowerCase();
  }
  if (label && (out.unit === 'pcs' || out.unit === 'pack')) out.label = label;
  return out;
}

/** Render a canonical object. Shared by formatQuantity, standardizeAmount and scaleAmount. */
function formatCanonical({ amount, unit, label }) {
  const n = Math.max(0, amount);
  if (unit === 'g' || unit === 'ml') {
    const r = roundMetric(n);
    if (n >= 1000 || r >= 1000) return `${fmtNum(n / 1000, 1)} ${unit === 'g' ? 'kg' : 'L'}`;
    return `${fmtNum(r, 1)} ${unit}`;
  }
  const q = fmtNum(n, 1);
  const shown = Number(q);
  if (unit === 'pcs') return label ? `${q} ${inflect(label, shown)}` : `${q} pcs`;
  return `${q} ${inflect(label || 'pack', shown)}`;
}

/**
 * Human display of a quantity: "635 g", "1.5 kg", "500 ml", "3.8 L", "6 pcs",
 * "2 packs", "2 cloves". Takes a canonical object, a parsed object or raw text;
 * text that carries no number comes back trimmed as it was ("a pinch").
 * Idempotent: formatQuantity(formatQuantity(x)) === formatQuantity(x).
 */
export function formatQuantity(input) {
  const c = toCanonical(input);
  if (c.amount == null) {
    if (typeof input === 'string') return input.trim();
    return input && typeof input.raw === 'string' ? input.raw.trim() : '';
  }
  return formatCanonical(c);
}

/** Anything after the first comma is a qualifier worth keeping ("3 cups, cooked"). */
function qualifier(text) {
  const i = text.indexOf(',');
  if (i < 0) return '';
  const tail = text.slice(i + 1).trim();
  return tail ? `, ${tail}` : '';
}

/**
 * Recipe ingredient amounts in metric: "8 oz" -> "225 g", "½ cup" -> "120 ml",
 * "2 cloves" -> "2 cloves", "3 cups, cooked" -> "720 ml, cooked". A bare number
 * stays bare ("2") because the ingredient name already carries the noun.
 */
export function standardizeAmount(text) {
  return scaleAmount(text, 1);
}

/**
 * Scale the leading number of a recipe amount (after standardizing) by `factor`
 * and re-format; text without a quantity is returned trimmed, untouched.
 */
export function scaleAmount(text, factor) {
  const raw = str(text).trim();
  if (!raw) return '';
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const p = parseQuantity(raw);
  if (p.qty == null) return raw;
  const tail = qualifier(raw.replace(/(\d),(\d{3})\b/g, '$1$2'));
  if (p.unit == null) return fmtNum(p.qty * f, 1) + tail;
  const c = toCanonical(p);
  c.amount *= f;
  return formatCanonical(c) + tail;
}

/* ---------- servings ---------- */

/** One serving in canonical units when we know nothing about the food. `pack` is a shrug. */
export const DEFAULT_SERVING = { g: 100, ml: 240, pcs: 1, pack: null };

const S = (size, unit, extra = null) => (extra ? { size, unit, ...extra } : { size, unit });
/**
 * One serving per food, keyed by the pantry key (or its head noun). Matching is
 * exact key first, then the longest trailing phrase ("red bell pepper" ->
 * "bell pepper"), then earlier words; plurals are tried both ways.
 */
export const SERVING_SIZES = {
  eggs: S(1, 'pcs'), milk: S(240, 'ml'), cream: S(60, 'ml'), yogurt: S(150, 'g'), yoghurt: S(150, 'g'), butter: S(15, 'g'),
  cheese: S(30, 'g'), parmesan: S(30, 'g'), feta: S(30, 'g'), cheddar: S(30, 'g'), mozzarella: S(30, 'g'),
  rice: S(60, 'g'), 'jasmine rice': S(60, 'g'), 'arborio rice': S(60, 'g'), basmati: S(60, 'g'),
  pasta: S(90, 'g'), spaghetti: S(90, 'g'), penne: S(90, 'g'), noodles: S(90, 'g'),
  bread: S(50, 'g'), flour: S(60, 'g'), oats: S(40, 'g'),
  chicken: S(150, 'g'), beef: S(150, 'g'), pork: S(150, 'g'), lamb: S(150, 'g'), turkey: S(150, 'g'),
  fish: S(150, 'g'), salmon: S(150, 'g'), shrimp: S(150, 'g'), tofu: S(150, 'g'),
  spinach: S(60, 'g'), kale: S(60, 'g'), lettuce: S(60, 'g'), 'spring mix': S(60, 'g'), greens: S(60, 'g'),
  tomatoes: S(1, 'pcs'), onion: S(1, 'pcs'), 'red onion': S(1, 'pcs'), cucumber: S(1, 'pcs'), potato: S(1, 'pcs'),
  apple: S(1, 'pcs'), banana: S(1, 'pcs'), lemon: S(1, 'pcs'), lime: S(1, 'pcs'), avocado: S(1, 'pcs'),
  pepper: S(1, 'pcs'), 'bell pepper': S(1, 'pcs'),
  garlic: S(1, 'pcs', { head: 10 }),      // a clove is a serving; a head holds about ten
  mushrooms: S(75, 'g'), carrots: S(1, 'pcs'),
  'olive oil': S(15, 'ml'), oil: S(15, 'ml'),
  'soy sauce': S(30, 'ml'), vinegar: S(30, 'ml'), stock: S(240, 'ml'), broth: S(240, 'ml'),   // a serving of stock is a cup, not a splash
  spices: S(2, 'g'), cumin: S(2, 'g'), paprika: S(2, 'g'), 'chili flakes': S(2, 'g'), salt: S(2, 'g'), 'black pepper': S(2, 'g'),
  olives: S(30, 'g'), beans: S(120, 'g'), chickpeas: S(120, 'g'), lentils: S(120, 'g'),
  broccoli: S(100, 'g'), cauliflower: S(100, 'g'),
  scallions: S(1, 'pcs'), basil: S(5, 'g'), herbs: S(5, 'g'),
};

const singular = w => w.replace(/ies$/, 'y').replace(/(sh|ch|ss|x|o)es$/, '$1').replace(/([^s])s$/, '$1');
const sizeFor = w => SERVING_SIZES[w] || SERVING_SIZES[singular(w)] || SERVING_SIZES[`${w}s`] || SERVING_SIZES[`${w}es`] || null;

function lookupServing(key) {
  const norm = str(key).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  const words = norm.split(' ');
  const candidates = [];
  for (let i = 0; i < words.length; i++) candidates.push(words.slice(i).join(' '));   // whole key, then down to the head noun
  for (let i = 0; i < words.length - 1; i++) candidates.push(words[i]);               // then the describing words alone
  for (const c of candidates) { const hit = sizeFor(c); if (hit) return hit; }
  return null;
}

/**
 * How many servings a pantry quantity represents for the food `key`, or null
 * when the text has no number or is packaging we cannot size ("1 bunch" — the
 * caller uses the catalog's package default). "1 head" of garlic is 10 servings.
 * When the quantity's family differs from the food's serving unit, g and ml are
 * treated as interchangeable and pcs falls back to the family default.
 */
export function servingsFor(key, text) {
  const c = toCanonical(text);
  if (c.amount == null || !c.unit) return null;
  const entry = lookupServing(key);
  if (c.unit === 'pack') {
    if (entry && entry.head && c.label === 'head') return round2((c.amount * entry.head) / entry.size);
    return null;
  }
  let per;
  if (entry && entry.unit === c.unit) per = entry.size;
  else if (entry && entry.unit !== 'pcs' && c.unit !== 'pcs') per = entry.size;   // g ≈ ml for the foods we list
  else per = DEFAULT_SERVING[c.unit];
  return round2(c.amount / per);
}
