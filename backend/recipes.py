"""
Recipe generation for Pantry: Gemini writes the dishes, we rank them.

Contract with the frontend (frontend/app/app.js → pantryForApi / dishFromApi):

    POST /recipes  { items: [PantryItem], count, max_missing, request }
    →  { count, recipes: [ { title, cook_minutes, servings, difficulty,
                             ingredients: [ { name, amount, matched_name,
                                              servings_used, staple, have } ],
                             steps, uses_expiring, missing_count, coverage,
                             urgency_days } ] }

The model is asked to cook from what is in the pantry and to lean on whatever
expires first. Ranking happens here, in plain Python, so the order on the deck
is deterministic: soonest-expiring ingredient first, then fewest missing items,
then best pantry coverage.
"""

from __future__ import annotations

import os
import re
from typing import Literal

from google.genai import types
from pydantic import BaseModel, Field

MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")


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
- cook_minutes is realistic; difficulty is easy for most weeknight food.
- Steps: 3 to 7 short imperative sentences, one action each.
- Vary the dishes: different main ingredients and cooking methods, not six
  versions of the same stir-fry.
{preference}"""


def _pantry_lines(items: list[PantryItem]) -> str:
    rows = []
    for it in sorted(items, key=lambda i: i.days_left):
        if not it.is_food or it.quantity_servings <= 0:
            continue
        when = f"{it.days_left} days" if it.days_left < 999 else "long shelf life"
        rows.append(f"- {it.name} · about {it.quantity_servings:g} servings · {when} ({it.deadline_reason})")
    return "\n".join(rows) if rows else "- (empty)"


def generate(req: RecipeRequest, client, model: str | None = None) -> list[dict]:
    """Ask Gemini for dishes. Returns plain dicts; ranking is done by rank()."""
    food = [i for i in req.items if i.is_food and i.quantity_servings > 0]
    if not food:
        return []

    preference = f"\nThe cook asked for: {req.request.strip()}" if req.request and req.request.strip() else ""
    prompt = PROMPT.format(
        pantry=_pantry_lines(food),
        want=min(req.count + 2, 12),  # a couple of spares so ranking has something to drop
        max_missing=req.max_missing,
        preference=preference,
    )

    response = client.models.generate_content(
        model=model or MODEL,
        contents=prompt,
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


def rank(recipes: list[dict], max_missing: int, items: list[PantryItem] | None = None) -> list[dict]:
    """Score, filter and order recipes. Adds have/missing_count/coverage/urgency_days."""
    pantry = {_norm(i.name): i for i in (items or []) if i.is_food}
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

        r["missing_count"] = missing
        r["coverage"] = round(have / max(have + missing, 1), 3)
        r["urgency_days"] = urgency
        r["uses_expiring"] = expiring or list(r.get("uses_expiring", []) or [])
        ranked.append(r)

    ranked.sort(key=lambda r: (r["urgency_days"], r["missing_count"], -r["coverage"], r.get("cook_minutes", 0)))
    return ranked
