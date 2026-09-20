"""
mise en feast chatbot — Claude (Bedrock) with a small set of controlled app tools.

The assistant can reason about the user's pantry, expiring food, preferences and
recent meals, and can request safe changes. It does NOT get database access.
Instead it calls the tools below; the backend validates each call and either
answers from the request context (reads) or returns a structured `action` the
frontend applies through the normal Supabase path (writes). This keeps every AWS
credential server-side and every write behind code we control and validate.

Contract with the frontend (frontend/shared/api.js -> chat, app.js -> handleChat):

    POST /chat
      {
        messages:      [ { role: 'user'|'assistant', content: str } ],   # the turn history
        pantry:        [ PantryItem ],   # same shape /recipes takes (pantryForApi)
        prefs:         Prefs | null,     # the v2 preferences object
        recent_meals:  [ { title, cooked_at? } ],  # optional, newest first
        shopping:      [ { name, quantity?, unit?, done? } ]   # the shopping list, optional
      }
    ->
      {
        reply:   str,           # what to show in the chat bubble
        actions: [ Action ],    # writes for the client to apply, already validated
        recipes: [ Recipe ]     # full recipes (when the user asked what to cook) the
                                # client renders as tappable cards -> the recipe popup
      }

Actions the client knows how to apply:
    { type: 'update_preference', field, value }        # field/value validated here
    { type: 'mark_food_gone',    id?, name, key? }      # resolved to a pantry item
    { type: 'record_checkin',    id?, name, key?, percent }   # percent 0..100
    { type: 'add_pantry_items',  items: [ { name, quantity, unit, expires_in_days } ] }
    { type: 'add_shopping_items',    items: [ { name, quantity, unit, note } ] }
    { type: 'remove_shopping_items', names: [ str ] }   # names as they read on the list

In the add_* actions `quantity` is a number > 0 or null, `unit` is one of
g, kg, ml, l, pcs, pack or "" (imperial and packaging words are converted here,
see _clean_unit), `expires_in_days` is 1..730 or null and `note` is free text.
remove_shopping_items only carries names that matched an item in `shopping`,
so the client never has to guess what the model meant.

Reads never produce actions. The deterministic layers (decay, expiration,
consumption-rate learning) stay in the frontend / SQL exactly as before; the
chatbot only triggers them, it never recomputes them.
"""

from __future__ import annotations

import math
import re

from fastapi import HTTPException
from pydantic import BaseModel, Field

import bedrock
import recipes as rx
import recipes_ai  # Claude recipe suggestions (leaves the deck's recipe engine untouched)
from recipes import (
    ALLERGENS,
    CUISINES,
    DIETS,
    EQUIPMENT,
    SHOPPING,
    SKILLS,
    PantryItem,
    Prefs,
)

MAX_TOOL_TURNS = 6  # a generous cap so a chain of tool calls can't loop forever


class ChatMessage(BaseModel):
    role: str = "user"
    content: str = ""


class Meal(BaseModel):
    title: str = ""
    cooked_at: str = ""


class ShoppingItem(BaseModel):
    """One row of the client's shopping list, as much of it as the assistant needs."""

    name: str
    quantity: float | None = None
    unit: str = ""
    done: bool = False


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)
    pantry: list[PantryItem] = Field(default_factory=list)
    prefs: Prefs | None = None
    recent_meals: list[Meal] = Field(default_factory=list)
    shopping: list[ShoppingItem] = Field(default_factory=list)


SYSTEM = """You are the in-app assistant for mise en feast, an app that tracks what food a
household has, what is expiring, their dietary preferences, and what they have cooked.

You can call tools to read the pantry, expiring food, preferences and recent meals,
and to make safe changes: update a preference, mark a food as gone, or record how
much of an item is left (an inventory check-in). Always read the relevant data
before answering questions about it, and prefer a tool over guessing.

When the user tells you something actionable, take the action AND confirm it plainly:
- "I finished the milk" / "we're out of eggs" -> mark_food_gone.
- "I have about half my rice left" / "the yogurt is 30% gone" -> record_checkin with
  the percentage REMAINING (30% gone means 70 remaining).
- "I don't like seafood" / "we went vegetarian" / "no more than 30 minutes" ->
  update_preference.
- "add eggs to my pantry" / "I bought 2 lb of chicken thighs" / "we picked up milk and
  bread" -> add_pantry_items (one call with every item; pass the quantity and unit the
  user said, and expires_in_days only if they said when it goes off).
- "put lemons on my shopping list" / "I need to buy rice" / "remind me to get butter"
  -> add_to_shopping_list.
- "take milk off the list" / "I got the eggs, remove them" -> remove_from_shopping_list.
- "what's on my list?" / "what do I still need to buy?" -> read_shopping_list.

For "what can I make ..." questions, call suggest_recipes directly and immediately — it
already receives the full pantry and preferences, so do NOT call read_pantry or
get_expiring first. The recipes it returns are shown to the user as tappable cards.

Be concise, friendly and specific. Never invent pantry items the user does not have. Do
not claim you changed something unless you called the tool for it: never say an item was
added to the pantry or the list, or removed, without the matching tool call in this turn."""


# ---------------------------------------------------------------------------
# Tool definitions (Bedrock Converse toolSpec shape)
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "toolSpec": {
            "name": "read_pantry",
            "description": "List the food currently in the pantry with how much is left and days until it expires.",
            "inputSchema": {"json": {"type": "object", "properties": {}}},
        }
    },
    {
        "toolSpec": {
            "name": "get_expiring",
            "description": "List pantry food expiring within the given number of days (default 5), soonest first.",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {"days": {"type": "integer", "description": "Window in days. Default 5."}},
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "read_preferences",
            "description": "Read the household's dietary preferences: allergies, diet, cuisines, time limit, skill, equipment, dislikes, household size.",
            "inputSchema": {"json": {"type": "object", "properties": {}}},
        }
    },
    {
        "toolSpec": {
            "name": "recent_meals",
            "description": "List the meals the household has cooked recently, newest first.",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {"limit": {"type": "integer", "description": "How many to return. Default 5."}},
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "suggest_recipes",
            "description": (
                "Generate 1-3 concrete recipes the user can cook right now from their current "
                "pantry, with full ingredients and steps, honouring their preferences and leaning "
                "on food that expires soon. Use this whenever the user asks what to cook or what "
                "they can make. Optionally pass 'request' to refine (e.g. 'under 15 minutes', "
                "'something with eggs'). The recipes are shown to the user as tappable cards, so "
                "keep your own reply short and just introduce them."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "request": {"type": "string", "description": "Optional refinement of what they want."},
                        "count": {"type": "integer", "description": "How many recipes, 1-4. Default 3."},
                    },
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "update_preference",
            "description": (
                "Update one dietary preference. field is one of: allergies, diet, cuisines, "
                "equipment (each a list of allowed ids), maxMinutes (integer, 0=any), skill "
                "(beginner|comfortable|confident), shopping (weekly|twice-weekly|whenever), "
                "avoid (free text of disliked ingredients), household (object {adults,kids}). "
                "For a list field, pass the COMPLETE new list."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "field": {"type": "string"},
                        "value": {"description": "The new value for the field (type depends on the field)."},
                    },
                    "required": ["field", "value"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "mark_food_gone",
            "description": "Mark a pantry item as used up / gone. Pass the food name the user mentioned.",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {"name": {"type": "string", "description": "The food, e.g. 'milk'."}},
                    "required": ["name"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "record_checkin",
            "description": "Record an inventory check-in: how much of an item is LEFT, as a percentage 0-100.",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "The food, e.g. 'eggs'."},
                        "percent": {"type": "number", "description": "Percentage remaining, 0-100."},
                    },
                    "required": ["name", "percent"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "read_shopping_list",
            "description": "List what is on the household's shopping list, with quantities and whether each item is already bought.",
            "inputSchema": {"json": {"type": "object", "properties": {}}},
        }
    },
    {
        "toolSpec": {
            "name": "add_pantry_items",
            "description": (
                "Add food the user has bought or already has to the pantry. Use it when they say "
                "they bought, got, picked up or have something, or ask to add it to the pantry. "
                "One call with every item mentioned. Pass quantity and unit only when the user "
                "gave them (any unit is fine: lb, oz, dozen, bag, pack, g, ml...), and "
                "expires_in_days only when they said when it goes off."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "items": {
                            "type": "array",
                            "description": "The foods to add.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string", "description": "The food, e.g. 'chicken thighs'."},
                                    "quantity": {"type": "number", "description": "How much, if the user said. Omit otherwise."},
                                    "unit": {"type": "string", "description": "The unit the user used, e.g. 'lb', 'dozen', 'bag'. Omit otherwise."},
                                    "expires_in_days": {"type": "integer", "description": "Days until it goes off, only if the user said."},
                                },
                                "required": ["name"],
                            },
                        }
                    },
                    "required": ["items"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "add_to_shopping_list",
            "description": (
                "Put items on the household's shopping list. Use it when the user needs to buy "
                "something, wants a reminder to get it, or asks to add it to the list. One call "
                "with every item mentioned; quantity and unit only when given."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "items": {
                            "type": "array",
                            "description": "The things to buy.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string", "description": "The item, e.g. 'lemons'."},
                                    "quantity": {"type": "number", "description": "How much, if the user said."},
                                    "unit": {"type": "string", "description": "The unit the user used, if any."},
                                    "note": {"type": "string", "description": "A short note, e.g. 'for the curry'. Optional."},
                                },
                                "required": ["name"],
                            },
                        }
                    },
                    "required": ["items"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "remove_from_shopping_list",
            "description": (
                "Take items off the shopping list. Pass the item names the user mentioned; the "
                "result says which ones were on the list and which were not."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "names": {"type": "array", "items": {"type": "string"}, "description": "The items to remove."}
                    },
                    "required": ["names"],
                }
            },
        }
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_WORD = re.compile(r"[a-z0-9]+")


def _norm(s: str) -> str:
    return " ".join(_WORD.findall((s or "").lower()))


def _best_match(name: str, candidates: list[tuple[list[str], object]]):
    """Best candidate for a free-text food name: exact, then substring, then token overlap.

    Each candidate is ([names it answers to], value): the first name is the display
    name and drives the substring and overlap passes, any extra names (a group_key)
    only count as exact hits. Shared by the pantry and shopping-list lookups so
    "take milk off the list" and "we're out of milk" resolve the same way."""
    q = _norm(name)
    if not q:
        return None
    for names, value in candidates:
        if any(_norm(n) == q for n in names if n):
            return value
    for names, value in candidates:
        n = _norm(names[0]) if names else ""
        if n and (q in n or n in q):
            return value
    words = set(q.split())
    best, best_score = None, 0.0
    for names, value in candidates:
        overlap = len(words & set(_norm(names[0] if names else "").split()))
        if overlap:
            score = overlap / max(len(words), 1)
            if score > best_score:
                best, best_score = value, score
    return best if best_score >= 0.5 else None


def _match_item(name: str, pantry: list[PantryItem]) -> PantryItem | None:
    """Best pantry item for a free-text food name."""
    return _best_match(name, [([it.name, it.group_key], it) for it in pantry if it.is_food])


def _match_shopping(name: str, shopping: list[ShoppingItem]) -> ShoppingItem | None:
    """Best shopping-list row for a free-text name. Unchecked rows are tried first, so
    "take milk off" removes the milk still to buy rather than the one already bought."""
    rows = sorted(shopping, key=lambda s: s.done)
    return _best_match(name, [([s.name], s) for s in rows])


def _shopping_view(shopping: list[ShoppingItem]) -> list[dict]:
    return [{"name": s.name, "quantity": s.quantity, "unit": s.unit, "done": s.done} for s in shopping]


def _pantry_view(pantry: list[PantryItem]) -> list[dict]:
    return [
        {
            "name": it.name,
            "servings_left": round(it.quantity_servings, 2),
            "days_left": it.days_left,
            "expires_or_runs_out": it.deadline_reason,
        }
        for it in pantry
        if it.is_food and it.quantity_servings > 0
    ]


def _prefs_view(prefs: Prefs | None) -> dict:
    if prefs is None:
        return {"note": "no preferences saved yet"}
    return {
        "allergies": prefs.allergies,
        "diet": prefs.diet,
        "cuisines": prefs.cuisines,
        "maxMinutes": prefs.max_minutes,
        "skill": prefs.skill,
        "equipment": prefs.equipment,
        "avoid": prefs.avoid,
        "shopping": prefs.shopping,
        "household": {"adults": prefs.household.adults, "kids": prefs.household.kids},
    }


# ---- preference validation (mirrors the store.js / recipes.py contract) ----

_LIST_FIELDS = {"allergies": ALLERGENS, "diet": DIETS, "cuisines": CUISINES, "equipment": EQUIPMENT}


def _as_list(value) -> list[str]:
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value]
    return []


def _validate_pref(field: str, value):
    """Return (field, cleaned_value) for a valid preference update, or raise ValueError."""
    if field in _LIST_FIELDS:
        allowed = set(_LIST_FIELDS[field])
        cleaned = [v.lower() for v in _as_list(value) if v.lower() in allowed]
        return field, cleaned
    if field == "maxMinutes":
        try:
            return field, max(0, int(round(float(value))))
        except (TypeError, ValueError):
            raise ValueError("maxMinutes must be a number")
    if field == "skill":
        v = str(value).strip().lower()
        if v not in SKILLS:
            raise ValueError(f"skill must be one of {', '.join(SKILLS)}")
        return field, v
    if field == "shopping":
        v = str(value).strip().lower()
        if v not in SHOPPING:
            raise ValueError(f"shopping must be one of {', '.join(SHOPPING)}")
        return field, v
    if field == "avoid":
        return field, str(value).strip()[:200]
    if field == "household":
        v = value if isinstance(value, dict) else {}
        out = {}
        if "adults" in v:
            out["adults"] = max(1, min(8, int(round(float(v["adults"])))))
        if "kids" in v:
            out["kids"] = max(0, min(6, int(round(float(v["kids"])))))
        if not out:
            raise ValueError("household needs adults and/or kids")
        return field, out
    raise ValueError(f"unknown preference field: {field}")


# ---- item validation for add_pantry_items / add_to_shopping_list ----

UNITS = ("g", "kg", "ml", "l", "pcs", "pack")  # what the pantry stores; same list as units.js

# Unit word -> (canonical unit, factor applied to the quantity). Imperial, volume
# and packaging words are folded into the six units above, so the client never
# has to know what an ounce is. Factors match frontend/shared/units.js. Anything
# not listed comes back as "" and the quantity is kept as the user said it.
_UNIT_MAP: dict[str, tuple[str, float]] = {
    **{w: ("g", 1.0) for w in ("g", "gr", "gram", "grams")},
    **{w: ("kg", 1.0) for w in ("kg", "kilo", "kilos", "kilogram", "kilograms")},
    **{w: ("ml", 1.0) for w in ("ml", "milliliter", "milliliters", "millilitre", "millilitres")},
    **{w: ("l", 1.0) for w in ("l", "liter", "liters", "litre", "litres")},
    **{w: ("pcs", 1.0) for w in ("pcs", "pc", "piece", "pieces", "count", "ct", "each", "ea", "whole", "egg", "eggs", "clove", "cloves")},
    **{w: ("pack", 1.0) for w in (
        "pack", "packs", "pk", "packet", "packets", "jar", "jars", "bottle", "bottles", "can", "cans",
        "bag", "bags", "box", "boxes", "carton", "cartons", "tub", "tubs", "bunch", "bunches",
    )},
    **{w: ("g", 28.35) for w in ("oz", "ounce", "ounces")},
    **{w: ("g", 453.6) for w in ("lb", "lbs", "pound", "pounds")},
    "dozen": ("pcs", 12.0),
    **{w: ("ml", 5.0) for w in ("tsp", "teaspoon", "teaspoons")},
    **{w: ("ml", 15.0) for w in ("tbsp", "tablespoon", "tablespoons")},
    **{w: ("ml", 240.0) for w in ("cup", "cups")},
    **{w: ("ml", 29.57) for w in ("fl oz", "floz", "fluid ounce", "fluid ounces")},
    **{w: ("ml", 473.0) for w in ("pint", "pints", "pt")},
    **{w: ("ml", 946.0) for w in ("quart", "quarts", "qt")},
    **{w: ("ml", 3785.0) for w in ("gallon", "gallons", "gal")},
}

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def _clean_name(value) -> str | None:
    """A display name the client can store: trimmed, inner whitespace collapsed, no
    control characters, at most 60 chars. None when nothing usable is left."""
    if not isinstance(value, str):
        return None
    text = " ".join(_CONTROL.sub("", value).split())[:60].strip()
    return text or None


def _clean_quantity(value) -> float | None:
    """A positive finite number, else None (the model sends 0 or null for "some")."""
    try:
        q = float(value)
    except (TypeError, ValueError):
        return None
    return q if math.isfinite(q) and q > 0 else None


def _clean_days(value) -> int | None:
    """expires_in_days: a whole number of days from 1 to 730 (two years), else None."""
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= 730 else None


def _clean_note(value) -> str:
    return " ".join(_CONTROL.sub("", str(value or "")).split())[:120]


def _clean_unit(unit, quantity: float | None) -> tuple[float | None, str]:
    """Fold a free-text unit into one of UNITS, scaling the quantity for imperial,
    volume and dozen. Returns (quantity, unit); unknown units come back as ""."""
    word = " ".join(_WORD.findall(str(unit or "").lower()))
    hit = _UNIT_MAP.get(word)
    if hit is None:
        return quantity, ""
    canonical, factor = hit
    if quantity is not None and factor != 1.0:
        quantity = round(quantity * factor, 2)
    return quantity, canonical


def _clean_items(raw, extra: str) -> list[dict]:
    """Validate a tool's `items` into [{ name, quantity, unit, <extra> }], where `extra`
    is 'expires_in_days' (pantry) or 'note' (shopping). Rows without a usable name are
    dropped and a food named twice keeps its first row, so the client can apply the
    list as-is."""
    out: list[dict] = []
    seen: set[str] = set()
    for row in raw if isinstance(raw, list) else []:
        if isinstance(row, str):
            row = {"name": row}  # the model occasionally sends bare names
        if not isinstance(row, dict):
            continue
        name = _clean_name(row.get("name"))
        if not name or _norm(name) in seen:
            continue
        seen.add(_norm(name))
        quantity, unit = _clean_unit(row.get("unit"), _clean_quantity(row.get("quantity")))
        item = {"name": name, "quantity": quantity, "unit": unit}
        item[extra] = _clean_days(row.get(extra)) if extra == "expires_in_days" else _clean_note(row.get(extra))
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# Tool execution — reads answer from context; writes emit a validated action
# ---------------------------------------------------------------------------


def _run_tool(name: str, args: dict, req: ChatRequest, actions: list[dict], recipes: list[dict]) -> dict:
    """Execute one tool call. Returns the JSON result Claude sees; appends to `actions`
    (writes) or `recipes` (suggested dishes) so the endpoint can hand them to the client."""
    if name == "read_pantry":
        return {"pantry": _pantry_view(req.pantry)}

    if name == "get_expiring":
        days = args.get("days", 5)
        try:
            days = int(days)
        except (TypeError, ValueError):
            days = 5
        soon = sorted(
            (it for it in req.pantry if it.is_food and it.quantity_servings > 0 and it.days_left <= days),
            key=lambda i: i.days_left,
        )
        return {"days": days, "expiring": _pantry_view(soon)}

    if name == "read_preferences":
        return {"preferences": _prefs_view(req.prefs)}

    if name == "recent_meals":
        limit = args.get("limit", 5)
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 5
        meals = [{"title": m.title, "cooked_at": m.cooked_at} for m in req.recent_meals[: max(1, limit)]]
        return {"recent_meals": meals}

    if name == "suggest_recipes":
        count = args.get("count", 3)
        try:
            count = max(1, min(4, int(count)))
        except (TypeError, ValueError):
            count = 3
        request = str(args.get("request") or "").strip() or None
        rreq = rx.RecipeRequest(items=req.pantry, count=count, max_missing=3, request=request, prefs=req.prefs)
        # Lazy suggestions: no steps (they are the bulk of the output and are written later,
        # only for the card the user opens). This is what keeps suggestions fast. Uses Claude
        # via recipes_ai, so the deck's own recipe engine in recipes.py is untouched.
        ranked = recipes_ai.suggest(rreq, count=count)
        seen = {r["title"] for r in recipes}
        for r in ranked:
            if r["title"] not in seen:
                recipes.append(r)  # full recipe dicts for the client to render as tappable cards
                seen.add(r["title"])
        if not ranked:
            return {"recipes": [], "note": "nothing cookable from the current pantry within the limits"}
        # A compact view is enough for Claude to introduce them; the client renders the full cards.
        return {
            "recipes": [
                {
                    "title": r["title"],
                    "cook_minutes": r.get("cook_minutes"),
                    "difficulty": r.get("difficulty"),
                    "missing_count": r.get("missing_count"),
                    "uses_expiring": r.get("uses_expiring"),
                }
                for r in ranked
            ]
        }

    if name == "update_preference":
        try:
            field, cleaned = _validate_pref(str(args.get("field", "")), args.get("value"))
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        actions.append({"type": "update_preference", "field": field, "value": cleaned})
        return {"ok": True, "field": field, "value": cleaned}

    if name == "mark_food_gone":
        item = _match_item(str(args.get("name", "")), req.pantry)
        if item is None:
            return {"ok": False, "error": f"no pantry item matches {args.get('name')!r}"}
        actions.append({"type": "mark_food_gone", "id": item.id, "name": item.name, "key": item.group_key})
        return {"ok": True, "marked_gone": item.name}

    if name == "record_checkin":
        item = _match_item(str(args.get("name", "")), req.pantry)
        if item is None:
            return {"ok": False, "error": f"no pantry item matches {args.get('name')!r}"}
        try:
            percent = float(args.get("percent"))
        except (TypeError, ValueError):
            return {"ok": False, "error": "percent must be a number 0-100"}
        percent = max(0.0, min(100.0, percent))
        actions.append(
            {"type": "record_checkin", "id": item.id, "name": item.name, "key": item.group_key, "percent": percent}
        )
        return {"ok": True, "item": item.name, "percent_remaining": percent}

    if name == "read_shopping_list":
        return {"shopping": _shopping_view(req.shopping)}

    if name == "add_pantry_items":
        items = _clean_items(args.get("items"), "expires_in_days")
        if not items:
            return {"ok": False, "error": "items must be a non-empty list of { name, quantity?, unit?, expires_in_days? }"}
        actions.append({"type": "add_pantry_items", "items": items})
        return {"ok": True, "added": [i["name"] for i in items]}

    if name == "add_to_shopping_list":
        items = _clean_items(args.get("items"), "note")
        if not items:
            return {"ok": False, "error": "items must be a non-empty list of { name, quantity?, unit?, note? }"}
        actions.append({"type": "add_shopping_items", "items": items})
        return {"ok": True, "added": [i["name"] for i in items]}

    if name == "remove_from_shopping_list":
        names = args.get("names")
        if isinstance(names, str):
            names = [names]
        names = [n.strip() for n in (names if isinstance(names, list) else []) if isinstance(n, str) and n.strip()]
        if not names:
            return {"ok": False, "error": "names must be a non-empty list of item names"}
        removed: list[str] = []
        unknown: list[str] = []
        for n in names:
            hit = _match_shopping(n, req.shopping)
            if hit is None:
                unknown.append(n)
            elif hit.name not in removed:
                removed.append(hit.name)  # the name as it reads on the list, so the client can find it
        if removed:
            actions.append({"type": "remove_shopping_items", "names": removed})
        return {"ok": bool(removed), "removed": removed, "unknown": unknown}

    return {"ok": False, "error": f"unknown tool: {name}"}


# ---------------------------------------------------------------------------
# The chat loop
# ---------------------------------------------------------------------------


def _recipes_intro(n: int) -> str:
    """A short local intro for the recipe cards, so a pure-suggestion turn skips the
    extra model round-trip that would otherwise write this same sentence."""
    lead = "Here's an idea" if n == 1 else f"Here are {n} ideas"
    return f"{lead} from what's in your pantry — tap a card for the full recipe."


def _to_converse_messages(history: list[ChatMessage]) -> list[dict]:
    """Turn the plain turn history into Converse messages, dropping empties and
    making sure the conversation ends on a user turn."""
    msgs: list[dict] = []
    for m in history:
        role = "assistant" if m.role == "assistant" else "user"
        text = (m.content or "").strip()
        if not text:
            continue
        # Converse rejects two same-role messages in a row; merge if needed.
        if msgs and msgs[-1]["role"] == role:
            msgs[-1]["content"].append({"text": text})
        else:
            msgs.append({"role": role, "content": [{"text": text}]})
    return msgs


def run(req: ChatRequest) -> dict:
    """Run the chatbot for one user turn. Returns { reply, actions }."""
    messages = _to_converse_messages(req.messages)
    if not messages or messages[-1]["role"] != "user":
        raise HTTPException(400, "The last message must be from the user.")

    actions: list[dict] = []
    recipes: list[dict] = []

    for _ in range(MAX_TOOL_TURNS):
        response = bedrock.converse(
            messages=messages,
            system=SYSTEM,
            tools=TOOLS,
            max_tokens=768,
            temperature=0.3,
            model=bedrock.model_fast(),  # tool routing + short replies: the fast tier
        )
        stop = response.get("stopReason")
        assistant = bedrock.output_message(response)
        messages.append(assistant)  # carry the assistant turn (text + toolUse) forward

        if stop != "tool_use":
            return {"reply": bedrock.response_text(response), "actions": actions, "recipes": recipes}

        # Answer every tool call in this turn, then loop so Claude can continue.
        uses = bedrock.tool_uses(response)
        recipes_before = len(recipes)
        tool_results = []
        for use in uses:
            result = _run_tool(use.get("name", ""), use.get("input") or {}, req, actions, recipes)
            tool_results.append(
                {"toolResult": {"toolUseId": use.get("toolUseId"), "content": [{"json": result}]}}
            )
        messages.append({"role": "user", "content": tool_results})

        # Fast path: a turn that only suggested recipes needs no extra synthesis round-trip
        # (that round-trip is ~4s of pure latency). Introduce the cards with a local line.
        if {u.get("name") for u in uses} == {"suggest_recipes"} and len(recipes) > recipes_before:
            return {"reply": _recipes_intro(len(recipes) - recipes_before), "actions": actions, "recipes": recipes}

    # Ran out of tool turns: make one last plain call for a closing reply.
    response = bedrock.converse(
        messages=messages, system=SYSTEM, max_tokens=768, temperature=0.3, model=bedrock.model_fast()
    )
    return {"reply": bedrock.response_text(response), "actions": actions, "recipes": recipes}
