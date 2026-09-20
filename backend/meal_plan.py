"""
A week of meals from the pantry: POST /meal-plan.

Gemini plans breakfast, lunch and dinner for each day, cooking from what is in
the pantry, spending the soonest-expiring food first and drawing anything it
has to buy from one small basket so a single shop covers the week. The model
names ingredients; Python decides `have` and `missing` by matching them back to
real pantry rows with the same annotate() the deck uses, so a plan cell and a
deck card never disagree about what you own.

Contract with the frontend (frontend/shared/api.js -> fetchMealPlan):

    POST /meal-plan
      { items: [PantryItem], prefs: Prefs|null, days: 1..14 (default 7),
        start: 'YYYY-MM-DD' (default today), request: str|null }
    -> { start: 'YYYY-MM-DD',
         days: [ { date: 'YYYY-MM-DD',
                   meals: { breakfast: Meal|null, lunch: Meal|null, dinner: Meal|null } } ] }

    Meal = the step-less recipe dict the chat suggestions return:
      { title, description, cook_minutes, servings, difficulty,
        ingredients: [ { name, amount, matched_name, servings_used, staple, have } ],
        missing_count, coverage, urgency_days, uses_expiring, steps: [] }
    A meal is null when the model wrote one that trips an allergy or breaks a
    diet (annotate() returned None) or when it came back short a day.

Latency: the plan is generated in chunks of CHUNK_DAYS. The first chunk runs
alone and fixes the week's shopping basket and the dishes already used; the
remaining chunks run in parallel, each told the basket, the titles to avoid and
the pantry as the first chunk left it. Seven days is therefore two model calls
back to back (about the cost of the deck), fourteen is three deep.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator

import llm
from recipes import (
    MODEL,
    Ingredient,
    PantryItem,
    Prefs,
    _hard_rules,
    _norm,
    _pantry_lines,
    _preferences,
    annotate,
    servings_rule,
)

MEALS = ("breakfast", "lunch", "dinner")
CHUNK_DAYS = 4  # 7 days -> 4 + 3; keeps each answer around a dozen dishes


# ---------------------------------------------------------------------------
# Shapes
# ---------------------------------------------------------------------------


class MealPlanRequest(BaseModel):
    items: list[PantryItem]
    prefs: Prefs | None = None
    days: int = Field(default=7, ge=1, le=14)
    start: date | None = None  # default today (server time zone)
    request: str | None = None  # free text, e.g. "light dinners, we're away Saturday"

    @field_validator("start", mode="before")
    @classmethod
    def _blank_start(cls, v):
        # An empty string from a form is "today", not a 422; a malformed date still is.
        return None if isinstance(v, str) and not v.strip() else v


class RecipeStub(BaseModel):
    """A recipe without steps (recipes_ai.RecipeStub plus description). Steps are
    written on demand by /recipe-detail when the user opens the cell."""

    title: str
    description: str = Field(
        default="",
        description="One sentence on how it tastes or why it works. Not a menu blurb.",
    )
    cook_minutes: int = Field(description="Total time from start to plate.")
    servings: int
    difficulty: Literal["easy", "medium", "hard"]
    ingredients: list[Ingredient]
    uses_expiring: list[str] = Field(
        default_factory=list,
        description="Pantry item names (exact) that this dish uses which expire within about five days.",
    )


class DayPlan(BaseModel):
    breakfast: RecipeStub
    lunch: RecipeStub
    dinner: RecipeStub


class MealPlanBatch(BaseModel):
    days: list[DayPlan]


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

PLAN_PROMPT = """You plan a household's meals from what is already in their kitchen.

PANTRY (name · servings on hand · days until it spoils or runs out):
{pantry}

Plan {span}: breakfast, lunch and dinner for each day, {n_meals} dishes in all,
in order, one entry per day.

Rules:
- Cook from the pantry. Use the items with the fewest days left in the first
  days, before they spoil, and spread the rest across the days so nothing runs
  out on day one.
- Breakfasts are simple: 15 minutes or less, few ingredients.
- Each dish may need at most 3 ingredients that are NOT in the pantry and are
  not staples. Staples (salt, pepper, oil, water, sugar, dried spices) are
  assumed on hand: mark them staple = true and do not count them.
- Reuse the same missing ingredients across the days so one shopping trip
  covers everything: pick a small basket of extras (a couple of vegetables, one
  protein, one dairy or fresh herb) and build several dishes around it rather
  than buying something new for every meal.{basket}
- For every ingredient that comes from the pantry, set matched_name to the
  pantry name EXACTLY as written above. Leave matched_name empty otherwise.
- servings_used is how many pantry servings the dish consumes of that item.
- Vary cuisines and cooking methods; no dish twice, and no two dinners in a row
  built around the same main ingredient.{avoid}
- Keep titles plain and appetizing ("Spinach and garlic pasta"), 2 to 5 words.
  No numbers in titles, no brand names. description is one sentence on how the
  dish tastes or why it works.
- cook_minutes is realistic; difficulty is easy for most weeknight food.
- Do NOT write cooking steps. They are written separately, later.
{hard_rules}{preferences}{preference}"""


def _span(dates: list[date], chunk: range) -> str:
    """'days 5 to 7 (Fri 26 Sep, Sat 27 Sep, Sun 28 Sep)' — day numbers so a later
    chunk knows where it sits in the week, weekdays so weekends can cook longer."""
    days = [dates[i] for i in chunk]
    labels = ", ".join(d.strftime("%a %-d %b") for d in days)
    if len(days) == 1:
        return f"day {chunk.start + 1} ({labels})"
    return f"days {chunk.start + 1} to {chunk.stop} ({labels})"


def build_plan_prompt(
    req: MealPlanRequest,
    food: list[PantryItem],
    dates: list[date],
    chunk: range,
    basket: list[str] = (),
    avoid: list[str] = (),
) -> str:
    """Pure, so it can be inspected without calling the model."""
    basket_line = (
        "\n  The week's shopping basket already has: "
        + ", ".join(basket)
        + ". Draw any non-pantry ingredient from that basket; add something new only when nothing on it works."
        if basket
        else ""
    )
    avoid_line = "\n  Already planned earlier in the week, do not repeat: " + ", ".join(avoid) + "." if avoid else ""
    ask = req.request.strip() if req.request and req.request.strip() else ""
    return PLAN_PROMPT.format(
        pantry=_pantry_lines(food),
        span=_span(dates, chunk),
        n_meals=len(chunk) * len(MEALS),
        basket=basket_line,
        avoid=avoid_line,
        hard_rules=_hard_rules(req.prefs) if req.prefs else "",
        # the household-size rule is inside the preferences block; without prefs it stands alone
        preferences=_preferences(req.prefs) if req.prefs else "\n" + servings_rule(None) + "\n",
        preference=f"\nThe cook asked for: {ask}\n" if ask else "",
    )


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


def _chunks(n_days: int) -> list[range]:
    return [range(i, min(i + CHUNK_DAYS, n_days)) for i in range(0, n_days, CHUNK_DAYS)]


def _empty_day(day: date) -> dict:
    return {"date": day.isoformat(), "meals": {meal: None for meal in MEALS}}


def _finish(stub: RecipeStub, items: list[PantryItem], prefs: Prefs | None) -> dict | None:
    """Model output -> the client's Meal dict: annotated against the full pantry, steps empty."""
    meal = stub.model_dump()
    meal["steps"] = []  # shape stays stable with the chat cards; steps arrive on demand
    return annotate(meal, items, prefs)


def _plan_chunk(
    client,
    model: str,
    req: MealPlanRequest,
    food: list[PantryItem],
    dates: list[date],
    chunk: range,
    basket: list[str],
    avoid: list[str],
) -> list[dict]:
    """One model call for `chunk`'s days -> [ { date, meals } ], padded with empty
    days if the model came back short, so the calendar always lines up."""
    prompt = build_plan_prompt(req, food, dates, chunk, basket, avoid)
    batch = llm.generate_json(client, prompt, MealPlanBatch, model)
    out: list[dict] = []
    for offset, i in enumerate(chunk):
        day = _empty_day(dates[i])
        if offset < len(batch.days):
            plan = batch.days[offset]
            day["meals"] = {meal: _finish(getattr(plan, meal), req.items, req.prefs) for meal in MEALS}
        out.append(day)
    return out


def _meals(days: list[dict]):
    for day in days:
        for meal in day["meals"].values():
            if meal:
                yield meal


def _basket(days: list[dict]) -> list[str]:
    """The non-pantry, non-staple ingredients the first chunk decided to buy."""
    names: list[str] = []
    seen: set[str] = set()
    for meal in _meals(days):
        for ing in meal["ingredients"]:
            if ing.get("have") or ing.get("staple"):
                continue
            key = _norm(ing.get("name", ""))
            if key and key not in seen:
                seen.add(key)
                names.append(ing["name"])
    return names


def _deplete(food: list[PantryItem], days: list[dict]) -> list[PantryItem]:
    """The pantry as the first chunk leaves it: servings_used subtracted per matched
    item, anything eaten up dropped, so the later days do not plan a third dinner
    around the two servings of salmon already gone."""
    used: dict[str, float] = {}
    for meal in _meals(days):
        for ing in meal["ingredients"]:
            if ing.get("have") and not ing.get("staple") and ing.get("matched_name"):
                key = _norm(ing["matched_name"])
                try:
                    used[key] = used.get(key, 0.0) + max(0.0, float(ing.get("servings_used") or 0))
                except (TypeError, ValueError):
                    pass
    remaining: list[PantryItem] = []
    for item in food:
        left = item.quantity_servings - used.get(_norm(item.name), 0.0)
        if left > 0:
            remaining.append(item.model_copy(update={"quantity_servings": round(left, 2)}))
    return remaining


def generate(req: MealPlanRequest, client, model: str | None = None) -> dict:
    """Plan `req.days` days from `req.start`. Raises 400 for an empty pantry; model
    failures propagate for the route to turn into a 502."""
    food = [i for i in req.items if i.is_food and i.quantity_servings > 0]
    if not food:
        raise HTTPException(400, "The pantry is empty: add some food before planning the week.")

    model = model or MODEL
    start = req.start or date.today()
    dates = [start + timedelta(days=i) for i in range(req.days)]
    chunks = _chunks(req.days)

    first = _plan_chunk(client, model, req, food, dates, chunks[0], [], [])
    days = list(first)

    if len(chunks) > 1:
        basket = _basket(first)
        avoid = [meal["title"] for meal in _meals(first)]
        remaining = _deplete(food, first) or food
        with ThreadPoolExecutor(max_workers=len(chunks) - 1) as pool:
            rest = pool.map(
                lambda chunk: _plan_chunk(client, model, req, remaining, dates, chunk, basket, avoid),
                chunks[1:],
            )
            for part in rest:
                days.extend(part)

    return {"start": start.isoformat(), "days": days}
