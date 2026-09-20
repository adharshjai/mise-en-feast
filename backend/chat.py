"""
Pantry chatbot — Claude (Bedrock) with a small set of controlled app tools.

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
        recent_meals:  [ { title, cooked_at? } ]   # optional, newest first
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

Reads never produce actions. The deterministic layers (decay, expiration,
consumption-rate learning) stay in the frontend / SQL exactly as before; the
chatbot only triggers them, it never recomputes them.
"""

from __future__ import annotations

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


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)
    pantry: list[PantryItem] = Field(default_factory=list)
    prefs: Prefs | None = None
    recent_meals: list[Meal] = Field(default_factory=list)


SYSTEM = """You are the in-app assistant for Pantry, an app that tracks what food a
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

For "what can I make ..." questions, call suggest_recipes directly and immediately — it
already receives the full pantry and preferences, so do NOT call read_pantry or
get_expiring first. The recipes it returns are shown to the user as tappable cards.

Be concise, friendly and specific. Never invent pantry items the user does not have. Do
not claim you changed something unless you called the tool for it."""


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
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_WORD = re.compile(r"[a-z0-9]+")


def _norm(s: str) -> str:
    return " ".join(_WORD.findall((s or "").lower()))


def _match_item(name: str, pantry: list[PantryItem]) -> PantryItem | None:
    """Best pantry item for a free-text food name: exact, then substring, then token overlap."""
    q = _norm(name)
    if not q:
        return None
    food = [i for i in pantry if i.is_food]
    for it in food:
        if _norm(it.name) == q or _norm(it.group_key) == q:
            return it
    for it in food:
        n = _norm(it.name)
        if n and (q in n or n in q):
            return it
    words = set(q.split())
    best, best_score = None, 0.0
    for it in food:
        overlap = len(words & set(_norm(it.name).split()))
        if overlap:
            score = overlap / max(len(words), 1)
            if score > best_score:
                best, best_score = it, score
    return best if best_score >= 0.5 else None


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
