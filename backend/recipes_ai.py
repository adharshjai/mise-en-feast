"""
Claude (Bedrock) recipe suggestions for the chatbot — separate from the deck's
recipe engine in recipes.py, which is left exactly as it is (Gemini, two-phase).

The chatbot suggests dishes with a fast "lazy" flow:
  1. suggest() asks Claude for a few dishes WITHOUT steps (a schema with no steps
     field, so the model can't pad the output) — steps are the bulk of the tokens,
     so leaving them out is what keeps suggestions quick. Ranking reuses recipes.rank.
  2. generate_steps() writes the steps for ONE dish, on demand, when the user opens
     its card (see /recipe-detail).

Everything reuses the shapes and helpers in recipes.py (PantryItem, Prefs,
RecipeRequest, Ingredient, rank, and the pantry/preference prompt blocks) so the
chatbot honours the same preference and allergy rules as the deck.
"""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, Field

import bedrock
from recipes import (  # reuse the deck's contract + prompt blocks; recipes.py is untouched
    Ingredient,
    PantryItem,
    Prefs,
    RecipeRequest,
    _hard_rules,
    _pantry_lines,
    _preferences,
    rank,
)

SYSTEM = (
    "You are a practical home-cooking assistant. You plan dinners strictly from the "
    "ingredients a household already has, respect their dietary rules and preferences, "
    "and reply with exactly the JSON object requested and nothing else."
)


# ---------------------------------------------------------------------------
# A recipe without steps (steps are written later, on demand)
# ---------------------------------------------------------------------------


class RecipeStub(BaseModel):
    title: str
    cook_minutes: int = Field(description="Total time from start to plate.")
    servings: int
    difficulty: Literal["easy", "medium", "hard"]
    ingredients: list[Ingredient]
    uses_expiring: list[str] = Field(
        default_factory=list,
        description="Pantry item names (exact) that this dish uses which expire within about five days.",
    )


class RecipeStubBatch(BaseModel):
    recipes: list[RecipeStub]


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
- servings_used is how many pantry servings the dish consumes of that item.
- Keep titles plain and appetizing ("Spinach and garlic pasta"), 2 to 5 words.
  No numbers in titles, no brand names.
- cook_minutes is realistic; difficulty is easy for most weeknight food.
- Do NOT write cooking steps. The steps are written separately, later.
- Vary the dishes: different main ingredients and cooking methods.
{hard_rules}{preferences}{preference}"""


def _schema_type(prop: dict) -> str:
    if "$ref" in prop:
        return prop["$ref"].rsplit("/", 1)[-1] + " object"
    if "enum" in prop:
        return "string, one of " + ", ".join(json.dumps(v) for v in prop["enum"])
    kind = prop.get("type")
    if kind == "array":
        return "array of " + _schema_type(prop.get("items", {})) + "s"
    return kind or "value"


def _schema_fields(schema: dict) -> list[str]:
    lines = []
    for name, prop in schema.get("properties", {}).items():
        line = f'- "{name}" ({_schema_type(prop)})'
        if prop.get("description"):
            line += ": " + prop["description"]
        lines.append(line)
    return lines


def _json_instructions() -> str:
    schema = RecipeStubBatch.model_json_schema()
    parts = [
        "",
        "Answer with a single JSON object and nothing else: no markdown, no code fence, "
        'no commentary. Numbers are JSON numbers, not strings; an unknown string is "".',
        "",
        "The object has these fields:",
        *_schema_fields(schema),
    ]
    for name, definition in schema.get("$defs", {}).items():
        parts += ["", f"Each {name} object has these fields:", *_schema_fields(definition)]
    return "\n".join(parts) + "\n"


JSON_INSTRUCTIONS = _json_instructions()


def _build_prompt(req: RecipeRequest, spares: int) -> str:
    food = [i for i in req.items if i.is_food and i.quantity_servings > 0]
    preference = f"\nThe cook asked for: {req.request.strip()}" if req.request and req.request.strip() else ""
    hard_rules = _hard_rules(req.prefs) if req.prefs else ""
    preferences = _preferences(req.prefs) if req.prefs else ""
    return PROMPT.format(
        pantry=_pantry_lines(food),
        want=min(req.count + max(0, spares), 12),
        max_missing=req.max_missing,
        hard_rules=hard_rules,
        preferences=preferences,
        preference=preference,
    )


def suggest(req: RecipeRequest, count: int = 3) -> list[dict]:
    """Fast recipe suggestions (no steps), ranked with recipes.rank. Returns up to `count` dicts."""
    food = [i for i in req.items if i.is_food and i.quantity_servings > 0]
    if not food:
        return []

    prompt = _build_prompt(req, spares=0) + "\n" + JSON_INSTRUCTIONS
    response = bedrock.converse(
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        system=SYSTEM,
        max_tokens=1400,
        temperature=0.5,
        model=bedrock.model_smart(),
    )
    batch = RecipeStubBatch.model_validate(bedrock.extract_json_object(bedrock.response_text(response)))
    generated = [r.model_dump() for r in batch.recipes]
    for r in generated:
        r.setdefault("steps", [])  # shape stays stable; steps arrive on demand
    return rank(generated, req.max_missing, req.items, prefs=req.prefs)[:count]


# ---------------------------------------------------------------------------
# Steps on demand
# ---------------------------------------------------------------------------


class StepsRequest(BaseModel):
    title: str
    servings: int = Field(default=2, ge=1, le=24)
    ingredients: list[str] = Field(default_factory=list)
    request: str | None = None


class _StepsOnly(BaseModel):
    steps: list[str]


def generate_steps(req: StepsRequest) -> list[str]:
    """Write the cooking steps for one dish. Small and quick, so it runs on the fast model."""
    ings = ", ".join(i.strip() for i in req.ingredients if i and i.strip()) or "(use sensible common ingredients)"
    prompt = (
        "Write the cooking steps for this dish.\n"
        f"Dish: {req.title}\n"
        f"Serves: {req.servings}\n"
        f"Ingredients: {ings}\n"
        + (f"The cook asked for: {req.request.strip()}\n" if req.request and req.request.strip() else "")
        + "\nRules: 3 to 7 short imperative steps, one action each, in order. No step numbers in the "
        "text itself. Assume common staples (salt, pepper, oil, water) are on hand.\n"
        '\nAnswer with a single JSON object and nothing else: {"steps": ["...", "..."]}\n'
    )
    response = bedrock.converse(
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        system=SYSTEM,
        max_tokens=800,
        temperature=0.4,
        model=bedrock.model_fast(),
    )
    return _StepsOnly.model_validate(bedrock.extract_json_object(bedrock.response_text(response))).steps
