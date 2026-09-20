"""
Recipe generation for mise en feast: Gemini writes the dishes, we rank them.

Two model calls, not one. The first asks only for dish ideas — a title, the one
pantry item the dish is built around, and a line on why it is worth cooking
tonight. The second turns those ideas into recipes. Asked for six recipes in a
single call the model writes six variations of the same weeknight stir-fry, and
since Gemini 3.x ignores temperature, anchoring each idea to a different
tradition up front is the only reliable way to get variety.

The model proposes dishes and names ingredients; Python decides `have` and
`missing` by matching those names back to real pantry rows (see rank()). That
way a card on screen can never claim you own garlic when you don't.

Contract with the frontend (frontend/app/app.js → pantryForApi / dishFromApi):

    POST /recipes  { items: [PantryItem], count, max_missing, request, prefs? }
    →  { count, recipes: [ { title, description, cook_minutes, servings,
                             difficulty,
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
      shopping: 'weekly'|'twice-weekly'|'whenever',
      liked:    ['dish titles they rated up'],      # at most 30, 80 chars each
      disliked: ['dish titles they rated down'] }   # same limits (see clean_titles)

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
                = the usual exclusions). rank() drops any dish whose ingredient
                names break one, the same check the frontend does.
  SOFT preferences (prompt only):
    cuisines (favour, don't restrict), maxMinutes, skill (beginner → few
    steps, common techniques), equipment (never require anything not listed),
    avoid (disliked ingredients), servings = ceil(adults + 0.5 * kids),
    liked (dishes they rated up: make more like these) and disliked (dishes
    they rated down: not these or close variants). rank() also drops any dish
    whose normalised title equals a disliked title, so a repeat never reaches
    the deck even when the model ignores the note.
  `shopping` is not used here; it drives the pantry's planning on the client.

The model is asked to cook from what is in the pantry and to lean on whatever
expires first. Ranking happens here, in plain Python, so the order on the deck
is deterministic: soonest-expiring ingredient first, then fewest missing items,
then best pantry coverage.
"""

from __future__ import annotations

import math
import os
import random
import re
from typing import Iterable, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

import llm

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
    # Named cheeses are spelled out: "cheddar" and "ricotta" never contain the
    # word cheese, and a dairy allergy that misses them is the dangerous kind.
    "dairy": (
        "milk", "cheese", "butter", "cream", "creme", "yogurt", "yoghurt", "ghee",
        "whey", "casein", "custard", "kefir", "curd", "gelato",
        "parmesan", "feta", "mozzarella", "cheddar", "brie", "camembert", "gouda",
        "gruyere", "provolone", "ricotta", "mascarpone", "halloumi", "paneer",
        "queso", "cotija", "pecorino", "asiago", "manchego", "gorgonzola",
        "roquefort", "stilton", "havarti", "colby", "burrata", "romano",
    ),
    "eggs": ("egg",),
    "gluten": ("wheat", "flour", "pasta", "spaghetti", "noodle", "bread", "couscous", "barley", "bulgur", "seitan", "soy sauce"),
    "shellfish": ("shrimp", "prawn", "crab", "lobster", "clam", "mussel", "oyster", "scallop"),
    "fish": ("fish", "salmon", "tuna", "cod", "anchov", "sardine", "trout", "tilapia"),
    "soy": ("soy", "tofu", "edamame", "tempeh", "miso"),
    "sesame": ("sesame", "tahini"),
}

# A plant milk, cream, butter, yogurt or cheese is not dairy. One rule for the
# whole family, the same one FALSE_FRIENDS uses in frontend/shared/store.js, so
# a new alternative does not have to be added in two places. The nut word is
# kept, so peanut butter still trips the peanut allergy.
_ALT_DAIRY = re.compile(
    r"\b(coconut|almond|oat|soy|rice|cashew|peanut|hazelnut|macadamia|cocoa|shea|nut|plant)"
    r"[ -]+(milk|cream|creamer|butter|yogurt|yoghurt|cheese)\b"
)

# Phrases that contain a keyword but are not the allergen. They are blanked out
# of the name before matching. Kept short and on the side of caution: when in
# doubt an ingredient stays flagged.
_SAFE_PHRASES: dict[str, tuple[str, ...]] = {
    "dairy": (
        "cream of tartar", "apple butter",
        "butternut", "butter bean", "butter lettuce", "buttercup",
        "bean curd",  # tofu, not a cheese curd
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


# Same class as chat._CONTROL: tab and newline are kept so split() turns them into a space.
_TITLE_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def clean_titles(values, limit: int = 30, max_len: int = 80) -> list[str]:
    """Dish titles as the client keeps them (Prefs.liked / disliked): trimmed, inner
    whitespace collapsed, no control characters, at most `max_len` chars each,
    de-duplicated on the normalised form (case and punctuation ignored, the first
    spelling kept), at most `limit` kept. The client writes the newest ratings
    first, so a long list loses its oldest entries. A bare string is one title;
    anything that is not a list of strings means "none", never a 422."""
    if values is None:
        return []
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, (list, tuple, set)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for v in values:
        if not isinstance(v, str):
            continue
        title = " ".join(_TITLE_CONTROL.sub("", v).split())[:max_len].strip()
        key = _norm(title)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(title)
        if len(out) >= limit:
            break
    return out


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
    liked: list[str] = Field(default_factory=list)  # dish titles rated up, newest first
    disliked: list[str] = Field(default_factory=list)  # dish titles rated down, newest first

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

    @field_validator("liked", "disliked", mode="before")
    @classmethod
    def _titles(cls, v):
        return clean_titles(v)


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
    count: int = Field(default=6, ge=1, le=18)
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
    description: str = Field(
        default="",
        description="One sentence on how it tastes or why it works. Not a menu blurb.",
    )
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


class Idea(BaseModel):
    """First pass: a dish worth cooking, before anyone writes the recipe."""

    title: str = Field(description="The dish name as a cook would say it out loud, not a category.")
    hero: str = Field(description="The one pantry item the dish is built around, copied exactly from the pantry list.")
    angle: str = Field(description="One line on why it is worth cooking tonight.")


class IdeaBatch(BaseModel):
    ideas: list[Idea]


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

# One tradition per idea. Sampled per request, so two refreshes of the same
# pantry do not return the same six dishes.
ANGLES = (
    "something Italian, simple, few ingredients",
    "something with heat and acid, Mexican or Thai",
    "a one-pan roast or traybake",
    "a soup, stew, or braise",
    "eggs doing the heavy lifting, any time of day",
    "a grain bowl or salad that eats like a meal",
    "something East Asian, wok or steamer",
    "comfort food, unfashionable and good",
    "a sandwich, flatbread, or toast that counts as dinner",
    "something South Asian or Middle Eastern, spice-forward",
    "a pasta or noodle dish that is not the obvious one",
    "something French or bistro-style, unfussy",
    "a curry or a dal, whatever the pantry's grain and legumes suggest",
    "breakfast for dinner: pancakes, hash, or a big omelette",
    "a Latin or Caribbean plate: rice, beans, a bright salsa",
    "something baked or a casserole that feeds the week",
    "a vegetable as the main event, roasted or charred",
    "a skillet dinner in under twenty minutes",
)

BRAINSTORM_PROMPT = """You cook at home most nights and you are good at it.

PANTRY (name · servings on hand · days until it spoils or runs out):
{pantry}
{preference}
Come up with {want} dish ideas for tonight, one for each of these directions:

{directions}

Rules:
- Each dish is built around ONE hero ingredient, copied exactly from the pantry
  list above. Not a survey of the fridge.
- Most heroes should be items with the fewest days left.
- Do not repeat a hero ingredient across ideas.
- Name dishes the way a person says them out loud. "Kale and sausage
  orecchiette", not "Hearty Vegetable and Protein Pasta Dish". No adjective
  stacking, no "delicious", no "medley", no "fusion". 2 to 5 words, no numbers,
  no brand names.
- A dish may need one or two things the pantry does not have. Say so in the angle.
- If the cook asked for something specific above, that wins: give them what they
  asked for, and use the directions only for the ideas it does not cover.
{hard_rules}{preferences}"""

DEVELOP_PROMPT = """Write these {want} recipes properly.

{ideas}

PANTRY (name · servings on hand · days until it spoils or runs out):
{pantry}

Salt, pepper, water, oil, sugar and common dried spices are on hand. Nothing
else is free.

Rules:
- For every ingredient that comes from the pantry, set matched_name to the
  pantry name EXACTLY as written above. Leave matched_name empty otherwise, and
  mark the staples above staple = true so they are never counted as missing.
- Each dish may need at most {max_missing} ingredients that are NOT in the
  pantry and are not staples.
- servings_used is how much of the pantry the dish eats, in the servings unit
  shown above. Half a bunch of kale out of 4 servings is 2, not 0.5.
- uses_expiring lists the pantry items the dish uses that have five days or
  fewer left, named exactly as above.
- cook_minutes is realistic, start to plate.
- Rate difficulty on this rubric, honestly: "easy" = one pan or pot, up to about five
  steps, nothing has to happen at the same time; "medium" = two components cooked
  in parallel, or a technique that needs attention such as searing, emulsifying,
  or reducing a sauce; "hard" = several components with precise timing, or an
  advanced technique such as dough, tempering, deep-frying or pastry. Most
  weeknight food is easy; do not call a dish easy because the cook is confident.

Write the steps the way you would tell a friend who can cook but has not made
this before. That means:
- Real heat levels and times. "Medium-high, 4 minutes a side", not "saute".
- A sensory cue for anything that can go wrong: what it should look, smell or
  sound like when it is ready.
- Say when something can happen while something else cooks.
- Never write "cook until done", "season to taste" or "add remaining
  ingredients". Those are placeholders, not instructions.
- 5 to 9 steps, one action each, and do not number them.

description is one sentence on how the dish tastes or why it works. Not a menu
blurb. No "burst of flavor", no "perfect for busy weeknights".
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


def servings_rule(prefs: Prefs | None) -> str:
    """The one prompt line that sizes every dish for the household. Part of _preferences()
    when there are prefs; the callers emit it on its own when there are none, so it is
    stated exactly once either way."""
    n = servings_target(prefs)
    return f"- Make every dish serve {n}: set servings = {n} and size the amounts for {n} people."


def _preferences(prefs: Prefs) -> str:
    """Servings, cuisines, time, skill, equipment, dislikes: the block the model should favour."""
    lines = [servings_rule(prefs)]
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
    # Titles can contain commas, so they are joined with semicolons.
    if prefs.liked:
        lines.append(f"- Dishes they rated up (make more like these): {'; '.join(prefs.liked)}.")
    if prefs.disliked:
        lines.append(f"- Dishes they rated down (do not suggest these or close variants): {'; '.join(prefs.disliked)}.")
    return "\nPREFERENCES:\n" + "\n".join(lines) + "\n"


def _blocks(req: RecipeRequest) -> dict:
    """The pieces both prompts share: the pantry, the rules, and the free-text ask."""
    food = [i for i in req.items if i.is_food and i.quantity_servings > 0]
    return {
        "pantry": _pantry_lines(food),
        "hard_rules": _hard_rules(req.prefs) if req.prefs else "",
        "preferences": _preferences(req.prefs) if req.prefs else "",
        "preference": f"\nThe cook asked for: {req.request.strip()}\n" if req.request and req.request.strip() else "",
        # A couple of spares so ranking has something to drop.
        "want": min(req.count + 2, 12),
    }


def build_brainstorm_prompt(req: RecipeRequest, angles: list[str]) -> str:
    """First-pass prompt. Pure, so it can be inspected without calling the model."""
    blocks = _blocks(req)
    return BRAINSTORM_PROMPT.format(
        directions="\n".join(f"{n}. {a}" for n, a in enumerate(angles, 1)),
        **blocks,
    )


def build_develop_prompt(req: RecipeRequest, ideas: list[Idea]) -> str:
    """Second-pass prompt. Pure, like build_brainstorm_prompt."""
    blocks = {**_blocks(req), "want": len(ideas)}
    return DEVELOP_PROMPT.format(
        ideas="\n".join(f"{n}. {i.title} (hero: {i.hero}) — {i.angle}" for n, i in enumerate(ideas, 1)),
        max_missing=req.max_missing,
        **blocks,
    )


def generate(req: RecipeRequest, client, model: str | None = None) -> list[dict]:
    """Ask Gemini for dishes: ideas first, then the recipes. Ranking is done by rank()."""
    food = [i for i in req.items if i.is_food and i.quantity_servings > 0]
    if not food:
        return []

    want = min(req.count + 2, 18)
    angles = random.sample(ANGLES, min(want, len(ANGLES)))
    ideas = llm.generate_json(client, build_brainstorm_prompt(req, angles), IdeaBatch, model or MODEL).ideas

    # Drop repeated heroes before paying for a second call to develop them.
    seen: set[frozenset[str]] = set()
    unique: list[Idea] = []
    for idea in ideas:
        key = frozenset(_tokens(idea.hero)) or frozenset({_norm(idea.title)})
        if key in seen:
            continue
        seen.add(key)
        unique.append(idea)

    if not unique:
        raise ValueError("the model returned no dish ideas")

    batch = llm.generate_json(client, build_develop_prompt(req, unique[:want]), RecipeBatch, model or MODEL)
    return [r.model_dump() for r in batch.recipes]


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------

_WORD = re.compile(r"[a-z0-9]+")

# Assumed to be in every kitchen. The model is asked to flag these itself; this
# is the safety net, so a forgotten flag never shows salt as something to buy.
STAPLES = (
    "salt", "pepper", "black pepper", "salt and pepper", "water", "oil", "olive oil",
    "vegetable oil", "cooking oil", "cooking spray", "sugar", "ice",
)


def _norm(s: str) -> str:
    return " ".join(_WORD.findall((s or "").lower()))


def _singular(word: str) -> str:
    """Enough plural stripping that "tomato" matches "tomatoes". Both sides of every
    comparison come through here, so it only has to be consistent, not correct."""
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"  # berries -> berry
    if len(word) > 4 and word.endswith(("oes", "ses", "xes", "ches", "shes")):
        return word[:-2]  # tomatoes -> tomato, dishes -> dish
    if word.endswith("s") and not word.endswith("ss"):
        return word[:-1]  # eggs -> egg, but glass stays glass
    return word


def _tokens(s: str) -> set[str]:
    stop = {"fresh", "large", "small", "chopped", "sliced", "diced", "of", "the", "a", "and", "or"}
    return {_singular(t) for t in _WORD.findall((s or "").lower()) if t not in stop and len(t) > 2}


_STAPLE_TOKENS = [_tokens(s) for s in STAPLES]


def is_staple(name: str) -> bool:
    """True for salt, oil and friends. Subset, not overlap: 'oil-packed tuna' is tuna."""
    words = _tokens(name)
    return bool(words) and any(words <= staple for staple in _STAPLE_TOKENS)


def ingredient_hits(names: Iterable[str], allergies: Iterable[str]) -> list[str]:
    """The allergen keys (from `allergies`) that any of the ingredient names trips.

    Mirrors ingredientHits() in frontend/shared/store.js. Substring match on the
    normalised name, minus a few phrases that only look like the allergen
    (eggplant, peanut butter, coconut milk, oyster mushroom...).
    """
    texts = [_ALT_DAIRY.sub(r"\1 ", _norm(n)) for n in names if n]
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


# Mirrors the diet half of passesPrefs() in frontend/app/app.js. These are
# ingredient-name checks, not certification of halal or kosher sourcing.
_MEAT = re.compile(r"\b(chicken|beef|pork|bacon|ham|lard|lamb|turkey|duck|veal|venison|sausage|gelatin)\b")
_PORK = re.compile(r"\b(pork|bacon|ham|lard)\b")
_ALCOHOL = re.compile(r"\b(wine|beer|vodka|rum|brandy|sake|sherry|bourbon)\b")


def diet_conflicts(names: Iterable[str], diets: Iterable[str]) -> bool:
    """True when these ingredient names break one of the household's diets."""
    names = [n for n in names if n]
    if not names:
        return False
    text = " ".join(_norm(n) for n in names)
    meat = bool(_MEAT.search(text))
    seafood = bool(ingredient_hits(names, ("fish", "shellfish")))
    dairy = bool(ingredient_hits(names, ("dairy",)))
    eggs = bool(ingredient_hits(names, ("eggs",)))
    pork = bool(_PORK.search(text))
    alcohol = bool(_ALCOHOL.search(text))

    for diet in diets:
        if diet == "vegan" and (meat or seafood or dairy or eggs or "honey" in text):
            return True
        if diet == "vegetarian" and (meat or seafood):
            return True
        if diet == "pescatarian" and meat:
            return True
        if diet == "halal" and (pork or alcohol):
            return True
        if diet == "kosher" and (pork or ingredient_hits(names, ("shellfish",)) or (meat and dairy)):
            return True
    return False


def _match(ingredient: dict, pantry: dict[str, PantryItem]) -> PantryItem | None:
    """Prefer the model's exact matched_name; fall back to token overlap on the ingredient name.

    Scored against the shorter of the two names, so "Roma tomatoes" still finds
    "Tomatoes", but sharing one generic word is not enough: "Lime juice" must not
    match "Hint of Lime Tortilla Chips", nor "Cheddar cheese" a fig goat cheese.
    A wrong match here shows as "you have this" and quietly drops the item off
    the shopping list, so the bar is a clear majority of the shorter name.
    """
    exact = _norm(ingredient.get("matched_name", ""))
    if exact and exact in pantry:
        return pantry[exact]
    words = _tokens(ingredient.get("name", ""))
    if not words:
        return None
    best, best_score = None, 0.0
    for key, item in pantry.items():
        key_words = _tokens(key)
        overlap = len(words & key_words)
        if overlap:
            score = overlap / max(min(len(words), len(key_words)), 1)
            if score > best_score:
                best, best_score = item, score
    return best if best_score > 0.5 else None


def _annotate(r: dict, pantry: dict[str, PantryItem], allergies: list[str], diets: list[str]) -> dict | None:
    """The core of annotate() and rank(): pantry already normalised, prefs already split.

    Mutates `r` in place (each ingredient gets have/staple/matched_name, the recipe
    gets missing_count/coverage/urgency_days/uses_expiring) and returns it, or None
    when the dish trips an allergy or breaks a diet.
    """
    have = missing = 0
    urgency = 999
    expiring: list[str] = []
    for ing in r.get("ingredients", []):
        if ing.get("staple") or is_staple(ing.get("name", "")):
            ing["staple"] = True
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

    if allergies or diets:
        names = []
        for ing in r.get("ingredients", []):
            names.append(ing.get("name", ""))
            names.append(ing.get("matched_name", ""))
        # Unsafe or off-diet for this household, whatever the model said.
        if allergies and ingredient_hits(names, allergies):
            return None
        if diets and diet_conflicts(names, diets):
            return None

    r["missing_count"] = missing
    r["coverage"] = round(have / max(have + missing, 1), 3)
    r["urgency_days"] = urgency
    r["uses_expiring"] = expiring or list(r.get("uses_expiring", []) or [])
    return r


def annotate(recipe: dict, items: list[PantryItem] | None = None, prefs: Prefs | None = None) -> dict | None:
    """Mark one recipe's ingredients against the pantry, without filtering it.

    Sets `have` (and `staple`, `matched_name`) on every ingredient and
    `missing_count`, `coverage`, `urgency_days`, `uses_expiring` on the recipe,
    using the same matching rank() uses, so a meal-plan cell and a deck card
    agree on what you own. Returns the same dict, or None when the dish trips
    one of the household's allergies or breaks its diet (staples included).
    """
    pantry = {_norm(i.name): i for i in (items or []) if i.is_food}
    allergies = list(prefs.allergies) if prefs else []
    diets = list(prefs.diet) if prefs else []
    return _annotate(recipe, pantry, allergies, diets)


def rank(
    recipes: list[dict],
    max_missing: int,
    items: list[PantryItem] | None = None,
    prefs: Prefs | None = None,
) -> list[dict]:
    """Score, filter and order recipes. Adds have/missing_count/coverage/urgency_days.

    With `prefs`, any dish whose ingredients trip one of the household's
    allergies, or break its diet, is dropped outright (staples included:
    "butter" or "sesame oil" marked as a staple is still the allergen), so a
    model slip never reaches the client. Dishes that use nothing from the
    pantry, or need more than `max_missing`, are dropped too, and so is any
    dish whose normalised title the household rated down (`prefs.disliked`).
    """
    pantry = {_norm(i.name): i for i in (items or []) if i.is_food}
    allergies = list(prefs.allergies) if prefs else []
    diets = list(prefs.diet) if prefs else []
    disliked = {_norm(t) for t in prefs.disliked} if prefs else set()
    seen_titles: set[str] = set()
    ranked: list[dict] = []

    for r in recipes:
        title_key = _norm(r.get("title", ""))
        if not title_key or title_key in seen_titles:
            continue
        seen_titles.add(title_key)
        if title_key in disliked:
            continue  # rated down: never back on the deck, whatever the model wrote

        if _annotate(r, pantry, allergies, diets) is None:
            continue
        have = sum(1 for ing in r.get("ingredients", []) if ing.get("have") and not ing.get("staple"))
        if have == 0 or r["missing_count"] > max_missing:
            continue
        ranked.append(r)

    ranked.sort(key=lambda r: (r["urgency_days"], r["missing_count"], -r["coverage"], r.get("cook_minutes", 0)))
    return ranked
