"""
Photo of a dish → recipe.

Contract with the frontend (frontend/app/app.js builds a deck-style dish from it):

    POST /identify   multipart/form-data, field "file" (image/jpeg|png|webp|heic)
    200 → IdentifiedDish (below), exactly:
        { title, confidence, description, cuisine, cook_minutes, servings,
          difficulty: "easy"|"medium"|"hard",
          ingredients: [ { name, amount, staple } ],
          steps: [str],
          tags: { vegetarian, vegan, contains: [allergen keys] } }
    400 / 502 / 503 as the other endpoints (see main.py).

What is here:
  IdentifiedDish     pydantic models with Field descriptions written so the class can
                     be passed straight to Gemini as response_schema.
  IDENTIFY_PROMPT    the full prompt.
  SAMPLE_IDENTIFIED  a canned shakshuka answer, the same one the frontend ships as its
                     "Use a sample photo" / backend-not-ready fallback. identify()
                     returns it, without touching Gemini, when IDENTIFY_STUB=1.
  finish()           post-processing: allergens the ingredients trip are added to
                     tags.contains even when the model forgot them.
"""

from __future__ import annotations

import os
import re
from typing import Literal

from google.genai import types
from pydantic import BaseModel, Field, field_validator

import llm
from recipes import ALLERGENS, ingredient_hits

MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")

STUB_ENV = "IDENTIFY_STUB"


def stubbed() -> bool:
    """True when IDENTIFY_STUB=1: identify() answers with SAMPLE_IDENTIFIED and never
    touches Gemini, so the whole frontend flow can be exercised without a key.
    Read at call time (not import time) so .env, loaded by main.py, is honoured."""
    return os.getenv(STUB_ENV, "").strip() == "1"


# ---------------------------------------------------------------------------
# Response schema — exactly the 200 contract, nothing more.
#
# Descriptions double as instructions to the model, so they are written for
# Gemini, not for humans. Keep constraints (ranges, enums) OUT of the JSON
# schema and in the validators below: response_schema conversion only supports
# a subset of JSON Schema, and a model slip should be tidied up, not 502.
# ---------------------------------------------------------------------------


class IdentifiedIngredient(BaseModel):
    name: str = Field(description="Ingredient as it reads in a recipe, e.g. 'Eggs' or 'Crushed tomatoes'. No brand names.")
    amount: str = Field(
        default="",
        description="Human amount for the stated servings, e.g. '4', '2 tbsp', '1 can (400 g)', 'to taste'.",
    )
    staple: bool = Field(
        default=False,
        description="True for salt, pepper, oil, water, sugar and common dried spices: assumed on hand in any kitchen.",
    )

    @field_validator("name", "amount", mode="before")
    @classmethod
    def _text(cls, v):
        return str(v or "").strip()


class IdentifiedTags(BaseModel):
    vegetarian: bool = Field(description="True if the dish contains no meat, poultry, fish or seafood.")
    vegan: bool = Field(description="True if the dish contains no animal products at all (implies vegetarian).")
    contains: list[str] = Field(
        default_factory=list,
        description=(
            "Allergens present, using ONLY these keys: peanuts, tree-nuts, dairy, eggs, gluten, "
            "shellfish, fish, soy, sesame. Empty list if none."
        ),
    )

    @field_validator("contains", mode="before")
    @classmethod
    def _contains(cls, v):
        if isinstance(v, str):
            v = [v]
        if not isinstance(v, (list, tuple, set)):
            return []
        out: list[str] = []
        for item in v:
            key = str(item).strip().lower().replace("_", "-").replace(" ", "-")
            if key in ALLERGENS and key not in out:
                out.append(key)
        return out


class IdentifiedDish(BaseModel):
    title: str = Field(description="The dish's common name, plain and appetizing, 2 to 5 words, no brand names. E.g. 'Shakshuka'.")
    confidence: float = Field(
        description=(
            "How sure you are that the photo shows this dish, from 0 to 1. Above 0.8 only when the "
            "dish is unmistakable; 0.4 to 0.7 when it could be one of a few similar dishes; below 0.3 "
            "when you are mostly guessing; 0 when the photo does not show food."
        )
    )
    description: str = Field(description="One plain sentence about the dish: what it is and what makes it that dish.")
    cuisine: str = Field(
        default="",
        description=(
            "Lowercase cuisine key. Prefer one of: italian, mexican, indian, chinese, japanese, thai, "
            "mediterranean, american, middle-eastern, korean, french, latin. Otherwise a single lowercase "
            "word such as 'ethiopian', or '' if it does not belong to a cuisine."
        ),
    )
    cook_minutes: int = Field(description="Realistic total time from start to plate for a home cook, in minutes.")
    servings: int = Field(description="How many people the ingredient amounts below feed. Usually 2 to 4.")
    difficulty: Literal["easy", "medium", "hard"] = Field(
        description=(
            "'easy' = one pan or pot, up to about five steps, nothing happens at the same time; "
            "'medium' = two components in parallel, or a technique that needs attention (searing, "
            "emulsifying, reducing); 'hard' = several components with precise timing, or dough, "
            "tempering, deep-frying or pastry."
        )
    )
    ingredients: list[IdentifiedIngredient] = Field(description="Everything needed, staples included and flagged.")
    steps: list[str] = Field(description="3 to 8 short imperative sentences, one action each, in cooking order.")
    tags: IdentifiedTags

    @field_validator("title", "description", mode="before")
    @classmethod
    def _text(cls, v):
        return re.sub(r"\s+", " ", str(v or "")).strip()

    @field_validator("confidence", mode="before")
    @classmethod
    def _confidence(cls, v):
        try:
            n = float(v)
        except (TypeError, ValueError):
            return 0.0
        if 1 < n <= 100:  # the model answered in percent
            n = n / 100
        return round(max(0.0, min(1.0, n)), 3)

    @field_validator("cuisine", mode="before")
    @classmethod
    def _cuisine(cls, v):
        key = re.sub(r"[^a-z0-9]+", "-", str(v or "").strip().lower()).strip("-")
        return "" if key in ("", "none", "unknown", "n-a") else key

    @field_validator("cook_minutes", "servings", mode="before")
    @classmethod
    def _positive_int(cls, v):
        try:
            return max(1, int(round(float(v))))
        except (TypeError, ValueError):
            return 1

    @field_validator("ingredients", mode="after")
    @classmethod
    def _ingredients(cls, v):
        return [ing for ing in v if ing.name]

    @field_validator("steps", mode="before")
    @classmethod
    def _steps(cls, v):
        if isinstance(v, str):
            v = [v]
        if not isinstance(v, (list, tuple)):
            return []
        out = []
        for s in v:
            s = re.sub(r"^\s*(?:step\s*)?\d+[.):]\s*", "", str(s or "").strip(), flags=re.I)  # "1. Heat..." → "Heat..."
            if s:
                out.append(s)
        return out


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

IDENTIFY_PROMPT = """You are looking at a photo of a dish someone wants to cook at home.

Name the dish and write the recipe for it, as JSON matching the schema.

- title: the dish's common name, plain and appetizing, 2 to 5 words. No brand
  names, no numbers, no adjectives like "delicious". If it is a well-known named
  dish (shakshuka, pad thai, carbonara), use that name.
- confidence: from 0 to 1, how sure you are that the photo shows this dish.
  Above 0.8 only when the dish is unmistakable. 0.4 to 0.7 when it could be one
  of a few similar dishes (a red curry vs a massaman). Below 0.3 when you are
  mostly guessing. Be honest; a low number is more useful than a wrong dish.
- description: one plain sentence: what the dish is and what makes it that dish.
- cuisine: a lowercase key. Prefer one of italian, mexican, indian, chinese,
  japanese, thai, mediterranean, american, middle-eastern, korean, french, latin.
  Otherwise a single lowercase word ("ethiopian"), or "" if it belongs to none.
- cook_minutes: a realistic total from start to plate for a normal home cook,
  including prep. Not the fastest possible time.
- servings: how many people the amounts you give feed, usually 2 to 4. The
  plate in the photo is one serving; write the recipe for a sensible batch.
- difficulty, on this rubric, honestly: "easy" = one pan or pot, up to about
  five steps, nothing has to happen at the same time; "medium" = two components
  cooked in parallel, or a technique that needs attention such as searing,
  emulsifying, or reducing a sauce; "hard" = several components with precise
  timing, or an advanced technique such as dough, tempering, deep-frying or
  pastry. Most weeknight food is easy.
- ingredients: everything the recipe needs, one entry each, with a human amount
  for the stated servings ("4", "2 tbsp", "1 can (400 g)", "to taste"). Mark
  salt, pepper, oil, water, sugar and common dried spices as staple = true;
  everything else staple = false. Include what you can see AND what the dish
  needs but the photo cannot show (the stock in a risotto). No brand names.
- steps: 3 to 8 short imperative sentences, one action each, in cooking order,
  with times and temperatures where they matter. Do not number them.
- tags: vegetarian (no meat, poultry, fish or seafood), vegan (no animal
  products at all, so also no eggs, dairy or honey), and contains: the allergens
  present using ONLY these keys:
    peanuts (peanuts, peanut butter, peanut oil, satay sauce)
    tree-nuts (almonds, walnuts, cashews, pecans, pistachios, hazelnuts, nut milks)
    dairy (milk, cheese, butter, cream, yogurt, ghee)
    eggs (whole eggs, egg wash, mayonnaise, meringue)
    gluten (wheat, flour, pasta, noodles, bread, couscous, barley, regular soy sauce)
    shellfish (shrimp, prawns, crab, lobster, clams, mussels, oysters, scallops)
    fish (any fish, fish sauce, anchovies, Worcestershire sauce)
    soy (soy sauce, tofu, edamame, tempeh, miso)
    sesame (sesame seeds, sesame oil, tahini)
  Tag by the ingredients you list, not by what is visible.

If the photo is unclear, partly eaten, badly lit or could be several dishes,
still answer: pick the single most likely dish, write its recipe, and lower
confidence accordingly. Do not refuse and do not ask for a better photo.

If the photo does not show food at all, set confidence to 0, title to
"Not a dish", description to what the photo does show, and leave ingredients
and steps empty.
"""


# ---------------------------------------------------------------------------
# Sample — a shakshuka equivalent to the frontend's own fallback (SAMPLE_IDENTIFIED in
# frontend/shared/store.js; same stats and tags, the ingredient wording differs slightly)
# ---------------------------------------------------------------------------

SAMPLE_IDENTIFIED: dict = {
    "title": "Shakshuka",
    "confidence": 0.86,
    "description": "Eggs poached in a spiced tomato and onion sauce, finished with crumbled feta.",
    "cuisine": "middle-eastern",
    "cook_minutes": 30,
    "servings": 2,
    "difficulty": "easy",
    "ingredients": [
        {"name": "Olive oil", "amount": "2 tbsp", "staple": True},
        {"name": "Onion", "amount": "1 medium, diced", "staple": False},
        {"name": "Garlic", "amount": "3 cloves, sliced", "staple": False},
        {"name": "Crushed tomatoes", "amount": "1 can (400 g)", "staple": False},
        {"name": "Ground cumin", "amount": "1 tsp", "staple": True},
        {"name": "Salt", "amount": "to taste", "staple": True},
        {"name": "Eggs", "amount": "4", "staple": False},
        {"name": "Feta cheese", "amount": "60 g, crumbled", "staple": False},
    ],
    "steps": [
        "Warm the olive oil in a wide skillet over medium heat and soften the onion, about 5 minutes.",
        "Add the garlic and cumin and cook for a minute until fragrant.",
        "Pour in the crushed tomatoes, season with salt, and simmer until thick, about 10 minutes.",
        "Make four wells in the sauce and crack an egg into each.",
        "Cover and cook until the whites are set but the yolks are still soft, 5 to 7 minutes.",
        "Scatter the feta over the top and serve straight from the pan.",
    ],
    "tags": {"vegetarian": True, "vegan": False, "contains": ["eggs", "dairy"]},
}


# ---------------------------------------------------------------------------
# The call
# ---------------------------------------------------------------------------


def finish(dish: IdentifiedDish) -> IdentifiedDish:
    """Pure post-processing, no model involved. Safety net for tags.contains: any
    allergen the listed ingredients trip (same keyword table as /recipes) is added,
    so a forgotten "feta" still shows as dairy. Runs on the stub too."""
    names = [ing.name for ing in dish.ingredients]
    for key in ingredient_hits(names, ALLERGENS):
        if key not in dish.tags.contains:
            dish.tags.contains.append(key)
    if dish.tags.vegan:
        dish.tags.vegetarian = True
    if "eggs" in dish.tags.contains or "dairy" in dish.tags.contains:
        dish.tags.vegan = False
    if "fish" in dish.tags.contains or "shellfish" in dish.tags.contains:
        dish.tags.vegetarian = dish.tags.vegan = False
    return dish


def identify(image_bytes: bytes, mime_type: str, client, model: str | None = None) -> IdentifiedDish:
    """Look at a photo of a dish and return its recipe.

    `client` is the Gemini client from main.gemini() (None is fine while stubbed).
    """
    if stubbed():
        return finish(IdentifiedDish(**SAMPLE_IDENTIFIED))

    dish = llm.generate_json(
        client,
        [types.Part.from_bytes(data=image_bytes, mime_type=mime_type), IDENTIFY_PROMPT],
        IdentifiedDish,
        model or MODEL,
    )
    return finish(dish)
