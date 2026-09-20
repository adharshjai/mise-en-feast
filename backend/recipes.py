"""
Recipe generation for Pantry: Gemini writes the dishes, we rank them.

Contract with the frontend (frontend/app/app.js → pantryForApi / dishFromApi):

    POST /recipes  { items: [PantryItem], count, max_missing, request, prefs? }
    →  { count, recipes: [ { title, cook_minutes, servings, difficulty,
                             ingredients: [ { name, amount, matched_name,
                                              servings_used, staple, have } ],
                             steps, uses_expiring, missing_count, coverage,
                             urgency_days } ] }

`prefs` is the household profile the frontend keeps in Supabase
user_metadata.pantry_prefs (or localStorage 'pantry.prefs.v1' in demo mode),
version 2 of the preferences contract, sent as-is:

    { version: 2, onboarded: bool,
      household: { adults: 1..8, kids: 0..6 },
      allergies: ['peanuts','tree-nuts','dairy','eggs','gluten','shellfish','fish','soy','sesame'],
      diet:      ['vegetarian','vegan','pescatarian','halal','kosher'],
      cuisines:  ['italian','mexican','indian','chinese','japanese','thai','mediterranean',
                  'american','middle-eastern','korean','french','latin'],
      maxMinutes: 0|20|30|45|60 (0 = any),
      skill: 'beginner'|'comfortable'|'confident',
      equipment: ['oven','stovetop','microwave','air-fryer','blender','slow-cooker','grill'],
      avoid: 'free text',
      shopping: 'weekly'|'twice-weekly'|'whenever' }

Every field is optional and falls back to the contract default; unknown fields
and unknown list values are ignored rather than rejected, so an older or newer
client never gets a 422 for its profile.

How prefs shape the result:
  HARD rules (in the prompt, and enforced again in rank()):
    allergies — never include the allergen or anything containing it. rank()
                drops any dish whose ingredient names trip ALLERGEN_KEYWORDS
                for the user's allergies, so a model slip never reaches the deck.
    diet      — spelled out plainly (vegan = no animal products, vegetarian =
                no meat or fish, pescatarian = fish ok no meat, halal / kosher
                = the usual exclusions).
  SOFT preferences (prompt only):
    cuisines (favour, don't restrict), maxMinutes, skill (beginner → few
    steps, common techniques), equipment (never require anything not listed),
    avoid (disliked ingredients), and servings = ceil(adults + 0.5 * kids).
  `shopping` is not used here; it drives the pantry's planning on the client.

The model is asked to cook from what is in the pantry and to lean on whatever
expires first. Ranking happens here, in plain Python, so the order on the deck
is deterministic: soonest-expiring ingredient first, then fewest missing items,
then best pantry coverage.
"""

from __future__ import annotations

import math
import os
import re
from typing import Iterable, Literal

from google.genai import types
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")


# ---------------------------------------------------------------------------
# Preferences contract (version 2) — keep in sync with frontend/shared/store.js
# ---------------------------------------------------------------------------

ALLERGENS = ("peanuts", "tree-nuts", "dairy", "eggs", "gluten", "shellfish", "fish", "soy", "sesame")
DIETS = ("vegetarian", "vegan", "pescatarian", "halal", "kosher")
CUISINES = (
    "italian", "mexican", "indian", "chinese", "japanese", "thai", "mediterranean",
    "american", "middle-eastern", "korean", "french", "latin",
)
EQUIPMENT = ("oven", "stovetop", "microwave", "air-fryer", "blender", "slow-cooker", "grill")
SKILLS = ("beginner", "comfortable", "confident")
SHOPPING = ("weekly", "twice-weekly", "whenever")
DEFAULT_EQUIPMENT = ("oven", "stovetop", "microwave")

# Same table as the frontend's ALLERGEN_KEYWORDS. Matched as substrings of the
# normalised (lowercase, punctuation-free) ingredient name, so 'anchov' catches
# anchovy and anchovies, 'noodle' catches noodles.
ALLERGEN_KEYWORDS: dict[str, tuple[str, ...]] = {
    "peanuts": ("peanut", "groundnut"),
    "tree-nuts": ("almond", "walnut", "cashew", "pecan", "pistachio", "hazelnut", "macadamia"),
    "dairy": ("milk", "cheese", "butter", "cream", "yogurt", "yoghurt", "parmesan", "feta", "mozzarella", "ghee"),
    "eggs": ("egg",),
    "gluten": ("wheat", "flour", "pasta", "spaghetti", "noodle", "bread", "couscous", "barley", "bulgur", "seitan", "soy sauce"),
    "shellfish": ("shrimp", "prawn", "crab", "lobster", "clam", "mussel", "oyster", "scallop"),
    "fish": ("fish", "salmon", "tuna", "cod", "anchov", "sardine", "trout", "tilapia"),
    "soy": ("soy", "tofu", "edamame", "tempeh", "miso"),
    "sesame": ("sesame", "tahini"),
}

# Phrases that contain a keyword but are not the allergen. They are blanked out
# of the name before matching. Kept short and on the side of caution: when in
# doubt an ingredient stays flagged.
_SAFE_PHRASES: dict[str, tuple[str, ...]] = {
    "dairy": (
        "coconut milk", "almond milk", "oat milk", "soy milk", "rice milk", "cashew milk",
        "coconut cream", "cashew cream", "cream of tartar",
        "peanut butter", "almond butter", "cashew butter", "cocoa butter", "apple butter",
        "butternut", "butter bean", "butter lettuce", "buttercup",
        "dairy free", "non dairy",
    ),
    "eggs": ("eggplant", "veggie", "egg free", "eggless"),
    "gluten": (
        "rice noodle", "glass noodle", "zucchini noodle",
        "rice flour", "almond flour", "chickpea flour", "corn flour", "cornflour", "coconut flour",
        "buckwheat", "spaghetti squash", "gluten free",
    ),
    "shellfish": ("oyster mushroom", "scalloped"),
}

# Plain-English hints for the prompt, so "never include dairy" also says what dairy means.
_ALLERGEN_HINTS: dict[str, str] = {
    "peanuts": "peanuts, peanut butter, peanut oil, satay sauce",
    "tree-nuts": "almonds, walnuts, cashews, pecans, pistachios, hazelnuts, macadamias, nut butters and nut milks",
    "dairy": "milk, cheese, butter, cream, yogurt, ghee, whey",
    "eggs": "whole eggs, egg wash, mayonnaise, meringue",
    "gluten": "wheat, flour, pasta, noodles, bread, couscous, barley, bulgur, seitan, regular soy sauce",
    "shellfish": "shrimp, prawns, crab, lobster, clams, mussels, oysters, scallops, oyster sauce",
    "fish": "any fish, fish sauce, anchovies, Worcestershire sauce",
    "soy": "soy sauce, tofu, edamame, tempeh, miso, soy milk",
    "sesame": "sesame seeds, sesame oil, tahini",
}

_DIET_RULES: dict[str, str] = {
    "vegan": "Vegan: no animal products at all. No meat, poultry, fish, seafood, eggs, dairy, honey or gelatin.",
    "vegetarian": "Vegetarian: no meat, poultry, fish or seafood, and no animal-based stock, gelatin or fish sauce.",
    "pescatarian": "Pescatarian: fish and seafood are fine; no meat or poultry, and no meat-based stock.",
    "halal": "Halal: no pork or pork products (bacon, ham, lard, pork gelatin), no alcohol in any form (no wine, beer or spirits in cooking), and any meat is assumed to be halal.",
    "kosher": "Kosher: no pork, no shellfish, and never meat and dairy in the same dish.",
}

_SKILL_NOTES: dict[str, str] = {
    "beginner": "The cook is a beginner: keep to a few steps and common techniques (boil, saute, bake, roast), nothing that needs juggling several pans or precise timing.",
    "comfortable": "The cook is comfortable in the kitchen: normal weeknight techniques are fine.",
    "confident": "The cook is confident: any technique is fine if the result is worth it.",
}


def _subset(values, allowed: Iterable[str]) -> list[str]:
    """Lowercased, de-duplicated, order-preserving; anything not in `allowed` is dropped."""
    if values is None:
        return []
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, (list, tuple, set)):
        return []
    allowed = set(allowed)
    out: list[str] = []
    for v in values:
        key = str(v).strip().lower()
        if key in allowed and key not in out:
            out.append(key)
    return out


def _clamp_int(value, default: int, lo: int, hi: int) -> int:
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


class Household(BaseModel):
    model_config = ConfigDict(extra="ignore")

    adults: int = 2
    kids: int = 0

    @model_validator(mode="before")
    @classmethod
    def _shape(cls, data):
        if data is None:
            return {}
        if isinstance(data, (int, float)) and not isinstance(data, bool):
            return {"adults": data}  # v1 shape: household was just a head count
        if isinstance(data, dict):
            return {k: v for k, v in data.items() if v is not None}
        if isinstance(data, Household):
            return data
        return {}  # anything else (a string, a list) means "use the defaults", not a 422

    @field_validator("adults", mode="before")
    @classmethod
    def _adults(cls, v):
        return _clamp_int(v, 2, 1, 8)

    @field_validator("kids", mode="before")
    @classmethod
    def _kids(cls, v):
        return _clamp_int(v, 0, 0, 6)


class Prefs(BaseModel):
    """The household profile (preferences contract v2). Every field is optional."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    version: int = 2
    onboarded: bool = False
    household: Household = Field(default_factory=Household)
    allergies: list[str] = Field(default_factory=list)
    diet: list[str] = Field(default_factory=list)
    cuisines: list[str] = Field(default_factory=list)
    max_minutes: int = Field(default=0, alias="maxMinutes")  # 0 = any
    skill: str = "comfortable"
    equipment: list[str] = Field(default_factory=lambda: list(DEFAULT_EQUIPMENT))
    avoid: str = ""
    shopping: str = "weekly"

    @model_validator(mode="before")
    @classmethod
    def _drop_nulls(cls, data):
        # A null from the client means "use the default", never a validation error.
        if isinstance(data, dict):
            return {k: v for k, v in data.items() if v is not None}
        if isinstance(data, Prefs):
            return data
        return {}  # a profile that is not an object at all: defaults, not a 422

    @field_validator("version", mode="before")
    @classmethod
    def _version(cls, v):
        return _clamp_int(v, 2, 1, 999)

    @field_validator("onboarded", mode="before")
    @classmethod
    def _onboarded(cls, v):
        if isinstance(v, str):
            return v.strip().lower() in ("1", "true", "yes")
        return bool(v)

    @field_validator("allergies", mode="before")
    @classmethod
    def _allergies(cls, v):
        return _subset(v, ALLERGENS)

    @field_validator("diet", mode="before")
    @classmethod
    def _diet(cls, v):
        return _subset(v, DIETS)

    @field_validator("cuisines", mode="before")
    @classmethod
    def _cuisines(cls, v):
        return _subset(v, CUISINES)

    @field_validator("equipment", mode="before")
    @classmethod
    def _equipment(cls, v):
        return _subset(v, EQUIPMENT)

    @field_validator("max_minutes", mode="before")
    @classmethod
    def _max_minutes(cls, v):
        return _clamp_int(v, 0, 0, 24 * 60)

    @field_validator("skill", mode="before")
    @classmethod
    def _skill(cls, v):
        key = str(v or "").strip().lower()
        return key if key in SKILLS else "comfortable"

    @field_validator("shopping", mode="before")
    @classmethod
    def _shopping(cls, v):
        key = str(v or "").strip().lower()
        return key if key in SHOPPING else "weekly"

    @field_validator("avoid", mode="before")
    @classmethod
    def _avoid(cls, v):
        if isinstance(v, (list, tuple)):
            v = ", ".join(str(x) for x in v)
        parts = [p.strip() for p in str(v or "").replace("\n", ",").split(",")]
        return ", ".join(p for p in parts if p)[:200]


def servings_target(prefs: Prefs | None) -> int:
    """How many the dishes should serve: ceil(adults + 0.5 * kids), at least 1."""
    if prefs is None:
        return 2
    return max(1, math.ceil(prefs.household.adults + 0.5 * prefs.household.kids))


# ---------------------------------------------------------------------------
# Shapes
# ---------------------------------------------------------------------------


class PantryItem(BaseModel):
    """One aggregated pantry row as the frontend sends it (lots are summed per food)."""

    id: str = ""
    name: str
    category: str = "other"
    quantity_servings: float = 1
    days_left: int = 999
    deadline_reason: str = "spoils"  # "spoils" or "runs out"
    is_food: bool = True
    group_key: str = ""
    variant: str = ""


class RecipeRequest(BaseModel):
    items: list[PantryItem]
    count: int = Field(default=6, ge=1, le=12)
    max_missing: int = Field(default=2, ge=0, le=6)
    request: str | None = None  # free-text preference, e.g. "vegetarian, under 30 minutes"
    prefs: Prefs | None = None  # the household profile (preferences contract v2)


class Ingredient(BaseModel):
    name: str = Field(description="Ingredient as it reads in the recipe, e.g. 'Spinach'.")
    amount: str = Field(default="", description="Human amount, e.g. '2 cups' or '4 eggs'.")
    matched_name: str = Field(
        default="",
        description="The pantry item this uses, copied EXACTLY from the pantry list, or '' if not in the pantry.",
    )
    servings_used: float = Field(default=1, description="Pantry servings this recipe consumes of that item.")
    staple: bool = Field(
        default=False,
        description="True for salt, pepper, oil, water, sugar, common dried spices: assumed on hand, never counted as missing.",
    )


class Recipe(BaseModel):
    title: str
    cook_minutes: int = Field(description="Total time from start to plate.")
    servings: int
    difficulty: Literal["easy", "medium", "hard"]
    ingredients: list[Ingredient]
    steps: list[str] = Field(description="Short, numbered-style steps a person can follow while cooking.")
    uses_expiring: list[str] = Field(
        default_factory=list,
        description="Pantry item names (exact) that this dish uses which expire within about five days.",
    )


class RecipeBatch(BaseModel):
    recipes: list[Recipe]


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

PROMPT = """You plan dinners from what is already in someone's kitchen.

PANTRY (name · servings on hand · days until it spoils or runs out):
{pantry}

Write {want} distinct dishes a normal home cook can make tonight.

Rules:
- Cook from the pantry. Every dish must use at least two pantry items, and the
  first few dishes must use the items with the fewest days left.
- Each dish may need at most {max_missing} ingredients that are NOT in the pantry
  and are not staples. Staples (salt, pepper, oil, water, sugar, dried spices)
  are assumed on hand: mark them staple = true and do not count them.
- For every ingredient that comes from the pantry, set matched_name to the
  pantry name EXACTLY as written above. Leave matched_name empty otherwise.
- servings_used is how many pantry servings the dish consumes of that item
  (a two-person pasta uses about 2 servings of pasta).
- Keep titles plain and appetizing ("Spinach and garlic pasta"), 2 to 5 words.
  No numbers in titles, no brand names.
- cook_minutes is realistic.
- Rate difficulty on this rubric, honestly: "easy" = one pan or pot, up to about five
  steps, nothing has to happen at the same time; "medium" = two components cooked
  in parallel, or a technique that needs attention such as searing, emulsifying,
  or reducing a sauce; "hard" = several components with precise timing, or an
  advanced technique such as dough, tempering, deep-frying or pastry. Most
  weeknight food is easy; do not call a dish easy because the cook is confident.
- Steps: 3 to 7 short imperative sentences, one action each.
- Vary the dishes: different main ingredients and cooking methods, not six
  versions of the same stir-fry.
{hard_rules}{preferences}{preference}"""


def _pantry_lines(items: list[PantryItem]) -> str:
    rows = []
    for it in sorted(items, key=lambda i: i.days_left):
        if not it.is_food or it.quantity_servings <= 0:
            continue
        when = f"{it.days_left} days" if it.days_left < 999 else "long shelf life"
        rows.append(f"- {it.name} · about {it.quantity_servings:g} servings · {when} ({it.deadline_reason})")
    return "\n".join(rows) if rows else "- (empty)"


def _label(key: str) -> str:
    return key.replace("-", " ")


def _join(words: list[str], conj: str = "and") -> str:
    words = [_label(w) for w in words]
    if len(words) <= 1:
        return "".join(words)
    return ", ".join(words[:-1]) + f" {conj} " + words[-1]


def _hard_rules(prefs: Prefs) -> str:
    """Allergies and diet: the block the model must never break."""
    lines: list[str] = []
    for key in prefs.allergies:
        hint = _ALLERGEN_HINTS.get(key, "")
        lines.append(f"- Never include {_label(key)} or anything containing it" + (f" ({hint})." if hint else "."))
    for key in prefs.diet:
        rule = _DIET_RULES.get(key)
        if rule:
            lines.append(f"- {rule}")
    if not lines:
        return ""
    return (
        "\nHARD RULES (never break these; a pantry item that breaks one must be left\n"
        "unused, even if it expires soon):\n" + "\n".join(lines) + "\n"
    )


def _preferences(prefs: Prefs) -> str:
    """Servings, cuisines, time, skill, equipment, dislikes: the block the model should favour."""
    n = servings_target(prefs)
    lines = [f"- Make every dish serve {n}: set servings = {n} and size the amounts for {n} people."]
    if prefs.cuisines:
        lines.append(f"- Cuisines they enjoy: {_join(prefs.cuisines)}. Favour these styles, but do not restrict every dish to them.")
    if prefs.max_minutes > 0:
        lines.append(f"- Keep every dish under {prefs.max_minutes} minutes from start to plate.")
    lines.append(f"- {_SKILL_NOTES.get(prefs.skill, _SKILL_NOTES['comfortable'])}")
    if prefs.equipment:
        missing = [e for e in EQUIPMENT if e not in prefs.equipment]
        line = f"- Equipment available: {_join(prefs.equipment)}."
        if missing:
            line += f" Do not require {_join(missing, 'or') if len(missing) <= 3 else 'anything else, in particular no ' + _join(missing, 'or')}."
        lines.append(line)
    else:
        lines.append("- Equipment available: none listed. Keep to no-cook dishes or ones that need nothing beyond a knife, a board and a bowl.")
    if prefs.avoid:
        lines.append(f"- Ingredients they dislike: {prefs.avoid}. Leave these out.")
    return "\nPREFERENCES:\n" + "\n".join(lines) + "\n"


def build_prompt(req: RecipeRequest) -> str:
    """The full prompt for a request. Pure, so it can be inspected without calling the model."""
    food = [i for i in req.items if i.is_food and i.quantity_servings > 0]
    preference = f"\nThe cook asked for: {req.request.strip()}" if req.request and req.request.strip() else ""
    hard_rules = _hard_rules(req.prefs) if req.prefs else ""
    preferences = _preferences(req.prefs) if req.prefs else ""
    return PROMPT.format(
        pantry=_pantry_lines(food),
        want=min(req.count + 2, 12),  # a couple of spares so ranking has something to drop
        max_missing=req.max_missing,
        hard_rules=hard_rules,
        preferences=preferences,
        preference=preference,
    )


def generate(req: RecipeRequest, client, model: str | None = None) -> list[dict]:
    """Ask Gemini for dishes. Returns plain dicts; ranking is done by rank()."""
    food = [i for i in req.items if i.is_food and i.quantity_servings > 0]
    if not food:
        return []

    response = client.models.generate_content(
        model=model or MODEL,
        contents=build_prompt(req),
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=RecipeBatch,
        ),
    )

    batch = response.parsed
    if batch is None:  # the SDK could not hydrate the schema; parse the text ourselves
        import json

        batch = RecipeBatch(**json.loads(response.text))

    return [r.model_dump() for r in batch.recipes]


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------

_WORD = re.compile(r"[a-z0-9]+")


def _norm(s: str) -> str:
    return " ".join(_WORD.findall((s or "").lower()))


def _tokens(s: str) -> set[str]:
    stop = {"fresh", "large", "small", "chopped", "sliced", "diced", "of", "the", "a", "and", "or"}
    return {t for t in _WORD.findall((s or "").lower()) if t not in stop and len(t) > 2}


def ingredient_hits(names: Iterable[str], allergies: Iterable[str]) -> list[str]:
    """The allergen keys (from `allergies`) that any of the ingredient names trips.

    Mirrors ingredientHits() in frontend/shared/store.js. Substring match on the
    normalised name, minus a few phrases that only look like the allergen
    (eggplant, peanut butter, coconut milk, oyster mushroom...).
    """
    texts = [_norm(n) for n in names if n]
    hits: list[str] = []
    for key in allergies:
        keywords = ALLERGEN_KEYWORDS.get(key)
        if not keywords:
            continue
        safe = _SAFE_PHRASES.get(key, ())
        for text in texts:
            for phrase in safe:
                text = text.replace(phrase, " ")
            if any(kw in text for kw in keywords):
                hits.append(key)
                break
    return hits


def _match(ingredient: dict, pantry: dict[str, PantryItem]) -> PantryItem | None:
    """Prefer the model's exact matched_name; fall back to token overlap on the ingredient name."""
    exact = _norm(ingredient.get("matched_name", ""))
    if exact and exact in pantry:
        return pantry[exact]
    words = _tokens(ingredient.get("name", ""))
    if not words:
        return None
    best, best_score = None, 0.0
    for key, item in pantry.items():
        overlap = len(words & _tokens(key))
        if overlap:
            score = overlap / max(len(words), 1)
            if score > best_score:
                best, best_score = item, score
    return best if best_score >= 0.5 else None


def rank(
    recipes: list[dict],
    max_missing: int,
    items: list[PantryItem] | None = None,
    prefs: Prefs | None = None,
) -> list[dict]:
    """Score, filter and order recipes. Adds have/missing_count/coverage/urgency_days.

    With `prefs`, any dish whose ingredients trip one of the user's allergies is
    dropped outright (staples included: "butter" or "sesame oil" marked as a
    staple is still the allergen), so a model slip never reaches the client.
    """
    pantry = {_norm(i.name): i for i in (items or []) if i.is_food}
    allergies = list(prefs.allergies) if prefs else []
    seen_titles: set[str] = set()
    ranked: list[dict] = []

    for r in recipes:
        title_key = _norm(r.get("title", ""))
        if not title_key or title_key in seen_titles:
            continue
        seen_titles.add(title_key)

        have = missing = 0
        urgency = 999
        expiring: list[str] = []
        for ing in r.get("ingredients", []):
            if ing.get("staple"):
                ing["have"] = True
                continue
            item = _match(ing, pantry) if pantry else None
            if item is None and not pantry and ing.get("matched_name"):
                item = PantryItem(name=ing["matched_name"])  # trust the model when we were not given a pantry
            if item is not None:
                ing["have"] = True
                ing["matched_name"] = item.name
                have += 1
                urgency = min(urgency, item.days_left)
                if item.days_left <= 5 and item.name not in expiring:
                    expiring.append(item.name)
            else:
                ing["have"] = False
                missing += 1

        if have == 0 or missing > max_missing:
            continue

        if allergies:
            names = []
            for ing in r.get("ingredients", []):
                names.append(ing.get("name", ""))
                names.append(ing.get("matched_name", ""))
            if ingredient_hits(names, allergies):
                continue  # unsafe for this household, whatever the model said

        r["missing_count"] = missing
        r["coverage"] = round(have / max(have + missing, 1), 3)
        r["urgency_days"] = urgency
        r["uses_expiring"] = expiring or list(r.get("uses_expiring", []) or [])
        ranked.append(r)

    ranked.sort(key=lambda r: (r["urgency_days"], r["missing_count"], -r["coverage"], r.get("cook_minutes", 0)))
    return ranked
